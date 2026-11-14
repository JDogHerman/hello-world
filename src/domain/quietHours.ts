import { DateTime } from 'luxon';

/**
 * Quiet hours are a daily local-time window, e.g. 21:00–08:00 (may wrap midnight).
 * start === end means "no quiet hours". All functions are pure and DST-safe
 * (wall-clock times are resolved in the configured zone by luxon).
 */
export interface QuietHours {
  start: string; // 'HH:MM' or 'HH:MM:SS'
  end: string;
  timezone: string;
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}

function localMinutes(dt: DateTime): number {
  return dt.hour * 60 + dt.minute + dt.second / 60;
}

export function hasQuietHours(q: QuietHours): boolean {
  return minutesOf(q.start) !== minutesOf(q.end);
}

export function isQuiet(at: Date, q: QuietHours): boolean {
  if (!hasQuietHours(q)) return false;
  const t = localMinutes(DateTime.fromJSDate(at, { zone: q.timezone }));
  const s = minutesOf(q.start);
  const e = minutesOf(q.end);
  return s < e ? t >= s && t < e : t >= s || t < e;
}

/** The next instant strictly after-or-at `at` whose local time is `hhmm`. */
function nextLocalTime(at: Date, hhmm: string, zone: string): Date {
  const m = minutesOf(hhmm);
  const local = DateTime.fromJSDate(at, { zone });
  let candidate = local.set({ hour: Math.floor(m / 60), minute: m % 60, second: 0, millisecond: 0 });
  if (candidate.toMillis() < local.toMillis()) candidate = candidate.plus({ days: 1 });
  return candidate.toJSDate();
}

/** If `at` is inside quiet hours, the instant they end; otherwise `at` itself. */
export function quietEnd(at: Date, q: QuietHours): Date {
  if (!isQuiet(at, q)) return at;
  return nextLocalTime(at, q.end, q.timezone);
}

/** Next instant quiet hours begin (at or after `at`); null if there are none. */
export function nextQuietStart(at: Date, q: QuietHours): Date | null {
  if (!hasQuietHours(q)) return null;
  return nextLocalTime(at, q.start, q.timezone);
}

/**
 * Adds `minutes` of *active* (non-quiet) time to `start`. The countdown pauses
 * during quiet hours, so an offer sent at 20:30 with a 60-minute window and
 * quiet hours 21:00–08:00 expires at 08:30 the next morning.
 */
export function addActiveMinutes(start: Date, minutes: number, q: QuietHours): Date {
  let remaining = minutes * 60_000;
  let cursor = quietEnd(start, q);
  // Bounded loop: each iteration consumes one full active window.
  for (let i = 0; i < 1000; i++) {
    const qs = nextQuietStart(cursor, q);
    if (!qs) return new Date(cursor.getTime() + remaining);
    const available = qs.getTime() - cursor.getTime();
    if (remaining <= available) return new Date(cursor.getTime() + remaining);
    remaining -= available;
    cursor = quietEnd(qs, q);
  }
  throw new Error('addActiveMinutes did not converge');
}
