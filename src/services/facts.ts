
import type { Executor } from '../db/kysely.js';
import type { SelectionContext, WorkerFacts } from '../domain/selection.js';
import type { AppConfig, Job, Position } from '../db/types.js';
import type { CallInfo } from '../sms/templates.js';

export function selectionContext(job: Job, position: Position, config: AppConfig): SelectionContext {
  return {
    job: { id: job.id, venueId: job.venue_id, jobTypeId: job.job_type_id, startsAt: job.starts_at, endsAt: job.est_end_at },
    position: { id: position.id, skillId: position.skill_id },
    bufferMinutes: config.booking_buffer_minutes,
  };
}

/**
 * Loads everything the pure selection function needs, scoped to the job's time window
 * (plus buffer). Pass workerIds to load a subset (dispatch-time rechecks).
 */
export async function loadWorkerFacts(
  ex: Executor,
  ctx: SelectionContext,
  workerIds?: number[],
): Promise<WorkerFacts[]> {
  if (workerIds && workerIds.length === 0) return [];
  const ms = ctx.bufferMinutes * 60_000;
  const winStart = new Date(ctx.job.startsAt.getTime() - ms);
  const winEnd = new Date(ctx.job.endsAt.getTime() + ms);

  let wq = ex.selectFrom('worker').selectAll();
  if (workerIds) wq = wq.where('id', 'in', workerIds);
  const workers = await wq.execute();
  if (workers.length === 0) return [];
  const ids = workers.map((w) => w.id);

  const [skills, refusals, unavail, bookings, offers] = await Promise.all([
    ex.selectFrom('worker_skill').selectAll().where('worker_id', 'in', ids).execute(),
    ex.selectFrom('worker_refusal').selectAll().where('worker_id', 'in', ids).execute(),
    ex
      .selectFrom('worker_unavailability')
      .selectAll()
      .where('worker_id', 'in', ids)
      .where('starts_at', '<', ctx.job.endsAt)
      .where('ends_at', '>', ctx.job.startsAt)
      .execute(),
    ex
      .selectFrom('booking')
      .selectAll()
      .where('worker_id', 'in', ids)
      .where('cancelled_at', 'is', null)
      .where((eb) =>
        eb.or([eb('job_id', '=', ctx.job.id), eb.and([eb('starts_at', '<', winEnd), eb('ends_at', '>', winStart)])]),
      )
      .execute(),
    ex
      .selectFrom('offer')
      .innerJoin('position', 'position.id', 'offer.position_id')
      .select(['offer.worker_id', 'offer.position_id', 'position.job_id'])
      .where('offer.worker_id', 'in', ids)
      .where('offer.status', 'in', ['queued', 'sent'])
      .where('position.job_id', '=', ctx.job.id)
      .execute(),
  ]);

  const group = <T extends { worker_id: number }>(rows: T[]) => {
    const m = new Map<number, T[]>();
    for (const r of rows) m.set(r.worker_id, [...(m.get(r.worker_id) ?? []), r]);
    return m;
  };
  const gs = group(skills);
  const gr = group(refusals);
  const gu = group(unavail);
  const gb = group(bookings);
  const go = group(offers);

  return workers.map((w) => ({
    id: w.id,
    firstName: w.first_name,
    lastName: w.last_name,
    tranche: w.tranche,
    startDate: w.start_date,
    active: w.active,
    smsOptOut: w.sms_opt_out,
    skillIds: (gs.get(w.id) ?? []).map((s) => s.skill_id),
    refusedJobTypeIds: (gr.get(w.id) ?? []).filter((r) => r.job_type_id !== null).map((r) => r.job_type_id!),
    refusedVenueIds: (gr.get(w.id) ?? []).filter((r) => r.venue_id !== null).map((r) => r.venue_id!),
    unavailability: (gu.get(w.id) ?? []).map((u) => ({ start: u.starts_at, end: u.ends_at })),
    bookings: (gb.get(w.id) ?? []).map((b) => ({ jobId: b.job_id, positionId: b.position_id, start: b.starts_at, end: b.ends_at })),
    openOffers: (go.get(w.id) ?? []).map((o) => ({ jobId: o.job_id, positionId: o.position_id })),
  }));
}

export async function loadCallInfo(ex: Executor, positionId: number, config: AppConfig): Promise<CallInfo> {
  const row = await ex
    .selectFrom('position')
    .innerJoin('job', 'job.id', 'position.job_id')
    .innerJoin('venue', 'venue.id', 'job.venue_id')
    .innerJoin('job_type', 'job_type.id', 'job.job_type_id')
    .innerJoin('skill', 'skill.id', 'position.skill_id')
    .select([
      'venue.name as venue',
      'job_type.name as jobType',
      'skill.name as skill',
      'job.starts_at as startsAt',
      'job.est_end_at as endsAt',
    ])
    .where('position.id', '=', positionId)
    .executeTakeFirstOrThrow();
  return { ...row, smsPrefix: config.sms_prefix, timezone: config.timezone };
}

export async function lockPosition(ex: Executor, positionId: number): Promise<Position> {
  const p = await ex.selectFrom('position').selectAll().where('id', '=', positionId).forNoKeyUpdate().executeTakeFirst();
  if (!p) throw new Error(`position ${positionId} not found`);
  return p;
}

/** Ensures a row exists then locks it (used where lock ordering matters). */
export async function lockWorker(ex: Executor, workerId: number) {
  return ex.selectFrom('worker').selectAll().where('id', '=', workerId).forNoKeyUpdate().executeTakeFirstOrThrow();
}

