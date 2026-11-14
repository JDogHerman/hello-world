import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import type { AppContext } from '../../services/context.js';
import * as J from '../../services/jobs.js';
import { handleInboundSms } from '../../services/inboundSms.js';
import { anyStaff } from '../auth.js';
import { actorOf, back, type ServerOptions } from '../server.js';

type P = { id: string };

const arr = (v: unknown): string[] => (v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

export async function loadBoard(ctx: AppContext, jobId: number) {
  const job = await ctx.db
    .selectFrom('job')
    .innerJoin('venue', 'venue.id', 'job.venue_id')
    .innerJoin('job_type', 'job_type.id', 'job.job_type_id')
    .selectAll('job')
    .select(['venue.name as venue', 'venue.address as address', 'job_type.name as job_type'])
    .where('job.id', '=', jobId)
    .executeTakeFirst();
  if (!job) return null;
  const positions = await ctx.db
    .selectFrom('position')
    .innerJoin('skill', 'skill.id', 'position.skill_id')
    .leftJoin('candidate_list', 'candidate_list.position_id', 'position.id')
    .selectAll('position')
    .select([
      'skill.name as skill',
      'candidate_list.id as list_id',
      'candidate_list.status as list_status',
      sql<number>`(SELECT count(*) FROM candidate_entry ce WHERE ce.list_id = candidate_list.id AND ce.removed_at IS NULL)::int`.as('candidates'),
    ])
    .where('position.job_id', '=', jobId)
    .orderBy('position.id')
    .execute();
  const pids = positions.map((p) => p.id);
  const offers = pids.length
    ? await ctx.db
        .selectFrom('offer')
        .innerJoin('worker', 'worker.id', 'offer.worker_id')
        .select([
          'offer.id',
          'offer.position_id',
          'offer.status',
          'offer.code',
          'offer.sent_at',
          'offer.expires_at',
          'offer.queued_at',
          'offer.responded_at',
          'offer.cancel_reason',
          'worker.id as worker_id',
          'worker.first_name',
          'worker.last_name',
          'worker.phone',
        ])
        .where('offer.position_id', 'in', pids)
        .orderBy('offer.id')
        .execute()
    : [];
  const bookings = pids.length
    ? await ctx.db
        .selectFrom('booking')
        .innerJoin('worker', 'worker.id', 'booking.worker_id')
        .select(['booking.id', 'booking.position_id', 'booking.cancelled_at', 'booking.cancel_reason', 'worker.id as worker_id', 'worker.first_name', 'worker.last_name', 'worker.phone'])
        .where('booking.position_id', 'in', pids)
        .orderBy('booking.id')
        .execute()
    : [];
  return {
    job,
    positions: positions.map((p) => ({
      ...p,
      inFlight: offers.filter((o) => o.position_id === p.id && (o.status === 'sent' || o.status === 'queued')),
      history: offers.filter((o) => o.position_id === p.id && o.status !== 'sent' && o.status !== 'queued'),
      bookings: bookings.filter((b) => b.position_id === p.id && !b.cancelled_at),
    })),
  };
}

export function registerJobRoutes(app: FastifyInstance, ctx: AppContext, env: ServerOptions['env']) {
  app.get('/jobs', { preHandler: anyStaff }, async (req, reply) => {
    const { when = 'upcoming' } = req.query as Record<string, string>;
    let q = ctx.db
      .selectFrom('job')
      .innerJoin('venue', 'venue.id', 'job.venue_id')
      .innerJoin('job_type', 'job_type.id', 'job.job_type_id')
      .selectAll('job')
      .select([
        'venue.name as venue',
        'job_type.name as job_type',
        sql<number>`(SELECT coalesce(sum(quantity),0) FROM position p WHERE p.job_id = job.id AND p.status <> 'cancelled')::int`.as('needed'),
        sql<number>`(SELECT coalesce(sum(filled_count),0) FROM position p WHERE p.job_id = job.id AND p.status <> 'cancelled')::int`.as('filled'),
        sql<number>`(SELECT count(*) FROM position p JOIN candidate_list cl ON cl.position_id = p.id WHERE p.job_id = job.id AND cl.status IN ('draft','pending_approval'))::int`.as('awaiting_approval'),
        sql<number>`(SELECT count(*) FROM position p WHERE p.job_id = job.id AND p.status = 'exhausted')::int`.as('exhausted'),
      ]);
    q = when === 'past' ? q.where('job.est_end_at', '<', new Date()).orderBy('job.starts_at', 'desc') : q.where('job.est_end_at', '>=', new Date()).orderBy('job.starts_at');
    const jobs = await q.limit(200).execute();
    return reply.page('jobs/index', { title: 'Jobs', jobs, when });
  });

  app.get('/jobs/new', { preHandler: anyStaff }, async (_req, reply) => {
    const [venues, jobTypes, skills] = await Promise.all([
      ctx.db.selectFrom('venue').selectAll().where('active', '=', true).orderBy('name').execute(),
      ctx.db.selectFrom('job_type').selectAll().where('active', '=', true).orderBy('name').execute(),
      ctx.db.selectFrom('skill').selectAll().where('active', '=', true).orderBy('name').execute(),
    ]);
    return reply.page('jobs/new', { title: 'New job', venues, jobTypes, skills });
  });

  app.post('/jobs', { preHandler: anyStaff }, async (req, reply) => {
    const b = req.body as Record<string, unknown>;
    const skillIds = arr(b.skill_id);
    const qtys = arr(b.quantity);
    const positions = skillIds
      .map((s, i) => ({ skill_id: s, quantity: qtys[i] }))
      .filter((p) => p.skill_id && p.quantity && Number(p.quantity) > 0);
    const id = await J.createJob(ctx, { ...b, positions }, actorOf(req));
    return reply.redirect(`/jobs/${id}?ok=${encodeURIComponent('Job created. Review and approve each candidate list — nothing is texted until you do.')}`, 303);
  });

  app.get<{ Params: P }>('/jobs/:id', { preHandler: anyStaff }, async (req, reply) => {
    const board = await loadBoard(ctx, Number(req.params.id));
    if (!board) return reply.callNotFound();
    const [skills, workers] = await Promise.all([
      ctx.db.selectFrom('skill').selectAll().where('active', '=', true).orderBy('name').execute(),
      env.SMS_PROVIDER === 'console' ? ctx.db.selectFrom('worker').select(['id', 'first_name', 'last_name', 'phone']).orderBy('last_name').execute() : [],
    ]);
    return reply.page('jobs/show', { title: `${board.job.job_type} — ${board.job.venue}`, ...board, skills, workers });
  });

  // Partial for the live status board (polled every few seconds).
  app.get<{ Params: P }>('/jobs/:id/board', { preHandler: anyStaff }, async (req, reply) => {
    const board = await loadBoard(ctx, Number(req.params.id));
    if (!board) return reply.callNotFound();
    return reply.page('jobs/_board', board);
  });

  app.post<{ Params: P }>('/jobs/:id/cancel', { preHandler: anyStaff }, async (req, reply) => {
    await J.cancelJob(ctx, Number(req.params.id), (req.body as { reason: string }).reason, actorOf(req));
    return back(req, reply, `/jobs/${req.params.id}`, { ok: 'Job cancelled; workers notified' });
  });

  app.post<{ Params: P }>('/jobs/:id/notes', { preHandler: anyStaff }, async (req, reply) => {
    await J.updateJobNotes(ctx, Number(req.params.id), (req.body as { notes: string }).notes ?? '', actorOf(req));
    return back(req, reply, `/jobs/${req.params.id}`, { ok: 'Notes saved' });
  });

  app.post<{ Params: P }>('/jobs/:id/positions', { preHandler: anyStaff }, async (req, reply) => {
    await J.addPosition(ctx, Number(req.params.id), req.body, actorOf(req));
    return back(req, reply, `/jobs/${req.params.id}`, { ok: 'Position added (draft list generated)' });
  });

  app.post<{ Params: P }>('/positions/:id/quantity', { preHandler: anyStaff }, async (req, reply) => {
    const b = req.body as { quantity: string; reason: string };
    await J.setQuantity(ctx, Number(req.params.id), Number(b.quantity), b.reason, actorOf(req));
    return back(req, reply, '/jobs', { ok: 'Quantity updated' });
  });

  app.post<{ Params: P }>('/bookings/:id/release', { preHandler: anyStaff }, async (req, reply) => {
    await J.releaseBooking(ctx, Number(req.params.id), (req.body as { reason: string }).reason, actorOf(req));
    return back(req, reply, '/jobs', { ok: 'Worker released; slot reopened' });
  });

  // Development only: simulate a worker texting in (console SMS provider).
  app.post('/dev/sms', { preHandler: anyStaff }, async (req, reply) => {
    if (env.SMS_PROVIDER !== 'console') return reply.code(404).send();
    const b = req.body as { worker_id: string; body: string };
    const w = await ctx.db.selectFrom('worker').select('phone').where('id', '=', Number(b.worker_id)).executeTakeFirst();
    if (!w) return back(req, reply, '/jobs', { err: 'Choose a worker' });
    const result = await handleInboundSms(ctx, { from: w.phone, body: b.body ?? '', providerSid: `DEV${Date.now()}${Math.random().toString(36).slice(2, 8)}` });
    return back(req, reply, '/jobs', { ok: `Simulated reply processed: ${result}` });
  });
}
