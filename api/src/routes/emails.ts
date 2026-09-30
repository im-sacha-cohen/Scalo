import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import {
  applyVars,
  emailTemplate,
  type Broadcast,
  type Campaign,
  type CampaignEmail,
  type CampaignSubscriber,
  type EmailSend,
  type EmailStats,
  type PageContent,
  type QueueJob,
  type QueueState,
  type QueueStatus,
} from '@scalo/shared';
import { db, nowIso, type BroadcastRow, type CampaignEmailRow, type CampaignRow, type Db, type EmailSendRow } from '../db';
import { enrollInCampaign, getContactRow, stopSubscription } from '../services/contacts';
import { deliver, EXAMPLE_VARS, footerHtml, getSettingsRow, renderEmail, smtpConfigured } from '../services/email';
import { abResult, activeAb, broadcastSegment, recipients, startBroadcast } from '../services/broadcasts';
import { backfillEmail, refreshCompleted, rescheduleCampaign } from '../services/campaigns';
import { complaintStats } from '../services/feedback';
import { clearBackoff, dailyLimitResumeAt, getBackoffUntil, sentInLast24h } from '../worker';
import { HttpError, likeEscape, notFound, pageContentSchema, paramId, uid } from '../util';

export const emailsRouter = Router();

const emptyContent = (): PageContent => emailTemplate();
const subjectSchema = z.string().trim().min(1).max(250);
const tagIdSchema = z.number().int().positive().nullable();
const ALREADY_SENT = 'Cette newsletter a déjà été envoyée';
const SCHEDULE_MIN_MS = 60_000;
const SCHEDULE_MAX_MS = 365 * 86400_000;

const EMPTY_STATS: EmailStats = { sent: 0, opened: 0, clicked: 0, pending: 0, sending: 0, failed: 0 };

const abTestSchema = z
  .object({
    subjects: z.array(z.string().trim().max(250)).min(1).max(2),
    test_percent: z.number().int().min(5).max(50).default(20),
    wait_hours: z.number().min(0.25).max(72).default(4),
  })
  .refine((a) => a.subjects.filter(Boolean).length >= 1, { message: 'Ajoutez au moins un objet alternatif', path: ['subjects'] })
  .refine((a) => a.test_percent * (a.subjects.filter(Boolean).length + 1) <= 100, {
    message: 'La part de test par variante est trop grande pour le nombre de variantes',
    path: ['test_percent'],
  })
  .transform((a) => ({ ...a, subjects: a.subjects.filter(Boolean) }));

const conditionSchema = z
  .object({
    type: z.enum(['has_tag', 'not_has_tag', 'opened_previous', 'clicked_previous', 'not_opened_previous']),
    tag_id: z.number().int().positive().nullable().optional(),
    action: z.enum(['skip', 'stop']).default('skip'),
  })
  .refine((c) => (c.type !== 'has_tag' && c.type !== 'not_has_tag') || !!c.tag_id, { message: 'Choisissez un tag', path: ['tag_id'] })
  .transform((c) => ({ type: c.type, action: c.action, ...(c.type === 'has_tag' || c.type === 'not_has_tag' ? { tag_id: c.tag_id } : {}) }));

/** Delivery stats of several broadcasts / campaign emails in one query (`skipped`: campaign emails only). */
export async function statsFor(col: 'broadcast_id' | 'campaign_email_id', ids: number[]): Promise<Map<number, EmailStats>> {
  const map = new Map<number, EmailStats>();
  const campaign = col === 'campaign_email_id';
  for (const id of ids) map.set(id, campaign ? { ...EMPTY_STATS, skipped: 0 } : { ...EMPTY_STATS });
  if (!ids.length) return map;
  const { rows } = await sql<EmailStats & { key: number }>`
    SELECT ${sql.ref(col)} AS key,
      COUNT(*) FILTER (WHERE status = 'sent') AS sent,
      COUNT(*) FILTER (WHERE opened_at IS NOT NULL) AS opened,
      COUNT(*) FILTER (WHERE clicked_at IS NOT NULL) AS clicked,
      COUNT(*) FILTER (WHERE status = 'pending') AS pending,
      COUNT(*) FILTER (WHERE status = 'sending') AS sending,
      COUNT(*) FILTER (WHERE status = 'failed') AS failed,
      COUNT(*) FILTER (WHERE status = 'skipped') AS skipped
    FROM email_sends WHERE ${sql.ref(col)} = ANY(${ids}::bigint[]) AND NOT is_test
    GROUP BY 1`.execute(db);
  for (const { key, skipped, ...st } of rows) map.set(key, campaign ? { ...st, skipped } : st);
  return map;
}

async function assertTag(userId: number, tagId: number | null | undefined) {
  if (tagId == null) return;
  if (!(await db.selectFrom('tags').select('id').where('id', '=', tagId).where('user_id', '=', userId).executeTakeFirst())) throw notFound('Tag');
}

// ---------- broadcasts ----------

const toBroadcast = (r: BroadcastRow, stats?: EmailStats, ab?: Broadcast['ab']): Broadcast => ({
  id: r.id,
  subject: r.subject,
  content: r.content ?? emptyContent(),
  tag_id: r.tag_id,
  segment_id: r.segment_id,
  status: r.status,
  sent_at: r.sent_at,
  scheduled_at: r.scheduled_at,
  created_at: r.created_at,
  ab_test: activeAb(r),
  ...(stats ? { stats } : {}),
  ...(ab !== undefined ? { ab } : {}),
});

async function broadcastWithStats(r: BroadcastRow) {
  return toBroadcast(r, (await statsFor('broadcast_id', [r.id])).get(r.id), await abResult(r));
}

async function ownedBroadcast(userId: number, rawId: unknown, ex: Db = db) {
  const r = await ex.selectFrom('broadcasts').selectAll().where('id', '=', paramId(rawId, 'Newsletter')).where('user_id', '=', userId).executeTakeFirst();
  if (!r) throw notFound('Newsletter');
  return r;
}

emailsRouter.get('/broadcasts', async (req, res) => {
  const rows = await db.selectFrom('broadcasts').selectAll().where('user_id', '=', uid(req)).orderBy('created_at', 'desc').orderBy('id', 'desc').execute();
  const stats = await statsFor('broadcast_id', rows.map((r) => r.id));
  res.json(rows.map((r) => toBroadcast(r, stats.get(r.id))));
});

emailsRouter.post('/broadcasts', async (req, res) => {
  const userId = uid(req);
  // `content`: email chosen in the template gallery (a kit's email…), otherwise the plain default
  const { subject, content } = z.object({ subject: subjectSchema, content: pageContentSchema.optional() }).parse(req.body);
  const row = await db
    .insertInto('broadcasts')
    .values({ user_id: userId, subject, content: JSON.stringify(content ?? emailTemplate()), status: 'draft', created_at: nowIso() })
    .returningAll()
    .executeTakeFirstOrThrow();
  res.status(201).json(await broadcastWithStats(row));
});

emailsRouter.get('/broadcasts/:id', async (req, res) => {
  res.json(await broadcastWithStats(await ownedBroadcast(uid(req), req.params.id)));
});

// Editable while draft or scheduled (until the scheduled send starts).
emailsRouter.patch('/broadcasts/:id', async (req, res) => {
  const userId = uid(req);
  const b = await ownedBroadcast(userId, req.params.id);
  if (b.status === 'sent') throw new HttpError(409, ALREADY_SENT);
  const body = z
    .object({
      subject: subjectSchema.optional(),
      content: pageContentSchema.optional(),
      tag_id: tagIdSchema.optional(),
      segment_id: tagIdSchema.optional(),
      ab_test: abTestSchema.nullable().optional(),
    })
    .parse(req.body);
  await assertTag(userId, body.tag_id);
  if (body.segment_id && !(await db.selectFrom('segments').select('id').where('id', '=', body.segment_id).where('user_id', '=', userId).executeTakeFirst())) {
    throw notFound('Segment');
  }
  const updated = await db
    .updateTable('broadcasts')
    .set({
      subject: body.subject ?? b.subject,
      ...(body.content ? { content: JSON.stringify(body.content) } : {}),
      tag_id: body.tag_id === undefined ? b.tag_id : body.tag_id,
      segment_id: body.segment_id === undefined ? b.segment_id : body.segment_id,
      ...(body.ab_test !== undefined ? { ab_test: body.ab_test ? JSON.stringify(body.ab_test) : null } : {}),
    })
    .where('id', '=', b.id)
    .where('status', 'in', ['draft', 'scheduled']) // started meanwhile → no row
    .returningAll()
    .executeTakeFirst();
  if (!updated) throw new HttpError(409, ALREADY_SENT);
  res.json(await broadcastWithStats(updated));
});

emailsRouter.post('/broadcasts/:id/schedule', async (req, res) => {
  const userId = uid(req);
  const b = await ownedBroadcast(userId, req.params.id);
  if (b.status === 'sent') throw new HttpError(409, ALREADY_SENT);
  const { scheduled_at } = z.object({ scheduled_at: z.iso.datetime({ offset: true }) }).parse(req.body);
  const at = new Date(scheduled_at).getTime();
  if (!Number.isFinite(at) || at < Date.now() + SCHEDULE_MIN_MS) throw new HttpError(400, 'La date d’envoi doit être dans au moins 1 minute');
  if (at > Date.now() + SCHEDULE_MAX_MS) throw new HttpError(400, 'La date d’envoi ne peut pas dépasser 1 an');
  const row = await db
    .updateTable('broadcasts')
    .set({ status: 'scheduled', scheduled_at: new Date(at).toISOString() })
    .where('id', '=', b.id)
    .where('status', 'in', ['draft', 'scheduled'])
    .returningAll()
    .executeTakeFirst();
  if (!row) throw new HttpError(409, ALREADY_SENT);
  res.json(await broadcastWithStats(row));
});

emailsRouter.post('/broadcasts/:id/unschedule', async (req, res) => {
  const userId = uid(req);
  const b = await ownedBroadcast(userId, req.params.id);
  const row = await db
    .updateTable('broadcasts')
    .set({ status: 'draft', scheduled_at: null })
    .where('id', '=', b.id)
    .where('status', '=', 'scheduled') // already started → no row
    .returningAll()
    .executeTakeFirst();
  if (!row) throw new HttpError(409, b.status === 'sent' ? 'L’envoi de cette newsletter a déjà commencé' : 'Cette newsletter n’est pas programmée');
  res.json(await broadcastWithStats(row));
});

emailsRouter.delete('/broadcasts/:id', async (req, res) => {
  const b = await ownedBroadcast(uid(req), req.params.id);
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('email_sends').where('broadcast_id', '=', b.id).where('status', '=', 'pending').execute();
    await trx.deleteFrom('broadcasts').where('id', '=', b.id).execute();
  });
  res.json({ ok: true });
});

emailsRouter.get('/broadcasts/:id/recipients-count', async (req, res) => {
  const userId = uid(req);
  const b = await ownedBroadcast(userId, req.params.id);
  const tagId = req.query.tag_id !== undefined && req.query.tag_id !== '' ? paramId(req.query.tag_id, 'Tag') : b.tag_id;
  const segmentId = req.query.segment_id !== undefined ? (req.query.segment_id === '' ? null : paramId(req.query.segment_id, 'Segment')) : b.segment_id;
  const seg = await broadcastSegment({ user_id: userId, segment_id: segmentId });
  const { n } = await recipients(userId, tagId, undefined, seg)
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirstOrThrow();
  res.json({ count: n });
});

// "Envoyer maintenant" (also for a scheduled newsletter). Recipients are computed now.
emailsRouter.post('/broadcasts/:id/send', async (req, res) => {
  const userId = uid(req);
  const b = await ownedBroadcast(userId, req.params.id);
  if (b.status === 'sent') throw new HttpError(409, ALREADY_SENT);
  const sent = await db.transaction().execute(async (trx) => {
    // draft|scheduled → sent first: a concurrent second click (or the scheduler) finds no row → 409, never queued twice
    const row = await trx
      .updateTable('broadcasts')
      .set({ status: 'sent', sent_at: nowIso() })
      .where('id', '=', b.id)
      .where('status', 'in', ['draft', 'scheduled'])
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new HttpError(409, ALREADY_SENT);
    await startBroadcast(trx, row);
    return row;
  });
  res.json(await broadcastWithStats(await ownedBroadcast(userId, sent.id))); // re-read: A/B phase set by startBroadcast
});

emailsRouter.post('/broadcasts/:id/test', async (req, res) => {
  const userId = uid(req);
  const b = await ownedBroadcast(userId, req.params.id);
  const { email } = z.object({ email: z.email() }).parse(req.body);
  const settings = await getSettingsRow(userId);
  const contact = await db
    .selectFrom('contacts')
    .select(['first_name', 'last_name', 'phone'])
    .where('user_id', '=', userId)
    .where('email', '=', email.toLowerCase())
    .executeTakeFirst();
  const vars = contact
    ? { first_name: contact.first_name ?? '', last_name: contact.last_name ?? '', email, phone: contact.phone ?? '' }
    : { ...EXAMPLE_VARS, email };
  const subject = `[TEST] ${applyVars(b.subject, vars)}`;
  const html = renderEmail(b.content ?? emptyContent(), subject, vars, footerHtml(settings, '#'));
  const result = await deliver(settings, { to: email, subject, html });
  const now = nowIso();
  await db
    .insertInto('email_sends')
    .values({
      user_id: userId,
      is_test: true,
      kind: 'test',
      to_email: email,
      subject,
      html,
      status: result.ok ? 'sent' : 'failed',
      send_at: now,
      sent_at: result.ok ? now : null,
      error: result.ok ? null : result.error,
      created_at: now,
    })
    .execute();
  if (!result.ok) throw new HttpError(502, `Échec de l’envoi : ${result.error}`);
  res.json({ ok: true });
});

// ---------- campaigns ----------

async function ownedCampaign(userId: number, rawId: unknown) {
  const r = await db.selectFrom('campaigns').selectAll().where('id', '=', paramId(rawId, 'Campagne')).where('user_id', '=', userId).executeTakeFirst();
  if (!r) throw notFound('Campagne');
  return r;
}

async function ownedCampaignEmail(userId: number, rawId: unknown) {
  const r = await db
    .selectFrom('campaign_emails as e')
    .innerJoin('campaigns as c', 'c.id', 'e.campaign_id')
    .selectAll('e')
    .where('e.id', '=', paramId(rawId, 'Email'))
    .where('c.user_id', '=', userId)
    .executeTakeFirst();
  if (!r) throw notFound('Email');
  return r;
}

const toCampaignEmail = (r: CampaignEmailRow, stats?: EmailStats): CampaignEmail => {
  const base = { id: r.id, campaign_id: r.campaign_id, subject: r.subject, delay_days: r.delay_days, position: r.position, condition: r.condition ?? null };
  return (stats ? { ...base, content: r.content ?? emptyContent(), stats } : base) as CampaignEmail;
};

async function campaignEmailWithStats(r: CampaignEmailRow) {
  return toCampaignEmail(r, (await statsFor('campaign_email_id', [r.id])).get(r.id));
}

/** `full`: emails with content + stats (detail view); otherwise emails without content (list view). */
export async function toCampaigns(rows: CampaignRow[], full: boolean): Promise<Campaign[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [emails, subs] = await Promise.all([
    db
      .selectFrom('campaign_emails')
      .select(
        full
          ? ['id', 'campaign_id', 'subject', 'content', 'delay_days', 'position', 'condition']
          : ['id', 'campaign_id', 'subject', 'delay_days', 'position', 'condition'],
      )
      .where('campaign_id', 'in', ids)
      .orderBy('position')
      .orderBy('id')
      .execute() as Promise<CampaignEmailRow[]>,
    db
      .selectFrom('campaign_subscriptions')
      .select(['campaign_id', (eb) => eb.fn.countAll<number>().as('n')])
      .where('campaign_id', 'in', ids)
      .groupBy('campaign_id')
      .execute(),
  ]);
  const stats = full ? await statsFor('campaign_email_id', emails.map((e) => e.id)) : null;
  const subCount = new Map(subs.map((s) => [s.campaign_id, s.n]));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    trigger_tag_id: r.trigger_tag_id,
    stop_tag_id: r.stop_tag_id,
    created_at: r.created_at,
    subscribers: subCount.get(r.id) ?? 0,
    emails: emails.filter((e) => e.campaign_id === r.id).map((e) => toCampaignEmail(e, stats?.get(e.id))),
  }));
}

const toCampaign = async (r: CampaignRow, full: boolean) => (await toCampaigns([r], full))[0];

emailsRouter.get('/campaigns', async (req, res) => {
  const rows = await db.selectFrom('campaigns').selectAll().where('user_id', '=', uid(req)).orderBy('created_at', 'desc').orderBy('id', 'desc').execute();
  res.json(await toCampaigns(rows, false));
});

emailsRouter.post('/campaigns', async (req, res) => {
  const userId = uid(req);
  const body = z
    .object({ name: z.string().trim().min(1).max(120), trigger_tag_id: tagIdSchema.optional(), stop_tag_id: tagIdSchema.optional() })
    .parse(req.body);
  await assertTag(userId, body.trigger_tag_id);
  await assertTag(userId, body.stop_tag_id);
  const row = await db
    .insertInto('campaigns')
    .values({ user_id: userId, name: body.name, trigger_tag_id: body.trigger_tag_id ?? null, stop_tag_id: body.stop_tag_id ?? null, created_at: nowIso() })
    .returningAll()
    .executeTakeFirstOrThrow();
  res.status(201).json(await toCampaign(row, true));
});

emailsRouter.get('/campaigns/:id', async (req, res) => {
  res.json(await toCampaign(await ownedCampaign(uid(req), req.params.id), true));
});

emailsRouter.patch('/campaigns/:id', async (req, res) => {
  const userId = uid(req);
  const c = await ownedCampaign(userId, req.params.id);
  const body = z
    .object({ name: z.string().trim().min(1).max(120).optional(), trigger_tag_id: tagIdSchema.optional(), stop_tag_id: tagIdSchema.optional() })
    .parse(req.body);
  await assertTag(userId, body.trigger_tag_id);
  await assertTag(userId, body.stop_tag_id);
  const row = await db
    .updateTable('campaigns')
    .set({
      name: body.name ?? c.name,
      trigger_tag_id: body.trigger_tag_id === undefined ? c.trigger_tag_id : body.trigger_tag_id,
      stop_tag_id: body.stop_tag_id === undefined ? c.stop_tag_id : body.stop_tag_id,
    })
    .where('id', '=', c.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  res.json(await toCampaign(row, true));
});

emailsRouter.delete('/campaigns/:id', async (req, res) => {
  const c = await ownedCampaign(uid(req), req.params.id);
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('email_sends').where('campaign_id', '=', c.id).where('status', '=', 'pending').execute();
    await trx.deleteFrom('campaigns').where('id', '=', c.id).execute();
  });
  res.json({ ok: true });
});

/**
 * Adds an email at the end of the sequence. `apply_to_existing` (default true): existing active subscribers for whom
 * this email is already due (enrollment + cumulative delays in the past) get it now; false: they skip it. Subscribers
 * who have not reached it yet get it in both cases.
 */
emailsRouter.post('/campaigns/:id/emails', async (req, res) => {
  const userId = uid(req);
  const c = await ownedCampaign(userId, req.params.id);
  const body = z
    .object({
      subject: subjectSchema,
      delay_days: z.number().int().min(0).max(3650),
      condition: conditionSchema.nullable().optional(),
      content: pageContentSchema.optional(),
      apply_to_existing: z.boolean().default(true),
    })
    .parse(req.body);
  if (body.condition && 'tag_id' in body.condition) await assertTag(userId, body.condition.tag_id);
  const { row, backfilled } = await db.transaction().execute(async (trx) => {
    // serialise concurrent additions to the same campaign (positions)
    await sql`SELECT id FROM campaigns WHERE id = ${c.id} FOR UPDATE`.execute(trx);
    const row = await trx
      .insertInto('campaign_emails')
      .values({
        campaign_id: c.id,
        subject: body.subject,
        content: JSON.stringify(body.content ?? emailTemplate()),
        delay_days: body.delay_days,
        condition: body.condition ? JSON.stringify(body.condition) : null,
        position: sql<number>`(SELECT COALESCE(MAX(position), -1) + 1 FROM campaign_emails WHERE campaign_id = ${c.id})`,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const backfilled = await backfillEmail(c.id, row.id, body.apply_to_existing, trx);
    return { row, backfilled };
  });
  res.status(201).json({ ...(await campaignEmailWithStats(row)), backfilled });
});

emailsRouter.post('/campaigns/:id/emails/reorder', async (req, res) => {
  const userId = uid(req);
  const c = await ownedCampaign(userId, req.params.id);
  const { ids } = z.object({ ids: z.array(z.number().int().positive()).min(1).max(500) }).parse(req.body);
  const emails = await db.selectFrom('campaign_emails').select('id').where('campaign_id', '=', c.id).execute();
  const known = new Set(emails.map((e) => e.id));
  if (ids.length !== known.size || new Set(ids).size !== ids.length || !ids.every((id) => known.has(id))) {
    throw new HttpError(400, 'La liste doit contenir chaque email de la campagne une seule fois');
  }
  await db.transaction().execute(async (trx) => {
    for (const [position, id] of ids.entries()) await trx.updateTable('campaign_emails').set({ position }).where('id', '=', id).execute();
    await rescheduleCampaign(c.id, trx);
  });
  res.json(await toCampaign((await ownedCampaign(userId, c.id)), true));
});

emailsRouter.patch('/campaign-emails/:id', async (req, res) => {
  const userId = uid(req);
  const e = await ownedCampaignEmail(userId, req.params.id);
  const body = z
    .object({
      subject: subjectSchema.optional(),
      content: pageContentSchema.optional(),
      delay_days: z.number().int().min(0).max(3650).optional(),
      condition: conditionSchema.nullable().optional(),
    })
    .parse(req.body);
  if (body.condition && 'tag_id' in body.condition) await assertTag(userId, body.condition.tag_id);
  const row = await db.transaction().execute(async (trx) => {
    const row = await trx
      .updateTable('campaign_emails')
      .set({
        subject: body.subject ?? e.subject,
        ...(body.content ? { content: JSON.stringify(body.content) } : {}),
        delay_days: body.delay_days ?? e.delay_days,
        ...(body.condition !== undefined ? { condition: body.condition ? JSON.stringify(body.condition) : null } : {}),
      })
      .where('id', '=', e.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    // a new delay moves the pending emails of every subscriber (this one and the following ones)
    if (body.delay_days !== undefined && body.delay_days !== e.delay_days) await rescheduleCampaign(e.campaign_id, trx);
    // pending rows keep the subject for the outbox
    if (body.subject && body.subject !== e.subject) {
      await trx.updateTable('email_sends').set({ subject: body.subject }).where('campaign_email_id', '=', e.id).where('status', '=', 'pending').execute();
    }
    return row;
  });
  res.json(await campaignEmailWithStats(row));
});

emailsRouter.delete('/campaign-emails/:id', async (req, res) => {
  const e = await ownedCampaignEmail(uid(req), req.params.id);
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('email_sends').where('campaign_email_id', '=', e.id).where('status', '=', 'pending').execute();
    await trx.deleteFrom('campaign_emails').where('id', '=', e.id).execute();
    await sql`
      UPDATE campaign_emails ce SET position = o.pos
        FROM (SELECT id, (ROW_NUMBER() OVER (ORDER BY position, id) - 1)::int AS pos FROM campaign_emails WHERE campaign_id = ${e.campaign_id}) o
       WHERE ce.id = o.id AND ce.position IS DISTINCT FROM o.pos`.execute(trx);
    // the following emails lose this delay
    await rescheduleCampaign(e.campaign_id, trx);
    await refreshCompleted(e.campaign_id, trx);
  });
  res.json({ ok: true });
});

emailsRouter.post('/campaigns/:id/enroll', async (req, res) => {
  const userId = uid(req);
  const c = await ownedCampaign(userId, req.params.id);
  const { contact_id } = z.object({ contact_id: z.number().int().positive() }).parse(req.body);
  const contact = await getContactRow(userId, contact_id);
  if (!contact) throw notFound('Contact');
  if (!contact.confirmed_at) throw new HttpError(409, 'Ce contact n’a pas encore confirmé son inscription (double opt-in)');
  await enrollInCampaign(userId, c.id, contact_id);
  res.json({ ok: true });
});

const SUB_STATUSES = ['active', 'completed', 'stopped', 'unsubscribed'] as const;

emailsRouter.get('/campaigns/:id/subscribers', async (req, res) => {
  const userId = uid(req);
  const c = await ownedCampaign(userId, req.params.id);
  const q = z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(200).default(25),
      status: z.enum(SUB_STATUSES).optional().catch(undefined),
      search: z.string().trim().max(200).optional(),
    })
    .parse(req.query);
  let base = db.selectFrom('campaign_subscriptions as s').innerJoin('contacts as ct', 'ct.id', 's.contact_id').where('s.campaign_id', '=', c.id);
  if (q.status) base = base.where('s.status', '=', q.status);
  if (q.search) {
    const like = `%${likeEscape(q.search)}%`;
    base = base.where((eb) => eb.or([eb('ct.email', 'ilike', like), eb('ct.first_name', 'ilike', like), eb('ct.last_name', 'ilike', like)]));
  }
  const [{ n }, rows, totalEmails] = await Promise.all([
    base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
    base
      .select([
        's.contact_id',
        'ct.email',
        'ct.first_name',
        'ct.last_name',
        's.status',
        's.created_at as enrolled_at',
        's.stopped_reason',
        sql<number>`(SELECT COUNT(*) FROM email_sends es WHERE es.campaign_id = s.campaign_id AND es.contact_id = s.contact_id AND es.status = 'sent' AND NOT es.is_test)`.as('sent'),
        sql<number>`(SELECT COUNT(*) FROM email_sends es WHERE es.campaign_id = s.campaign_id AND es.contact_id = s.contact_id AND es.status = 'skipped' AND NOT es.is_test)`.as('skipped'),
        sql<string | null>`(SELECT MIN(es.send_at) FROM email_sends es WHERE es.campaign_id = s.campaign_id AND es.contact_id = s.contact_id AND es.status IN ('pending', 'sending') AND NOT es.is_test)`.as('next_send_at'),
      ])
      .orderBy('s.created_at', 'desc')
      .orderBy('s.id', 'desc')
      .limit(q.limit)
      .offset((q.page - 1) * q.limit)
      .execute(),
    db.selectFrom('campaign_emails').select((eb) => eb.fn.countAll<number>().as('n')).where('campaign_id', '=', c.id).executeTakeFirstOrThrow(),
  ]);
  const items: CampaignSubscriber[] = rows.map((r) => ({
    ...r,
    next_send_at: r.next_send_at ? new Date(r.next_send_at).toISOString() : null,
    total: totalEmails.n,
  }));
  res.json({ items, total: n });
});

emailsRouter.post('/campaigns/:id/subscribers/:contactId/unsubscribe', async (req, res) => {
  const userId = uid(req);
  const c = await ownedCampaign(userId, req.params.id);
  const contactId = paramId(req.params.contactId, 'Contact');
  const ok = await stopSubscription(userId, c.id, contactId, 'unsubscribed', 'Désinscrit de la campagne', db);
  if (!ok) {
    const exists = await db.selectFrom('campaign_subscriptions').select('status').where('campaign_id', '=', c.id).where('contact_id', '=', contactId).executeTakeFirst();
    if (!exists) throw notFound('Inscription');
    throw new HttpError(409, 'Ce contact n’est plus actif dans cette campagne');
  }
  res.json({ ok: true });
});

// ---------- outbox ----------

const SEND_COLS = [
  'id', 'to_email', 'subject', 'status', 'send_at', 'sent_at', 'opened_at', 'clicked_at', 'error', 'broadcast_id', 'campaign_id', 'is_test',
  'contact_id', 'attempts', 'kind', 'variant',
] as const;
type SendRow = Pick<EmailSendRow, (typeof SEND_COLS)[number]>;

const toSend = (r: SendRow): EmailSend & { contact_id: number | null } => ({
  id: r.id,
  to_email: r.to_email,
  subject: r.subject,
  status: r.status,
  attempts: r.attempts,
  send_at: r.send_at,
  sent_at: r.sent_at,
  opened_at: r.opened_at,
  clicked_at: r.clicked_at,
  error: r.error,
  contact_id: r.contact_id,
  kind: r.kind,
  variant: r.variant,
  source: r.is_test
    ? 'test'
    : r.kind === 'confirmation' || r.kind === 'order'
      ? r.kind
      : r.broadcast_id
        ? `broadcast:${r.broadcast_id}`
        : r.campaign_id
          ? `campaign:${r.campaign_id}`
          : 'deleted',
});

emailsRouter.get('/emails/outbox', async (req, res) => {
  const userId = uid(req);
  const q = z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      status: z.enum(['pending', 'sending', 'sent', 'failed', 'skipped']).optional().catch(undefined),
      broadcast_id: z.coerce.number().int().positive().optional().catch(undefined),
      search: z.string().trim().max(200).optional(),
    })
    .parse(req.query);
  let base = db.selectFrom('email_sends').where('user_id', '=', userId);
  if (q.status) base = base.where('status', '=', q.status);
  if (q.broadcast_id) base = base.where('broadcast_id', '=', q.broadcast_id);
  if (q.search) {
    const like = `%${likeEscape(q.search)}%`;
    base = base.where((eb) => eb.or([eb('to_email', 'ilike', like), eb('subject', 'ilike', like)]));
  }
  const [{ n }, rows] = await Promise.all([
    base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
    base
      .select(SEND_COLS)
      .orderBy('id', 'desc')
      .limit(q.limit)
      .offset((q.page - 1) * q.limit)
      .execute(),
  ]);
  res.json({ items: rows.map(toSend), total: n });
});

// ---------- sending queue (live tracking & control) ----------

async function queueStatus(userId: number): Promise<QueueStatus> {
  const settings = await getSettingsRow(userId);
  const [counts, sent24, jobRows, errors, upcoming, complaints] = await Promise.all([
    sql<{ due: number; scheduled: number; retrying: number; sending: number; failed_24h: number; sent_last_minute: number }>`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending' AND send_at <= now()) AS due,
        COUNT(*) FILTER (WHERE status = 'pending' AND send_at > now()) AS scheduled,
        COUNT(*) FILTER (WHERE status = 'pending' AND attempts > 0) AS retrying,
        COUNT(*) FILTER (WHERE status = 'sending') AS sending,
        COUNT(*) FILTER (WHERE status = 'failed' AND NOT is_test AND created_at >= now() - interval '24 hours') AS failed_24h,
        COUNT(*) FILTER (WHERE status = 'sent' AND NOT is_test AND sent_at >= now() - interval '1 minute') AS sent_last_minute
      FROM email_sends WHERE user_id = ${userId}`.execute(db),
    sentInLast24h(userId),
    sql<Omit<QueueJob, 'eta_seconds' | 'done'>>`
      SELECT b.id AS broadcast_id, b.subject, b.sent_at AS started_at, b.ab_phase, b.ab_decide_at,
        COUNT(s.id) AS total,
        COUNT(*) FILTER (WHERE s.status = 'sent') AS sent,
        COUNT(*) FILTER (WHERE s.status = 'failed') AS failed,
        COUNT(*) FILTER (WHERE s.status = 'pending') AS pending,
        COUNT(*) FILTER (WHERE s.status = 'sending') AS sending,
        COUNT(*) FILTER (WHERE s.opened_at IS NOT NULL) AS opened,
        COUNT(*) FILTER (WHERE s.clicked_at IS NOT NULL) AS clicked
      FROM broadcasts b JOIN email_sends s ON s.broadcast_id = b.id AND NOT s.is_test
      WHERE b.user_id = ${userId} AND b.status = 'sent'
      GROUP BY b.id
      HAVING COUNT(*) FILTER (WHERE s.status IN ('pending', 'sending')) > 0 OR b.sent_at >= now() - interval '24 hours' OR b.ab_phase = 'testing'
      ORDER BY b.sent_at DESC LIMIT 20`.execute(db),
    sql<{ error: string; count: number }>`
      SELECT error, COUNT(*) AS count FROM email_sends
      WHERE user_id = ${userId} AND NOT is_test AND error IS NOT NULL
        AND (status = 'failed' OR (status = 'pending' AND attempts > 0)) AND created_at >= now() - interval '24 hours'
      GROUP BY error ORDER BY count DESC LIMIT 5`.execute(db),
    db
      .selectFrom('broadcasts')
      .select(['id', 'subject', 'scheduled_at', 'tag_id', 'ab_test'])
      .where('user_id', '=', userId)
      .where('status', '=', 'scheduled')
      .orderBy('scheduled_at')
      .limit(20)
      .execute(),
    complaintStats(userId),
  ]);
  const c = counts.rows[0];
  const rate = Math.max(1, settings.rate_per_minute);
  const limit = settings.daily_limit;
  const remainingToday = limit > 0 ? Math.max(0, limit - sent24) : Infinity;

  const backoff = getBackoffUntil(userId);
  let state: QueueState = 'idle';
  let resumeAt: string | null = null;
  if (settings.sending_paused) state = 'paused';
  else if (backoff) { state = 'backoff'; resumeAt = new Date(backoff).toISOString(); }
  else if (c.due + c.sending > 0 && remainingToday === 0) { state = 'daily_limit'; resumeAt = await dailyLimitResumeAt(userId, limit); }
  else if (c.due + c.sending > 0) state = 'sending';

  // ETA: emails beyond today's quota wait for the window to free up (approximated to 24h per quota).
  const etaFor = (count: number) => {
    if (count <= 0) return 0;
    const now_ = Math.min(count, remainingToday);
    let eta = Math.ceil((now_ / rate) * 60);
    if (count > now_ && limit > 0) eta += Math.ceil((count - now_) / limit) * 86_400;
    return eta;
  };

  const jobs = jobRows.rows.map((j) => ({ ...j, done: j.pending + j.sending === 0 && j.ab_phase !== 'testing', eta_seconds: etaFor(j.pending + j.sending) }));

  return {
    state,
    paused_reason: settings.sending_paused ? settings.paused_reason || 'Envoi mis en pause manuellement' : null,
    resume_at: resumeAt,
    dev_mode: !smtpConfigured(settings),
    rate_per_minute: rate,
    daily_limit: limit,
    sent_24h: sent24,
    sent_last_minute: c.sent_last_minute,
    due: c.due,
    scheduled: c.scheduled,
    retrying: c.retrying,
    sending: c.sending,
    failed_24h: c.failed_24h,
    eta_seconds: etaFor(c.due + c.sending),
    jobs,
    recent_errors: errors.rows,
    upcoming: upcoming.map((u) => ({ broadcast_id: u.id, subject: u.subject, scheduled_at: u.scheduled_at!, tag_id: u.tag_id, ab: !!activeAb(u) })),
    complaints,
  };
}

emailsRouter.get('/emails/queue', async (req, res) => {
  res.json(await queueStatus(uid(req)));
});

emailsRouter.post('/emails/queue/pause', async (req, res) => {
  const userId = uid(req);
  await getSettingsRow(userId);
  await db.updateTable('settings').set({ sending_paused: true, paused_reason: 'Envoi mis en pause manuellement' }).where('user_id', '=', userId).execute();
  res.json(await queueStatus(userId));
});

emailsRouter.post('/emails/queue/resume', async (req, res) => {
  const userId = uid(req);
  await getSettingsRow(userId);
  await db.updateTable('settings').set({ sending_paused: false, paused_reason: '' }).where('user_id', '=', userId).execute();
  clearBackoff(userId);
  res.json(await queueStatus(userId));
});

emailsRouter.post('/emails/queue/retry-failed', async (req, res) => {
  const userId = uid(req);
  const { broadcast_id } = z.object({ broadcast_id: z.number().int().positive().optional() }).parse(req.body ?? {});
  // Failures worth retrying: not unsubscribed / bounced / cancelled / deleted source.
  const r = await sql`
    UPDATE email_sends s SET status = 'pending', send_at = now(), attempts = 0, error = NULL
      FROM contacts c
     WHERE c.id = s.contact_id AND s.user_id = ${userId}
       AND s.status = 'failed' AND NOT s.is_test
       AND (s.broadcast_id IS NOT NULL OR s.campaign_email_id IS NOT NULL)
       AND NOT c.unsubscribed AND NOT c.bounced AND COALESCE(s.error, '') NOT IN ('Annulé', 'unsubscribed')
       ${broadcast_id ? sql`AND s.broadcast_id = ${broadcast_id}` : sql``}`.execute(db);
  res.json({ count: Number(r.numAffectedRows ?? 0) });
});

emailsRouter.post('/emails/queue/cancel', async (req, res) => {
  const userId = uid(req);
  const { broadcast_id } = z.object({ broadcast_id: z.number().int().positive() }).parse(req.body ?? {});
  await ownedBroadcast(userId, broadcast_id);
  // an A/B test waiting for its winner is cancelled too (the remaining recipients will not get it)
  await db.updateTable('broadcasts').set({ ab_phase: 'done' }).where('id', '=', broadcast_id).where('ab_phase', '=', 'testing').execute();
  const r = await db
    .updateTable('email_sends')
    .set({ status: 'failed', error: 'Annulé' })
    .where('user_id', '=', userId)
    .where('broadcast_id', '=', broadcast_id)
    .where('status', '=', 'pending')
    .executeTakeFirst();
  res.json({ count: Number(r.numUpdatedRows) });
});

emailsRouter.post('/emails/sends/:id/retry', async (req, res) => {
  const userId = uid(req);
  const id = paramId(req.params.id, 'Email');
  const row = await db
    .selectFrom('email_sends as s')
    .leftJoin('contacts as c', 'c.id', 's.contact_id')
    .select(['s.id', 's.status', 's.is_test', 'c.unsubscribed', 'c.bounced'])
    .where('s.id', '=', id)
    .where('s.user_id', '=', userId)
    .executeTakeFirst();
  if (!row) throw notFound('Email');
  if (row.status !== 'failed' || row.is_test) throw new HttpError(409, 'Seuls les envois en échec peuvent être relancés');
  if (row.unsubscribed == null) throw new HttpError(409, 'Le contact n’existe plus');
  if (row.unsubscribed) throw new HttpError(409, 'Ce contact est désinscrit');
  if (row.bounced) throw new HttpError(409, 'Cette adresse est invalide (bounce). Corrigez l’email du contact pour réessayer.');
  const updated = await db
    .updateTable('email_sends')
    .set({ status: 'pending', send_at: nowIso(), attempts: 0, error: null })
    .where('id', '=', id)
    .where('status', '=', 'failed')
    .returning(SEND_COLS)
    .executeTakeFirst();
  if (!updated) throw new HttpError(409, 'Seuls les envois en échec peuvent être relancés');
  res.json(toSend(updated));
});

emailsRouter.get('/emails/sends/:id/html', async (req, res) => {
  const userId = uid(req);
  const row = await db
    .selectFrom('email_sends')
    .select(['html', 'status'])
    .where('id', '=', paramId(req.params.id, 'Email'))
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!row) throw notFound('Email');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src * data:; style-src 'unsafe-inline'; frame-ancestors 'self'");
  res.send(
    row.html ??
      `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#64748b;padding:40px;text-align:center">Cet email n’a pas encore été envoyé (statut : ${row.status}).</body></html>`,
  );
});

// ---------- preview ----------

emailsRouter.post('/preview/email', async (req, res) => {
  const userId = uid(req);
  const body = z.object({ content: pageContentSchema, subject: z.string().max(250).default('') }).parse(req.body);
  const settings = await getSettingsRow(userId);
  const html = renderEmail(body.content as unknown as PageContent, applyVars(body.subject, EXAMPLE_VARS), EXAMPLE_VARS, footerHtml(settings, '#'));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});
