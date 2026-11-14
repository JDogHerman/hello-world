import type { Executor } from '../db/kysely.js';
import type { Actor } from './context.js';

export async function audit(
  ex: Executor,
  actor: Actor,
  action: string,
  entity: string,
  entityId: number | null,
  opts: { reason?: string | null; data?: Record<string, unknown>; at?: Date } = {},
): Promise<void> {
  await ex
    .insertInto('audit_log')
    .values({
      actor_type: actor.type,
      actor_id: actor.type === 'system' ? null : actor.id,
      actor_label: actor.label,
      action,
      entity,
      entity_id: entityId,
      reason: opts.reason ?? null,
      data: JSON.stringify(opts.data ?? {}),
      ...(opts.at ? { at: opts.at } : {}),
    })
    .execute();
}
