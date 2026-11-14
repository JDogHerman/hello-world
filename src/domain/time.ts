import { DateTime } from 'luxon';

/** Converts a local date ('YYYY-MM-DD') and time ('HH:MM') in `zone` to an instant. */
export function localToInstant(date: string, time: string, zone: string): Date {
  const dt = DateTime.fromISO(`${date}T${time}`, { zone });
  if (!dt.isValid) throw new Error(`Invalid date/time: ${date} ${time}`);
  return dt.toJSDate();
}

/**
 * Job times are entered as a date + start + estimated end. An end time at or before
 * the start time means the call runs past midnight into the next day.
 */
export function jobWindow(date: string, start: string, end: string, zone: string): { startsAt: Date; endsAt: Date } {
  const startsAt = localToInstant(date, start, zone);
  let endsAt = localToInstant(date, end, zone);
  if (endsAt <= startsAt) {
    endsAt = DateTime.fromJSDate(endsAt, { zone }).plus({ days: 1 }).toJSDate();
  }
  return { startsAt, endsAt };
}

export function fmt(at: Date | null | undefined, zone: string, pattern = 'ccc M/d h:mm a'): string {
  if (!at) return '';
  return DateTime.fromJSDate(at, { zone }).toFormat(pattern);
}

export function localDate(at: Date, zone: string): string {
  return DateTime.fromJSDate(at, { zone }).toFormat('yyyy-MM-dd');
}

export function localTime(at: Date, zone: string): string {
  return DateTime.fromJSDate(at, { zone }).toFormat('HH:mm');
}

/** For <input type="datetime-local"> values. */
export function localDateTimeInput(at: Date, zone: string): string {
  return DateTime.fromJSDate(at, { zone }).toFormat("yyyy-MM-dd'T'HH:mm");
}

export function parseDateTimeInput(value: string, zone: string): Date {
  const dt = DateTime.fromISO(value, { zone });
  if (!dt.isValid) throw new Error(`Invalid date/time: ${value}`);
  return dt.toJSDate();
}
