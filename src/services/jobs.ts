import { z } from 'zod';
import { jobWindow } from '../domain/time.js';
import * as T from '../sms/templates.js';
import { audit } from './audit.js';
import { generateList } from './candidateLists.js';
import { getConfig } from './config.js';
import { DomainError, inTx, type Actor, type AppContext } from './context.js';
import { loadCallInfo } from './facts.js';
import { cancelOffer, reconcileLocked, withPositionScope } from './offerEngine.js';
import { enqueueSms } from './outbox.js';

const dateRe = /^\d{4}-\d{2}-\d{2}$/;
const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;

export const JobInput = z.object({
  venue_id: z.coerce.number().int().positive('Choose a venue'),
  job_type_id: z.coerce.number().int().positive('Choose a job type'),
  date: z.string().regex(dateRe, 'Date is required'),
  start_time: z.string().regex(timeRe, 'Start time is required'),
  end_time: z.string().regex(timeRe, 'Estimated end time is required'),
  notes: z.string().max(2000).default(''),
  positions: z
    .array(z.object({ skill_id: z.coerce.number().int().positive(), quantity: z.coerce.number().int().min(1).max(200) }))
    .min(1, 'Add at least one position'),
});
export type JobInput = z.infer<typeof JobInput>;

function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new DomainError(r.error.issues.map((i) => i.message).join('; '));
  return r.data;
}

/** Creates a job, its positions, and a draft candidate list for each position. Nothing is texted. */
export async function createJob(ctx: AppContext, raw: unknown, actor: Actor): Promise<number> {
  const input = parseOrThrow(JobInput, raw);
  return inTx(ctx, async (tx) => {
    const config = await getConfig(tx);
    const { startsAt, endsAt } = jobWindow(input.date, input.start_time, input.end_time, config.timezone);
    const job = await tx
      .insertInto('job')
      .values({
        venue_id: input.venue_id,
        job_type_id: input.job_type_id,
        starts_at: startsAt,
        est_end_at: endsAt,
        notes: input.notes,
        created_by: actor.type === 'user' ? actor.id : null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(tx, actor, 'job.created', 'job', job.id, { data: { ...input } });
    for (const p of input.positions) {
      const pos = await tx.insertInto('position').values({ job_id: job.id, skill_id: p.skill_id, quantity: p.quantity }).returningAll().executeTakeFirstOrThrow();
      await audit(tx, actor, 'position.created', 'position', pos.id, { data: { job_id: job.id, ...p } });
      await generateList(tx, pos.id, actor);
    }
    return job.id;
  });
}

export async function addPosition(ctx: AppContext, jobId: number, raw: unknown, actor: Actor): Promise<number> {
  const p = parseOrThrow(z.object({ skill_id: z.coerce.number().int().positive(), quantity: z.coerce.number().int().min(1).max(200) }), raw);
  return inTx(ctx, async (tx) => {
    const job = await tx.selectFrom('job').selectAll().where('id', '=', jobId).forNoKeyUpdate().executeTakeFirst();
    if (!job) throw new DomainError('Job not found', 404);
    if (job.status !== 'open') throw new DomainError('Job is not open', 409);
    const pos = await tx.insertInto('position').values({ job_id: jobId, skill_id: p.skill_id, quantity: p.quantity }).returningAll().executeTakeFirstOrThrow();
    await audit(tx, actor, 'position.created', 'position', pos.id, { data: { job_id: jobId, ...p } });
    await generateList(tx, pos.id, actor);
    return pos.id;
  });
}

export async function updateJobNotes(ctx: AppContext, jobId: number, notes: string, actor: Actor): Promise<void> {
  await inTx(ctx, async (tx) => {
    await tx.updateTable('job').set({ notes, updated_at: new Date() }).where('id', '=', jobId).execute();
    await audit(tx, actor, 'job.notes_updated', 'job', jobId, { data: { notes } });
  });
}

/** Changes a position's quantity (must stay ≥ the number already filled). */
export async function setQuantity(ctx: AppContext, positionId: number, quantity: number, reason: string, actor: Actor): Promise<void> {
  if (!reason?.trim()) throw new DomainError('A reason is required.');
  await inTx(ctx, async (tx, fx) => {
    await withPositionScope(ctx, tx, fx, positionId, async (s, position) => {
      if (!Number.isInteger(quantity) || quantity < Math.max(1, position.filled_count)) {
        throw new DomainError(`Quantity must be at least ${Math.max(1, position.filled_count)}.`);
      }
      if (position.status === 'cancelled') throw new DomainError('Position is cancelled.', 409);
      const updated = await tx
        .updateTable('position')
        .set({ quantity, status: position.status === 'filled' && quantity > position.filled_count ? 'open' : position.status, updated_at: s.now })
        .where('id', '=', positionId)
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, actor, 'position.quantity_changed', 'position', positionId, {
        reason,
        data: { from: position.quantity, to: quantity },
      });
      await reconcileLocked(s, updated);
    });
  });
}

/** Cancels a job: withdraws open offers and texts every worker who had accepted. */
export async function cancelJob(ctx: AppContext, jobId: number, reason: string, actor: Actor): Promise<void> {
  if (!reason?.trim()) throw new DomainError('A reason is required to cancel a job.');
  await inTx(ctx, async (tx, fx) => {
    const job = await tx.selectFrom('job').selectAll().where('id', '=', jobId).forNoKeyUpdate().executeTakeFirst();
    if (!job) throw new DomainError('Job not found', 404);
    if (job.status !== 'open') throw new DomainError(`Job is already ${job.status}.`, 409);
    const now = ctx.clock.now();
    await tx.updateTable('job').set({ status: 'cancelled', updated_at: now }).where('id', '=', jobId).execute();
    const positions = await tx.selectFrom('position').select('id').where('job_id', '=', jobId).orderBy('id').execute();
    for (const { id } of positions) {
      await withPositionScope(ctx, tx, fx, id, async (s) => {
        const offers = await tx.selectFrom('offer').selectAll().where('position_id', '=', id).where('status', 'in', ['queued', 'sent']).forNoKeyUpdate().execute();
        for (const o of offers) await cancelOffer(s, o, 'job_cancelled', actor);
        const bookings = await tx
          .updateTable('booking')
          .set({ cancelled_at: now, cancel_reason: 'job_cancelled' })
          .where('position_id', '=', id)
          .where('cancelled_at', 'is', null)
          .returning(['id', 'worker_id'])
          .execute();
        for (const b of bookings) {
          const w = await tx.selectFrom('worker').select('phone').where('id', '=', b.worker_id).executeTakeFirstOrThrow();
          await enqueueSms(tx, { workerId: b.worker_id, phone: w.phone, body: T.callCancelledText(s.info) });
        }
        await tx.updateTable('position').set({ status: 'cancelled', updated_at: now }).where('id', '=', id).execute();
        await tx.updateTable('candidate_list').set({ status: 'cancelled', updated_at: now }).where('position_id', '=', id).execute();
      });
    }
    await audit(tx, actor, 'job.cancelled', 'job', jobId, { reason });
  });
}

/** Releases a worker from an accepted call; the slot reopens and the next candidate is offered. */
export async function releaseBooking(ctx: AppContext, bookingId: number, reason: string, actor: Actor): Promise<void> {
  if (!reason?.trim()) throw new DomainError('A reason is required.');
  await inTx(ctx, async (tx, fx) => {
    const b = await tx.selectFrom('booking').selectAll().where('id', '=', bookingId).executeTakeFirst();
    if (!b || b.cancelled_at) throw new DomainError('Booking not found or already released.', 404);
    await withPositionScope(ctx, tx, fx, b.position_id, async (s, position) => {
      const now = s.now;
      await tx.updateTable('booking').set({ cancelled_at: now, cancel_reason: reason }).where('id', '=', bookingId).execute();
      const updated = await tx
        .updateTable('position')
        .set((eb) => ({ filled_count: eb('filled_count', '-', 1), status: 'open', updated_at: now }))
        .where('id', '=', position.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const w = await tx.selectFrom('worker').select('phone').where('id', '=', b.worker_id).executeTakeFirstOrThrow();
      await enqueueSms(tx, { workerId: b.worker_id, phone: w.phone, body: T.releasedText(s.info) });
      await audit(tx, actor, 'booking.released', 'booking', bookingId, {
        reason,
        data: { worker_id: b.worker_id, position_id: position.id },
      });
      await reconcileLocked(s, updated);
    });
  });
}

export async function acknowledgeAlert(ctx: AppContext, alertId: number, actor: Actor): Promise<void> {
  await inTx(ctx, async (tx) => {
    await tx
      .updateTable('alert')
      .set({ acknowledged_at: new Date(), acknowledged_by: actor.type === 'user' ? actor.id : null })
      .where('id', '=', alertId)
      .execute();
    await audit(tx, actor, 'alert.acknowledged', 'alert', alertId);
  });
}

export { loadCallInfo };
