import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { toE164 } from '../domain/phone.js';
import type { AppUser } from '../db/types.js';
import { audit } from './audit.js';
import { DomainError, inTx, type Actor, type AppContext } from './context.js';

const UserInput = z.object({
  email: z.string().trim().toLowerCase().email('Valid email required'),
  name: z.string().trim().min(1, 'Name required'),
  role: z.enum(['admin', 'steward']),
  phone: z.string().trim().optional().default(''),
  password: z.string().optional().default(''),
  active: z.preprocess((v) => v === true || v === 'on' || v === 'true', z.boolean()).default(true),
});

export async function authenticate(ctx: AppContext, email: string, password: string): Promise<AppUser | null> {
  const u = await ctx.db.selectFrom('app_user').selectAll().where('email', '=', email.trim().toLowerCase()).executeTakeFirst();
  if (!u || !u.active) return null;
  return (await bcrypt.compare(password, u.password_hash)) ? u : null;
}

export async function saveUser(ctx: AppContext, id: number | null, raw: unknown, actor: Actor): Promise<number> {
  const r = UserInput.safeParse(raw);
  if (!r.success) throw new DomainError(r.error.issues.map((i) => i.message).join('; '));
  const d = r.data;
  const phone = d.phone ? toE164(d.phone, ctx.defaultRegion) : null;
  if (d.phone && !phone) throw new DomainError('Invalid phone number.');
  if (!id && d.password.length < 8) throw new DomainError('Password must be at least 8 characters.');
  if (id && d.password && d.password.length < 8) throw new DomainError('Password must be at least 8 characters.');
  const hash = d.password ? await bcrypt.hash(d.password, 10) : null;
  try {
    return await inTx(ctx, async (tx) => {
      if (id) {
        await tx
          .updateTable('app_user')
          .set({ email: d.email, name: d.name, role: d.role, phone, active: d.active, updated_at: new Date(), ...(hash ? { password_hash: hash } : {}) })
          .where('id', '=', id)
          .execute();
        await audit(tx, actor, 'user.updated', 'app_user', id, { data: { email: d.email, role: d.role, active: d.active, password_changed: !!hash } });
        return id;
      }
      const u = await tx
        .insertInto('app_user')
        .values({ email: d.email, name: d.name, role: d.role, phone, password_hash: hash!, active: d.active })
        .returning('id')
        .executeTakeFirstOrThrow();
      await audit(tx, actor, 'user.created', 'app_user', u.id, { data: { email: d.email, role: d.role } });
      return u.id;
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new DomainError('That email is already in use.', 409);
    throw err;
  }
}
