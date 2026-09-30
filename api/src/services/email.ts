import nodemailer from 'nodemailer';
import { esc, renderEmailDocument, type PageContent, type Settings } from '@scalo/shared';
import { db, type Db, type SettingsRow } from '../db';
import { PUBLIC_URL, signId } from '../util';
import { poweredByEmailHtml } from './branding';

export type { SettingsRow };

/** Settings of an account, created with defaults (sender = account name/email) on first access. */
export async function getSettingsRow(userId: number, ex: Db = db): Promise<SettingsRow> {
  const row = await ex.selectFrom('settings').selectAll().where('user_id', '=', userId).executeTakeFirst();
  if (row) return row;
  const user = await ex.selectFrom('users').select(['name', 'email']).where('id', '=', userId).executeTakeFirst();
  if (!user) throw new Error(`Utilisateur ${userId} introuvable`);
  await ex
    .insertInto('settings')
    .values({ user_id: userId, sender_name: user.name, sender_email: user.email })
    .onConflict((oc) => oc.column('user_id').doNothing())
    .execute();
  return ex.selectFrom('settings').selectAll().where('user_id', '=', userId).executeTakeFirstOrThrow();
}

export const smtpConfigured = (s: SettingsRow) => Boolean(s.smtp_host.trim());

/** Account settings as exposed by the API (password masked, webhook URL). */
export function publicSettings(s: SettingsRow): Settings {
  return {
    sender_name: s.sender_name,
    sender_email: s.sender_email,
    company_address: s.company_address,
    smtp_host: s.smtp_host,
    smtp_port: s.smtp_port,
    smtp_user: s.smtp_user,
    smtp_pass: '',
    smtp_secure: Boolean(s.smtp_secure),
    smtp_configured: smtpConfigured(s),
    rate_per_minute: s.rate_per_minute,
    daily_limit: s.daily_limit,
    double_optin_default: Boolean(s.double_optin_default),
    dkim_selectors: s.dkim_selectors,
    webhook_secret: s.webhook_secret ?? '',
    webhook_base_url: `${PUBLIC_URL}/api/webhooks/email`,
  };
}

/** Feedback-ID value for a send: `<source>:<account>:<type>:scalo` (Gmail Postmaster Tools groups complaints by it). */
export function feedbackId(s: { user_id: number; kind: string; broadcast_id: number | null; campaign_id?: number | null }) {
  const source = s.broadcast_id ? `b${s.broadcast_id}` : s.campaign_id ? `c${s.campaign_id}` : s.kind;
  return `${source}:${s.user_id}:${s.kind}:scalo`;
}

export const unsubscribeUrl = (contactId: number) => `${PUBLIC_URL}/u/${signId('unsub', contactId)}`;

export function footerHtml(settings: SettingsRow, unsubUrl: string) {
  const addr = settings.company_address.trim();
  return `${addr ? `${esc(addr).replace(/\n/g, '<br>')}<br><br>` : ''}Vous recevez cet email car vous êtes inscrit à notre liste.<br><a href="${esc(unsubUrl)}" style="color:#94a3b8;text-decoration:underline">Se désinscrire</a>${poweredByEmailHtml(settings.user_id)}`;
}

export const EXAMPLE_VARS = { first_name: 'Marie', last_name: 'Dupont', email: 'marie.dupont@exemple.fr', phone: '06 12 34 56 78' };

const unescapeAttr = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Rewrites http(s) links to the click tracker (except the unsubscribe link) and appends the open pixel. */
export function addTracking(html: string, sendId: number) {
  const unsubPrefix = `${PUBLIC_URL}/u/`;
  const out = html.replace(/href="(https?:\/\/[^"]+)"/gi, (m, raw: string) => {
    const url = unescapeAttr(raw);
    if (url.startsWith(unsubPrefix)) return m;
    return `href="${esc(`${PUBLIC_URL}/t/c/${sendId}?u=${encodeURIComponent(url)}`)}"`;
  });
  const pixel = `<img src="${PUBLIC_URL}/t/o/${sendId}.gif" width="1" height="1" alt="" style="border:0;width:1px;height:1px">`;
  return out.includes('</body>') ? out.replace('</body>', `${pixel}</body>`) : out + pixel;
}

export function renderEmail(content: PageContent, subject: string, vars: Record<string, string>, footer: string) {
  // baseUrl: uploaded images (/uploads/...) must be absolute in the recipient's mail client
  return renderEmailDocument(content, { subject, vars, footer, baseUrl: PUBLIC_URL });
}

// ---------- delivery ----------

export type DeliveryErrorKind =
  | 'auth'       // credentials refused: pause the whole queue, retrying is pointless
  | 'connection' // network / server unavailable / throttled: retry later, back off the account
  | 'temporary'  // 4xx for this message: retry later
  | 'recipient'  // 5xx on the recipient: hard bounce, never retry this address
  | 'permanent'; // other 5xx / invalid message

export type DeliveryResult = { ok: true; dev: boolean; messageId?: string } | { ok: false; error: string; kind: DeliveryErrorKind };

interface MailOptions {
  to: string;
  subject: string;
  html: string;
  unsubscribeUrl?: string; // adds RFC 8058 one-click unsubscribe headers
  sendId?: number;
  /** Feedback-ID header (Gmail feedback loop / complaint aggregation): `<campaign>:<customer>:<type>:<sender>`. */
  feedbackId?: string;
}

const transports = new Map<number, { key: string; transporter: ReturnType<typeof nodemailer.createTransport> }>();

const transportKey = (s: SettingsRow) => JSON.stringify([s.smtp_host, s.smtp_port, s.smtp_user, s.smtp_pass, s.smtp_secure]);

/** One pooled SMTP connection set per account, reused across sends and rebuilt when settings change. */
function getTransporter(s: SettingsRow) {
  const key = transportKey(s);
  const cur = transports.get(s.user_id);
  if (cur && cur.key === key) return cur.transporter;
  cur?.transporter.close();
  const transporter = nodemailer.createTransport({
    pool: true,
    maxConnections: 2,
    maxMessages: 100, // recycle the connection every 100 messages
    host: s.smtp_host,
    port: s.smtp_port,
    secure: Boolean(s.smtp_secure),
    auth: s.smtp_user ? { user: s.smtp_user, pass: s.smtp_pass } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  transports.set(s.user_id, { key, transporter });
  return transporter;
}

export function resetTransport(userId: number) {
  transports.get(userId)?.transporter.close();
  transports.delete(userId);
}

/** Closes every pooled SMTP connection (graceful shutdown, tests). */
export function closeAllTransports() {
  for (const id of [...transports.keys()]) resetTransport(id);
}

export function classifySmtpError(e: unknown): DeliveryErrorKind {
  const err = e as { code?: string; responseCode?: number; command?: string };
  const code = err.responseCode;
  if (err.code === 'EAUTH' || code === 535 || code === 534 || code === 530) return 'auth';
  if (code === 421 || code === 454) return 'connection';
  if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETLS'].includes(err.code ?? '')) return 'connection';
  if (code && code >= 400 && code < 500) return 'temporary';
  if (code && code >= 500) {
    // 550/551/553 on RCPT = mailbox unknown/refused; 552 on RCPT = mailbox full (still treated as a bounce)
    if (err.command === 'RCPT TO' || [550, 551, 553].includes(code)) return 'recipient';
    return 'permanent';
  }
  if (err.code === 'EENVELOPE') return 'recipient';
  return 'connection'; // unknown failures are most often transient
}

/** Plain-text alternative: improves deliverability and is shown by text-only clients. */
export function htmlToText(html: string) {
  return html
    .replace(/<(head|style|script)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<img[^>]*>/gi, '')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const text = label.replace(/<[^>]+>/g, '').trim();
      const url = unescapeAttr(href);
      return text && text !== url ? `${text} (${url})` : url;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|table|ul|ol)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function deliver(settings: SettingsRow, mail: MailOptions): Promise<DeliveryResult> {
  if (!smtpConfigured(settings)) return { ok: true, dev: true };
  try {
    const fromEmail = settings.sender_email || settings.smtp_user;
    const headers: Record<string, string> = {};
    if (mail.unsubscribeUrl) {
      headers['List-Unsubscribe'] = `<${mail.unsubscribeUrl}>`;
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    }
    if (mail.sendId) headers['X-Scalo-Send-Id'] = String(mail.sendId);
    if (mail.feedbackId) headers['Feedback-ID'] = mail.feedbackId;
    const info = await getTransporter(settings).sendMail({
      from: settings.sender_name ? { name: settings.sender_name, address: fromEmail } : fromEmail,
      to: mail.to,
      subject: mail.subject,
      html: mail.html,
      text: htmlToText(mail.html),
      headers,
    });
    const messageId = typeof info?.messageId === 'string' ? info.messageId.replace(/^<|>$/g, '') : undefined;
    return { ok: true, dev: false, messageId };
  } catch (e) {
    const kind = classifySmtpError(e);
    if (kind === 'auth' || kind === 'connection') resetTransport(settings.user_id);
    return { ok: false, error: e instanceof Error ? e.message : String(e), kind };
  }
}

/** Checks that the SMTP server accepts our connection and credentials. */
export async function verifySmtp(settings: SettingsRow) {
  resetTransport(settings.user_id);
  await getTransporter(settings).verify();
}
