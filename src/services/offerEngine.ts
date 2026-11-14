/**
 * The offer engine. Every function that changes offers for a position runs while
 * holding that position's row lock (SELECT ... FOR NO KEY UPDATE), so offer creation,
 * acceptance and expiry for one position are serialized.
 *
 * Lock order (to avoid deadlocks): worker → position → offer. Code that needs locks
 * on several positions takes them one transaction at a time (see Effects).
 *
 * NO KEY UPDATE (not FOR UPDATE) is used throughout: we never change key columns, and it
 * does not conflict with the KEY SHARE locks Postgres takes for foreign-key checks
 * (e.g. inserting an sms_message that references an offer), which otherwise deadlock.
 */
import type { Tx } from '../db/kysely.js';
import type { AppConfig, Offer, Position } from '../db/types.js';
import { addActiveMinutes, isQuiet } from '../domain/quietHours.js';
import { generateOfferCode } from '../domain/replyParser.js';
import { blockingReasons, describeReasons, overlaps } from '../domain/selection.js';
import { canListTransition, nextListStatus, nextOfferStatus, type ListEvent } from '../domain/stateMachines.js';
import * as T from '../sms/templates.js';
import type { CallInfo } from '../sms/templates.js';
import { audit } from './audit.js';
import { getConfig, quietHoursOf } from './config.js';
import { inTx, registerEffectRunner, SYSTEM, type Actor, type AppContext, type Effects } from './context.js';
import { loadCallInfo, loadWorkerFacts, lockPosition, selectionContext } from './facts.js';
import { enqueueSms, flushOutbox } from './outbox.js';

export type CancelReason =
  | 'position_filled'
  | 'conflict'
  | 'opted_out'
  | 'worker_inactive'
  | 'job_cancelled'
  | 'position_cancelled'
  | 'removed_from_list';

interface Scope {
  ctx: AppContext;
  tx: Tx;
  fx: Effects;
  config: AppConfig;
  now: Date;
  info: CallInfo;
}

async function scopeFor(ctx: AppContext, tx: Tx, fx: Effects, positionId: number): Promise<Scope> {
  const config = await getConfig(tx);
  return { ctx, tx, fx, config, now: ctx.clock.now(), info: await loadCallInfo(tx, positionId, config) };
}

// ------------------------------------------------------------------ public entry points

/** Re-evaluates one position: expire due offers, release queued ones, top up, detect filled/exhausted. */
export async function reconcilePosition(ctx: AppContext, positionId: number): Promise<void> {
  await inTx(ctx, async (tx, fx) => {
    const position = await lockPosition(tx, positionId);
    await reconcileLocked(await scopeFor(ctx, tx, fx, positionId), position);
  });
}

/**
 * Periodic tick (every minute via pg-boss, plus targeted wake-ups at offer expiry).
 * Finds positions that may need work and reconciles each in its own transaction.
 */
export async function tick(ctx: AppContext): Promise<void> {
  const now = ctx.clock.now();
  const rows = await ctx.db
    .selectFrom('position')
    .innerJoin('candidate_list', 'candidate_list.position_id', 'position.id')
    .innerJoin('job', 'job.id', 'position.job_id')
    .select('position.id')
    .where('job.status', '=', 'open')
    .where('position.status', 'in', ['open', 'exhausted'])
    .where('candidate_list.status', 'in', ['approved', 'active', 'exhausted'])
    .where('job.est_end_at', '>', now)
    .union(
      // positions with offers past expiry, whatever else is going on
      ctx.db
        .selectFrom('offer')
        .select('offer.position_id as id')
        .where('offer.status', '=', 'sent')
        .where('offer.expires_at', '<=', now),
    )
    .execute();
  for (const r of rows) {
    try {
      await reconcilePosition(ctx, r.id);
    } catch (err) {
      ctx.log.error(`reconcile position ${r.id} failed`, err);
    }
  }
  await flushOutbox(ctx);
}

// ------------------------------------------------------------------ core

export async function reconcileLocked(s: Scope, position: Position): Promise<void> {
  const { tx, now, config } = s;
  const list = await tx.selectFrom('candidate_list').selectAll().where('position_id', '=', position.id).forNoKeyUpdate().executeTakeFirst();
  const job = await tx.selectFrom('job').selectAll().where('id', '=', position.job_id).executeTakeFirstOrThrow();

  // 1. Expire offers whose reply window has passed (always, even for closed positions).
  const due = await tx
    .selectFrom('offer')
    .selectAll()
    .where('position_id', '=', position.id)
    .where('status', '=', 'sent')
    .where('expires_at', '<=', now)
    .forNoKeyUpdate()
    .execute();
  for (const o of due) {
    await transitionOffer(s, o, 'expire', {});
    await audit(tx, SYSTEM, 'offer.expired', 'offer', o.id, { at: now, data: { position_id: position.id, worker_id: o.worker_id } });
  }

  if (!list || job.status !== 'open' || position.status === 'cancelled') return;
  if (!['approved', 'active', 'exhausted', 'filled'].includes(list.status)) return; // not approved: never text

  let listStatus = list.status;
  const setList = async (event: ListEvent) => {
    if (!canListTransition(listStatus, event)) return;
    listStatus = nextListStatus(listStatus, event);
    await tx.updateTable('candidate_list').set({ status: listStatus, updated_at: now }).where('id', '=', list.id).execute();
  };
  if (listStatus === 'approved') await setList('activate');

  const openSlots = position.quantity - position.filled_count;
  const openOffers = await tx
    .selectFrom('offer')
    .selectAll()
    .where('position_id', '=', position.id)
    .where('status', 'in', ['queued', 'sent'])
    .orderBy('id')
    .forNoKeyUpdate()
    .execute();

  // 2. Filled: close it out and stand down everyone else.
  if (openSlots <= 0) {
    if (position.status !== 'filled') {
      await tx.updateTable('position').set({ status: 'filled', updated_at: now }).where('id', '=', position.id).execute();
      await audit(tx, SYSTEM, 'position.filled', 'position', position.id, { at: now, data: { job_id: job.id } });
    }
    await setList('fill');
    for (const o of openOffers) await cancelOffer(s, o, 'position_filled');
    return;
  }
  if (listStatus === 'filled') await setList('reopen'); // a booking was released

  // No new offers once the call is over.
  const callOver = job.est_end_at <= now;
  const quiet = isQuiet(now, quietHoursOf(config));
  const selCtx = selectionContext(job, position, config);

  // 3. Quiet hours over: send held offers (re-checking eligibility first).
  let outstanding = 0;
  for (const o of openOffers) {
    if (o.status === 'queued' && !quiet && !callOver) {
      const [facts] = await loadWorkerFacts(tx, selCtx, [o.worker_id]);
      const entry = o.candidate_entry_id
        ? await tx.selectFrom('candidate_entry').select('source').where('id', '=', o.candidate_entry_id).executeTakeFirst()
        : undefined;
      const reasons = blockingReasons(facts, selCtx, entry?.source === 'manual');
      if (reasons.length) {
        await cancelOffer(s, o, reasons.includes('opted_out') ? 'opted_out' : 'conflict');
        continue;
      }
      await sendOffer(s, o);
    }
    outstanding++;
  }

  // 4. Top up to the target number of outstanding offers.
  const target = openSlots * config.offers_per_open_slot;
  if (!callOver && outstanding < target) {
    const entries = await tx
      .selectFrom('candidate_entry')
      .leftJoin('offer', (j) => j.onRef('offer.worker_id', '=', 'candidate_entry.worker_id').on('offer.position_id', '=', position.id))
      .select(['candidate_entry.id', 'candidate_entry.worker_id', 'candidate_entry.source', 'candidate_entry.skipped_reasons'])
      .where('candidate_entry.list_id', '=', list.id)
      .where('candidate_entry.removed_at', 'is', null)
      .where('offer.id', 'is', null) // each worker gets one shot per position
      .orderBy('candidate_entry.rank')
      .execute();
    const facts = new Map((await loadWorkerFacts(tx, selCtx, entries.map((e) => e.worker_id))).map((f) => [f.id, f]));

    for (const e of entries) {
      if (outstanding >= target) break;
      const f = facts.get(e.worker_id)!;
      const reasons = blockingReasons(f, selCtx, e.source === 'manual');
      const prev = e.skipped_reasons ?? [];
      if (reasons.length) {
        if (prev.join() !== reasons.join()) {
          await tx.updateTable('candidate_entry').set({ skipped_reasons: reasons }).where('id', '=', e.id).execute();
          await audit(tx, SYSTEM, 'candidate.skipped', 'candidate_entry', e.id, {
            at: now,
            reason: describeReasons(reasons),
            data: { position_id: position.id, worker_id: e.worker_id, reasons },
          });
        }
        continue;
      }
      if (prev.length) await tx.updateTable('candidate_entry').set({ skipped_reasons: null }).where('id', '=', e.id).execute();
      await createOffer(s, position, e.id, f.id, quiet);
      outstanding++;
    }
  }

  // 5. Exhausted / recovered.
  if (outstanding === 0 && !callOver) {
    if (position.status !== 'exhausted') {
      await tx.updateTable('position').set({ status: 'exhausted', updated_at: now }).where('id', '=', position.id).execute();
      await setList('exhaust');
      await raiseExhaustedAlert(s, position);
    }
  } else if (outstanding > 0 && position.status === 'exhausted') {
    await tx.updateTable('position').set({ status: 'open', updated_at: now }).where('id', '=', position.id).execute();
    await setList('reopen');
    await audit(tx, SYSTEM, 'position.reopened', 'position', position.id, { at: now });
  }
}

async function createOffer(s: Scope, position: Position, entryId: number, workerId: number, quiet: boolean): Promise<void> {
  const { tx, now } = s;
  const taken = await tx
    .selectFrom('offer')
    .select('code')
    .where('worker_id', '=', workerId)
    .where('status', 'in', ['queued', 'sent'])
    .execute();
  const code = generateOfferCode(new Set(taken.map((t) => t.code)));
  const offer = await tx
    .insertInto('offer')
    .values({
      position_id: position.id,
      worker_id: workerId,
      candidate_entry_id: entryId,
      code,
      status: 'queued',
      queued_at: now,
      sent_at: null,
      expires_at: null,
      responded_at: null,
      reply_text: null,
      cancel_reason: null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(tx, SYSTEM, quiet ? 'offer.queued_quiet_hours' : 'offer.created', 'offer', offer.id, {
    at: now,
    data: { position_id: position.id, worker_id: workerId, code },
  });
  if (!quiet) await sendOffer(s, offer);
}

async function sendOffer(s: Scope, offer: Offer): Promise<void> {
  const { tx, now, config } = s;
  const window = config.reply_window_minutes;
  const expiresAt = addActiveMinutes(now, window, quietHoursOf(config));
  nextOfferStatus(offer.status, 'send'); // validates
  await tx
    .updateTable('offer')
    .set({ status: 'sent', sent_at: now, expires_at: expiresAt, updated_at: now })
    .where('id', '=', offer.id)
    .execute();
  const worker = await tx.selectFrom('worker').select(['phone']).where('id', '=', offer.worker_id).executeTakeFirstOrThrow();
  await enqueueSms(tx, {
    workerId: offer.worker_id,
    phone: worker.phone,
    offerId: offer.id,
    body: T.offerText(s.info, offer.code, now, expiresAt, window),
  });
  await audit(tx, SYSTEM, 'offer.sent', 'offer', offer.id, {
    at: now,
    data: { position_id: offer.position_id, worker_id: offer.worker_id, code: offer.code, expires_at: expiresAt },
  });
  s.fx.wakeups.push({ positionId: offer.position_id, at: expiresAt });
}

async function transitionOffer(
  s: Scope,
  offer: Offer,
  event: 'accept' | 'decline' | 'expire' | 'cancel',
  extra: { replyText?: string; cancelReason?: CancelReason },
): Promise<void> {
  const to = nextOfferStatus(offer.status, event);
  await s.tx
    .updateTable('offer')
    .set({
      status: to,
      updated_at: s.now,
      ...(event === 'accept' || event === 'decline' ? { responded_at: s.now, reply_text: extra.replyText ?? null } : {}),
      ...(extra.cancelReason ? { cancel_reason: extra.cancelReason } : {}),
    })
    .where('id', '=', offer.id)
    .execute();
  offer.status = to;
}

/** Cancels an open offer; texts the worker only if they had actually received it. */
export async function cancelOffer(s: Scope, offer: Offer, reason: CancelReason, actor: Actor = SYSTEM): Promise<void> {
  const wasSent = offer.status === 'sent';
  await transitionOffer(s, offer, 'cancel', { cancelReason: reason });
  await audit(s.tx, actor, 'offer.cancelled', 'offer', offer.id, {
    at: s.now,
    reason,
    data: { position_id: offer.position_id, worker_id: offer.worker_id, was_sent: wasSent },
  });
  if (!wasSent || reason === 'opted_out') return;
  const worker = await s.tx.selectFrom('worker').select('phone').where('id', '=', offer.worker_id).executeTakeFirstOrThrow();
  const body = reason === 'position_filled' ? T.filledText(s.info, offer.code) : T.withdrawnText(s.info, offer.code);
  await enqueueSms(s.tx, { workerId: offer.worker_id, phone: worker.phone, offerId: offer.id, body });
}

async function raiseExhaustedAlert(s: Scope, position: Position): Promise<void> {
  const { tx, now, config, info } = s;
  const message = `${info.skill} for ${info.jobType} at ${info.venue} ran out of candidates (${position.filled_count}/${position.quantity} filled).`;
  await tx.insertInto('alert').values({
    kind: 'position_exhausted',
    job_id: position.job_id,
    position_id: position.id,
    message,
    acknowledged_by: null,
    acknowledged_at: null,
  }).execute();
  await audit(tx, SYSTEM, 'position.exhausted', 'position', position.id, { at: now, data: { job_id: position.job_id } });
  if (config.steward_sms_alerts) {
    const stewards = await tx
      .selectFrom('app_user')
      .select(['phone'])
      .where('role', '=', 'steward')
      .where('active', '=', true)
      .where('phone', 'is not', null)
      .execute();
    for (const st of stewards) {
      await enqueueSms(tx, {
        workerId: null,
        phone: st.phone!,
        body: T.exhaustedStewardText(config.local_name, info, position.filled_count, position.quantity),
      });
    }
  }
}

// ------------------------------------------------------------------ replies (caller holds worker lock)

export type ReplyOutcome = 'accepted' | 'declined' | 'expired' | 'filled' | 'conflict' | 'not_open';

/**
 * Applies YES/NO to an offer. Caller must already hold the worker row lock; this takes
 * the position lock and re-reads the offer under it, so two YES replies racing for the
 * last slot are serialized and exactly one wins.
 */
export async function respondToOffer(
  ctx: AppContext,
  tx: Tx,
  fx: Effects,
  offerId: number,
  answer: 'accept' | 'decline',
  replyText: string,
  actor: Actor,
): Promise<ReplyOutcome> {
  const peek = await tx.selectFrom('offer').select('position_id').where('id', '=', offerId).executeTakeFirstOrThrow();
  let position = await lockPosition(tx, peek.position_id);
  const offer = await tx.selectFrom('offer').selectAll().where('id', '=', offerId).forNoKeyUpdate().executeTakeFirstOrThrow();
  const s = await scopeFor(ctx, tx, fx, position.id);
  const worker = await tx.selectFrom('worker').selectAll().where('id', '=', offer.worker_id).executeTakeFirstOrThrow();
  const reply = (body: string) => enqueueSms(tx, { workerId: worker.id, phone: worker.phone, offerId: offer.id, body });

  if (offer.status !== 'sent') return 'not_open';

  // Reply arrived after the deadline but before the tick processed it.
  if (offer.expires_at && offer.expires_at <= s.now) {
    await transitionOffer(s, offer, 'expire', {});
    await audit(tx, SYSTEM, 'offer.expired', 'offer', offer.id, { at: s.now, data: { late_reply: replyText } });
    await reply(T.expiredText(s.info, offer.code));
    await reconcileLocked(s, position);
    return 'expired';
  }

  if (answer === 'decline') {
    await transitionOffer(s, offer, 'decline', { replyText });
    await audit(tx, actor, 'offer.declined', 'offer', offer.id, {
      at: s.now,
      data: { position_id: position.id, worker_id: worker.id, reply: replyText },
    });
    await reply(T.declineAckText(s.info, offer.code));
    await reconcileLocked(s, position); // next candidate
    return 'declined';
  }

  // ---- accept
  if (position.filled_count >= position.quantity || position.status === 'cancelled') {
    await cancelOffer(s, offer, 'position_filled'); // texts "filled"
    return 'filled';
  }
  const job = await tx.selectFrom('job').selectAll().where('id', '=', position.job_id).executeTakeFirstOrThrow();
  const buffer = s.config.booking_buffer_minutes * 60_000;
  const padded = { start: new Date(job.starts_at.getTime() - buffer), end: new Date(job.est_end_at.getTime() + buffer) };
  const bookings = await tx
    .selectFrom('booking')
    .selectAll()
    .where('worker_id', '=', worker.id)
    .where('cancelled_at', 'is', null)
    .execute();
  const conflict = bookings.some((b) => b.job_id === job.id || overlaps({ start: b.starts_at, end: b.ends_at }, padded));
  if (conflict || !worker.active) {
    await transitionOffer(s, offer, 'cancel', { cancelReason: 'conflict' });
    await audit(tx, SYSTEM, 'offer.cancelled', 'offer', offer.id, {
      at: s.now,
      reason: conflict ? 'conflict' : 'worker_inactive',
      data: { reply: replyText },
    });
    await reply(T.conflictText(s.info, offer.code));
    await reconcileLocked(s, position);
    return 'conflict';
  }

  await transitionOffer(s, offer, 'accept', { replyText });
  await tx
    .insertInto('booking')
    .values({
      worker_id: worker.id,
      job_id: job.id,
      position_id: position.id,
      offer_id: offer.id,
      starts_at: job.starts_at,
      ends_at: job.est_end_at,
      cancelled_at: null,
      cancel_reason: null,
    })
    .execute();
  position = await tx
    .updateTable('position')
    .set((eb) => ({ filled_count: eb('filled_count', '+', 1), updated_at: s.now }))
    .where('id', '=', position.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(tx, actor, 'offer.accepted', 'offer', offer.id, {
    at: s.now,
    data: { position_id: position.id, worker_id: worker.id, reply: replyText, filled: `${position.filled_count}/${position.quantity}` },
  });
  await reply(T.confirmText(s.info, offer.code));
  fx.cancelConflicts.push({ workerId: worker.id, acceptedOfferId: offer.id });
  await reconcileLocked(s, position);
  return 'accepted';
}

/** Late-reply text for an offer that is no longer open. */
export function closedOfferText(info: CallInfo, offer: Offer, answer: 'accept' | 'decline'): string {
  switch (offer.status) {
    case 'expired':
      return T.expiredText(info, offer.code);
    case 'accepted':
      return T.alreadyAcceptedText(info, offer.code);
    case 'declined':
      return T.alreadyDeclinedText(info, offer.code);
    case 'cancelled':
      return offer.cancel_reason === 'position_filled' ? T.filledText(info, offer.code) : T.withdrawnText(info, offer.code);
    default:
      return answer === 'accept' ? T.expiredText(info, offer.code) : T.withdrawnText(info, offer.code);
  }
}

// ------------------------------------------------------------------ cross-position helpers

/** Cancels every open offer for a worker (opt-out, deactivation); each position in its own lock. */
export async function cancelOpenOffersForWorker(
  ctx: AppContext,
  tx: Tx,
  fx: Effects,
  workerId: number,
  reason: CancelReason,
  actor: Actor,
): Promise<void> {
  const offers = await tx
    .selectFrom('offer')
    .select(['id', 'position_id'])
    .where('worker_id', '=', workerId)
    .where('status', 'in', ['queued', 'sent'])
    .orderBy('position_id')
    .execute();
  for (const o of offers) {
    const position = await lockPosition(tx, o.position_id);
    const offer = await tx.selectFrom('offer').selectAll().where('id', '=', o.id).forNoKeyUpdate().executeTakeFirstOrThrow();
    if (offer.status !== 'queued' && offer.status !== 'sent') continue;
    const s = await scopeFor(ctx, tx, fx, position.id);
    await cancelOffer(s, offer, reason, actor);
    fx.reconcile.add(position.id);
  }
}

export async function withPositionScope<T>(
  ctx: AppContext,
  tx: Tx,
  fx: Effects,
  positionId: number,
  fn: (s: Scope, position: Position) => Promise<T>,
): Promise<T> {
  const position = await lockPosition(tx, positionId);
  return fn(await scopeFor(ctx, tx, fx, positionId), position);
}

/** After an accept: withdraw the worker's other open offers that now overlap (or are on the same job). */
async function cancelConflictingOffers(ctx: AppContext, workerId: number, acceptedOfferId: number): Promise<void> {
  const accepted = await ctx.db
    .selectFrom('offer')
    .innerJoin('position', 'position.id', 'offer.position_id')
    .innerJoin('job', 'job.id', 'position.job_id')
    .select(['job.id as job_id', 'job.starts_at', 'job.est_end_at'])
    .where('offer.id', '=', acceptedOfferId)
    .executeTakeFirstOrThrow();
  const config = await getConfig(ctx.db);
  const buffer = config.booking_buffer_minutes * 60_000;
  const others = await ctx.db
    .selectFrom('offer')
    .innerJoin('position', 'position.id', 'offer.position_id')
    .innerJoin('job', 'job.id', 'position.job_id')
    .select(['offer.id', 'offer.position_id', 'job.id as job_id', 'job.starts_at', 'job.est_end_at'])
    .where('offer.worker_id', '=', workerId)
    .where('offer.status', 'in', ['queued', 'sent'])
    .where('offer.id', '<>', acceptedOfferId)
    .execute();
  const padded = { start: new Date(accepted.starts_at.getTime() - buffer), end: new Date(accepted.est_end_at.getTime() + buffer) };
  for (const o of others) {
    if (o.job_id !== accepted.job_id && !overlaps({ start: o.starts_at, end: o.est_end_at }, padded)) continue;
    await inTx(ctx, async (tx, fx) => {
      await withPositionScope(ctx, tx, fx, o.position_id, async (s, position) => {
        const offer = await tx.selectFrom('offer').selectAll().where('id', '=', o.id).forNoKeyUpdate().executeTakeFirstOrThrow();
        if (offer.status !== 'queued' && offer.status !== 'sent') return;
        await cancelOffer(s, offer, 'conflict');
        await reconcileLocked(s, position);
      });
    });
  }
}

registerEffectRunner(async (ctx, fx) => {
  for (const c of fx.cancelConflicts) {
    try {
      await cancelConflictingOffers(ctx, c.workerId, c.acceptedOfferId);
    } catch (err) {
      ctx.log.error('cancelConflictingOffers failed', err);
    }
  }
  for (const id of fx.reconcile) {
    try {
      await reconcilePosition(ctx, id);
    } catch (err) {
      ctx.log.error(`reconcile ${id} failed`, err);
    }
  }
  for (const w of fx.wakeups) {
    try {
      await ctx.scheduler.wakeAt(w.positionId, w.at);
    } catch (err) {
      ctx.log.warn('could not schedule wake-up (tick will catch it)', err);
    }
  }
  try {
    await flushOutbox(ctx);
  } catch (err) {
    ctx.log.error('outbox flush failed', err);
  }
});
