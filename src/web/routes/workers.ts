import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import type { AppContext } from '../../services/context.js';
import * as W from '../../services/workers.js';
import { adminOnly, anyStaff } from '../auth.js';
import { actorOf, back } from '../server.js';

type P = { id: string };

export function registerWorkerRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/workers', { preHandler: anyStaff }, async (req, reply) => {
    const { q = '', status = 'active', skill = '' } = req.query as Record<string, string>;
    let query = ctx.db
      .selectFrom('worker')
      .selectAll('worker')
      .select(
        sql<string>`(SELECT string_agg(s.name, ', ' ORDER BY s.name) FROM worker_skill ws JOIN skill s ON s.id = ws.skill_id WHERE ws.worker_id = worker.id)`.as('skills'),
      )
      .orderBy('tranche')
      .orderBy('start_date')
      .orderBy('last_name')
      .orderBy('id');
    if (status === 'active') query = query.where('active', '=', true);
    if (status === 'inactive') query = query.where('active', '=', false);
    if (status === 'opted_out') query = query.where('sms_opt_out', '=', true);
    if (q.trim()) {
      const like = `%${q.trim().replace(/[%_\\]/g, (m) => '\\' + m)}%`;
      const digits = q.replace(/\D/g, '');
      query = query.where((eb) =>
        eb.or([
          eb(sql`first_name || ' ' || last_name`, 'ilike', like),
          eb(sql`last_name || ', ' || first_name`, 'ilike', like),
          ...(digits.length >= 3 ? [eb('phone', 'like', `%${digits}%`)] : []),
        ]),
      );
    }
    if (skill) {
      query = query.where((eb) =>
        eb.exists(eb.selectFrom('worker_skill').select('worker_id').whereRef('worker_skill.worker_id', '=', 'worker.id').where('skill_id', '=', Number(skill))),
      );
    }
    const workers = await query.execute();
    const skills = await ctx.db.selectFrom('skill').selectAll().orderBy('name').execute();
    return reply.page('workers/index', { title: 'Workers', workers, skills, q, status, skill });
  });

  app.get('/workers/new', { preHandler: adminOnly }, async (_req, reply) => {
    const skills = await ctx.db.selectFrom('skill').selectAll().where('active', '=', true).orderBy('name').execute();
    return reply.page('workers/form', { title: 'New worker', worker: null, skills, workerSkills: [] });
  });

  app.post('/workers', { preHandler: adminOnly }, async (req, reply) => {
    const id = await W.createWorker(ctx, req.body, actorOf(req));
    return reply.redirect(`/workers/${id}?ok=Worker+created`, 303);
  });

  app.get<{ Params: P }>('/workers/:id', { preHandler: anyStaff }, async (req, reply) => {
    const id = Number(req.params.id);
    const worker = await ctx.db.selectFrom('worker').selectAll().where('id', '=', id).executeTakeFirst();
    if (!worker) return reply.callNotFound();
    const [skills, workerSkills, refusals, unavailability, bookings, offers, messages, jobTypes, venues] = await Promise.all([
      ctx.db.selectFrom('skill').selectAll().orderBy('name').execute(),
      ctx.db.selectFrom('worker_skill').select('skill_id').where('worker_id', '=', id).execute(),
      ctx.db
        .selectFrom('worker_refusal')
        .leftJoin('job_type', 'job_type.id', 'worker_refusal.job_type_id')
        .leftJoin('venue', 'venue.id', 'worker_refusal.venue_id')
        .select(['worker_refusal.id', 'worker_refusal.reason', 'job_type.name as job_type', 'venue.name as venue'])
        .where('worker_id', '=', id)
        .execute(),
      ctx.db.selectFrom('worker_unavailability').selectAll().where('worker_id', '=', id).where('ends_at', '>', sql<Date>`now() - interval '30 days'`).orderBy('starts_at').execute(),
      ctx.db
        .selectFrom('booking')
        .innerJoin('job', 'job.id', 'booking.job_id')
        .innerJoin('venue', 'venue.id', 'job.venue_id')
        .innerJoin('job_type', 'job_type.id', 'job.job_type_id')
        .innerJoin('position', 'position.id', 'booking.position_id')
        .innerJoin('skill', 'skill.id', 'position.skill_id')
        .select(['booking.id', 'booking.starts_at', 'booking.ends_at', 'booking.cancelled_at', 'booking.cancel_reason', 'job.id as job_id', 'venue.name as venue', 'job_type.name as job_type', 'skill.name as skill'])
        .where('booking.worker_id', '=', id)
        .orderBy('booking.starts_at', 'desc')
        .limit(25)
        .execute(),
      ctx.db
        .selectFrom('offer')
        .innerJoin('position', 'position.id', 'offer.position_id')
        .innerJoin('job', 'job.id', 'position.job_id')
        .innerJoin('skill', 'skill.id', 'position.skill_id')
        .select(['offer.id', 'offer.code', 'offer.status', 'offer.sent_at', 'offer.responded_at', 'offer.cancel_reason', 'job.id as job_id', 'job.starts_at', 'skill.name as skill'])
        .where('offer.worker_id', '=', id)
        .orderBy('offer.id', 'desc')
        .limit(25)
        .execute(),
      ctx.db.selectFrom('sms_message').selectAll().where('worker_id', '=', id).orderBy('id', 'desc').limit(30).execute(),
      ctx.db.selectFrom('job_type').selectAll().where('active', '=', true).orderBy('name').execute(),
      ctx.db.selectFrom('venue').selectAll().where('active', '=', true).orderBy('name').execute(),
    ]);
    return reply.page('workers/show', {
      title: `${worker.first_name} ${worker.last_name}`,
      worker,
      skills,
      workerSkills: workerSkills.map((s) => s.skill_id),
      refusals,
      unavailability,
      bookings,
      offers,
      messages,
      jobTypes,
      venues,
    });
  });

  app.post<{ Params: P }>('/workers/:id', { preHandler: adminOnly }, async (req, reply) => {
    await W.updateWorker(ctx, Number(req.params.id), req.body, actorOf(req));
    return back(req, reply, `/workers/${req.params.id}`, { ok: 'Saved' });
  });

  app.post<{ Params: P }>('/workers/:id/opt-out', { preHandler: adminOnly }, async (req, reply) => {
    await W.adminOptOut(ctx, Number(req.params.id), (req.body as { reason: string }).reason, actorOf(req));
    return back(req, reply, `/workers/${req.params.id}`, { ok: 'Worker opted out of SMS' });
  });

  app.post<{ Params: P }>('/workers/:id/refusals', { preHandler: anyStaff }, async (req, reply) => {
    const b = req.body as { target?: string; reason?: string };
    const [kind = '', target_id = ''] = (b.target ?? '').split(':');
    await W.addRefusal(ctx, Number(req.params.id), { kind, target_id, reason: b.reason }, actorOf(req));
    return back(req, reply, `/workers/${req.params.id}`, { ok: 'Refusal added' });
  });

  app.post<{ Params: P & { rid: string } }>('/workers/:id/refusals/:rid/delete', { preHandler: anyStaff }, async (req, reply) => {
    await W.removeRefusal(ctx, Number(req.params.id), Number(req.params.rid), actorOf(req));
    return back(req, reply, `/workers/${req.params.id}`, { ok: 'Refusal removed' });
  });

  app.post<{ Params: P }>('/workers/:id/unavailability', { preHandler: anyStaff }, async (req, reply) => {
    await W.addUnavailability(ctx, Number(req.params.id), req.body as { starts_at: string; ends_at: string; note?: string }, actorOf(req));
    return back(req, reply, `/workers/${req.params.id}`, { ok: 'Unavailability added' });
  });

  app.post<{ Params: P & { uid: string } }>('/workers/:id/unavailability/:uid/delete', { preHandler: anyStaff }, async (req, reply) => {
    await W.removeUnavailability(ctx, Number(req.params.id), Number(req.params.uid), actorOf(req));
    return back(req, reply, `/workers/${req.params.id}`, { ok: 'Unavailability removed' });
  });
}
