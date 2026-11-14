import type { Tx } from '../db/kysely.js';
import type { CandidateList } from '../db/types.js';
import { describeReasons, exclusionReasons, OVERRIDABLE_REASONS, selectCandidates } from '../domain/selection.js';
import { canListTransition, nextListStatus } from '../domain/stateMachines.js';
import { audit } from './audit.js';
import { getConfig } from './config.js';
import { DomainError, inTx, type Actor, type AppContext } from './context.js';
import { loadWorkerFacts, lockPosition, selectionContext } from './facts.js';
import { cancelOffer, reconcileLocked, withPositionScope } from './offerEngine.js';

function requireReason(reason: string | undefined | null): string {
  const r = (reason ?? '').trim();
  if (r.length < 3) throw new DomainError('A reason is required for every change to a candidate list.');
  return r;
}

function requireSteward(actor: Actor): void {
  if (actor.type !== 'user' || actor.role !== 'steward') throw new DomainError('Only a Steward can approve candidate lists.', 403);
}

async function lockList(tx: Tx, listId: number): Promise<CandidateList> {
  const list = await tx.selectFrom('candidate_list').selectAll().where('id', '=', listId).executeTakeFirst();
  if (!list) throw new DomainError('Candidate list not found', 404);
  await lockPosition(tx, list.position_id); // position lock first (engine lock order)
  return tx.selectFrom('candidate_list').selectAll().where('id', '=', listId).forNoKeyUpdate().executeTakeFirstOrThrow();
}

/** Renumbers active (non-removed) entries 1..n preserving order. */
async function renumber(tx: Tx, listId: number): Promise<void> {
  const rows = await tx
    .selectFrom('candidate_entry')
    .select(['id', 'rank'])
    .where('list_id', '=', listId)
    .where('removed_at', 'is', null)
    .orderBy('rank')
    .orderBy('id')
    .execute();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].rank !== i + 1) await tx.updateTable('candidate_entry').set({ rank: i + 1 }).where('id', '=', rows[i].id).execute();
  }
}

/** Builds (or rebuilds) the draft list for a position using the pure selection function. */
export async function generateList(tx: Tx, positionId: number, actor: Actor): Promise<CandidateList> {
  const position = await lockPosition(tx, positionId);
  const job = await tx.selectFrom('job').selectAll().where('id', '=', position.job_id).executeTakeFirstOrThrow();
  const config = await getConfig(tx);
  let list = await tx.selectFrom('candidate_list').selectAll().where('position_id', '=', positionId).forNoKeyUpdate().executeTakeFirst();
  if (list && !canListTransition(list.status, 'regenerate')) {
    throw new DomainError(`Cannot regenerate a list that is ${list.status}.`, 409);
  }
  const ctx = selectionContext(job, position, config);
  const result = selectCandidates(await loadWorkerFacts(tx, ctx), ctx);

  if (!list) {
    list = await tx.insertInto('candidate_list').values({ position_id: positionId, approved_by: null, approved_at: null }).returningAll().executeTakeFirstOrThrow();
  } else {
    await tx.deleteFrom('candidate_entry').where('list_id', '=', list.id).execute();
    await tx.deleteFrom('candidate_exclusion').where('list_id', '=', list.id).execute();
    list = await tx
      .updateTable('candidate_list')
      .set({ status: 'draft', generated_at: new Date(), updated_at: new Date() })
      .where('id', '=', list.id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  if (result.ranked.length) {
    await tx
      .insertInto('candidate_entry')
      .values(result.ranked.map((w, i) => ({ list_id: list!.id, worker_id: w.id, rank: i + 1, removed_at: null, removed_reason: null, skipped_reasons: null })))
      .execute();
  }
  if (result.excluded.length) {
    await tx
      .insertInto('candidate_exclusion')
      .values(result.excluded.map((e) => ({ list_id: list!.id, worker_id: e.workerId, reasons: e.reasons })))
      .execute();
  }
  await audit(tx, actor, 'list.generated', 'candidate_list', list.id, {
    data: { position_id: positionId, ranked: result.ranked.length, excluded: result.excluded.length },
  });
  return list;
}

export async function regenerate(ctx: AppContext, listId: number, actor: Actor): Promise<void> {
  await inTx(ctx, async (tx) => {
    const list = await lockList(tx, listId);
    await generateList(tx, list.position_id, actor);
  });
}

export async function submitForApproval(ctx: AppContext, listId: number, actor: Actor): Promise<void> {
  await inTx(ctx, async (tx) => {
    const list = await lockList(tx, listId);
    const status = nextListStatus(list.status, 'submit');
    await tx.updateTable('candidate_list').set({ status, updated_at: new Date() }).where('id', '=', listId).execute();
    await audit(tx, actor, 'list.submitted', 'candidate_list', listId);
  });
}

/** Steward approval. This is the only path that lets texts go out for a position. */
export async function approve(ctx: AppContext, listId: number, actor: Actor, note?: string): Promise<void> {
  requireSteward(actor);
  await inTx(ctx, async (tx, fx) => {
    const list = await lockList(tx, listId);
    if (!canListTransition(list.status, 'approve')) throw new DomainError(`List is already ${list.status}.`, 409);
    const job = await tx
      .selectFrom('job')
      .innerJoin('position', 'position.job_id', 'job.id')
      .select(['job.status'])
      .where('position.id', '=', list.position_id)
      .executeTakeFirstOrThrow();
    if (job.status !== 'open') throw new DomainError('Job is not open.', 409);
    const count = await tx
      .selectFrom('candidate_entry')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('list_id', '=', listId)
      .where('removed_at', 'is', null)
      .executeTakeFirstOrThrow();
    const now = ctx.clock.now();
    await tx
      .updateTable('candidate_list')
      .set({ status: 'approved', approved_by: actor.type === 'user' ? actor.id : null, approved_at: now, updated_at: now })
      .where('id', '=', listId)
      .execute();
    await audit(tx, actor, 'list.approved', 'candidate_list', listId, {
      reason: note ?? null,
      data: { position_id: list.position_id, candidates: Number(count.n) },
    });
    await withPositionScope(ctx, tx, fx, list.position_id, (s, p) => reconcileLocked(s, p));
  });
}

export async function moveEntry(ctx: AppContext, entryId: number, newRank: number, reason: string, actor: Actor): Promise<void> {
  const why = requireReason(reason);
  await inTx(ctx, async (tx, fx) => {
    const entry = await tx.selectFrom('candidate_entry').selectAll().where('id', '=', entryId).executeTakeFirst();
    if (!entry || entry.removed_at) throw new DomainError('Entry not found', 404);
    const list = await lockList(tx, entry.list_id);
    if (list.status === 'cancelled' || list.status === 'filled') throw new DomainError(`List is ${list.status}.`, 409);
    const rows = await tx
      .selectFrom('candidate_entry')
      .select(['id'])
      .where('list_id', '=', list.id)
      .where('removed_at', 'is', null)
      .orderBy('rank')
      .execute();
    const ids = rows.map((r) => r.id).filter((id) => id !== entryId);
    const target = Math.max(1, Math.min(Math.trunc(newRank), ids.length + 1));
    ids.splice(target - 1, 0, entryId);
    for (let i = 0; i < ids.length; i++) await tx.updateTable('candidate_entry').set({ rank: i + 1 }).where('id', '=', ids[i]).execute();
    await audit(tx, actor, 'list.entry_moved', 'candidate_list', list.id, {
      reason: why,
      data: { entry_id: entryId, worker_id: entry.worker_id, from: entry.rank, to: target },
    });
    if (list.status === 'active' || list.status === 'exhausted') fx.reconcile.add(list.position_id);
  });
}

export async function removeEntry(ctx: AppContext, entryId: number, reason: string, actor: Actor): Promise<void> {
  const why = requireReason(reason);
  await inTx(ctx, async (tx, fx) => {
    const entry = await tx.selectFrom('candidate_entry').selectAll().where('id', '=', entryId).executeTakeFirst();
    if (!entry || entry.removed_at) throw new DomainError('Entry not found', 404);
    const list = await lockList(tx, entry.list_id);
    if (list.status === 'cancelled') throw new DomainError('List is cancelled.', 409);
    await tx.updateTable('candidate_entry').set({ removed_at: new Date(), removed_reason: why }).where('id', '=', entryId).execute();
    await renumber(tx, list.id);
    await audit(tx, actor, 'list.entry_removed', 'candidate_list', list.id, {
      reason: why,
      data: { entry_id: entryId, worker_id: entry.worker_id },
    });
    // Removing someone with an outstanding offer withdraws it and moves to the next person.
    await withPositionScope(ctx, tx, fx, list.position_id, async (s, position) => {
      const open = await tx
        .selectFrom('offer')
        .selectAll()
        .where('position_id', '=', position.id)
        .where('worker_id', '=', entry.worker_id)
        .where('status', 'in', ['queued', 'sent'])
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (open) await cancelOffer(s, open, 'removed_from_list', actor);
      await reconcileLocked(s, position);
    });
  });
}

/**
 * Hand-adds a worker. Hard exclusions (inactive, opted out, unavailable, double
 * booked, already on this job) always block. Soft ones (missing skill, refused venue
 * or job type) may be overridden by the Steward; the override is logged.
 */
export async function addEntry(
  ctx: AppContext,
  listId: number,
  workerId: number,
  rank: number | null,
  reason: string,
  actor: Actor,
  allowOverride = false,
): Promise<void> {
  const why = requireReason(reason);
  await inTx(ctx, async (tx, fx) => {
    const list = await lockList(tx, listId);
    if (list.status === 'cancelled' || list.status === 'filled') throw new DomainError(`List is ${list.status}.`, 409);
    const position = await tx.selectFrom('position').selectAll().where('id', '=', list.position_id).executeTakeFirstOrThrow();
    const job = await tx.selectFrom('job').selectAll().where('id', '=', position.job_id).executeTakeFirstOrThrow();
    const config = await getConfig(tx);
    const sctx = selectionContext(job, position, config);
    const [facts] = await loadWorkerFacts(tx, sctx, [workerId]);
    if (!facts) throw new DomainError('Worker not found', 404);
    const reasons = exclusionReasons(facts, sctx);
    const hard = reasons.filter((r) => !OVERRIDABLE_REASONS.has(r));
    if (hard.length) throw new DomainError(`Cannot add: ${describeReasons(hard)}.`, 409);
    if (reasons.length && !allowOverride) {
      throw new DomainError(`Worker is excluded (${describeReasons(reasons)}). Tick "override" to add anyway.`, 409);
    }
    const prior = await tx.selectFrom('offer').select('status').where('position_id', '=', position.id).where('worker_id', '=', workerId).executeTakeFirst();
    if (prior) throw new DomainError(`Worker already received an offer for this position (${prior.status}).`, 409);

    const existing = await tx.selectFrom('candidate_entry').selectAll().where('list_id', '=', listId).where('worker_id', '=', workerId).executeTakeFirst();
    if (existing && !existing.removed_at) throw new DomainError('Worker is already on this list.', 409);
    const count = await tx
      .selectFrom('candidate_entry')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('list_id', '=', listId)
      .where('removed_at', 'is', null)
      .executeTakeFirstOrThrow();
    const n = Number(count.n);
    const at = rank ? Math.max(1, Math.min(Math.trunc(rank), n + 1)) : n + 1;
    // shift down to make room
    await tx
      .updateTable('candidate_entry')
      .set((eb) => ({ rank: eb('rank', '+', 1) }))
      .where('list_id', '=', listId)
      .where('removed_at', 'is', null)
      .where('rank', '>=', at)
      .execute();
    if (existing) {
      await tx
        .updateTable('candidate_entry')
        .set({ rank: at, removed_at: null, removed_reason: null, source: 'manual', skipped_reasons: null })
        .where('id', '=', existing.id)
        .execute();
    } else {
      await tx
        .insertInto('candidate_entry')
        .values({ list_id: listId, worker_id: workerId, rank: at, source: 'manual', removed_at: null, removed_reason: null, skipped_reasons: null })
        .execute();
    }
    await tx.deleteFrom('candidate_exclusion').where('list_id', '=', listId).where('worker_id', '=', workerId).execute();
    await renumber(tx, listId);
    await audit(tx, actor, 'list.entry_added', 'candidate_list', listId, {
      reason: why,
      data: { worker_id: workerId, rank: at, overridden: reasons },
    });
    if (['active', 'exhausted', 'approved'].includes(list.status)) fx.reconcile.add(list.position_id);
  });
}
