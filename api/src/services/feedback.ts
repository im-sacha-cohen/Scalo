// Provider feedback (spam complaints, hard bounces) received on POST /api/webhooks/email/:provider/:secret.
// Formats: generic JSON, Amazon SES (through SNS), Postmark, Mailgun, Brevo. The per-account secret in the URL
// authenticates the call (SNS signatures are not verified: see README).
import { sql } from 'kysely';
import type { ComplaintStats } from '@scalo/shared';
import { db, type Db } from '../db';
import { flagBounce, flagComplaint, normEmail } from './contacts';

export const PROVIDERS = ['generic', 'ses', 'postmark', 'mailgun', 'brevo'] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface FeedbackEvent {
  type: 'complaint' | 'bounce';
  email: string;
  messageId?: string | null;
  sendId?: number | null; // our X-Scalo-Send-Id header, when the provider echoes the headers
}

export interface ParsedPayload {
  events: FeedbackEvent[];
  /** SNS subscription confirmation: URL to fetch to confirm the subscription. */
  subscribeUrl?: string;
}

/** Complaint rate above which the UI warns (0.1 %) and above which sending is paused (0.3 %, last 1000 sends). */
export const COMPLAINT_WARN_RATE = 0.001;
export const COMPLAINT_PAUSE_RATE = 0.003;
export const COMPLAINT_WINDOW = 1000;
/** Below this many sends in the window the rate is not meaningful (one complaint out of 20 = 5 %): no auto-pause. */
export const COMPLAINT_MIN_SENDS = 100;

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const cleanId = (v: unknown) => str(v).trim().replace(/^<|>$/g, '') || null;

function headerValue(headers: unknown, name: string): string | null {
  // SES: [{name, value}], Mailgun: {name: value}
  const lower = name.toLowerCase();
  if (Array.isArray(headers)) {
    const h = headers.find((x) => str(obj(x).name).toLowerCase() === lower);
    return h ? str(obj(h).value) || null : null;
  }
  for (const [k, v] of Object.entries(obj(headers))) if (k.toLowerCase() === lower) return str(v) || null;
  return null;
}

const sendIdFrom = (v: string | null) => (v && /^\d{1,15}$/.test(v.trim()) ? Number(v.trim()) : null);

function parseSesMessage(m: Record<string, unknown>): FeedbackEvent[] {
  const type = str(m.notificationType) || str(m.eventType);
  const mail = obj(m.mail);
  const messageId = cleanId(obj(mail.commonHeaders).messageId) ?? cleanId(mail.messageId);
  const sendId = sendIdFrom(headerValue(mail.headers, 'X-Scalo-Send-Id'));
  if (type === 'Complaint') {
    return arr(obj(m.complaint).complainedRecipients).map((r) => ({ type: 'complaint' as const, email: str(obj(r).emailAddress), messageId, sendId }));
  }
  if (type === 'Bounce') {
    const b = obj(m.bounce);
    if (str(b.bounceType) !== 'Permanent') return []; // transient bounces are retried by SES itself
    return arr(b.bouncedRecipients).map((r) => ({ type: 'bounce' as const, email: str(obj(r).emailAddress), messageId, sendId }));
  }
  return [];
}

const POSTMARK_HARD = new Set(['HardBounce', 'BadEmailAddress', 'ManuallyDeactivated', 'AddressChange']);
const BREVO_COMPLAINT = new Set(['spam', 'complaint']);
const BREVO_BOUNCE = new Set(['hard_bounce', 'hardBounce', 'invalid_email', 'invalid']);

/** Normalises a provider payload. Returns null when the payload is not understood. */
export function parsePayload(provider: Provider, body: unknown): ParsedPayload | null {
  const b = obj(body);
  switch (provider) {
    case 'generic': {
      const items = Array.isArray(body) ? body : arr(b.events).length ? arr(b.events) : [body];
      const events: FeedbackEvent[] = [];
      for (const it of items) {
        const o = obj(it);
        const type = str(o.type).toLowerCase();
        if (type !== 'complaint' && type !== 'bounce') continue;
        events.push({ type, email: str(o.email), messageId: cleanId(o.message_id), sendId: sendIdFrom(str(o.send_id) || (typeof o.send_id === 'number' ? String(o.send_id) : null)) });
      }
      return events.length ? { events } : null;
    }
    case 'ses': {
      // SNS envelope (HTTP/S subscription) or raw SES event (EventBridge, tests)
      const snsType = str(b.Type);
      if (snsType === 'SubscriptionConfirmation') return { events: [], subscribeUrl: str(b.SubscribeURL) };
      if (snsType === 'UnsubscribeConfirmation') return { events: [] };
      let msg: Record<string, unknown> = b;
      if (snsType === 'Notification') {
        try {
          msg = typeof b.Message === 'string' ? obj(JSON.parse(b.Message)) : obj(b.Message);
        } catch {
          return null;
        }
      } else if (b.detail) msg = obj(b.detail);
      const events = parseSesMessage(msg);
      return events.length || snsType === 'Notification' ? { events } : null;
    }
    case 'postmark': {
      const items = Array.isArray(body) ? body : [body];
      const events: FeedbackEvent[] = [];
      for (const it of items) {
        const o = obj(it);
        const record = str(o.RecordType);
        const type = str(o.Type);
        const base = { email: str(o.Email), messageId: cleanId(o.MessageID) };
        if (record === 'SpamComplaint' || type === 'SpamComplaint') events.push({ type: 'complaint', ...base });
        else if (record === 'Bounce' && POSTMARK_HARD.has(type)) events.push({ type: 'bounce', ...base });
      }
      return events.length || items.some((i) => obj(i).RecordType) ? { events } : null;
    }
    case 'mailgun': {
      const ev = obj(b['event-data']);
      const event = str(ev.event);
      if (!event) return null;
      const headers = obj(obj(ev.message).headers);
      const base = { email: str(ev.recipient), messageId: cleanId(headerValue(headers, 'message-id')), sendId: sendIdFrom(headerValue(headers, 'x-scalo-send-id')) };
      if (event === 'complained') return { events: [{ type: 'complaint', ...base }] };
      if (event === 'failed' && str(ev.severity) === 'permanent') return { events: [{ type: 'bounce', ...base }] };
      return { events: [] };
    }
    case 'brevo': {
      const items = Array.isArray(body) ? body : [body];
      const events: FeedbackEvent[] = [];
      for (const it of items) {
        const o = obj(it);
        const event = str(o.event);
        const base = { email: str(o.email), messageId: cleanId(o['message-id'] ?? o.message_id) };
        if (BREVO_COMPLAINT.has(event)) events.push({ type: 'complaint', ...base });
        else if (BREVO_BOUNCE.has(event)) events.push({ type: 'bounce', ...base });
      }
      return events.length || items.some((i) => obj(i).event) ? { events } : null;
    }
  }
}

/** SNS SubscribeURL must be an https URL of an AWS endpoint (never fetch anything else: SSRF). */
export function isAwsSubscribeUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') && /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/i.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Applies one event to the account: finds the send (our send id, then the provider message id, then the last email
 * sent to that address) and the contact, then flags the complaint / bounce. Returns what was done.
 */
export async function recordFeedback(userId: number, ev: FeedbackEvent, provider: string, ex: Db = db): Promise<'complaint' | 'bounce' | 'duplicate' | 'unknown'> {
  const email = normEmail(ev.email || '');
  let send: { id: number; contact_id: number | null } | undefined;
  if (ev.sendId) {
    send = await ex.selectFrom('email_sends').select(['id', 'contact_id']).where('id', '=', ev.sendId).where('user_id', '=', userId).executeTakeFirst();
  }
  if (!send && ev.messageId) {
    send = await ex.selectFrom('email_sends').select(['id', 'contact_id']).where('user_id', '=', userId).where('message_id', '=', ev.messageId).executeTakeFirst();
  }
  let contactId = send?.contact_id ?? null;
  if (!contactId && email) {
    const c = await ex.selectFrom('contacts').select('id').where('user_id', '=', userId).where('email', '=', email).executeTakeFirst();
    contactId = c?.id ?? null;
  }
  if (!contactId) return 'unknown';
  if (!send) {
    send = await ex
      .selectFrom('email_sends')
      .select(['id', 'contact_id'])
      .where('user_id', '=', userId)
      .where('contact_id', '=', contactId)
      .where('status', '=', 'sent')
      .where('is_test', '=', false)
      .orderBy('sent_at', 'desc')
      .limit(1)
      .executeTakeFirst();
  }
  if (ev.type === 'bounce') {
    return (await flagBounce(userId, contactId, `Bounce signalé par ${provider}`, ex)) ? 'bounce' : 'duplicate';
  }
  const done = await flagComplaint(userId, contactId, send?.id ?? null, provider, ex);
  if (done) await enforceComplaintRate(userId, ex);
  return done ? 'complaint' : 'duplicate';
}

export async function complaintStats(userId: number, ex: Db = db): Promise<ComplaintStats> {
  const { rows } = await sql<{ sent_30d: number; complaints_30d: number; window_sends: number; window_complaints: number }>`
    SELECT
      (SELECT COUNT(*) FROM email_sends WHERE user_id = ${userId} AND status = 'sent' AND NOT is_test AND kind <> 'confirmation'
          AND sent_at >= now() - interval '30 days') AS sent_30d,
      (SELECT COUNT(*) FROM email_sends WHERE user_id = ${userId} AND NOT is_test AND complained_at >= now() - interval '30 days') AS complaints_30d,
      w.n AS window_sends, w.c AS window_complaints
    FROM (SELECT COUNT(*) AS n, COUNT(complained_at) AS c FROM (
            SELECT complained_at FROM email_sends WHERE user_id = ${userId} AND status = 'sent' AND NOT is_test
             ORDER BY sent_at DESC LIMIT ${COMPLAINT_WINDOW}) last) w`.execute(ex);
  const r = rows[0];
  return {
    ...r,
    rate_30d: r.sent_30d ? r.complaints_30d / r.sent_30d : 0,
    window_rate: r.window_sends ? r.window_complaints / r.window_sends : 0,
  };
}

/** Pauses the account's sending when complaints exceed 0.3 % of the last 1000 sends (min. 100 sends). */
export async function enforceComplaintRate(userId: number, ex: Db = db): Promise<boolean> {
  const st = await complaintStats(userId, ex);
  if (st.window_sends < COMPLAINT_MIN_SENDS || st.window_rate <= COMPLAINT_PAUSE_RATE) return false;
  const pct = (st.window_rate * 100).toLocaleString('fr-FR', { maximumFractionDigits: 2 });
  const r = await ex
    .updateTable('settings')
    .set({
      sending_paused: true,
      paused_reason: `Taux de plaintes pour spam trop élevé : ${pct} % sur les ${st.window_sends} derniers envois (${st.window_complaints} plainte${st.window_complaints > 1 ? 's' : ''}, seuil 0,3 %). Nettoyez votre liste et vérifiez le consentement de vos contacts (double opt-in), puis reprenez l’envoi.`,
    })
    .where('user_id', '=', userId)
    .where('sending_paused', '=', false)
    .executeTakeFirst();
  return Number(r.numUpdatedRows) > 0;
}
