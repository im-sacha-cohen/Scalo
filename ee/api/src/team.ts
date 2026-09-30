/**
 * Scalo Enterprise Edition — Copyright (c) 2026 Scalo. All rights reserved.
 * Licensed under the Scalo Enterprise License (see ee/LICENSE): source-available, NOT open source.
 * Production use requires a valid Scalo Enterprise subscription and license key.
 */
// Team and roles: invite collaborators on an account (admin, editor, read only) by email.
//
// A member is a regular `users` row with his own email / password, attached to ONE account by `account_members`.
// When he signs in, requireAuth (core) asks `resolveActor`: the request then runs on behalf of the account
// (`req.userId` = account, `req.actorId` = member, `req.role`), and the core's generic rule (api/src/access.ts)
// enforces the role on every route.
import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { esc, ACCOUNT_ROLE_LABELS, type AccountRole } from '@scalo/shared';
import { db, isUniqueViolation, type Db } from '../../../api/src/db';
import { deliver, getSettingsRow } from '../../../api/src/services/email';
import { enforce, LIMITS } from '../../../api/src/services/ratelimit';
import { HttpError, notFound, paramId, PUBLIC_URL, signToken, uid } from '../../../api/src/util';
import type { InvitationCreated, InvitationPreview, Team, TeamInvitation } from '../../shared/types';
import { recordAudit } from './audit';
import { actorOf, requireAdmin, requireFeature, roleOf } from './common';
import { license } from './license/service';

const INVITATION_TTL_MS = 7 * 86_400_000;
const TEAM_LICENSE_REQUIRED = 'L’accès des collaborateurs nécessite une licence Entreprise valide. Contactez le propriétaire du compte.';

const newToken = () => `scalo_inv_${crypto.randomBytes(32).toString('base64url')}`;
const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
const inviteUrl = (token: string) => `${PUBLIC_URL}/invite/${token}`;

/** Session user → account he works for (core hook). A member without the `team` license cannot sign in; the owner always can. */
export async function resolveActor(userId: number): Promise<{ accountId: number; role: AccountRole } | null> {
  const m = await db.selectFrom('account_members').select(['account_id', 'role']).where('user_id', '=', userId).executeTakeFirst();
  if (!m) return null;
  if (!license.has('team')) throw new HttpError(403, TEAM_LICENSE_REQUIRED);
  return { accountId: m.account_id, role: m.role };
}

/** People counted against the seats of the license: owner + members + pending invitations. */
async function seatsUsed(accountId: number, ex: Db = db, { withInvitations = true } = {}): Promise<number> {
  const members = await ex.selectFrom('account_members').select((eb) => eb.fn.countAll<number>().as('n')).where('account_id', '=', accountId).executeTakeFirstOrThrow();
  if (!withInvitations) return 1 + members.n;
  const invitations = await ex
    .selectFrom('account_invitations')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('account_id', '=', accountId)
    .where('accepted_at', 'is', null)
    .where('expires_at', '>', new Date().toISOString())
    .executeTakeFirstOrThrow();
  return 1 + members.n + invitations.n;
}

const publicInvitation = (i: { id: number; email: string; role: TeamInvitation['role']; expires_at: string; created_at: string }): TeamInvitation => ({
  id: i.id,
  email: i.email,
  role: i.role,
  expires_at: i.expires_at,
  expired: Date.parse(i.expires_at) <= Date.now(),
  created_at: i.created_at,
});

async function sendInvitation(accountId: number, email: string, role: TeamInvitation['role'], url: string): Promise<boolean> {
  try {
    const [settings, account] = await Promise.all([getSettingsRow(accountId), db.selectFrom('users').select('name').where('id', '=', accountId).executeTakeFirst()]);
    const who = esc(account?.name || 'Un compte Scalo');
    const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;max-width:520px;margin:0 auto;padding:24px">
<p>Bonjour,</p>
<p><strong>${who}</strong> vous invite à rejoindre son espace de travail avec le rôle « ${esc(ACCOUNT_ROLE_LABELS[role])} ».</p>
<p><a href="${esc(url)}" style="display:inline-block;background:#5B4BFF;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:999px;font-weight:bold">Accepter l’invitation</a></p>
<p style="color:#64748b;font-size:13px">Ce lien est personnel, à usage unique et valable 7 jours. Si vous n’attendiez pas cette invitation, ignorez cet email.</p>
</div>`;
    const r = await deliver(settings, { to: email, subject: `${account?.name || 'Un compte'} vous invite à collaborer`, html });
    return r.ok && !r.dev;
  } catch {
    return false; // the link is also returned to the inviter
  }
}

// ---------- authenticated routes (owner / administrators) ----------

export const teamRouter = Router();

// Reading and removing stay possible without a license (housekeeping: nothing is ever locked in).
teamRouter.get('/team', async (req, res) => {
  requireAdmin(req);
  const accountId = uid(req);
  const [owner, members, invitations] = await Promise.all([
    db.selectFrom('users').select(['id', 'name', 'email']).where('id', '=', accountId).executeTakeFirstOrThrow(),
    db
      .selectFrom('account_members as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select(['m.id', 'm.user_id', 'u.name', 'u.email', 'm.role', 'm.created_at'])
      .where('m.account_id', '=', accountId)
      .orderBy('m.id')
      .execute(),
    db.selectFrom('account_invitations').select(['id', 'email', 'role', 'expires_at', 'created_at']).where('account_id', '=', accountId).where('accepted_at', 'is', null).orderBy('id', 'desc').execute(),
  ]);
  const team: Team = { owner, members, invitations: invitations.map(publicInvitation), seats: { used: await seatsUsed(accountId), limit: license.seats() } };
  res.json(team);
});

const inviteSchema = z.object({ email: z.email().max(254), role: z.enum(['admin', 'editor', 'viewer']) });

teamRouter.post('/team/invitations', async (req, res) => {
  requireAdmin(req);
  requireFeature('team');
  const accountId = uid(req);
  const body = inviteSchema.parse(req.body);
  const email = body.email.trim().toLowerCase();
  if (await db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst()) {
    throw new HttpError(409, 'Un compte existe déjà avec cet email : invitez une adresse qui n’a pas encore de compte');
  }
  const token = newToken();
  const row = await db.transaction().execute(async (trx) => {
    // re-inviting the same address replaces the previous (pending) invitation
    await trx.deleteFrom('account_invitations').where('account_id', '=', accountId).where('email', '=', email).where('accepted_at', 'is', null).execute();
    const limit = license.seats();
    if ((await seatsUsed(accountId, trx)) + 1 > limit) {
      throw new HttpError(409, `Tous les sièges de votre licence sont utilisés (${limit}). Retirez un membre ou une invitation, ou augmentez le nombre de sièges.`);
    }
    return trx
      .insertInto('account_invitations')
      .values({ account_id: accountId, email, role: body.role, token_hash: hashToken(token), invited_by: actorOf(req), expires_at: new Date(Date.now() + INVITATION_TTL_MS).toISOString(), created_at: new Date().toISOString() })
      .returning(['id', 'email', 'role', 'expires_at', 'created_at'])
      .executeTakeFirstOrThrow();
  });
  const url = inviteUrl(token);
  const out: InvitationCreated = { invitation: publicInvitation(row), invite_url: url, email_sent: await sendInvitation(accountId, email, body.role, url) };
  res.status(201).json(out);
});

/** New link (the previous one stops working) and a new 7-day validity. */
teamRouter.post('/team/invitations/:id/resend', async (req, res) => {
  requireAdmin(req);
  requireFeature('team');
  const accountId = uid(req);
  const token = newToken();
  const row = await db
    .updateTable('account_invitations')
    .set({ token_hash: hashToken(token), expires_at: new Date(Date.now() + INVITATION_TTL_MS).toISOString() })
    .where('id', '=', paramId(req.params.id, 'Invitation'))
    .where('account_id', '=', accountId)
    .where('accepted_at', 'is', null)
    .returning(['id', 'email', 'role', 'expires_at', 'created_at'])
    .executeTakeFirst();
  if (!row) throw notFound('Invitation');
  const url = inviteUrl(token);
  const out: InvitationCreated = { invitation: publicInvitation(row), invite_url: url, email_sent: await sendInvitation(accountId, row.email, row.role, url) };
  res.json(out);
});

teamRouter.delete('/team/invitations/:id', async (req, res) => {
  requireAdmin(req);
  const r = await db
    .deleteFrom('account_invitations')
    .where('id', '=', paramId(req.params.id, 'Invitation'))
    .where('account_id', '=', uid(req))
    .where('accepted_at', 'is', null)
    .executeTakeFirst();
  if (!r.numDeletedRows) throw notFound('Invitation');
  res.json({ ok: true });
});

async function memberOf(req: Request) {
  const m = await db.selectFrom('account_members').selectAll().where('id', '=', paramId(req.params.id, 'Membre')).where('account_id', '=', uid(req)).executeTakeFirst();
  if (!m) throw notFound('Membre');
  if (m.user_id === actorOf(req)) throw new HttpError(403, 'Vous ne pouvez pas modifier votre propre accès');
  // an administrator manages editors and read-only members; only the owner manages administrators
  if (roleOf(req) !== 'owner' && m.role === 'admin') throw new HttpError(403, 'Seul le propriétaire peut modifier un administrateur');
  return m;
}

teamRouter.patch('/team/members/:id', async (req, res) => {
  requireAdmin(req);
  requireFeature('team');
  const body = z.object({ role: z.enum(['admin', 'editor', 'viewer']) }).parse(req.body);
  const m = await memberOf(req);
  if (roleOf(req) !== 'owner' && body.role === 'admin') throw new HttpError(403, 'Seul le propriétaire peut nommer un administrateur');
  await db.updateTable('account_members').set({ role: body.role }).where('id', '=', m.id).execute();
  res.json({ ok: true });
});

/** Removes the member and his login (his `users` row only exists for this membership). */
teamRouter.delete('/team/members/:id', async (req, res) => {
  requireAdmin(req);
  const m = await memberOf(req);
  await db.deleteFrom('users').where('id', '=', m.user_id).execute(); // cascades to account_members
  res.json({ ok: true });
});

// ---------- public routes (invitation link) ----------

export const teamPublicRouter = Router();

const GONE = 'Cette invitation est introuvable, expirée ou déjà utilisée';

teamPublicRouter.get('/invitations/:token', async (req, res) => {
  const inv = await db
    .selectFrom('account_invitations as i')
    .innerJoin('users as u', 'u.id', 'i.account_id')
    .select(['i.email', 'i.role', 'i.expires_at', 'u.name as account_name'])
    .where('i.token_hash', '=', hashToken(String(req.params.token)))
    .where('i.accepted_at', 'is', null)
    .where('i.expires_at', '>', new Date().toISOString())
    .executeTakeFirst();
  if (!inv) throw new HttpError(404, GONE);
  res.json(inv satisfies InvitationPreview);
});

const acceptSchema = z.object({ name: z.string().trim().min(1).max(100), password: z.string().min(8).max(200) });

teamPublicRouter.post('/invitations/:token/accept', async (req, res) => {
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  await enforce(res, [[`invite:ip:${ip}`, LIMITS.registerIp]]);
  const body = acceptSchema.parse(req.body);
  if (!license.has('team')) throw new HttpError(403, TEAM_LICENSE_REQUIRED);
  const hash = await bcrypt.hash(body.password, 10);
  let out: { userId: number; accountId: number; role: TeamInvitation['role'] };
  try {
    out = await db.transaction().execute(async (trx) => {
      // single use: consumed atomically (a second click, or a concurrent one, finds nothing)
      const inv = await trx
        .updateTable('account_invitations')
        .set({ accepted_at: new Date().toISOString() })
        .where('token_hash', '=', hashToken(String(req.params.token)))
        .where('accepted_at', 'is', null)
        .where('expires_at', '>', new Date().toISOString())
        .returning(['account_id', 'email', 'role', 'invited_by'])
        .executeTakeFirst();
      if (!inv) throw new HttpError(404, GONE);
      if ((await seatsUsed(inv.account_id, trx, { withInvitations: false })) + 1 > license.seats()) {
        throw new HttpError(409, 'Tous les sièges de la licence de ce compte sont utilisés. Contactez la personne qui vous a invité.');
      }
      const user = await trx.insertInto('users').values({ email: inv.email, password_hash: hash, name: body.name, created_at: new Date().toISOString() }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('account_members').values({ account_id: inv.account_id, user_id: user.id, role: inv.role, invited_by: inv.invited_by, created_at: new Date().toISOString() }).execute();
      return { userId: user.id, accountId: inv.account_id, role: inv.role };
    });
  } catch (e) {
    // the transaction is rolled back: the invitation stays usable
    if (isUniqueViolation(e, 'users_email_key')) throw new HttpError(409, 'Un compte existe déjà avec cet email : connectez-vous, ou demandez une invitation sur une autre adresse');
    throw e;
  }
  if (license.has('audit_log')) {
    void recordAudit({ accountId: out.accountId, actorId: out.userId, role: out.role, action: 'team.invitation_accepted', method: 'POST', path: '/invitations/accept', resourceType: 'team', status: 201, ip });
  }
  const user = await db.selectFrom('users').select(['id', 'email', 'name', 'created_at']).where('id', '=', out.userId).executeTakeFirstOrThrow();
  res.status(201).json({ token: signToken(out.userId), user });
});

/** Housekeeping: invitations expired for more than 30 days. */
export async function purgeInvitations() {
  await db.deleteFrom('account_invitations').where('accepted_at', 'is', null).where('expires_at', '<', new Date(Date.now() - 30 * 86_400_000).toISOString()).execute();
}
