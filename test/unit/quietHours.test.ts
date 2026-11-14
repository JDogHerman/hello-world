import { describe, expect, it } from 'vitest';
import { addActiveMinutes, isQuiet, quietEnd, type QuietHours } from '../../src/domain/quietHours.js';

const NY = 'America/New_York';
const q: QuietHours = { start: '21:00', end: '08:00', timezone: NY };
// 2026-11-14 is after the DST change (EST, UTC-5).
const ny = (local: string) => new Date(`${local}-05:00`);

describe('isQuiet', () => {
  it.each([
    ['2026-11-14T20:59:00', false],
    ['2026-11-14T21:00:00', true],
    ['2026-11-14T23:30:00', true],
    ['2026-11-15T03:00:00', true],
    ['2026-11-15T07:59:00', true],
    ['2026-11-15T08:00:00', false],
    ['2026-11-15T12:00:00', false],
  ])('%s -> %s', (t, expected) => {
    expect(isQuiet(ny(t), q)).toBe(expected);
  });

  it('supports a same-day window', () => {
    const lunch: QuietHours = { start: '12:00', end: '13:00', timezone: NY };
    expect(isQuiet(ny('2026-11-14T12:30:00'), lunch)).toBe(true);
    expect(isQuiet(ny('2026-11-14T13:30:00'), lunch)).toBe(false);
  });

  it('start == end disables quiet hours', () => {
    expect(isQuiet(ny('2026-11-14T03:00:00'), { start: '00:00', end: '00:00', timezone: NY })).toBe(false);
  });
});

describe('quietEnd', () => {
  it('returns the next 08:00 when inside quiet hours', () => {
    expect(quietEnd(ny('2026-11-14T22:00:00'), q)).toEqual(ny('2026-11-15T08:00:00'));
    expect(quietEnd(ny('2026-11-15T02:00:00'), q)).toEqual(ny('2026-11-15T08:00:00'));
  });
  it('returns the input when not quiet', () => {
    const t = ny('2026-11-14T10:00:00');
    expect(quietEnd(t, q)).toEqual(t);
  });
});

describe('addActiveMinutes (offer expiry with paused countdown)', () => {
  it('adds plain minutes outside quiet hours', () => {
    expect(addActiveMinutes(ny('2026-11-14T10:00:00'), 60, q)).toEqual(ny('2026-11-14T11:00:00'));
  });

  it('pauses across quiet hours: 20:30 + 60m = 08:30 next day', () => {
    expect(addActiveMinutes(ny('2026-11-14T20:30:00'), 60, q)).toEqual(ny('2026-11-15T08:30:00'));
  });

  it('expiring exactly at quiet start is not pushed', () => {
    expect(addActiveMinutes(ny('2026-11-14T20:00:00'), 60, q)).toEqual(ny('2026-11-14T21:00:00'));
  });

  it('starting inside quiet hours begins counting at quiet end', () => {
    expect(addActiveMinutes(ny('2026-11-14T23:00:00'), 30, q)).toEqual(ny('2026-11-15T08:30:00'));
  });

  it('spans multiple days for long windows', () => {
    // 13 active hours per day; 20h window from 08:00 day 1 -> 13h day1, 7h day2 -> 15:00 day 2
    expect(addActiveMinutes(ny('2026-11-14T08:00:00'), 20 * 60, q)).toEqual(ny('2026-11-15T15:00:00'));
  });

  it('is DST-safe (spring forward 2027-03-14)', () => {
    // 20:30 EST on 3/13 + 60 min -> 08:30 EDT on 3/14
    const start = new Date('2027-03-13T20:30:00-05:00');
    expect(addActiveMinutes(start, 60, q)).toEqual(new Date('2027-03-14T08:30:00-04:00'));
  });

  it('works with no quiet hours', () => {
    const none: QuietHours = { start: '00:00', end: '00:00', timezone: NY };
    expect(addActiveMinutes(ny('2026-11-14T23:00:00'), 60, none)).toEqual(ny('2026-11-15T00:00:00'));
  });
});
