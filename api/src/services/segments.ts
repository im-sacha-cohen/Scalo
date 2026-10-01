// Segments: multi-criteria contact filters combined with ET (`all`) / OU (`any`), optionally nested (max depth 3).
//
// A filter is validated (zod + ownership of the referenced tags / funnels / campaigns / fields) and compiled into a
// Kysely boolean expression on the `contacts as c` table: every user value is a bound parameter, column names and
// operators come from fixed lists (never from the input). Referencing a deleted tag / campaign simply never matches.
import { sql, type Expression, type ExpressionBuilder, type SelectQueryBuilder, type SqlBool } from 'kysely';
import { z } from 'zod';
import { BUILTIN_FIELDS, isFilterGroup, parseFieldDateTime, type SegmentCondition, type SegmentFilter } from '@scalo/shared';
import { db, type Database, type Db } from '../db';
import { HttpError, likeEscape } from '../util';
import { fieldDefMap, parseDate, type FieldDef } from './fields';

export const MAX_FILTER_DEPTH = 3;
export const MAX_CONDITIONS = 50;

type CEb = ExpressionBuilder<Database & { c: Database['contacts'] }, 'c'>;
export type ContactPredicate = (eb: CEb) => Expression<SqlBool>;

// ---------- validation ----------

const id = z.number().int().positive();
const conditionSchema: z.ZodType<SegmentCondition> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tag'), op: z.enum(['has', 'not_has']), tag_id: id }),
  z.object({
    type: z.literal('field'),
    key: z.string().trim().min(1).max(40),
    op: z.enum(['eq', 'neq', 'contains', 'not_contains', 'gt', 'lt', 'within_days', 'empty', 'not_empty']),
    value: z.union([z.string().max(1000), z.number(), z.boolean()]).nullable().optional(),
  }),
  z.object({ type: z.literal('status'), op: z.enum(['is', 'is_not']).default('is'), value: z.enum(['confirmed', 'pending_confirmation', 'unsubscribed', 'bounced']) }),
  z.object({
    type: z.literal('created'),
    op: z.enum(['before', 'after', 'within_days', 'older_than_days']),
    value: z.union([z.string().max(40), z.number()]),
  }),
  z.object({ type: z.literal('email_activity'), op: z.enum(['opened', 'clicked', 'not_opened', 'not_clicked']), days: z.number().int().min(1).max(3650) }),
  z.object({ type: z.literal('optin'), op: z.enum(['did', 'did_not']).default('did'), funnel_id: id.nullable().default(null) }),
  z.object({ type: z.literal('campaign'), op: z.enum(['enrolled', 'not_enrolled', 'completed']), campaign_id: id }),
  z.object({ type: z.literal('purchase'), op: z.enum(['did', 'did_not']).default('did'), product: z.string().trim().max(200).nullable().optional() }),
]) as unknown as z.ZodType<SegmentCondition>;

export const segmentFilterSchema: z.ZodType<SegmentFilter> = z.lazy(() =>
  // strict: `{type: 'inconnu'}` must not be read as an empty group
  z.strictObject({
    match: z.enum(['all', 'any']).default('all'),
    conditions: z.array(z.union([conditionSchema, segmentFilterSchema])).max(MAX_CONDITIONS).default([]),
  }),
) as unknown as z.ZodType<SegmentFilter>;

function* walk(f: SegmentFilter, depth = 1): Generator<SegmentCondition> {
  if (depth > MAX_FILTER_DEPTH) throw new HttpError(400, `Filtre trop imbriqué (${MAX_FILTER_DEPTH} niveaux maximum)`);
  for (const c of f.conditions) {
    if (isFilterGroup(c)) yield* walk(c, depth + 1);
    else yield c;
  }
}

const isBuiltin = (k: string): k is (typeof BUILTIN_FIELDS)[number] => (BUILTIN_FIELDS as readonly string[]).includes(k);

/**
 * Semantic checks: referenced tags / funnels / campaigns / custom fields belong to the account, values have the right
 * shape for the operator. Throws a 400 / 404 with a French message.
 */
export async function assertFilter(userId: number, filter: SegmentFilter, ex: Db = db): Promise<void> {
  const conds = [...walk(filter)];
  if (conds.length > MAX_CONDITIONS) throw new HttpError(400, `${MAX_CONDITIONS} conditions maximum`);
  const ids = (t: string, k: string) => [...new Set(conds.filter((c) => c.type === t).map((c) => (c as Record<string, unknown>)[k]).filter((v): v is number => typeof v === 'number'))];
  const check = async (table: 'tags' | 'funnels' | 'campaigns', list: number[], label: string) => {
    if (!list.length) return;
    const found = await ex.selectFrom(table).select('id').where('user_id', '=', userId).where('id', 'in', list).execute();
    if (found.length !== list.length) throw new HttpError(404, `${label} introuvable dans une condition du filtre`);
  };
  await check('tags', ids('tag', 'tag_id'), 'Tag');
  await check('funnels', ids('optin', 'funnel_id'), 'Tunnel');
  await check('campaigns', ids('campaign', 'campaign_id'), 'Campagne');
  const defs = await fieldDefMap(userId, ex);
  for (const c of conds) {
    if (c.type === 'field') {
      const def = defs.get(c.key);
      if (!def && !isBuiltin(c.key)) throw new HttpError(404, `Champ « ${c.key} » introuvable dans une condition du filtre`);
      if (!['empty', 'not_empty'].includes(c.op) && (c.value === undefined || c.value === null || c.value === '')) {
        throw new HttpError(400, `Condition sur « ${def?.label ?? c.key} » : valeur manquante`);
      }
      if ((c.op === 'gt' || c.op === 'lt') && def && def.type === 'number' && !Number.isFinite(Number(c.value))) {
        throw new HttpError(400, `Condition sur « ${def.label} » : nombre attendu`);
      }
      if ((c.op === 'gt' || c.op === 'lt') && def?.type === 'date' && !parseDate(String(c.value))) {
        throw new HttpError(400, `Condition sur « ${def.label} » : date attendue`);
      }
      if ((c.op === 'gt' || c.op === 'lt' || c.op === 'eq' || c.op === 'neq') && def?.type === 'datetime' && !parseFieldDateTime(String(c.value))) {
        throw new HttpError(400, `Condition sur « ${def.label} » : date et heure attendues (ISO 8601)`);
      }
      if (c.op === 'within_days') {
        if (!def || (def.type !== 'date' && def.type !== 'datetime')) throw new HttpError(400, `Condition sur « ${def?.label ?? c.key} » : « dans les derniers jours » ne s’applique qu’aux dates`);
        const n = Number(c.value);
        if (!Number.isInteger(n) || n < 0 || n > 36500) throw new HttpError(400, `Condition sur « ${def.label} » : nombre de jours attendu`);
      }
    }
    if (c.type === 'created') {
      if ((c.op === 'before' || c.op === 'after') && !parseDate(String(c.value))) throw new HttpError(400, 'Date de création : date attendue (AAAA-MM-JJ)');
      if ((c.op === 'within_days' || c.op === 'older_than_days') && !(Number.isInteger(Number(c.value)) && Number(c.value) >= 0 && Number(c.value) <= 36500)) {
        throw new HttpError(400, 'Date de création : nombre de jours attendu');
      }
    }
  }
}

/** zod + semantic validation: the normalized filter. */
export async function parseFilter(userId: number, raw: unknown, ex: Db = db): Promise<SegmentFilter> {
  const f = segmentFilterSchema.parse(raw);
  await assertFilter(userId, f, ex);
  return f;
}

// ---------- compilation ----------

const daysAgo = (n: number) => sql<string>`now() - make_interval(days => ${Math.trunc(n)})`;

function fieldCondition(eb: CEb, c: Extract<SegmentCondition, { type: 'field' }>, def: FieldDef | undefined): Expression<SqlBool> {
  const builtin = isBuiltin(c.key);
  if (!def && !builtin) return sql<boolean>`false`;
  // text value of the field (builtin column or jsonb key); keys are bound parameters
  const text = builtin ? sql<string | null>`${sql.ref(`c.${c.key}`)}` : sql<string | null>`(c.fields ->> ${c.key}::text)`;
  const type = builtin ? 'text' : def!.type;
  const empty = sql<boolean>`coalesce(${text}, '') = ''`;
  if (c.op === 'empty') return empty;
  if (c.op === 'not_empty') return eb.not(empty);
  const v = c.value;
  switch (type) {
    case 'number': {
      const num = sql<number | null>`(CASE WHEN jsonb_typeof(c.fields -> ${c.key}::text) = 'number' THEN (c.fields ->> ${c.key}::text)::numeric END)`;
      const n = Number(v);
      if (!Number.isFinite(n)) return sql<boolean>`false`;
      if (c.op === 'gt') return sql<boolean>`${num} > ${n}`;
      if (c.op === 'lt') return sql<boolean>`${num} < ${n}`;
      if (c.op === 'eq') return sql<boolean>`${num} = ${n}`;
      if (c.op === 'neq') return sql<boolean>`${num} IS DISTINCT FROM ${n}`;
      break; // contains on a number: text semantics below
    }
    case 'date': {
      const dateOf = sql<string | null>`(CASE WHEN ${text} ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN ${text} END)`;
      if (c.op === 'within_days') {
        // today and the N previous days (UTC)
        const n = Math.trunc(Number(v));
        if (!Number.isInteger(n) || n < 0) return sql<boolean>`false`;
        return sql<boolean>`(${dateOf})::date BETWEEN (now() AT TIME ZONE 'UTC')::date - ${n}::int AND (now() AT TIME ZONE 'UTC')::date`;
      }
      const d = parseDate(String(v));
      if (!d) return sql<boolean>`false`;
      if (c.op === 'gt') return sql<boolean>`${dateOf} > ${d}`;
      if (c.op === 'lt') return sql<boolean>`${dateOf} < ${d}`;
      if (c.op === 'eq') return sql<boolean>`${dateOf} = ${d}`;
      if (c.op === 'neq') return sql<boolean>`${dateOf} IS DISTINCT FROM ${d}`;
      break;
    }
    case 'datetime': {
      // stored as ISO 8601 UTC; anything else (hand-edited data) never matches
      const at = sql<string | null>`(CASE WHEN ${text} ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$' THEN (${text})::timestamptz END)`;
      if (c.op === 'within_days') {
        const n = Math.trunc(Number(v));
        if (!Number.isInteger(n) || n < 0) return sql<boolean>`false`;
        return sql<boolean>`${at} BETWEEN now() - make_interval(days => ${n}) AND now()`;
      }
      const d = parseFieldDateTime(String(v));
      if (!d) return sql<boolean>`false`;
      if (c.op === 'gt') return sql<boolean>`${at} > ${d}::timestamptz`;
      if (c.op === 'lt') return sql<boolean>`${at} < ${d}::timestamptz`;
      if (c.op === 'eq') return sql<boolean>`${at} = ${d}::timestamptz`;
      if (c.op === 'neq') return sql<boolean>`${at} IS DISTINCT FROM ${d}::timestamptz`;
      return sql<boolean>`false`;
    }
    case 'checkbox': {
      const want = v === true || ['true', '1', 'oui', 'yes'].includes(String(v).toLowerCase());
      const isTrue = sql<boolean>`coalesce((c.fields -> ${c.key}::text) = 'true'::jsonb, false)`;
      if (c.op === 'eq') return want ? isTrue : eb.not(isTrue);
      if (c.op === 'neq') return want ? eb.not(isTrue) : isTrue;
      return sql<boolean>`false`;
    }
  }
  const s = String(v ?? '');
  switch (c.op) {
    case 'eq':
      return sql<boolean>`lower(${text}) = lower(${s})`;
    case 'neq':
      return sql<boolean>`lower(${text}) IS DISTINCT FROM lower(${s})`;
    case 'contains':
      return sql<boolean>`${text} ILIKE ${`%${likeEscape(s)}%`}`;
    case 'not_contains':
      return sql<boolean>`coalesce(${text}, '') NOT ILIKE ${`%${likeEscape(s)}%`}`;
    case 'gt':
      return sql<boolean>`${text} > ${s}`;
    case 'lt':
      return sql<boolean>`${text} < ${s}`;
  }
  return sql<boolean>`false`; // within_days on a non-date field
}

function statusCondition(eb: CEb, value: string): Expression<SqlBool> {
  switch (value) {
    case 'confirmed': // same meaning as the contact list "Abonnés" filter
      return eb.and([eb('c.confirmed_at', 'is not', null), eb('c.unsubscribed', '=', false), eb('c.bounced', '=', false)]);
    case 'pending_confirmation':
      return eb('c.confirmed_at', 'is', null);
    case 'unsubscribed':
      return eb('c.unsubscribed', '=', true);
    default:
      return eb('c.bounced', '=', true);
  }
}

function conditionExpr(eb: CEb, c: SegmentCondition, defs: Map<string, FieldDef>): Expression<SqlBool> {
  switch (c.type) {
    case 'tag': {
      const has = eb.exists(eb.selectFrom('contact_tags as ct').select('ct.tag_id').whereRef('ct.contact_id', '=', 'c.id').where('ct.tag_id', '=', c.tag_id));
      return c.op === 'has' ? has : eb.not(has);
    }
    case 'field':
      return fieldCondition(eb, c, defs.get(c.key));
    case 'status': {
      const e = statusCondition(eb, c.value);
      return c.op === 'is_not' ? eb.not(e) : e;
    }
    case 'created': {
      if (c.op === 'within_days') return eb('c.created_at', '>=', daysAgo(Number(c.value)));
      if (c.op === 'older_than_days') return eb('c.created_at', '<', daysAgo(Number(c.value)));
      const d = parseDate(String(c.value));
      if (!d) return sql<boolean>`false`;
      // 'before 2025-03-01' = created before that day starts; 'after' = from the next day on (UTC)
      if (c.op === 'before') return eb('c.created_at', '<', `${d}T00:00:00.000Z`);
      return eb('c.created_at', '>=', new Date(Date.parse(`${d}T00:00:00.000Z`) + 86400_000).toISOString());
    }
    case 'email_activity': {
      const clicked = c.op === 'clicked' || c.op === 'not_clicked';
      const since = daysAgo(c.days);
      const act = eb.exists(
        eb
          .selectFrom('email_sends as es')
          .select('es.id')
          .whereRef('es.contact_id', '=', 'c.id')
          .where('es.is_test', '=', false)
          .where((w) => (clicked ? w('es.clicked_at', '>=', since) : w.or([w('es.opened_at', '>=', since), w('es.clicked_at', '>=', since)]))),
      );
      return c.op === 'opened' || c.op === 'clicked' ? act : eb.not(act);
    }
    case 'optin': {
      const funnelId = c.funnel_id;
      const did = eb.exists(
        eb
          .selectFrom('contact_events as ev')
          .select('ev.id')
          .whereRef('ev.contact_id', '=', 'c.id')
          .where('ev.type', 'in', ['optin', 'optin_confirmed'])
          .$if(!!funnelId, (q) => q.where('ev.funnel_id', '=', funnelId!)),
      );
      return c.op === 'did' ? did : eb.not(did);
    }
    case 'campaign': {
      const statuses = c.op === 'completed' ? ['completed'] : ['active', 'completed'];
      const e = eb.exists(
        eb
          .selectFrom('campaign_subscriptions as cs')
          .select('cs.id')
          .whereRef('cs.contact_id', '=', 'c.id')
          .where('cs.campaign_id', '=', c.campaign_id)
          .where('cs.status', 'in', statuses as ('active' | 'completed')[]),
      );
      return c.op === 'not_enrolled' ? eb.not(e) : e;
    }
    case 'purchase': {
      const product = c.product?.trim();
      const did = eb.exists(
        eb
          .selectFrom('contact_events as ev')
          .select('ev.id')
          .whereRef('ev.contact_id', '=', 'c.id')
          .where('ev.type', '=', 'purchase')
          .$if(!!product, (q) => q.where(sql<boolean>`lower(ev.data ->> 'product') = lower(${product!})`)),
      );
      return c.op === 'did' ? did : eb.not(did);
    }
  }
}

function groupExpr(eb: CEb, f: SegmentFilter, defs: Map<string, FieldDef>, depth = 1): Expression<SqlBool> {
  const parts = f.conditions
    .map((c) => (isFilterGroup(c) ? (depth < MAX_FILTER_DEPTH ? groupExpr(eb, c, defs, depth + 1) : null) : conditionExpr(eb, c, defs)))
    .filter((e): e is Expression<SqlBool> => e !== null);
  if (!parts.length) return sql<boolean>`true`; // empty filter = every contact
  return f.match === 'any' ? eb.or(parts) : eb.and(parts);
}

/** Compiles a (validated) filter into a predicate on `contacts as c`. */
export async function compileFilter(userId: number, filter: SegmentFilter, ex: Db = db): Promise<ContactPredicate> {
  const defs = await fieldDefMap(userId, ex);
  return (eb) => groupExpr(eb, filter, defs);
}

/** Predicate of a saved segment of the account (404 when unknown). */
export async function segmentPredicate(userId: number, segmentId: number, ex: Db = db): Promise<ContactPredicate> {
  const seg = await ex.selectFrom('segments').select('filter').where('id', '=', segmentId).where('user_id', '=', userId).executeTakeFirst();
  if (!seg) throw new HttpError(404, 'Segment introuvable');
  return compileFilter(userId, seg.filter, ex);
}

export async function countMatching(userId: number, pred: ContactPredicate, ex: Db = db): Promise<number> {
  const r = await ex
    .selectFrom('contacts as c')
    .where('c.user_id', '=', userId)
    .where((eb) => pred(eb as unknown as CEb))
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirstOrThrow();
  return r.n;
}

/** Does this contact match the filter now? (automation conditions) */
export async function contactMatches(userId: number, contactId: number, filter: SegmentFilter | null, ex: Db = db): Promise<boolean> {
  if (!filter || !filter.conditions?.length) return true;
  const pred = await compileFilter(userId, filter, ex);
  const r = await ex
    .selectFrom('contacts as c')
    .select('c.id')
    .where('c.user_id', '=', userId)
    .where('c.id', '=', contactId)
    .where((eb) => pred(eb as unknown as CEb))
    .executeTakeFirst();
  return !!r;
}

// ---------- contact list filters (shared by the list, the bulk actions and the public API) ----------

export interface ContactListFilters {
  search?: string;
  tag_id?: number | null;
  status?: 'pending_confirmation' | 'confirmed' | 'unsubscribed' | 'bounced' | null;
  segment_id?: number | null;
  filter?: SegmentFilter | null;
}

/** Resolves the segment / ad hoc filter of a list query into one predicate (null = none). */
export async function listPredicate(userId: number, q: ContactListFilters, ex: Db = db): Promise<ContactPredicate | null> {
  const preds: ContactPredicate[] = [];
  if (q.segment_id) preds.push(await segmentPredicate(userId, q.segment_id, ex));
  if (q.filter && q.filter.conditions?.length) preds.push(await compileFilter(userId, q.filter, ex));
  if (!preds.length) return null;
  return (eb) => eb.and(preds.map((p) => p(eb)));
}

type ContactsQuery = SelectQueryBuilder<Database & { c: Database['contacts'] }, 'c', object>;

/** `contacts as c` of the account filtered like the contact list (search, tag, status, segment, ad hoc filter). */
export function applyListFilters<Q extends ContactsQuery>(base: Q, q: ContactListFilters, pred: ContactPredicate | null): Q {
  let out = base as ContactsQuery;
  if (q.search) {
    const like = `%${likeEscape(q.search)}%`;
    out = out.where((eb) =>
      eb.or([
        eb('c.email', 'ilike', like),
        eb('c.first_name', 'ilike', like),
        eb('c.last_name', 'ilike', like),
        eb(sql<string>`coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')`, 'ilike', like),
      ]),
    );
  }
  if (q.tag_id) {
    const tagId = q.tag_id;
    out = out.where((eb) =>
      eb.exists(eb.selectFrom('contact_tags as ct').select('ct.tag_id').whereRef('ct.contact_id', '=', 'c.id').where('ct.tag_id', '=', tagId)),
    );
  }
  if (q.status) out = out.where((eb) => statusCondition(eb as unknown as CEb, q.status!));
  if (pred) out = out.where((eb) => pred(eb as unknown as CEb));
  return out as Q;
}
