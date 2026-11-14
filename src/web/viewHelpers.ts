import { DateTime } from 'luxon';
import { formatPhone } from '../domain/phone.js';
import { describeReasons, EXCLUSION_REASONS } from '../domain/selection.js';

export { formatPhone as phone, describeReasons as reasons, EXCLUSION_REASONS };

export function dt(at: Date | string | null | undefined, tz: string, pattern = 'ccc M/d/yy h:mm a'): string {
  if (!at) return '';
  const d = typeof at === 'string' ? new Date(at) : at;
  return DateTime.fromJSDate(d, { zone: tz }).toFormat(pattern);
}

export function day(at: Date | null | undefined, tz: string): string {
  return dt(at, tz, 'ccc M/d/yy');
}

export function time(at: Date | null | undefined, tz: string): string {
  return dt(at, tz, 'h:mm a');
}

export function inputDateTime(at: Date | null | undefined, tz: string): string {
  return at ? DateTime.fromJSDate(at, { zone: tz }).toFormat("yyyy-MM-dd'T'HH:mm") : '';
}

export function iso(at: Date | null | undefined): string {
  return at ? at.toISOString() : '';
}

const BADGES: Record<string, string> = {
  draft: 'muted',
  pending_approval: 'warn',
  approved: 'info',
  active: 'info',
  open: 'info',
  queued: 'muted',
  sent: 'info',
  filled: 'ok',
  accepted: 'ok',
  complete: 'ok',
  exhausted: 'bad',
  declined: 'warn',
  expired: 'warn',
  cancelled: 'muted',
};

export function badge(status: string): string {
  return `<span class="badge ${BADGES[status] ?? 'muted'}">${status.replace(/_/g, ' ')}</span>`;
}

export function json(v: unknown): string {
  return JSON.stringify(v ?? {}, null, 0);
}
