import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import formbody from '@fastify/formbody';
import cookie from '@fastify/cookie';
import view from '@fastify/view';
import fstatic from '@fastify/static';
import ejs from 'ejs';
import qs from 'node:querystring';
import type { Env } from '../env.js';
import type { AppUser } from '../db/types.js';
import { DomainError, type Actor, type AppContext } from '../services/context.js';
import { getConfig } from '../services/config.js';
import * as viewHelpers from './viewHelpers.js';
import { registerAuth } from './auth.js';
import { registerWebhook } from './routes/webhook.js';
import { registerWorkerRoutes } from './routes/workers.js';
import { registerListRoutes } from './routes/lists.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerCandidateRoutes } from './routes/candidates.js';
import { registerAdminRoutes } from './routes/admin.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: AppUser | null;
  }
  interface FastifyReply {
    page(template: string, data?: Record<string, unknown>): Promise<FastifyReply>;
  }
}

export interface ServerOptions {
  ctx: AppContext;
  env: Pick<Env, 'SESSION_SECRET' | 'PUBLIC_BASE_URL' | 'TWILIO_AUTH_TOKEN' | 'TWILIO_VALIDATE_SIGNATURE' | 'SMS_PROVIDER' | 'NODE_ENV'>;
}

export function actorOf(req: FastifyRequest): Actor {
  const u = req.user!;
  return { type: 'user', id: u.id, label: u.name, role: u.role };
}

/** Redirect back (or to `fallback`) with a flash message in the query string. */
export function back(req: FastifyRequest, reply: FastifyReply, fallback: string, flash: { ok?: string; err?: string }) {
  const ref = req.headers.referer;
  let target = fallback;
  if (ref) {
    try {
      const u = new URL(ref);
      if (u.host === req.headers.host) target = u.pathname;
    } catch {
      /* ignore */
    }
  }
  const q = qs.stringify(Object.fromEntries(Object.entries(flash).filter(([, v]) => v)) as Record<string, string>);
  return reply.redirect(q ? `${target}?${q}` : target, 303);
}

export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const { ctx, env } = opts;
  const app = Fastify({ logger: env.NODE_ENV === 'production' ? { level: 'info' } : false, trustProxy: true });

  // Twilio posts form-encoded; repeated keys (checkboxes) become arrays.
  await app.register(formbody, { parser: (s) => qs.parse(s) });
  await app.register(cookie, { secret: env.SESSION_SECRET });
  await app.register(view, {
    engine: { ejs },
    root: fileURLToPath(new URL('../views', import.meta.url)),
    viewExt: 'ejs',
    production: env.NODE_ENV === 'production',
  });
  await app.register(fstatic, { root: fileURLToPath(new URL('../public', import.meta.url)), prefix: '/public/' });

  app.decorateRequest('user', null);
  app.decorateReply('page', async function (this: FastifyReply, template: string, data: Record<string, unknown> = {}) {
    const req = this.request;
    const config = await getConfig(ctx.db);
    const alerts = req.user
      ? await ctx.db.selectFrom('alert').select((eb) => eb.fn.countAll<string>().as('n')).where('acknowledged_at', 'is', null).executeTakeFirst()
      : null;
    const query = req.query as Record<string, string>;
    return this.view(template, {
      user: req.user,
      config,
      tz: config.timezone,
      path: req.url.split('?')[0],
      flash: { ok: query?.ok, err: query?.err },
      openAlerts: Number(alerts?.n ?? 0),
      devSms: env.SMS_PROVIDER === 'console',
      h: viewHelpers,
      title: '',
      ...data,
    });
  });

  // Basic CSRF defence on top of SameSite=Lax cookies: reject cross-origin form posts.
  app.addHook('onRequest', async (req, reply) => {
    if (req.method !== 'POST' || req.url.startsWith('/sms/')) return;
    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
      try {
        if (new URL(origin).host !== req.headers.host) return reply.code(403).send('Cross-origin request blocked');
      } catch {
        return reply.code(403).send('Bad origin');
      }
    }
  });

  app.get('/healthz', async () => ({ ok: true }));

  registerWebhook(app, ctx, env);
  registerAuth(app, ctx, env);
  registerWorkerRoutes(app, ctx);
  registerListRoutes(app, ctx);
  registerJobRoutes(app, ctx, env);
  registerCandidateRoutes(app, ctx);
  registerAdminRoutes(app, ctx);

  app.setErrorHandler(async (err, req, reply) => {
    if (err instanceof DomainError) {
      if (req.method === 'POST') return back(req, reply, '/', { err: err.message });
      reply.code(err.status);
      return reply.page('error', { title: 'Error', message: err.message });
    }
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) {
      reply.code(e.statusCode);
      return reply.page('error', { title: 'Error', message: e.message });
    }
    ctx.log.error(err);
    reply.code(500);
    return reply.page('error', { title: 'Error', message: 'Something went wrong. The error has been logged.' });
  });
  app.setNotFoundHandler(async (_req, reply) => {
    reply.code(404);
    return reply.page('error', { title: 'Not found', message: 'Page not found.' });
  });

  return app;
}
