import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../services/context.js';
import { LIST_LABELS, listItems, saveItem, setItemActive, type ListKind } from '../../services/masterData.js';
import { adminOnly, anyStaff } from '../auth.js';
import { actorOf, back } from '../server.js';

/** Skills, job types and venues: the controlled lists. */
export function registerListRoutes(app: FastifyInstance, ctx: AppContext) {
  for (const kind of Object.keys(LIST_LABELS) as ListKind[]) {
    const label = LIST_LABELS[kind];
    const base = `/${label.path}`;

    app.get(base, { preHandler: anyStaff }, async (_req, reply) => {
      const items = await listItems(ctx, kind);
      return reply.page('controlled', { title: label.plural, items, kind, label, base });
    });

    app.post(base, { preHandler: adminOnly }, async (req, reply) => {
      await saveItem(ctx, kind, null, req.body as Record<string, string>, actorOf(req));
      return back(req, reply, base, { ok: `${label.singular} added` });
    });

    app.post<{ Params: { id: string } }>(`${base}/:id`, { preHandler: adminOnly }, async (req, reply) => {
      await saveItem(ctx, kind, Number(req.params.id), req.body as Record<string, string>, actorOf(req));
      return back(req, reply, base, { ok: 'Saved' });
    });

    app.post<{ Params: { id: string } }>(`${base}/:id/toggle`, { preHandler: adminOnly }, async (req, reply) => {
      const active = (req.body as { active: string }).active === 'true';
      await setItemActive(ctx, kind, Number(req.params.id), active, actorOf(req));
      return back(req, reply, base, { ok: active ? 'Re-activated' : 'Retired (kept for history)' });
    });
  }
}
