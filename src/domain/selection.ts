/**
 * Candidate selection: a pure function with no I/O. Callers load the facts,
 * this module decides who is eligible and in what order.
 */

export interface Interval {
  start: Date;
  end: Date;
}

export interface WorkerFacts {
  id: number;
  firstName: string;
  lastName: string;
  tranche: number;
  /** Seniority date, 'YYYY-MM-DD'. Earlier = more senior. */
  startDate: string;
  active: boolean;
  smsOptOut: boolean;
  skillIds: number[];
  refusedJobTypeIds: number[];
  refusedVenueIds: number[];
  /** Blocked-out time the worker entered. */
  unavailability: Interval[];
  /** Accepted (non-cancelled) calls, any job. */
  bookings: (Interval & { jobId: number; positionId: number })[];
  /** Open (queued/sent) offers, any job. */
  openOffers: { jobId: number; positionId: number }[];
}

export interface SelectionContext {
  job: { id: number; venueId: number; jobTypeId: number; startsAt: Date; endsAt: Date };
  position: { id: number; skillId: number };
  /** Minimum gap required between this call and any other accepted call. */
  bufferMinutes: number;
}

export const EXCLUSION_REASONS = {
  inactive: 'Inactive',
  opted_out: 'Opted out of SMS',
  missing_skill: 'Missing required skill',
  refused_job_type: 'Refuses this job type',
  refused_venue: 'Refuses this venue',
  unavailable: 'Marked unavailable',
  double_booked: 'Booked on an overlapping call',
  already_on_job: 'Already holding or offered a position on this job',
} as const;

export type ExclusionReason = keyof typeof EXCLUSION_REASONS;

/** Reasons a Steward may override when hand-adding a worker (the worker can still be reached and is free). */
export const OVERRIDABLE_REASONS: ReadonlySet<ExclusionReason> = new Set(['missing_skill', 'refused_job_type', 'refused_venue']);

export interface Exclusion {
  workerId: number;
  reasons: ExclusionReason[];
}

export interface SelectionResult {
  ranked: WorkerFacts[];
  excluded: Exclusion[];
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

function widen(i: Interval, minutes: number): Interval {
  const ms = minutes * 60_000;
  return { start: new Date(i.start.getTime() - ms), end: new Date(i.end.getTime() + ms) };
}

/**
 * Every reason this worker cannot be offered this position (empty array = eligible).
 * All failing checks are reported, not just the first, so the Steward sees the full picture.
 */
export function exclusionReasons(w: WorkerFacts, ctx: SelectionContext): ExclusionReason[] {
  const reasons: ExclusionReason[] = [];
  const call: Interval = { start: ctx.job.startsAt, end: ctx.job.endsAt };

  if (!w.active) reasons.push('inactive');
  if (w.smsOptOut) reasons.push('opted_out');
  if (!w.skillIds.includes(ctx.position.skillId)) reasons.push('missing_skill');
  if (w.refusedJobTypeIds.includes(ctx.job.jobTypeId)) reasons.push('refused_job_type');
  if (w.refusedVenueIds.includes(ctx.job.venueId)) reasons.push('refused_venue');
  if (w.unavailability.some((u) => overlaps(u, call))) reasons.push('unavailable');

  const padded = widen(call, ctx.bufferMinutes);
  if (w.bookings.some((b) => b.jobId !== ctx.job.id && overlaps(b, padded))) reasons.push('double_booked');

  const onJob =
    w.bookings.some((b) => b.jobId === ctx.job.id) ||
    w.openOffers.some((o) => o.jobId === ctx.job.id && o.positionId !== ctx.position.id);
  if (onJob) reasons.push('already_on_job');

  return reasons;
}

/** Tranche ascending, then seniority (start_date ascending), then last name, then id. */
export function compareCandidates(a: WorkerFacts, b: WorkerFacts): number {
  if (a.tranche !== b.tranche) return a.tranche - b.tranche;
  if (a.startDate !== b.startDate) return a.startDate < b.startDate ? -1 : 1;
  const ln = a.lastName.localeCompare(b.lastName, 'en', { sensitivity: 'base' });
  if (ln !== 0) return ln;
  return a.id - b.id;
}

export function selectCandidates(workers: readonly WorkerFacts[], ctx: SelectionContext): SelectionResult {
  const ranked: WorkerFacts[] = [];
  const excluded: Exclusion[] = [];
  for (const w of workers) {
    const reasons = exclusionReasons(w, ctx);
    if (reasons.length === 0) ranked.push(w);
    else excluded.push({ workerId: w.id, reasons });
  }
  ranked.sort(compareCandidates);
  excluded.sort((a, b) => a.workerId - b.workerId);
  return { ranked, excluded };
}

/**
 * Re-check run immediately before an offer is texted (lists can go stale between
 * approval and sending). Manually-added entries may carry an override for the
 * soft reasons; hard reasons (opted out, double booked, ...) always block.
 */
export function blockingReasons(w: WorkerFacts, ctx: SelectionContext, allowOverride: boolean): ExclusionReason[] {
  const reasons = exclusionReasons(w, ctx);
  return allowOverride ? reasons.filter((r) => !OVERRIDABLE_REASONS.has(r)) : reasons;
}

export function describeReasons(reasons: readonly string[]): string {
  return reasons.map((r) => EXCLUSION_REASONS[r as ExclusionReason] ?? r).join('; ');
}
