import { Router, type Request } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import type { User } from '@scalo/shared';
import { db, isUniqueViolation, nowIso, type Db } from '../db';
import { env } from '../env';
import { getSettingsRow } from '../services/email';
import { clear, enforce, LIMITS, refund } from '../services/ratelimit';
import { HttpError, requireAuth, signToken, uid } from '../util';

const registerSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(6).max(200),
  name: z.string().trim().min(1).max(100),
});
const loginSchema = z.object({ email: z.string().trim().min(1).max(254), password: z.string().min(1).max(200) });

const EMAIL_TAKEN = 'Un compte existe déjà avec cet email';
// Compared against when the email is unknown, so response time doesn't reveal whether an account exists.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);

async function publicUser(id: number, ex: Db = db): Promise<User> {
  return ex.selectFrom('users').select(['id', 'email', 'name', 'created_at']).where('id', '=', id).executeTakeFirstOrThrow();
}

const SIGNUPS_CLOSED = 'Les inscriptions sont fermées sur cette instance';

/** ALLOW_SIGNUPS=false closes public sign-ups once an account exists (the first account of an empty instance is always allowed). */
async function signupsOpen(): Promise<boolean> {
  if (env.ALLOW_SIGNUPS) return true;
  return !(await db.selectFrom('users').select('id').limit(1).executeTakeFirst());
}

export const clientIp =(req: Request) => req.ip ?? req.socket.remoteAddress ?? 'unknown';

export function createAuthRouter() {
  const r = Router();

  // What the sign-up screen needs to know before showing its form.
  r.get('/config', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ signups: await signupsOpen() });
  });

  r.post('/register', async (req, res) => {
    await enforce(res, [[`register:ip:${clientIp(req)}`, LIMITS.registerIp]]);
    if (!(await signupsOpen())) throw new HttpError(403, SIGNUPS_CLOSED);
    const body = registerSchema.parse(req.body);
    const email = body.email.trim().toLowerCase();
    if (await db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst()) throw new HttpError(409, EMAIL_TAKEN);
    const hash = await bcrypt.hash(body.password, 10);
    let id: number;
    try {
      id = await db.transaction().execute(async (trx) => {
        const user = await trx.insertInto('users').values({ email, password_hash: hash, name: body.name, created_at: nowIso() }).returning('id').executeTakeFirstOrThrow();
        await getSettingsRow(user.id, trx); // default settings row
        return user.id;
      });
    } catch (e) {
      if (isUniqueViolation(e, 'users_email_key')) throw new HttpError(409, EMAIL_TAKEN);
      throw e;
    }
    res.status(201).json({ token: signToken(id), user: await publicUser(id) });
  });

  r.post('/login', async (req, res) => {
    const body = loginSchema.parse(req.body);
    const email = body.email.toLowerCase();
    const ipKey = `login:ip:${clientIp(req)}`;
    const emailKey = `login:email:${email}`;
    // Counted up front (atomic: parallel guesses can't slip through); given back on success.
    await enforce(res, [
      [ipKey, LIMITS.loginIp],
      [emailKey, LIMITS.loginEmail],
    ]);
    const row = await db.selectFrom('users').select(['id', 'password_hash']).where('email', '=', email).executeTakeFirst();
    const ok = await bcrypt.compare(body.password, row?.password_hash ?? DUMMY_HASH);
    if (!row || !ok) throw new HttpError(401, 'Email ou mot de passe incorrect');
    await Promise.all([clear(emailKey), refund(ipKey)]);
    res.json({ token: signToken(row.id), user: await publicUser(row.id) });
  });

  r.get('/me', requireAuth, async (req, res) => {
    res.json({ user: await publicUser(req.actorId ?? uid(req)) }); // the signed-in person (a team member, or the account)
  });

  return r;
}
