import { sql } from 'kysely';
import type { Executor } from '../db/kysely.js';
import { audit } from './audit.js';
import { SYSTEM, type AppContext } from './context.js';

const MAX_ATTEMPTS = 5;

/**
 * Transactional outbox: texts are written in the same transaction as the state
 * change that causes them and sent only after commit. A rolled-back accept can
 * never have sent a confirmation, and a crash after commit is retried by the tick.
 */
export async function enqueueSms(
  ex: Executor,
  msg: { workerId: number | null; phone: string; body: string; offerId?: number | null; notBefore?: Date },
): Promise<void> {
  await ex
    .insertInto('sms_message')
    .values({
      direction: 'outbound',
      worker_id: msg.workerId,
      phone: msg.phone,
      body: msg.body,
      offer_id: msg.offerId ?? null,
      status: 'pending',
      not_before: msg.notBefore ?? new Date(0),
      provider_sid: null,
      error: null,
      sent_at: null,
    })
    .execute();
}

/** Sends due outbound texts. Safe to call concurrently (rows are claimed with SKIP LOCKED). */
export async function flushOutbox(ctx: AppContext): Promise<number> {
  const now = ctx.clock.now();
  let sentCount = 0;
  for (;;) {
    const batch = await ctx.db
      .updateTable('sms_message')
      // not_before doubles as the claim time while 'sending' (see recoverStuckSends)
      .set({ status: 'sending', attempts: sql`attempts + 1`, not_before: now })
      .where(
        'id',
        'in',
        ctx.db
          .selectFrom('sms_message')
          .select('id')
          .where('status', '=', 'pending')
          .where('direction', '=', 'outbound')
          .where('not_before', '<=', now)
          .orderBy('id')
          .limit(25)
          .forNoKeyUpdate()
          .skipLocked(),
      )
      .returningAll()
      .execute();
    if (batch.length === 0) break;

    for (const m of batch.sort((a, b) => a.id - b.id)) {
      // Never text a worker who has opted out (carrier rules), even if queued earlier.
      if (m.worker_id) {
        const w = await ctx.db.selectFrom('worker').select('sms_opt_out').where('id', '=', m.worker_id).executeTakeFirst();
        if (w?.sms_opt_out) {
          await ctx.db.updateTable('sms_message').set({ status: 'skipped', error: 'worker opted out' }).where('id', '=', m.id).execute();
          continue;
        }
      }
      try {
        const res = await ctx.sms.send({ to: m.phone, body: m.body });
        await ctx.db
          .updateTable('sms_message')
          .set({ status: 'sent', provider_sid: res.providerSid, sent_at: ctx.clock.now(), error: null })
          .where('id', '=', m.id)
          .execute();
        await audit(ctx.db, SYSTEM, 'sms.sent', 'sms_message', m.id, {
          at: ctx.clock.now(),
          data: { to: m.phone, worker_id: m.worker_id, offer_id: m.offer_id, body: m.body, sid: res.providerSid },
        });
        sentCount++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const giveUp = m.attempts >= MAX_ATTEMPTS;
        await ctx.db
          .updateTable('sms_message')
          .set({
            status: giveUp ? 'failed' : 'pending',
            error: message,
            // simple backoff: 1, 2, 4, 8 minutes
            not_before: new Date(now.getTime() + 60_000 * 2 ** (m.attempts - 1)),
          })
          .where('id', '=', m.id)
          .execute();
        await audit(ctx.db, SYSTEM, giveUp ? 'sms.failed' : 'sms.retry', 'sms_message', m.id, {
          at: ctx.clock.now(),
          data: { to: m.phone, error: message, attempts: m.attempts },
        });
        ctx.log.error(`SMS to ${m.phone} failed (attempt ${m.attempts}): ${message}`);
      }
    }
  }
  return sentCount;
}

/** Rows stuck in 'sending' (process crashed mid-send) are retried after 5 minutes. */
export async function recoverStuckSends(ctx: AppContext): Promise<void> {
  const cutoff = new Date(ctx.clock.now().getTime() - 5 * 60_000);
  await ctx.db
    .updateTable('sms_message')
    .set({ status: 'pending' })
    .where('status', '=', 'sending')
    .where('not_before', '<', cutoff)
    .where('sent_at', 'is', null)
    .execute();
}
