import { describe, expect, it } from 'vitest';
import {
  blockingReasons,
  compareCandidates,
  exclusionReasons,
  selectCandidates,
  type SelectionContext,
  type WorkerFacts,
} from '../../src/domain/selection.js';

const RIGGING = 1;
const CARPENTRY = 2;
const LOAD_IN = 10;
const SHOW_CALL = 11;
const ARENA = 20;
const THEATER = 21;

const d = (s: string) => new Date(s);

const ctx: SelectionContext = {
  job: { id: 100, venueId: ARENA, jobTypeId: LOAD_IN, startsAt: d('2026-11-21T13:00:00Z'), endsAt: d('2026-11-21T21:00:00Z') },
  position: { id: 500, skillId: RIGGING },
  bufferMinutes: 0,
};

let nextId = 1;
function worker(over: Partial<WorkerFacts> = {}): WorkerFacts {
  const id = over.id ?? nextId++;
  return {
    id,
    firstName: 'W',
    lastName: `Worker${id}`,
    tranche: 1,
    startDate: '2010-01-01',
    active: true,
    smsOptOut: false,
    skillIds: [RIGGING],
    refusedJobTypeIds: [],
    refusedVenueIds: [],
    unavailability: [],
    bookings: [],
    openOffers: [],
    ...over,
  };
}

describe('exclusionReasons', () => {
  it('accepts a fully eligible worker', () => {
    expect(exclusionReasons(worker(), ctx)).toEqual([]);
  });

  it.each([
    ['inactive', { active: false }],
    ['opted_out', { smsOptOut: true }],
    ['missing_skill', { skillIds: [CARPENTRY] }],
    ['refused_job_type', { refusedJobTypeIds: [LOAD_IN] }],
    ['refused_venue', { refusedVenueIds: [ARENA] }],
  ] as const)('excludes for %s', (reason, over) => {
    expect(exclusionReasons(worker(over), ctx)).toEqual([reason]);
  });

  it('ignores refusals of other job types and venues', () => {
    expect(exclusionReasons(worker({ refusedJobTypeIds: [SHOW_CALL], refusedVenueIds: [THEATER] }), ctx)).toEqual([]);
  });

  it('reports every failing reason, not just the first', () => {
    const w = worker({ active: false, smsOptOut: true, skillIds: [], refusedVenueIds: [ARENA] });
    expect(exclusionReasons(w, ctx)).toEqual(['inactive', 'opted_out', 'missing_skill', 'refused_venue']);
  });

  describe('availability', () => {
    it('excludes when an unavailability block overlaps the call', () => {
      const w = worker({ unavailability: [{ start: d('2026-11-21T20:00:00Z'), end: d('2026-11-22T02:00:00Z') }] });
      expect(exclusionReasons(w, ctx)).toEqual(['unavailable']);
    });

    it('treats touching intervals as non-overlapping', () => {
      const w = worker({ unavailability: [{ start: d('2026-11-21T21:00:00Z'), end: d('2026-11-21T23:00:00Z') }] });
      expect(exclusionReasons(w, ctx)).toEqual([]);
    });

    it('excludes when an accepted call on another job overlaps', () => {
      const w = worker({
        bookings: [{ jobId: 99, positionId: 1, start: d('2026-11-21T08:00:00Z'), end: d('2026-11-21T14:00:00Z') }],
      });
      expect(exclusionReasons(w, ctx)).toEqual(['double_booked']);
    });

    it('applies the booking buffer', () => {
      const w = worker({
        bookings: [{ jobId: 99, positionId: 1, start: d('2026-11-21T09:00:00Z'), end: d('2026-11-21T12:30:00Z') }],
      });
      expect(exclusionReasons(w, ctx)).toEqual([]);
      expect(exclusionReasons(w, { ...ctx, bufferMinutes: 60 })).toEqual(['double_booked']);
    });

    it('does not block on open offers for other overlapping jobs (first YES wins)', () => {
      const w = worker({ openOffers: [{ jobId: 99, positionId: 7 }] });
      expect(exclusionReasons(w, ctx)).toEqual([]);
    });
  });

  describe('already on this job', () => {
    it('excludes a worker holding another position on the job', () => {
      const w = worker({ bookings: [{ jobId: 100, positionId: 501, start: ctx.job.startsAt, end: ctx.job.endsAt }] });
      expect(exclusionReasons(w, ctx)).toEqual(['already_on_job']);
    });

    it('excludes a worker with an open offer for another position on the job', () => {
      const w = worker({ openOffers: [{ jobId: 100, positionId: 501 }] });
      expect(exclusionReasons(w, ctx)).toEqual(['already_on_job']);
    });

    it('does not count an open offer for this same position', () => {
      const w = worker({ openOffers: [{ jobId: 100, positionId: 500 }] });
      expect(exclusionReasons(w, ctx)).toEqual([]);
    });
  });
});

describe('selectCandidates ordering', () => {
  it('sorts by tranche, then seniority, then last name, then id', () => {
    const ws = [
      worker({ id: 1, tranche: 2, startDate: '2000-01-01', lastName: 'Adams' }),
      worker({ id: 2, tranche: 1, startDate: '2015-06-01', lastName: 'Baker' }),
      worker({ id: 3, tranche: 1, startDate: '2012-03-04', lastName: 'Young' }),
      worker({ id: 4, tranche: 1, startDate: '2012-03-04', lastName: 'Clark' }),
      worker({ id: 6, tranche: 1, startDate: '2012-03-04', lastName: 'clark' }),
      worker({ id: 5, tranche: 1, startDate: '2012-03-04', lastName: 'Clark' }),
      worker({ id: 7, tranche: 3, startDate: '1990-01-01', lastName: 'Zed' }),
    ];
    const { ranked } = selectCandidates(ws, ctx);
    expect(ranked.map((w) => w.id)).toEqual([4, 5, 6, 3, 2, 1, 7]);
  });

  it('is deterministic regardless of input order', () => {
    const ws = Array.from({ length: 40 }, (_, i) =>
      worker({ id: i + 1, tranche: (i % 3) + 1, startDate: `20${10 + (i % 5)}-01-01`, lastName: ['A', 'B'][i % 2] }),
    );
    const a = selectCandidates(ws, ctx).ranked.map((w) => w.id);
    const b = selectCandidates([...ws].reverse(), ctx).ranked.map((w) => w.id);
    expect(a).toEqual(b);
  });

  it('separates eligible and excluded workers with reasons', () => {
    const ws = [worker({ id: 1 }), worker({ id: 2, skillIds: [] }), worker({ id: 3, refusedVenueIds: [ARENA] })];
    const res = selectCandidates(ws, ctx);
    expect(res.ranked.map((w) => w.id)).toEqual([1]);
    expect(res.excluded).toEqual([
      { workerId: 2, reasons: ['missing_skill'] },
      { workerId: 3, reasons: ['refused_venue'] },
    ]);
  });

  it('handles an empty roster', () => {
    expect(selectCandidates([], ctx)).toEqual({ ranked: [], excluded: [] });
  });

  it('compareCandidates is antisymmetric', () => {
    const a = worker({ id: 1, tranche: 1 });
    const b = worker({ id: 2, tranche: 1 });
    expect(Math.sign(compareCandidates(a, b))).toBe(-Math.sign(compareCandidates(b, a)));
  });
});

describe('blockingReasons (dispatch-time recheck)', () => {
  it('lets a Steward override soft reasons on a manual entry but never hard ones', () => {
    const soft = worker({ skillIds: [], refusedVenueIds: [ARENA] });
    expect(blockingReasons(soft, ctx, true)).toEqual([]);
    expect(blockingReasons(soft, ctx, false)).toEqual(['missing_skill', 'refused_venue']);
    const hard = worker({ skillIds: [], smsOptOut: true });
    expect(blockingReasons(hard, ctx, true)).toEqual(['opted_out']);
  });
});
