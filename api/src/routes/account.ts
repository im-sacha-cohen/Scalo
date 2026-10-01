// Paramètres → Données et compte (session JWT, under /api): summary, GDPR export, deletion of all the data, deletion
// of the account. Reserved to the owner of the account: a team member gets 403, even an administrator (`account` is
// also an owner-only area of access.ts). Deletions require the password (rate limited) and the email of the account.
import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db } from '../db';
import { accountSummary, deleteAccount, exportAccount, resetAccountData, type DeletionOptions } from '../services/account';
import { clear, enforce } from '../services/ratelimit';
import { HttpError, uid } from '../util';

export const OWNER_ONLY = 'Réservé au propriétaire du compte : demandez-lui d’effectuer cette opération.';
const MIN15 = 15 * 60_000;
/** Password checks before a deletion, per account. */
export const ACCOUNT_PASSWORD_LIMIT = { max: 5, windowMs: MIN15 };
const EXPORT_LIMIT = { max: 10, windowMs: 60 * 60_000 };

function ownerId(req: Request): number {
  const userId = uid(req);
  if (req.role !== 'owner' || req.actorId !== userId) throw new HttpError(403, OWNER_ONLY);
  return userId;
}

const deletionSchema = z.object({ password: z.string().min(1, 'Saisissez votre mot de passe').max(200), confirm: z.string().trim().max(254) });

/** Password (rate limited, counted before the comparison) + confirmation word = the email of the account. */
async function checkDeletion(req: Request, res: Response, userId: number) {
  const body = deletionSchema.parse(req.body);
  const key = `account-password:${userId}`;
  await enforce(res, [[key, ACCOUNT_PASSWORD_LIMIT]]);
  const user = await db.selectFrom('users').select(['email', 'password_hash']).where('id', '=', userId).executeTakeFirstOrThrow();
  // 403, not 401: the session is valid, the web app must not sign the person out
  if (!(await bcrypt.compare(body.password, user.password_hash))) throw new HttpError(403, 'Mot de passe incorrect');
  await clear(key);
  if (body.confirm.toLowerCase() !== user.email.toLowerCase()) throw new HttpError(400, 'Saisissez l’adresse email du compte pour confirmer');
}

export function createAccountRouter(opts: DeletionOptions = {}) {
  const r = Router();

  r.get('/account/summary', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await accountSummary(ownerId(req)));
  });

  // POST: heavy, never cached or prefetched
  r.post('/account/export', async (req, res) => {
    const userId = ownerId(req);
    await enforce(res, [[`account-export:${userId}`, EXPORT_LIMIT]]);
    const { zip, filename } = await exportAccount(userId);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(zip);
  });

  r.post('/account/reset', async (req, res) => {
    const userId = ownerId(req);
    await checkDeletion(req, res, userId);
    res.json({ ok: true, deleted: await resetAccountData(userId, opts) });
  });

  r.post('/account/delete', async (req, res) => {
    const userId = ownerId(req);
    await checkDeletion(req, res, userId);
    res.json({ ok: true, deleted: await deleteAccount(userId, opts) });
  });

  return r;
}
