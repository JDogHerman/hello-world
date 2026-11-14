import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../services/context.js';
import * as L from '../../services/candidateLists.js';
import { anyStaff, requireRole } from '../auth.js';
import { actorOf, back } from '../server.js';

type P = { id: string };

export function registerCandidateRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get<{ Params: P }>('/lists/:id', { preHandler: anyStaff }, async (req, reply) => {
    const id = Number(req.params.id);
    const list = await ctx.db
      .selectFrom('candidate_list')
      .innerJoin('position', 'position.id', 'candidate_list.position_id')
      .innerJoin('skill', 'skill.id', 'position.skill_id')
      .innerJoin('job', 'job.id', 'position.job_id')
      .innerJoin('venue', 'venue.id', 'job.venue_id')
      .innerJoin('job_type', 'job_type.id', 'job.job_type_id')
      .leftJoin('app_user', 'app_user.id', 'candidate_list.approved_by')
      .selectAll('candidate_list')
      .select([
        'position.quantity',
        'position.filled_count',
        'position.status as position_status',
        'skill.name as skill',
        'job.id as job_id',
        'job.starts_at',
        'job.est_end_at',
        'job.status as job_status',
        'venue.name as venue',
        'job_type.name as job_type',
        'app_user.name as approver',
      ])
      .where('candidate_list.id', '=', id)
      .executeTakeFirst();
    if (!list) return reply.callNotFound();

    const workerCols = ['worker.first_name', 'worker.last_name', 'worker.tranche', 'worker.start_date', 'worker.phone'] as const;
    const [entries, exclusions, offers, allWorkers] = await Promise.all([
      ctx.db
        .selectFrom('candidate_entry')
        .innerJoin('worker', 'worker.id', 'candidate_entry.worker_id')
        .selectAll('candidate_entry')
        .select(workerCols)
        .where('list_id', '=', id)
        .orderBy('candidate_entry.removed_at', (ob) => ob.nullsFirst())
        .orderBy('rank')
        .execute(),
      ctx.db
        .selectFrom('candidate_exclusion')
        .innerJoin('worker', 'worker.id', 'candidate_exclusion.worker_id')
        .selectAll('candidate_exclusion')
        .select(workerCols)
        .where('list_id', '=', id)
        .orderBy('worker.last_name')
        .execute(),
      ctx.db.selectFrom('offer').select(['worker_id', 'status', 'expires_at', 'code']).where('position_id', '=', list.position_id).execute(),
      ctx.db.selectFrom('worker').select(['id', 'first_name', 'last_name', 'tranche']).where('active', '=', true).where('sms_opt_out', '=', false).orderBy('last_name').execute(),
    ]);
    const offerBy = new Map(offers.map((o) => [o.worker_id, o]));
    const onList = new Set(entries.filter((e) => !e.removed_at).map((e) => e.worker_id));
    return reply.page('lists/show', {
      title: `Candidates — ${list.skill}`,
      list,
      active: entries.filter((e) => !e.removed_at),
      removed: entries.filter((e) => e.removed_at),
      exclusions,
      offerBy,
      addable: allWorkers.filter((w) => !onList.has(w.id)),
      canApprove: req.user!.role === 'steward',
    });
  });

  app.post<{ Params: P }>('/lists/:id/regenerate', { preHandler: anyStaff }, async (req, reply) => {
    await L.regenerate(ctx, Number(req.params.id), actorOf(req));
    return back(req, reply, `/lists/${req.params.id}`, { ok: 'List regenerated from current roster' });
  });

  app.post<{ Params: P }>('/lists/:id/submit', { preHandler: anyStaff }, async (req, reply) => {
    await L.submitForApproval(ctx, Number(req.params.id), actorOf(req));
    return back(req, reply, `/lists/${req.params.id}`, { ok: 'Submitted for Steward approval' });
  });

  app.post<{ Params: P }>('/lists/:id/approve', { preHandler: requireRole('steward') }, async (req, reply) => {
    await L.approve(ctx, Number(req.params.id), actorOf(req), (req.body as { note?: string })?.note);
    return back(req, reply, `/lists/${req.params.id}`, { ok: 'Approved — offers are going out' });
  });

  app.post<{ Params: P }>('/lists/:id/add', { preHandler: anyStaff }, async (req, reply) => {
    const b = req.body as { worker_id: string; rank?: string; reason: string; override?: string };
    await L.addEntry(ctx, Number(req.params.id), Number(b.worker_id), b.rank ? Number(b.rank) : null, b.reason, actorOf(req), b.override === 'on');
    return back(req, reply, `/lists/${req.params.id}`, { ok: 'Worker added' });
  });

  app.post<{ Params: P }>('/entries/:id/move', { preHandler: anyStaff }, async (req, reply) => {
    const b = req.body as { rank: string; reason: string };
    await L.moveEntry(ctx, Number(req.params.id), Number(b.rank), b.reason, actorOf(req));
    return back(req, reply, '/jobs', { ok: 'Moved' });
  });

  app.post<{ Params: P }>('/entries/:id/remove', { preHandler: anyStaff }, async (req, reply) => {
    await L.removeEntry(ctx, Number(req.params.id), (req.body as { reason: string }).reason, actorOf(req));
    return back(req, reply, '/jobs', { ok: 'Removed from list' });
  });
}
