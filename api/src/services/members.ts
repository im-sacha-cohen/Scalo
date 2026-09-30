// Members area authentication: magic link sent by email (hashed one-time token, short expiry) and the member session
// (signed httpOnly cookie scoped to `/m/<slug>`, unrelated to the admin session which is a JWT in the app).
import crypto from 'node:crypto';
import { DEFAULT_EMAIL_SETTINGS, esc, uid as blockId, type Block, type PageContent } from '@scalo/shared';
import { db, nowIso, type ContactRow } from '../db';
import { hmac, PUBLIC_URL } from '../util';
import { areaPath, type AreaRow } from './courses';
import { getSettingsRow, renderEmail } from './email';
import type { Limit } from './ratelimit';

export const LOGIN_TTL_MS = 20 * 60_000;
export const SESSION_TTL_MS = 30 * 86400_000;
export const SESSION_COOKIE = 'scalo_member';
export const PREVIEW_COOKIE = 'scalo_member_preview';

const MIN15 = 15 * 60_000;
export const MEMBER_LIMITS = {
  /** magic link requests per IP and members area */
  loginIp: { max: 10, windowMs: MIN15 },
  /** magic link emails per address and members area (beyond: silently not sent, same response) */
  loginEmail: { max: 3, windowMs: MIN15 },
} satisfies Record<string, Limit>;

export const hashLoginToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const TOKEN_RE = /^[\w-]{20,100}$/;

// ---------- session cookie ----------

/** `<contact>.<expiry>.<hmac>`: bound to the account, so a session of one members area is worthless on another. */
export function signSession(userId: number, contactId: number, now = Date.now()) {
  const exp = now + SESSION_TTL_MS;
  return `${contactId}.${exp.toString(36)}.${hmac('member', `${userId}:${contactId}:${exp}`)}`;
}

/** Contact id of a valid session cookie of this account, null otherwise. */
export function verifySession(userId: number, value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{1,15})\.([0-9a-z]{1,12})\.([\w-]+)$/.exec(value);
  if (!m) return null;
  const exp = parseInt(m[2], 36);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  const expected = Buffer.from(hmac('member', `${userId}:${m[1]}:${exp}`));
  const given = Buffer.from(m[3]);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  return Number(m[1]);
}

export const memberCookieOptions = (area: Pick<AreaRow, 'slug'>, maxAge: number) => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: PUBLIC_URL.startsWith('https://'),
  maxAge,
  path: areaPath(area),
});

// ---------- magic link ----------

export const loginUrl = (area: Pick<AreaRow, 'slug'>, token: string) => `${PUBLIC_URL}${areaPath(area)}/auth/${token}`;

function loginEmail(area: AreaRow, contact: Pick<ContactRow, 'email' | 'first_name' | 'last_name' | 'phone'>, token: string) {
  const vars = { first_name: contact.first_name ?? '', last_name: contact.last_name ?? '', email: contact.email, phone: contact.phone ?? '' };
  const subject = `Votre lien de connexion — ${area.name}`;
  const hello = contact.first_name?.trim() ? `Bonjour ${contact.first_name.trim()},` : 'Bonjour,';
  const blocks: Block[] = [
    { id: blockId(), type: 'text', text: hello } as Block,
    { id: blockId(), type: 'text', text: `Cliquez sur le bouton ci-dessous pour vous connecter à votre espace membres « ${area.name} ».` } as Block,
    { id: blockId(), type: 'button', label: 'Accéder à mon espace', action: 'url', url: loginUrl(area, token), bg: area.color, style: { align: 'center' } } as Block,
    {
      id: blockId(),
      type: 'text',
      text: 'Ce lien est valable 20 minutes et ne peut être utilisé qu’une seule fois.',
      style: { align: 'center', color: '#64748b', fontSize: 13 },
    } as Block,
  ];
  const content: PageContent = { settings: { ...DEFAULT_EMAIL_SETTINGS, accent: area.color }, blocks };
  const footer = esc(
    `Vous recevez cet email car une connexion à l’espace membres « ${area.name} » a été demandée avec cette adresse. Si vous n’êtes pas à l’origine de cette demande, ignorez simplement cet email.`,
  );
  return { subject, html: renderEmail(content, subject, vars, footer) };
}

/**
 * Creates a one-time login token for the contact and queues the email. It goes through the send queue as a
 * pre-rendered, untracked, top-priority email (same path as double opt-in confirmations): the link is never rewritten
 * by click tracking and the worker retries temporary SMTP errors.
 */
export async function requestLoginLink(area: AreaRow, contact: ContactRow, redirectPath: string | null): Promise<void> {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = nowIso();
  const settings = await getSettingsRow(area.user_id);
  const { subject, html } = loginEmail(area, contact, token);
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('member_login_tokens')
      .values({
        user_id: area.user_id,
        contact_id: contact.id,
        token_hash: hashLoginToken(token),
        redirect_path: redirectPath,
        expires_at: new Date(Date.now() + LOGIN_TTL_MS).toISOString(),
        created_at: now,
      })
      .execute();
    await trx
      .insertInto('email_sends')
      .values({ user_id: settings.user_id, contact_id: contact.id, kind: 'confirmation', to_email: contact.email, subject, html, status: 'pending', send_at: now, created_at: now })
      .execute();
  });
}

// Work done after the response was sent (see the login route): tracked so that tests can wait for it.
const inflight = new Set<Promise<void>>();

/** Runs `work` in the background; failures are logged, never thrown. */
export function afterResponse(work: Promise<unknown>) {
  const tracked: Promise<void> = work
    .then(() => undefined)
    .catch((e) => console.error('[members] lien de connexion :', e instanceof Error ? e.message : e))
    .finally(() => inflight.delete(tracked));
  inflight.add(tracked);
}

export const settleLoginLinks = () => Promise.all([...inflight]).then(() => undefined);

export type LoginTokenState = 'invalid' | 'expired' | 'used' | 'pending';

/** State of a token of this account (read only: GET never authenticates anybody). */
export async function lookupLoginToken(userId: number, token: string): Promise<LoginTokenState> {
  if (!TOKEN_RE.test(token)) return 'invalid';
  const row = await db
    .selectFrom('member_login_tokens')
    .select(['used_at', 'expires_at'])
    .where('token_hash', '=', hashLoginToken(token))
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!row) return 'invalid';
  if (row.used_at) return 'used';
  return new Date(row.expires_at).getTime() <= Date.now() ? 'expired' : 'pending';
}

/** Consumes a token (atomic, single use). Returns the contact to log in, or null. */
export async function consumeLoginToken(userId: number, token: string): Promise<{ contactId: number; redirect: string | null } | null> {
  if (!TOKEN_RE.test(token)) return null;
  const now = nowIso();
  const row = await db
    .updateTable('member_login_tokens')
    .set({ used_at: now })
    .where('token_hash', '=', hashLoginToken(token))
    .where('user_id', '=', userId)
    .where('used_at', 'is', null)
    .where('expires_at', '>', now)
    .returning(['contact_id', 'redirect_path'])
    .executeTakeFirst();
  return row ? { contactId: row.contact_id, redirect: row.redirect_path } : null;
}

/** Removes tokens expired for more than a day (called opportunistically when a link is requested). */
export async function cleanupLoginTokens() {
  await db.deleteFrom('member_login_tokens').where('expires_at', '<', new Date(Date.now() - 86400_000).toISOString()).execute();
}
