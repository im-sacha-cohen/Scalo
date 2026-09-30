// Double opt-in: a form submission creates a pending request (hashed one-time token, 7 days) and queues a
// confirmation email with top priority. The tag / campaign of the form are applied only once the contact confirms
// (GET /c/:token shows a button, POST confirms — mail scanners prefetch links and must not confirm anybody).
import crypto from 'node:crypto';
import { DEFAULT_EMAIL_SETTINGS, uid as blockId, type Block, type PageContent } from '@scalo/shared';
import { db, inTx, nowIso, type ContactRow, type Db } from '../db';
import { PUBLIC_URL } from '../util';
import { addTag, enrollByTriggerTags, enrollInCampaign, getOrCreateTag, logEvent } from './contacts';
import { footerHtml, getSettingsRow, renderEmail, unsubscribeUrl } from './email';
import { hit, type Limit } from './ratelimit';

export const OPTIN_TTL_MS = 7 * 86400_000;
export const DEFAULT_OPTIN_SUBJECT = 'Confirmez votre inscription';
export const DEFAULT_OPTIN_TEXT =
  'Bonjour {{first_name}},\n' +
  'Merci pour votre inscription ! Pour commencer à recevoir nos emails, confirmez votre adresse en cliquant sur le bouton ci-dessous.\n' +
  'Si vous n’êtes pas à l’origine de cette demande, ignorez simplement cet email : vous ne recevrez rien d’autre.';

/** Confirmation emails per contact (form submissions + manual resends): protects people from being flooded. */
export const OPTIN_EMAIL_LIMIT: Limit = { max: 3, windowMs: 60 * 60_000 };
/** Manual "resend" from the contact page: at most once every 5 minutes per contact. */
export const RESEND_COOLDOWN_MS = 5 * 60_000;

export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
export const confirmUrl = (token: string) => `${PUBLIC_URL}/c/${token}`;

/** Only absolute http(s) URLs (or same-site paths) can be used as the post-confirmation redirect. */
export function safeRedirect(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim() || v.length > 2000) return null;
  const t = v.trim();
  if (t.startsWith('/') && !t.startsWith('//')) return t;
  try {
    const u = new URL(t);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function confirmationEmail(
  settings: Parameters<typeof footerHtml>[0],
  contact: Pick<ContactRow, 'id' | 'email' | 'first_name' | 'last_name' | 'phone'>,
  token: string,
  custom: { subject?: string | null; text?: string | null } = {},
) {
  const vars = { first_name: contact.first_name ?? '', last_name: contact.last_name ?? '', email: contact.email, phone: contact.phone ?? '' };
  const subjectTpl = custom.subject?.trim() || DEFAULT_OPTIN_SUBJECT;
  const subject = subjectTpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) => (vars as Record<string, string>)[k] ?? '').trim() || DEFAULT_OPTIN_SUBJECT;
  const paragraphs = (custom.text?.trim() || DEFAULT_OPTIN_TEXT).split(/\n+/).map((t) => t.trim()).filter(Boolean);
  const blocks: Block[] = [
    ...paragraphs.map((text): Block => ({ id: blockId(), type: 'text', text })),
    { id: blockId(), type: 'button', label: 'Confirmer mon inscription', action: 'url', url: confirmUrl(token), style: { align: 'center' } } as Block,
    { id: blockId(), type: 'text', text: 'Ce lien est valable 7 jours.', style: { align: 'center', color: '#64748b', fontSize: 13 } } as Block,
  ];
  const content: PageContent = { settings: { ...DEFAULT_EMAIL_SETTINGS }, blocks };
  const html = renderEmail(content, subject, vars, footerHtml(settings, unsubscribeUrl(contact.id)));
  return { subject, html };
}

export interface OptinRequest {
  userId: number;
  contact: ContactRow;
  tagName?: string | null;
  campaignId?: number | null;
  funnelId?: number | null;
  stepId?: number | null;
  redirectUrl?: string | null;
  subject?: string | null;
  text?: string | null;
}

/**
 * Stores the pending actions and queues the confirmation email (kind 'confirmation', claimed before every other
 * send). The email is not queued for bounced / complained addresses nor beyond OPTIN_EMAIL_LIMIT.
 */
export function requestOptin(req: OptinRequest, ex: Db = db): Promise<{ queued: boolean; optinId: number }> {
  return inTx(ex, async (trx) => {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = nowIso();
    const optin = await trx
      .insertInto('pending_optins')
      .values({
        user_id: req.userId,
        contact_id: req.contact.id,
        token_hash: hashToken(token),
        tag_name: req.tagName?.trim() || null,
        campaign_id: req.campaignId ?? null,
        funnel_id: req.funnelId ?? null,
        step_id: req.stepId ?? null,
        redirect_url: safeRedirect(req.redirectUrl),
        expires_at: new Date(Date.now() + OPTIN_TTL_MS).toISOString(),
        created_at: now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const queued = await queueConfirmation(req.userId, req.contact, token, optin.id, { subject: req.subject, text: req.text }, trx);
    return { queued, optinId: optin.id };
  });
}

async function queueConfirmation(
  userId: number,
  contact: ContactRow,
  token: string,
  optinId: number,
  custom: { subject?: string | null; text?: string | null },
  trx: Db,
  checkLimit = true,
) {
  if (contact.bounced || contact.complained) return false;
  if (checkLimit && (await hit(`doi:${contact.id}`, OPTIN_EMAIL_LIMIT)).blocked) return false;
  const settings = await getSettingsRow(userId, trx);
  const { subject, html } = confirmationEmail(settings, contact, token, custom);
  const now = nowIso();
  const send = await trx
    .insertInto('email_sends')
    .values({ user_id: userId, contact_id: contact.id, kind: 'confirmation', to_email: contact.email, subject, html, status: 'pending', send_at: now, created_at: now })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx.updateTable('pending_optins').set({ send_id: send.id }).where('id', '=', optinId).execute();
  await trx.updateTable('contacts').set({ confirmation_sent_at: now }).where('id', '=', contact.id).execute();
  await logEvent(userId, contact.id, 'confirmation_sent', { subject }, {}, trx);
  return true;
}

/**
 * "Renvoyer l'email de confirmation": re-issues the latest pending request of the contact with a new token (the old
 * link stops working) and queues a new email. Throws 'cooldown' / 'limited' / 'confirmed' errors for the route.
 */
export async function resendConfirmation(userId: number, contact: ContactRow): Promise<'queued' | 'confirmed' | 'cooldown' | 'limited' | 'undeliverable'> {
  if (contact.confirmed_at) return 'confirmed';
  if (contact.bounced || contact.complained) return 'undeliverable';
  if (contact.confirmation_sent_at && Date.now() - new Date(contact.confirmation_sent_at).getTime() < RESEND_COOLDOWN_MS) return 'cooldown';
  // checked before the token is replaced: a refused resend must not invalidate the link already sent
  if ((await hit(`doi:${contact.id}`, OPTIN_EMAIL_LIMIT)).blocked) return 'limited';
  return db.transaction().execute(async (trx) => {
    const token = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + OPTIN_TTL_MS).toISOString();
    const latest = await trx
      .selectFrom('pending_optins')
      .select(['id', 'step_id'])
      .where('contact_id', '=', contact.id)
      .where('confirmed_at', 'is', null)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    let optinId: number;
    if (latest) {
      await trx.updateTable('pending_optins').set({ token_hash: hashToken(token), expires_at: expires }).where('id', '=', latest.id).execute();
      optinId = latest.id;
    } else {
      optinId = (
        await trx
          .insertInto('pending_optins')
          .values({ user_id: userId, contact_id: contact.id, token_hash: hashToken(token), expires_at: expires, created_at: nowIso() })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    }
    // custom subject/text of the form the request came from
    const custom = await formTexts(latest?.step_id ?? null, trx);
    await queueConfirmation(userId, contact, token, optinId, custom, trx, false);
    return 'queued' as const;
  });
}

async function formTexts(stepId: number | null, ex: Db) {
  if (!stepId) return {};
  const step = await ex.selectFrom('steps').select('content').where('id', '=', stepId).executeTakeFirst();
  const find = (blocks: Block[]): Block | undefined => {
    for (const b of blocks ?? []) {
      if (b.type === 'form' && b.doubleOptin !== false && (b.doubleOptinSubject || b.doubleOptinText)) return b;
      const kids = b.type === 'section' ? b.children : b.type === 'columns' ? b.columns.flatMap((c) => c.children) : [];
      const f = find(kids);
      if (f) return f;
    }
    return undefined;
  };
  const f = step ? find(step.content?.blocks ?? []) : undefined;
  return f && f.type === 'form' ? { subject: f.doubleOptinSubject, text: f.doubleOptinText } : {};
}

export type OptinLookup =
  | { state: 'invalid' }
  | { state: 'expired' }
  | { state: 'confirmed'; redirect: string | null; email: string }
  | { state: 'pending'; email: string };

export async function lookupOptin(token: string): Promise<OptinLookup> {
  if (!/^[\w-]{20,100}$/.test(token)) return { state: 'invalid' };
  const row = await db
    .selectFrom('pending_optins as p')
    .innerJoin('contacts as c', 'c.id', 'p.contact_id')
    .select(['p.confirmed_at', 'p.expires_at', 'p.redirect_url', 'c.email'])
    .where('p.token_hash', '=', hashToken(token))
    .executeTakeFirst();
  if (!row) return { state: 'invalid' };
  if (row.confirmed_at) return { state: 'confirmed', redirect: row.redirect_url, email: row.email };
  if (new Date(row.expires_at).getTime() <= Date.now()) return { state: 'expired' };
  return { state: 'pending', email: row.email };
}

/**
 * Confirms a request (single use, atomic): contact confirmed (and re-subscribed: explicit consent), pending tag
 * applied (fires its campaign triggers), pending campaign enrollment, campaigns triggered by tags the contact already
 * had while unconfirmed, event `optin_confirmed`.
 */
export async function confirmOptin(token: string): Promise<OptinLookup> {
  if (!/^[\w-]{20,100}$/.test(token)) return { state: 'invalid' };
  const done = await db.transaction().execute(async (trx) => {
    const row = await trx
      .updateTable('pending_optins')
      .set({ confirmed_at: nowIso() })
      .where('token_hash', '=', hashToken(token))
      .where('confirmed_at', 'is', null)
      .where('expires_at', '>', nowIso())
      .returningAll()
      .executeTakeFirst();
    if (!row) return null;
    const contact = await trx
      .updateTable('contacts')
      .set({ confirmed_at: (eb) => eb.fn.coalesce('confirmed_at', eb.val(nowIso())), unsubscribed: false })
      .where('id', '=', row.contact_id)
      .returningAll()
      .executeTakeFirstOrThrow();
    const [funnel, step] = await Promise.all([
      row.funnel_id ? trx.selectFrom('funnels').select('name').where('id', '=', row.funnel_id).executeTakeFirst() : undefined,
      row.step_id ? trx.selectFrom('steps').select('name').where('id', '=', row.step_id).executeTakeFirst() : undefined,
    ]);
    await logEvent(row.user_id, contact.id, 'optin_confirmed', { funnel: funnel?.name, step: step?.name }, { funnel_id: row.funnel_id, step_id: row.step_id }, trx);
    await enrollByTriggerTags(row.user_id, contact.id, trx);
    if (row.tag_name) await addTag(row.user_id, contact.id, await getOrCreateTag(row.user_id, row.tag_name, trx), undefined, trx);
    if (row.campaign_id) await enrollInCampaign(row.user_id, row.campaign_id, contact.id, undefined, trx);
    return { redirect: row.redirect_url, email: contact.email };
  });
  if (done) return { state: 'confirmed', ...done };
  const cur = await lookupOptin(token);
  return cur.state === 'pending' ? { state: 'invalid' } : cur; // lost a race → report the stored state
}
