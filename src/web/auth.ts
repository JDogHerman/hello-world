import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../services/context.js';
import type { ServerOptions } from './server.js';
import { authenticate } from '../services/users.js';
import { audit } from '../services/audit.js';

const COOKIE = 'sid';
const SESSION_HOURS = 12;
const PUBLIC_PREFIXES = ['/login', '/public/', '/sms/', '/healthz'];

/**
 * Minimal session: a signed, httpOnly cookie "<userId>.<expiryMs>". The user row is
 * re-read on every request, so deactivating a user or changing their role is immediate.
 */
export function registerAuth(app: FastifyInstance, ctx: AppContext, env: ServerOptions['env']) {
  const secure = env.PUBLIC_BASE_URL.startsWith('https://');

  app.addHook('preHandler', async (req, reply) => {
    const path = req.url.split('?')[0];
    const raw = req.cookies[COOKIE];
    if (raw) {
      const un = req.unsignCookie(raw);
      if (un.valid && un.value) {
        const [id, exp] = un.value.split('.').map(Number);
        if (Number.isFinite(exp) && exp > Date.now()) {
          const u = await ctx.db.selectFrom('app_user').selectAll().where('id', '=', id).where('active', '=', true).executeTakeFirst();
          req.user = u ?? null;
        }
      }
    }
    if (PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(p))) return;
    if (!req.user) return reply.redirect(`/login?next=${encodeURIComponent(req.url)}`, 303);
  });

  app.get('/login', async (req, reply) => {
    if (req.user) return reply.redirect('/', 303);
    return reply.page('login', { title: 'Sign in', next: (req.query as { next?: string }).next ?? '/' });
  });

  app.post('/login', async (req, reply) => {
    const { email = '', password = '', next = '/' } = req.body as Record<string, string>;
    const user = await authenticate(ctx, email, password);
    if (!user) {
      return reply.redirect(`/login?err=${encodeURIComponent('Invalid email or password')}&next=${encodeURIComponent(next)}`, 303);
    }
    const exp = Date.now() + SESSION_HOURS * 3600_000;
    reply.setCookie(COOKIE, `${user.id}.${exp}`, { signed: true, httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: SESSION_HOURS * 3600 });
    await audit(ctx.db, { type: 'user', id: user.id, label: user.name, role: user.role }, 'user.login', 'app_user', user.id);
    const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';
    return reply.redirect(safeNext, 303);
  });

  app.post('/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' });
    return reply.redirect('/login', 303);
  });
}

export function requireRole(...roles: ('admin' | 'steward')[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user || !roles.includes(req.user.role)) {
      reply.code(403);
      return reply.page('error', { title: 'Forbidden', message: `This page requires the ${roles.join(' or ')} role.` });
    }
  };
}

export const adminOnly = requireRole('admin');
export const anyStaff = requireRole('admin', 'steward');
