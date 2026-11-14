import { z } from 'zod';
import { IANAZone } from 'luxon';
import type { Executor } from '../db/kysely.js';
import type { AppConfig } from '../db/types.js';
import type { QuietHours } from '../domain/quietHours.js';
import { audit } from './audit.js';
import { DomainError, type Actor } from './context.js';

export async function getConfig(ex: Executor): Promise<AppConfig> {
  return ex.selectFrom('app_config').selectAll().where('id', '=', 1).executeTakeFirstOrThrow();
}

export function quietHoursOf(c: AppConfig): QuietHours {
  return { start: c.quiet_hours_start.slice(0, 5), end: c.quiet_hours_end.slice(0, 5), timezone: c.timezone };
}

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Use HH:MM (24-hour)');

export const ConfigInput = z.object({
  reply_window_minutes: z.coerce.number().int().min(1).max(1440),
  offers_per_open_slot: z.coerce.number().int().min(1).max(20),
  quiet_hours_start: hhmm,
  quiet_hours_end: hhmm,
  timezone: z.string().refine((tz) => IANAZone.isValidZone(tz), 'Unknown IANA timezone'),
  local_name: z.string().trim().min(1).max(40),
  booking_buffer_minutes: z.coerce.number().int().min(0).max(720),
  steward_sms_alerts: z.preprocess((v) => v === true || v === 'on' || v === 'true', z.boolean()),
});

export async function updateConfig(ex: Executor, actor: Actor, raw: unknown): Promise<AppConfig> {
  const parsed = ConfigInput.safeParse(raw);
  if (!parsed.success) throw new DomainError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const before = await getConfig(ex);
  const after = await ex
    .updateTable('app_config')
    .set({ ...parsed.data, updated_at: new Date() })
    .where('id', '=', 1)
    .returningAll()
    .executeTakeFirstOrThrow();
  const changed = Object.fromEntries(
    Object.keys(parsed.data)
      .filter((k) => String((before as any)[k]) !== String((after as any)[k]))
      .map((k) => [k, { from: (before as any)[k], to: (after as any)[k] }]),
  );
  await audit(ex, actor, 'config.update', 'config', 1, { data: changed });
  return after;
}
