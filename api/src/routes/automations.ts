// Automations: CRUD + execution journal (session JWT, under /api) and the incoming webhook (public, /api/hooks).
import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Automation, AutomationAction, AutomationRun, AutomationTrigger } from '@scalo/shared';
import { db, nowIso, type Db } from '../db';
import { enqueueRun, newSecret, webhookUrl } from '../services/automations';
import { recordPurchase } from '../services/contact-actions';
import { upsertContact } from '../services/contacts';
import { fieldDefMap, validateFields } from '../services/fields';
import { hit, type Limit } from '../services/ratelimit';
import { parseFilter } from '../services/segments';
import { webhookUrlError } from '../services/webhook-http';
import { HttpError, notFound, paramId, uid } from '../util';

export const automationsRouter = Router();

const MAX_AUTOMATIONS = 200;
/** Incoming webhook calls per automation. */
export const HOOK_LIMIT: Limit = { max: 60, windowMs: 60_000 };

// ---------- validation ----------

const id = z.number().int().positive();
const optId = id.nullable().optional().transform((v) => v ?? null);

const triggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('optin'), funnel_id: optId, step_id: optId }),
  z.object({ type: z.literal('contact_created') }),
  z.object({ type: z.literal('tag_added'), tag_id: id }),
  z.object({ type: z.literal('tag_removed'), tag_id: id }),
  z.object({
    type: z.literal('link_clicked'),
    url_contains: z.string().trim().max(500).nullable().optional().transform((v) => v || null),
    broadcast_id: optId,
    campaign_id: optId,
  }),
  z.object({ type: z.literal('purchase'), product: z.string().trim().max(200).nullable().optional().transform((v) => v || null) }),
  z.object({ type: z.literal('campaign_completed'), campaign_id: optId }),
  z.object({ type: z.literal('course_completed'), course_id: optId }),
  z.object({ type: z.literal('affiliate_approved') }),
  z.object({ type: z.literal('webhook') }),
]);

const fieldValue = z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]);
const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('add_tag'), tag_id: id }),
  z.object({ type: z.literal('remove_tag'), tag_id: id }),
  z.object({ type: z.literal('enroll'), campaign_id: id }),
  z.object({ type: z.literal('unenroll'), campaign_id: id }),
  z.object({ type: z.literal('set_field'), key: z.string().min(1).max(40), value: fieldValue }),
  z.object({ type: z.literal('unsubscribe') }),
  z.object({ type: z.literal('webhook'), url: z.string().trim().min(1).max(2000) }),
  z.object({ type: z.literal('wait'), amount: z.number().int().min(1).max(365), unit: z.enum(['minutes', 'hours', 'days']) }),
]);

const bodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().optional(),
  trigger: triggerSchema,
  conditions: z.unknown().nullable().optional(),
  actions: z.array(actionSchema).max(20),
  run_once: z.boolean().optional(),
});

async function assertOwned(userId: number, table: 'tags' | 'funnels' | 'campaigns' | 'broadcasts' | 'steps' | 'courses', ids: (number | null | undefined)[], label: string, ex: Db = db) {
  const list = [...new Set(ids.filter((v): v is number => typeof v === 'number'))];
  if (!list.length) return;
  const n =
    table === 'steps'
      ? (await ex.selectFrom('steps as s').innerJoin('funnels as f', 'f.id', 's.funnel_id').select('s.id').where('f.user_id', '=', userId).where('s.id', 'in', list).execute()).length
      : (await ex.selectFrom(table).select('id').where('user_id', '=', userId).where('id', 'in', list).execute()).length;
  if (n !== list.length) throw new HttpError(404, `${label} introuvable`);
}

/** Ownership of every reference, field values, webhook URLs; normalized conditions. */
async function validate(userId: number, body: z.infer<typeof bodySchema>) {
  const t = body.trigger as AutomationTrigger;
  await assertOwned(userId, 'tags', [t.type === 'tag_added' || t.type === 'tag_removed' ? t.tag_id : null], 'Tag du déclencheur');
  await assertOwned(userId, 'funnels', [t.type === 'optin' ? t.funnel_id : null], 'Tunnel du déclencheur');
  await assertOwned(userId, 'steps', [t.type === 'optin' ? t.step_id : null], 'Étape du déclencheur');
  await assertOwned(userId, 'broadcasts', [t.type === 'link_clicked' ? t.broadcast_id : null], 'Newsletter du déclencheur');
  await assertOwned(userId, 'campaigns', [t.type === 'link_clicked' || t.type === 'campaign_completed' ? t.campaign_id : null], 'Campagne du déclencheur');
  await assertOwned(userId, 'courses', [t.type === 'course_completed' ? t.course_id : null], 'Formation du déclencheur');
  const actions = body.actions as AutomationAction[];
  await assertOwned(userId, 'tags', actions.map((a) => (a.type === 'add_tag' || a.type === 'remove_tag' ? a.tag_id : null)), 'Tag d’une action');
  await assertOwned(userId, 'campaigns', actions.map((a) => (a.type === 'enroll' || a.type === 'unenroll' ? a.campaign_id : null)), 'Campagne d’une action');
  const defs = await fieldDefMap(userId);
  for (const a of actions) {
    if (a.type === 'set_field') {
      if (!defs.has(a.key)) throw new HttpError(404, `Champ « ${a.key} » introuvable`);
      validateFields(defs, { [a.key]: a.value });
    }
    if (a.type === 'webhook') {
      const err = webhookUrlError(a.url);
      if (err) throw new HttpError(400, `Webhook : ${err}`);
    }
  }
  const conditions = body.conditions ? await parseFilter(userId, body.conditions) : null;
  return { trigger: t, actions, conditions: conditions && conditions.conditions.length ? conditions : null };
}

// ---------- serialization ----------

type Row = Awaited<ReturnType<typeof ownedAutomation>>;

async function toAutomations(rows: Row[]): Promise<Automation[]> {
  const ids = rows.map((r) => r.id);
  const stats = ids.length
    ? await db
        .selectFrom('automation_runs')
        .select((eb) => [
          'automation_id',
          sql<number>`COUNT(*) FILTER (WHERE created_at > now() - interval '30 days' AND status <> 'skipped')`.as('runs_30d'),
          sql<number>`COUNT(*) FILTER (WHERE created_at > now() - interval '30 days' AND status = 'completed')`.as('completed_30d'),
          sql<number>`COUNT(*) FILTER (WHERE created_at > now() - interval '30 days' AND status = 'failed')`.as('failed_30d'),
          sql<number>`COUNT(*) FILTER (WHERE status = 'waiting')`.as('waiting'),
          eb.fn.countAll<number>().as('total'),
        ])
        .where('automation_id', 'in', ids)
        .groupBy('automation_id')
        .execute()
    : [];
  return rows.map((r) => {
    const s = stats.find((x) => x.automation_id === r.id);
    return {
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      trigger: r.trigger,
      conditions: r.conditions,
      actions: r.actions,
      run_once: r.run_once,
      webhook_url: r.trigger_type === 'webhook' && r.webhook_token ? webhookUrl(r.webhook_token) : null,
      signing_secret: r.signing_secret,
      stats: { runs_30d: Number(s?.runs_30d ?? 0), completed_30d: Number(s?.completed_30d ?? 0), failed_30d: Number(s?.failed_30d ?? 0), waiting: Number(s?.waiting ?? 0) },
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  });
}

function automationRows(userId: number) {
  return db.selectFrom('automations').selectAll().where('user_id', '=', userId);
}

async function ownedAutomation(userId: number, raw: unknown) {
  const a = await automationRows(userId).where('id', '=', paramId(raw, 'Automatisation')).executeTakeFirst();
  if (!a) throw notFound('Automatisation');
  return a;
}

// ---------- routes ----------

automationsRouter.get('/automations', async (req, res) => {
  res.json(await toAutomations(await automationRows(uid(req)).orderBy('created_at', 'desc').orderBy('id', 'desc').execute()));
});

automationsRouter.post('/automations', async (req, res) => {
  const userId = uid(req);
  const body = bodySchema.parse(req.body);
  const v = await validate(userId, body);
  const n = await db.selectFrom('automations').select((eb) => eb.fn.countAll<number>().as('n')).where('user_id', '=', userId).executeTakeFirstOrThrow();
  if (n.n >= MAX_AUTOMATIONS) throw new HttpError(409, `${MAX_AUTOMATIONS} automatisations maximum`);
  const row = await db
    .insertInto('automations')
    .values({
      user_id: userId,
      name: body.name,
      enabled: body.enabled ?? false,
      trigger_type: v.trigger.type,
      trigger: JSON.stringify(v.trigger),
      conditions: v.conditions ? JSON.stringify(v.conditions) : null,
      actions: JSON.stringify(v.actions),
      run_once: body.run_once ?? false,
      webhook_token: v.trigger.type === 'webhook' ? newSecret('hk_') : null,
      signing_secret: newSecret('whsec_'),
      created_at: nowIso(),
      updated_at: nowIso(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  res.status(201).json((await toAutomations([row]))[0]);
});

/** Execution journal of every automation of the account (declared before /automations/:id). */
automationsRouter.get('/automations/runs', async (req, res) => {
  res.json(await listRuns(uid(req), null, req.query));
});

automationsRouter.get('/automations/:id', async (req, res) => {
  res.json((await toAutomations([await ownedAutomation(uid(req), req.params.id)]))[0]);
});

automationsRouter.patch('/automations/:id', async (req, res) => {
  const userId = uid(req);
  const a = await ownedAutomation(userId, req.params.id);
  const cur = { name: a.name, enabled: a.enabled, trigger: a.trigger, conditions: a.conditions, actions: a.actions, run_once: a.run_once };
  const body = bodySchema.parse({ ...cur, ...(req.body ?? {}) });
  const v = await validate(userId, body);
  const row = await db
    .updateTable('automations')
    .set({
      name: body.name,
      enabled: body.enabled ?? a.enabled,
      trigger_type: v.trigger.type,
      trigger: JSON.stringify(v.trigger),
      conditions: v.conditions ? JSON.stringify(v.conditions) : null,
      actions: JSON.stringify(v.actions),
      run_once: body.run_once ?? a.run_once,
      // a webhook trigger gets its URL once (kept when switching back and forth)
      webhook_token: v.trigger.type === 'webhook' ? (a.webhook_token ?? newSecret('hk_')) : a.webhook_token,
      updated_at: nowIso(),
    })
    .where('id', '=', a.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  res.json((await toAutomations([row]))[0]);
});

/** New incoming webhook URL and/or signing secret: the old ones stop working immediately. */
automationsRouter.post('/automations/:id/rotate-secret', async (req, res) => {
  const userId = uid(req);
  const a = await ownedAutomation(userId, req.params.id);
  const { which } = z.object({ which: z.enum(['webhook', 'signing']).default('webhook') }).parse(req.body ?? {});
  const row = await db
    .updateTable('automations')
    .set(which === 'webhook' ? { webhook_token: newSecret('hk_'), updated_at: nowIso() } : { signing_secret: newSecret('whsec_'), updated_at: nowIso() })
    .where('id', '=', a.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  res.json((await toAutomations([row]))[0]);
});

automationsRouter.delete('/automations/:id', async (req, res) => {
  const a = await ownedAutomation(uid(req), req.params.id);
  await db.deleteFrom('automations').where('id', '=', a.id).execute();
  res.json({ ok: true });
});

automationsRouter.get('/automations/:id/runs', async (req, res) => {
  const userId = uid(req);
  const a = await ownedAutomation(userId, req.params.id);
  res.json(await listRuns(userId, a.id, req.query));
});

const runsQuery = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  status: z.enum(['pending', 'running', 'waiting', 'completed', 'failed', 'skipped']).optional().catch(undefined),
  contact_id: z.coerce.number().int().positive().optional().catch(undefined),
});

async function listRuns(userId: number, automationId: number | null, raw: unknown): Promise<{ items: AutomationRun[]; total: number }> {
  const q = runsQuery.parse(raw ?? {});
  let base = db
    .selectFrom('automation_runs as r')
    .innerJoin('automations as a', 'a.id', 'r.automation_id')
    .leftJoin('contacts as c', 'c.id', 'r.contact_id')
    .where('r.user_id', '=', userId);
  if (automationId) base = base.where('r.automation_id', '=', automationId);
  if (q.status) base = base.where('r.status', '=', q.status);
  if (q.contact_id) base = base.where('r.contact_id', '=', q.contact_id);
  const [{ n }, rows] = await Promise.all([
    base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
    base
      .select([
        'r.id',
        'r.automation_id',
        'a.name as automation_name',
        'r.contact_id',
        'c.email as contact_email',
        'r.status',
        'r.step',
        'r.depth',
        'r.trigger_data',
        'r.log',
        'r.error',
        'r.resume_at',
        'r.created_at',
        'r.finished_at',
      ])
      .orderBy('r.created_at', 'desc')
      .orderBy('r.id', 'desc')
      .limit(q.limit)
      .offset((q.page - 1) * q.limit)
      .execute(),
  ]);
  return { items: rows as AutomationRun[], total: n };
}

// ---------- incoming webhook (public) ----------

export const hooksRouter = Router();

const hookPayload = z.looseObject({
  email: z.string().trim().max(254).optional(),
  first_name: z.string().max(200).optional(),
  last_name: z.string().max(200).optional(),
  phone: z.string().max(60).optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  product: z.string().trim().max(200).optional(),
  amount: z.union([z.number(), z.string().max(30)]).optional(),
  currency: z.string().trim().max(10).optional(),
  external_id: z.string().trim().max(200).optional(),
  contact: z.looseObject({ email: z.string().max(254).optional() }).optional(),
});
const emailCheck = z.email();
const RESERVED = new Set(['email', 'first_name', 'last_name', 'phone', 'fields', 'product', 'amount', 'currency', 'external_id', 'contact']);

/**
 * POST /api/hooks/automations/:token (JSON or form): creates / updates the contact by email (+ custom fields, given in
 * `fields` or as top-level keys), records a purchase when `product` is given, then queues the automation's run.
 */
hooksRouter.post('/automations/:token', async (req, res) => {
  const token = String(req.params.token);
  const a = /^hk_[\w-]{20,64}$/.test(token)
    ? await db.selectFrom('automations').select(['id', 'user_id', 'enabled', 'run_once', 'trigger_type']).where('webhook_token', '=', token).executeTakeFirst()
    : undefined;
  if (!a || a.trigger_type !== 'webhook') throw new HttpError(404, 'Webhook introuvable');
  const limited = await hit(`hook:automation:${a.id}`, HOOK_LIMIT);
  if (limited.blocked) {
    res.setHeader('Retry-After', String(limited.retryAfter));
    throw new HttpError(429, `Trop d’appels : ${HOOK_LIMIT.max} par minute maximum pour ce webhook`);
  }
  if (!a.enabled) throw new HttpError(409, 'Cette automatisation est désactivée');
  const parsed = hookPayload.safeParse(req.body ?? {});
  if (!parsed.success) throw new HttpError(400, 'Données invalides');
  const p = parsed.data;
  const email = (p.email ?? p.contact?.email ?? '').trim().toLowerCase();
  if (!emailCheck.safeParse(email).success) throw new HttpError(400, 'Champ « email » manquant ou invalide');
  // custom fields: `fields: {key: value}` or top-level keys equal to a field key (lenient: unknown / invalid ignored)
  const defs = await fieldDefMap(a.user_id);
  const rawFields: Record<string, unknown> = { ...(p.fields ?? {}) };
  for (const [k, v] of Object.entries(p)) if (!RESERVED.has(k) && defs.has(k)) rawFields[k] = v;
  const fields = validateFields(defs, rawFields, true);
  let amount: number | null = null;
  if (p.amount !== undefined && p.amount !== '') {
    amount = typeof p.amount === 'number' ? p.amount : Number(String(p.amount).replace(',', '.'));
    if (!Number.isFinite(amount)) throw new HttpError(400, 'Champ « amount » : nombre attendu');
  }
  const result = await db.transaction().execute(async (trx) => {
    const { contact, created } = await upsertContact(a.user_id, { email, first_name: p.first_name, last_name: p.last_name, phone: p.phone, fields }, {}, trx);
    const purchase = p.product ? await recordPurchase(a.user_id, contact.id, { product: p.product, amount, currency: p.currency, external_id: p.external_id }, 'webhook', trx) : null;
    const data: Record<string, unknown> = { source: 'webhook' };
    if (purchase) Object.assign(data, { product: purchase.product, amount: purchase.amount, currency: purchase.currency });
    const runId = await enqueueRun(trx, a.user_id, a, contact.id, data);
    return { contact_id: contact.id, created, run_id: runId, purchase_id: purchase?.id ?? null, ignored_fields: fields.ignored };
  });
  res.status(202).json({ ok: true, ...result });
});
