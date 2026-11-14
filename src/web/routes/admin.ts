import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import type { AppContext } from '../../services/context.js';
import { updateConfig } from '../../services/config.js';
import { inTx } from '../../services/context.js';
import { acknowledgeAlert } from '../../services/jobs.js';
import { saveUser } from '../../services/users.js';
import { adminOnly, anyStaff } from '../auth.js';
import { actorOf, back } from '../server.js';

const PAGE = 100;

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/', { preHandler: anyStaff }, async (_req, reply) => {
    const now = new Date();
    const [alerts, pending, upcoming, inFlight] = await Promise.all([
      ctx.db.selectFrom('alert').selectAll().where('acknowledged_at', 'is', null).orderBy('created_at', 'desc').limit(50).execute(),
      ctx.db
        .selectFrom('candidate_list')
        .innerJoin('position', 'position.id', 'candidate_list.position_id')
        .innerJoin('skill', 'skill.id', 'position.skill_id')
        .innerJoin('job', 'job.id', 'position.job_id')
        .innerJoin('venue', 'venue.id', 'job.venue_id')
        .innerJoin('job_type', 'job_type.id', 'job.job_type_id')
        .select(['candidate_list.id', 'candidate_list.status', 'skill.name as skill', 'position.quantity', 'job.id as job_id', 'job.starts_at', 'venue.name as venue', 'job_type.name as job_type'])
        .where('candidate_list.status', 'in', ['draft', 'pending_approval'])
        .where('job.status', '=', 'open')
        .where('job.est_end_at', '>', now)
        .orderBy('job.starts_at')
        .execute(),
      ctx.db
        .selectFrom('job')
        .innerJoin('venue', 'venue.id', 'job.venue_id')
        .innerJoin('job_type', 'job_type.id', 'job.job_type_id')
        .selectAll('job')
        .select([
          'venue.name as venue',
          'job_type.name as job_type',
          sql<number>`(SELECT coalesce(sum(quantity),0) FROM position p WHERE p.job_id = job.id AND p.status <> 'cancelled')::int`.as('needed'),
          sql<number>`(SELECT coalesce(sum(filled_count),0) FROM position p WHERE p.job_id = job.id AND p.status <> 'cancelled')::int`.as('filled'),
        ])
        .where('job.status', '=', 'open')
        .where('job.est_end_at', '>', now)
        .orderBy('job.starts_at')
        .limit(20)
        .execute(),
      ctx.db.selectFrom('offer').select((eb) => eb.fn.countAll<string>().as('n')).where('status', 'in', ['sent', 'queued']).executeTakeFirstOrThrow(),
    ]);
    return reply.page('dashboard', { title: 'Dashboard', alerts, pending, upcoming, inFlight: Number(inFlight.n) });
  });

  app.post<{ Params: { id: string } }>('/alerts/:id/ack', { preHandler: anyStaff }, async (req, reply) => {
    await acknowledgeAlert(ctx, Number(req.params.id), actorOf(req));
    return back(req, reply, '/', { ok: 'Alert acknowledged' });
  });

  app.get('/audit', { preHandler: anyStaff }, async (req, reply) => {
    const { action = '', entity = '', entity_id = '', actor = '', before = '' } = req.query as Record<string, string>;
    let q = ctx.db.selectFrom('audit_log').selectAll().orderBy('id', 'desc').limit(PAGE + 1);
    if (action) q = q.where('action', 'like', `${action.replace(/[%_]/g, '')}%`);
    if (entity) q = q.where('entity', '=', entity);
    if (entity_id) q = q.where('entity_id', '=', Number(entity_id));
    if (actor) q = q.where('actor_label', 'ilike', `%${actor.replace(/[%_]/g, '')}%`);
    if (before) q = q.where('id', '<', before);
    const rows = await q.execute();
    const hasMore = rows.length > PAGE;
    const entries = rows.slice(0, PAGE);
    const actions = await ctx.db.selectFrom('audit_log').select('action').distinct().orderBy('action').execute();
    return reply.page('audit', {
      title: 'Audit log',
      entries,
      actions: actions.map((a) => a.action),
      filters: { action, entity, entity_id, actor },
      nextBefore: hasMore ? entries.at(-1)!.id : null,
    });
  });

  app.get('/messages', { preHandler: anyStaff }, async (req, reply) => {
    const { before = '' } = req.query as Record<string, string>;
    let q = ctx.db
      .selectFrom('sms_message')
      .leftJoin('worker', 'worker.id', 'sms_message.worker_id')
      .selectAll('sms_message')
      .select(['worker.first_name', 'worker.last_name'])
      .orderBy('sms_message.id', 'desc')
      .limit(PAGE + 1);
    if (before) q = q.where('sms_message.id', '<', Number(before));
    const rows = await q.execute();
    return reply.page('messages', { title: 'SMS messages', messages: rows.slice(0, PAGE), nextBefore: rows.length > PAGE ? rows[PAGE - 1].id : null });
  });

  app.get('/config', { preHandler: adminOnly }, async (_req, reply) => reply.page('config', { title: 'Settings' }));

  app.post('/config', { preHandler: adminOnly }, async (req, reply) => {
    await inTx(ctx, (tx) => updateConfig(tx, actorOf(req), req.body));
    return back(req, reply, '/config', { ok: 'Settings saved' });
  });

  app.get('/users', { preHandler: adminOnly }, async (_req, reply) => {
    const users = await ctx.db.selectFrom('app_user').selectAll().orderBy('name').execute();
    return reply.page('users', { title: 'Users', users });
  });

  app.post('/users', { preHandler: adminOnly }, async (req, reply) => {
    await saveUser(ctx, null, req.body, actorOf(req));
    return back(req, reply, '/users', { ok: 'User created' });
  });

  app.post<{ Params: { id: string } }>('/users/:id', { preHandler: adminOnly }, async (req, reply) => {
    await saveUser(ctx, Number(req.params.id), req.body, actorOf(req));
    return back(req, reply, '/users', { ok: 'User saved' });
  });
}
