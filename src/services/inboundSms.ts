import { sql } from 'kysely';
import type { Offer } from '../db/types.js';
import { parseReply } from '../domain/replyParser.js';
import * as T from '../sms/templates.js';
import { audit } from './audit.js';
import { getConfig } from './config.js';
import { inTx, type Actor, type AppContext } from './context.js';
import { loadCallInfo, lockWorker } from './facts.js';
import { cancelOpenOffersForWorker, closedOfferText, respondToOffer } from './offerEngine.js';
import { enqueueSms } from './outbox.js';

export interface InboundSms {
  from: string; // E.164
  body: string;
  providerSid: string;
}

export type InboundResult =
  | 'duplicate'
  | 'unknown_sender'
  | 'opted_out'
  | 'opted_in'
  | 'ignored_opted_out'
  | 'help'
  | 'accepted'
  | 'declined'
  | 'expired'
  | 'filled'
  | 'conflict'
  | 'closed'
  | 'no_open_offers'
  | 'ambiguous'
  | 'unknown_code'
  | 'unrecognized';

/**
 * Handles one inbound text. Idempotent: the provider message SID is stored with a
 * unique constraint in the same transaction, so a webhook retry is a no-op.
 */
export async function handleInboundSms(ctx: AppContext, msg: InboundSms): Promise<InboundResult> {
  return inTx(ctx, async (tx, fx) => {
    const now = ctx.clock.now();
    const worker = await tx.selectFrom('worker').selectAll().where('phone', '=', msg.from).executeTakeFirst();
    const inserted = await tx
      .insertInto('sms_message')
      .values({
        direction: 'inbound',
        worker_id: worker?.id ?? null,
        phone: msg.from,
        body: msg.body,
        offer_id: null,
        provider_sid: msg.providerSid,
        status: 'received',
        not_before: now,
        error: null,
        sent_at: null,
      })
      .onConflict((oc) => oc.column('provider_sid').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!inserted) return 'duplicate';

    const actor: Actor = worker
      ? { type: 'worker', id: worker.id, label: `${worker.first_name} ${worker.last_name}` }
      : { type: 'system', label: `unknown ${msg.from}` };
    await audit(tx, actor, 'sms.received', 'sms_message', inserted.id, {
      at: now,
      data: { from: msg.from, body: msg.body, sid: msg.providerSid, worker_id: worker?.id ?? null },
    });
    if (!worker) return 'unknown_sender';

    await lockWorker(tx, worker.id); // worker → position → offer lock order
    const config = await getConfig(tx);
    const reply = (body: string, offerId: number | null = null) =>
      enqueueSms(tx, { workerId: worker.id, phone: worker.phone, body, offerId });
    const parsed = parseReply(msg.body);

    // --- carrier keywords. Twilio's own opt-out handling sends the STOP/START confirmations,
    // so we record state but do not send a duplicate reply.
    if (parsed.kind === 'opt_out') {
      if (!worker.sms_opt_out) {
        await tx.updateTable('worker').set({ sms_opt_out: true, opt_out_at: now, updated_at: now }).where('id', '=', worker.id).execute();
        await audit(tx, actor, 'worker.opted_out', 'worker', worker.id, { at: now, data: { keyword: msg.body.trim() } });
        await cancelOpenOffersForWorker(ctx, tx, fx, worker.id, 'opted_out', actor);
      }
      return 'opted_out';
    }
    const reSubscribe = parsed.kind === 'opt_in' || (worker.sms_opt_out && parsed.kind === 'accept' && parsed.code === null);
    if (reSubscribe) {
      if (worker.sms_opt_out) {
        await tx.updateTable('worker').set({ sms_opt_out: false, opt_out_at: null, updated_at: now }).where('id', '=', worker.id).execute();
        await audit(tx, actor, 'worker.opted_in', 'worker', worker.id, { at: now, data: { keyword: msg.body.trim() } });
      }
      return 'opted_in';
    }
    if (worker.sms_opt_out) return 'ignored_opted_out'; // we may not text them back

    const openOffers = await tx
      .selectFrom('offer')
      .selectAll()
      .where('worker_id', '=', worker.id)
      .where('status', '=', 'sent')
      .orderBy('sent_at')
      .execute();
    const openCodes = openOffers.map((o) => o.code);

    if (parsed.kind === 'help') {
      await reply(T.helpText(config.sms_prefix, openCodes));
      return 'help';
    }
    if (parsed.kind === 'unknown') {
      await reply(T.helpText(config.sms_prefix, openCodes)); // offers stay open
      return 'unrecognized';
    }

    // --- YES / NO
    let offer: Offer | undefined;
    if (parsed.code) {
      offer = await tx
        .selectFrom('offer')
        .selectAll()
        .where('worker_id', '=', worker.id)
        .where('code', '=', parsed.code)
        .where('status', '<>', 'queued') // a queued offer's code was never sent
        .orderBy(sql`CASE WHEN status = 'sent' THEN 0 ELSE 1 END`)
        .orderBy('created_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (!offer) {
        await reply(T.unknownCodeText(config.sms_prefix, parsed.code, openCodes));
        return 'unknown_code';
      }
    } else if (openOffers.length === 1) {
      offer = openOffers[0];
    } else if (openOffers.length === 0) {
      await reply(T.noOpenOffersText(config.sms_prefix));
      return 'no_open_offers';
    } else {
      await reply(T.helpText(config.sms_prefix, openCodes));
      return 'ambiguous';
    }

    if (offer.status !== 'sent') {
      const info = await loadCallInfo(tx, offer.position_id, config);
      await reply(closedOfferText(info, offer, parsed.kind), offer.id);
      await audit(tx, actor, 'offer.late_reply', 'offer', offer.id, { at: now, data: { status: offer.status, body: msg.body } });
      return 'closed';
    }

    await tx.updateTable('sms_message').set({ offer_id: offer.id }).where('id', '=', inserted.id).execute();
    const outcome = await respondToOffer(ctx, tx, fx, offer.id, parsed.kind, msg.body, actor);
    if (outcome === 'not_open') return 'closed';
    return outcome;
  });
}
