import { z } from 'zod';
import { toE164 } from '../domain/phone.js';
import { parseDateTimeInput } from '../domain/time.js';
import { audit } from './audit.js';
import { getConfig } from './config.js';
import { DomainError, inTx, type Actor, type AppContext } from './context.js';
import { lockWorker } from './facts.js';
import { cancelOpenOffersForWorker } from './offerEngine.js';

const WorkerInput = z.object({
  first_name: z.string().trim().min(1, 'First name is required').max(80),
  last_name: z.string().trim().min(1, 'Last name is required').max(80),
  phone: z.string().trim().min(1, 'Phone is required'),
  tranche: z.coerce.number().int().min(1, 'Tranche must be 1 or more').max(99),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Start date is required'),
  active: z.preprocess((v) => v === true || v === 'on' || v === 'true', z.boolean()).default(true),
  notes: z.string().max(2000).optional().nullable(),
  skill_ids: z.preprocess(
    (v) => (v === undefined || v === '' ? [] : Array.isArray(v) ? v : [v]),
    z.array(z.coerce.number().int().positive()),
  ),
});

function parse(raw: unknown, region: string) {
  const r = WorkerInput.safeParse(raw);
  if (!r.success) throw new DomainError(r.error.issues.map((i) => i.message).join('; '));
  const phone = toE164(r.data.phone, region);
  if (!phone) throw new DomainError(`"${r.data.phone}" is not a valid phone number.`);
  return { ...r.data, phone };
}

async function phoneTaken(ctx: AppContext, phone: string, exceptId?: number): Promise<boolean> {
  let q = ctx.db.selectFrom('worker').select('id').where('phone', '=', phone);
  if (exceptId) q = q.where('id', '<>', exceptId);
  return !!(await q.executeTakeFirst());
}

export async function createWorker(ctx: AppContext, raw: unknown, actor: Actor): Promise<number> {
  const d = parse(raw, ctx.defaultRegion);
  if (await phoneTaken(ctx, d.phone)) throw new DomainError('Another worker already has that phone number.', 409);
  return inTx(ctx, async (tx) => {
    const w = await tx
      .insertInto('worker')
      .values({
        first_name: d.first_name,
        last_name: d.last_name,
        phone: d.phone,
        tranche: d.tranche,
        start_date: d.start_date,
        active: d.active,
        notes: d.notes ?? null,
        opt_out_at: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (d.skill_ids.length) await tx.insertInto('worker_skill').values(d.skill_ids.map((s) => ({ worker_id: w.id, skill_id: s }))).execute();
    await audit(tx, actor, 'worker.created', 'worker', w.id, { data: { ...d } });
    return w.id;
  });
}

export async function updateWorker(ctx: AppContext, id: number, raw: unknown, actor: Actor): Promise<void> {
  const d = parse(raw, ctx.defaultRegion);
  if (await phoneTaken(ctx, d.phone, id)) throw new DomainError('Another worker already has that phone number.', 409);
  await inTx(ctx, async (tx, fx) => {
    const before = await lockWorker(tx, id);
    const skillsBefore = (await tx.selectFrom('worker_skill').select('skill_id').where('worker_id', '=', id).execute()).map((s) => s.skill_id).sort();
    await tx
      .updateTable('worker')
      .set({
        first_name: d.first_name,
        last_name: d.last_name,
        phone: d.phone,
        tranche: d.tranche,
        start_date: d.start_date,
        active: d.active,
        notes: d.notes ?? null,
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .execute();
    await tx.deleteFrom('worker_skill').where('worker_id', '=', id).execute();
    if (d.skill_ids.length) await tx.insertInto('worker_skill').values(d.skill_ids.map((s) => ({ worker_id: id, skill_id: s }))).execute();
    const changes: Record<string, unknown> = {};
    for (const k of ['first_name', 'last_name', 'phone', 'tranche', 'start_date', 'active', 'notes'] as const) {
      if (String(before[k] ?? '') !== String(d[k] ?? '')) changes[k] = { from: before[k], to: d[k] };
    }
    const skillsAfter = [...d.skill_ids].sort();
    if (skillsBefore.join() !== skillsAfter.join()) changes.skills = { from: skillsBefore, to: skillsAfter };
    await audit(tx, actor, 'worker.updated', 'worker', id, { data: changes });
    if (before.active && !d.active) await cancelOpenOffersForWorker(ctx, tx, fx, id, 'worker_inactive', actor);
  });
}

/**
 * Admin-side opt-out (e.g. the worker asked in person). Opt-IN is deliberately not
 * offered here: carriers require the worker to text START themselves.
 */
export async function adminOptOut(ctx: AppContext, id: number, reason: string, actor: Actor): Promise<void> {
  if (!reason?.trim()) throw new DomainError('A reason is required.');
  await inTx(ctx, async (tx, fx) => {
    await lockWorker(tx, id);
    await tx.updateTable('worker').set({ sms_opt_out: true, opt_out_at: new Date(), updated_at: new Date() }).where('id', '=', id).execute();
    await audit(tx, actor, 'worker.opted_out', 'worker', id, { reason });
    await cancelOpenOffersForWorker(ctx, tx, fx, id, 'opted_out', actor);
  });
}

export async function addRefusal(
  ctx: AppContext,
  workerId: number,
  raw: { kind: string; target_id: string | number; reason?: string },
  actor: Actor,
): Promise<void> {
  const targetId = Number(raw.target_id);
  if (!['job_type', 'venue'].includes(raw.kind) || !Number.isInteger(targetId) || targetId <= 0) {
    throw new DomainError('Choose a job type or venue to refuse.');
  }
  await inTx(ctx, async (tx) => {
    await tx
      .insertInto('worker_refusal')
      .values({
        worker_id: workerId,
        job_type_id: raw.kind === 'job_type' ? targetId : null,
        venue_id: raw.kind === 'venue' ? targetId : null,
        reason: raw.reason ?? '',
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
    await audit(tx, actor, 'worker.refusal_added', 'worker', workerId, { reason: raw.reason, data: { kind: raw.kind, target_id: targetId } });
  });
}

export async function removeRefusal(ctx: AppContext, workerId: number, refusalId: number, actor: Actor): Promise<void> {
  await inTx(ctx, async (tx) => {
    const r = await tx.deleteFrom('worker_refusal').where('id', '=', refusalId).where('worker_id', '=', workerId).returningAll().executeTakeFirst();
    if (r) await audit(tx, actor, 'worker.refusal_removed', 'worker', workerId, { data: { job_type_id: r.job_type_id, venue_id: r.venue_id } });
  });
}

export async function addUnavailability(
  ctx: AppContext,
  workerId: number,
  raw: { starts_at: string; ends_at: string; note?: string },
  actor: Actor,
): Promise<void> {
  const config = await getConfig(ctx.db);
  let start: Date, end: Date;
  try {
    start = parseDateTimeInput(raw.starts_at, config.timezone);
    end = parseDateTimeInput(raw.ends_at, config.timezone);
  } catch {
    throw new DomainError('Enter a valid start and end.');
  }
  if (end <= start) throw new DomainError('End must be after start.');
  await inTx(ctx, async (tx) => {
    const u = await tx
      .insertInto('worker_unavailability')
      .values({ worker_id: workerId, starts_at: start, ends_at: end, note: raw.note ?? '' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await audit(tx, actor, 'worker.unavailability_added', 'worker', workerId, {
      data: { id: u.id, starts_at: start, ends_at: end, note: raw.note },
    });
  });
}

export async function removeUnavailability(ctx: AppContext, workerId: number, id: number, actor: Actor): Promise<void> {
  await inTx(ctx, async (tx) => {
    const u = await tx.deleteFrom('worker_unavailability').where('id', '=', id).where('worker_id', '=', workerId).returningAll().executeTakeFirst();
    if (u) await audit(tx, actor, 'worker.unavailability_removed', 'worker', workerId, { data: { starts_at: u.starts_at, ends_at: u.ends_at } });
  });
}
