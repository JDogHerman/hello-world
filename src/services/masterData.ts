import { DomainError, inTx, type Actor, type AppContext } from './context.js';
import { audit } from './audit.js';

export type ListKind = 'skill' | 'job_type' | 'venue';

export const LIST_LABELS: Record<ListKind, { singular: string; plural: string; path: string }> = {
  skill: { singular: 'Skill', plural: 'Skills', path: 'skills' },
  job_type: { singular: 'Job type', plural: 'Job types', path: 'job-types' },
  venue: { singular: 'Venue', plural: 'Venues', path: 'venues' },
};

export async function listItems(ctx: AppContext, kind: ListKind, includeInactive = true) {
  // `venue` has an extra address column; select it when present.
  let q = ctx.db.selectFrom(kind).selectAll().orderBy('name');
  if (!includeInactive) q = q.where('active', '=', true);
  return (await q.execute()) as { id: number; name: string; active: boolean; address?: string }[];
}

export async function saveItem(
  ctx: AppContext,
  kind: ListKind,
  id: number | null,
  raw: { name?: string; address?: string; active?: string | boolean },
  actor: Actor,
): Promise<void> {
  const name = (raw.name ?? '').trim();
  if (!name) throw new DomainError('Name is required.');
  const extra = kind === 'venue' ? { address: (raw.address ?? '').trim() } : {};
  try {
    await inTx(ctx, async (tx) => {
      if (id) {
        const active = raw.active === undefined ? undefined : raw.active === true || raw.active === 'on' || raw.active === 'true';
        await tx.updateTable(kind as 'skill').set({ name, ...extra, ...(active === undefined ? {} : { active }) }).where('id', '=', id).execute();
        await audit(tx, actor, `${kind}.updated`, kind, id, { data: { name, ...extra, active } });
      } else {
        const row = await tx.insertInto(kind as 'skill').values({ name, ...extra }).returning('id').executeTakeFirstOrThrow();
        await audit(tx, actor, `${kind}.created`, kind, row.id, { data: { name, ...extra } });
      }
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new DomainError(`"${name}" already exists.`, 409);
    throw err;
  }
}

export async function setItemActive(ctx: AppContext, kind: ListKind, id: number, active: boolean, actor: Actor): Promise<void> {
  await inTx(ctx, async (tx) => {
    await tx.updateTable(kind as 'skill').set({ active }).where('id', '=', id).execute();
    await audit(tx, actor, active ? `${kind}.activated` : `${kind}.deactivated`, kind, id);
  });
}
