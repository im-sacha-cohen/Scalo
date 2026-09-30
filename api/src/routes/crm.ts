// CRM routes (session JWT, under /api): custom fields, segments, contact query by filter, bulk actions.
import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { CUSTOM_FIELD_KEY_RE, CUSTOM_FIELD_TYPES, type CustomField, type Segment, type SegmentFilter } from '@scalo/shared';
import { db, isUniqueViolation, nowIso, type Db } from '../db';
import { runBulk } from '../services/bulk';
import { listFieldDefs, MAX_CUSTOM_FIELDS } from '../services/fields';
import { compileFilter, countMatching, parseFilter, segmentFilterSchema } from '../services/segments';
import { HttpError, notFound, paramId, uid } from '../util';
import { listContacts, listSchema } from './contacts';

export const crmRouter = Router();

// ---------- custom fields ----------

const MAX_SEGMENTS = 100;
const labelSchema = z.string().trim().min(1).max(80);
const optionsSchema = z
  .array(z.string().trim().min(1).max(100))
  .max(100)
  .transform((l) => [...new Map(l.map((o) => [o.toLowerCase(), o])).values()]);

/** Key from a label: « Date de naissance » → date_de_naissance. */
export function keyFromLabel(label: string) {
  const k = label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+|_+$/g, '')
    .slice(0, 40)
    .replace(/_+$/g, '');
  return k || 'champ';
}

export const createFieldSchema = z
  .object({
    key: z.string().trim().toLowerCase().regex(CUSTOM_FIELD_KEY_RE, 'Clé invalide : minuscules, chiffres et _ (commence par une lettre)').optional(),
    label: labelSchema,
    type: z.enum(CUSTOM_FIELD_TYPES),
    options: optionsSchema.optional(),
  })
  .refine((f) => f.type !== 'select' || (f.options?.length ?? 0) > 0, { message: 'Ajoutez au moins une option à la liste', path: ['options'] });

/** Creates a field definition (shared with the public API). 409 when the key exists or the limit is reached. */
export async function createField(userId: number, body: z.infer<typeof createFieldSchema>, ex: Db = db): Promise<CustomField> {
  const key = body.key ?? keyFromLabel(body.label);
  if (['email', 'first_name', 'last_name', 'phone', 'tags'].includes(key)) throw new HttpError(409, `La clé « ${key} » est réservée`);
  const n = await ex.selectFrom('custom_fields').select((eb) => eb.fn.countAll<number>().as('n')).where('user_id', '=', userId).executeTakeFirstOrThrow();
  if (n.n >= MAX_CUSTOM_FIELDS) throw new HttpError(409, `${MAX_CUSTOM_FIELDS} champs personnalisés maximum`);
  try {
    return await ex
      .insertInto('custom_fields')
      .values({
        user_id: userId,
        key,
        label: body.label,
        type: body.type,
        options: body.type === 'select' ? (body.options ?? []) : [],
        position: n.n,
        created_at: nowIso(),
      })
      .returning(['id', 'key', 'label', 'type', 'options', 'position', 'created_at'])
      .executeTakeFirstOrThrow();
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, `Un champ utilise déjà la clé « ${key} »`);
    throw e;
  }
}

async function ownedField(userId: number, raw: unknown) {
  const f = await db.selectFrom('custom_fields').selectAll().where('id', '=', paramId(raw, 'Champ')).where('user_id', '=', userId).executeTakeFirst();
  if (!f) throw notFound('Champ');
  return f;
}

crmRouter.get('/custom-fields', async (req, res) => {
  res.json(await listFieldDefs(uid(req)));
});

crmRouter.post('/custom-fields', async (req, res) => {
  res.status(201).json(await createField(uid(req), createFieldSchema.parse(req.body)));
});

crmRouter.post('/custom-fields/reorder', async (req, res) => {
  const userId = uid(req);
  const { ids } = z.object({ ids: z.array(z.number().int().positive()).min(1).max(MAX_CUSTOM_FIELDS) }).parse(req.body);
  await db.transaction().execute(async (trx) => {
    for (const [i, id] of ids.entries()) await trx.updateTable('custom_fields').set({ position: i }).where('id', '=', id).where('user_id', '=', userId).execute();
  });
  res.json(await listFieldDefs(userId));
});

// key and type are immutable (stored values never need a conversion)
crmRouter.patch('/custom-fields/:id', async (req, res) => {
  const userId = uid(req);
  const f = await ownedField(userId, req.params.id);
  const body = z.object({ label: labelSchema.optional(), options: optionsSchema.optional() }).strict().parse(req.body);
  if (f.type === 'select' && body.options && !body.options.length) throw new HttpError(400, 'Ajoutez au moins une option à la liste');
  const row = await db
    .updateTable('custom_fields')
    .set({ label: body.label ?? f.label, ...(f.type === 'select' && body.options ? { options: body.options } : {}) })
    .where('id', '=', f.id)
    .returning(['id', 'key', 'label', 'type', 'options', 'position', 'created_at'])
    .executeTakeFirstOrThrow();
  res.json(row);
});

/** Deletes the definition and the values stored on the contacts. */
crmRouter.delete('/custom-fields/:id', async (req, res) => {
  const userId = uid(req);
  const f = await ownedField(userId, req.params.id);
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('contacts')
      .set({ fields: sql<string>`fields - ${f.key}::text` })
      .where('user_id', '=', userId)
      .where(sql<boolean>`fields ? ${f.key}::text`)
      .execute();
    await trx.deleteFrom('custom_fields').where('id', '=', f.id).execute();
  });
  res.json({ ok: true });
});

// ---------- segments ----------

const segmentBody = z.object({ name: z.string().trim().min(1).max(120), filter: z.unknown() });

export async function toSegments(userId: number, rows: { id: number; name: string; filter: SegmentFilter; created_at: string; updated_at: string }[], withCount = true): Promise<Segment[]> {
  const out: Segment[] = [];
  for (const r of rows) {
    const s: Segment = { id: r.id, name: r.name, filter: r.filter, created_at: r.created_at, updated_at: r.updated_at };
    if (withCount) s.contacts_count = await countMatching(userId, await compileFilter(userId, r.filter));
    out.push(s);
  }
  return out;
}

export function segmentRows(userId: number) {
  return db.selectFrom('segments').select(['id', 'name', 'filter', 'created_at', 'updated_at']).where('user_id', '=', userId).orderBy(sql`lower(name)`).orderBy('id');
}

async function ownedSegment(userId: number, raw: unknown) {
  const s = await segmentRows(userId).where('id', '=', paramId(raw, 'Segment')).executeTakeFirst();
  if (!s) throw notFound('Segment');
  return s;
}

const SEGMENT_TAKEN = 'Un segment porte déjà ce nom';

crmRouter.get('/segments', async (req, res) => {
  const userId = uid(req);
  res.json(await toSegments(userId, await segmentRows(userId).execute(), req.query.counts !== '0'));
});

/** Number of contacts matching an ad hoc filter (live counter of the filter builder). */
crmRouter.post('/segments/preview', async (req, res) => {
  const userId = uid(req);
  const filter = await parseFilter(userId, z.object({ filter: z.unknown() }).parse(req.body).filter);
  res.json({ count: await countMatching(userId, await compileFilter(userId, filter)) });
});

crmRouter.post('/segments', async (req, res) => {
  const userId = uid(req);
  const body = segmentBody.parse(req.body);
  const filter = await parseFilter(userId, body.filter);
  const n = await db.selectFrom('segments').select((eb) => eb.fn.countAll<number>().as('n')).where('user_id', '=', userId).executeTakeFirstOrThrow();
  if (n.n >= MAX_SEGMENTS) throw new HttpError(409, `${MAX_SEGMENTS} segments maximum`);
  try {
    const row = await db
      .insertInto('segments')
      .values({ user_id: userId, name: body.name, filter: JSON.stringify(filter), created_at: nowIso(), updated_at: nowIso() })
      .returning(['id', 'name', 'filter', 'created_at', 'updated_at'])
      .executeTakeFirstOrThrow();
    res.status(201).json((await toSegments(userId, [row]))[0]);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, SEGMENT_TAKEN);
    throw e;
  }
});

crmRouter.get('/segments/:id', async (req, res) => {
  const userId = uid(req);
  res.json((await toSegments(userId, [await ownedSegment(userId, req.params.id)]))[0]);
});

crmRouter.patch('/segments/:id', async (req, res) => {
  const userId = uid(req);
  const s = await ownedSegment(userId, req.params.id);
  const body = z.object({ name: z.string().trim().min(1).max(120).optional(), filter: z.unknown().optional() }).parse(req.body);
  const filter = body.filter !== undefined ? await parseFilter(userId, body.filter) : s.filter;
  try {
    const row = await db
      .updateTable('segments')
      .set({ name: body.name ?? s.name, filter: JSON.stringify(filter), updated_at: nowIso() })
      .where('id', '=', s.id)
      .returning(['id', 'name', 'filter', 'created_at', 'updated_at'])
      .executeTakeFirstOrThrow();
    res.json((await toSegments(userId, [row]))[0]);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, SEGMENT_TAKEN);
    throw e;
  }
});

/** 409 while a newsletter not sent yet targets the segment (it would silently go to every contact). */
crmRouter.delete('/segments/:id', async (req, res) => {
  const userId = uid(req);
  const s = await ownedSegment(userId, req.params.id);
  const used = await db
    .selectFrom('broadcasts')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('segment_id', '=', s.id)
    .where('status', 'in', ['draft', 'scheduled'])
    .executeTakeFirstOrThrow();
  if (used.n) throw new HttpError(409, `Ce segment est utilisé par ${used.n} newsletter${used.n > 1 ? 's' : ''} non envoyée${used.n > 1 ? 's' : ''} : changez d’abord leurs destinataires`);
  await db.deleteFrom('segments').where('id', '=', s.id).execute();
  res.json({ ok: true });
});

// ---------- contacts: query by filter, bulk actions ----------

const querySchema = listSchema.extend({
  page: z.number().int().min(1).optional().default(1),
  limit: z.number().int().min(1).max(500).optional().default(50),
  tag_id: z.number().int().positive().nullable().optional().transform((v) => v ?? undefined),
  segment_id: z.number().int().positive().nullable().optional().transform((v) => v ?? undefined),
  filter: z.unknown().optional(),
});

/** Contact list with an ad hoc filter (the filter is too big for a query string). Same response as GET /contacts. */
crmRouter.post('/contacts/query', async (req, res) => {
  const userId = uid(req);
  const q = querySchema.parse(req.body ?? {});
  const filter = q.filter ? await parseFilter(userId, q.filter) : null;
  res.json(await listContacts(userId, q, filter));
});

const bulkActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('add_tag'), tag_name: z.string().trim().min(1).max(60) }),
  z.object({ type: z.literal('remove_tag'), tag_id: z.number().int().positive() }),
  z.object({ type: z.literal('enroll'), campaign_id: z.number().int().positive() }),
  z.object({ type: z.literal('unenroll'), campaign_id: z.number().int().positive() }),
  z.object({ type: z.literal('unsubscribe') }),
  z.object({ type: z.literal('delete') }),
  z.object({ type: z.literal('set_field'), key: z.string().min(1).max(40), value: z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]) }),
]);

const selectionSchema = z.union([
  z.object({ ids: z.array(z.number().int().positive()).min(1).max(10_000) }),
  z.object({
    all: z.literal(true),
    search: z.string().trim().max(200).optional(),
    tag_id: z.number().int().positive().nullable().optional(),
    status: z.enum(['pending_confirmation', 'confirmed', 'unsubscribed', 'bounced']).nullable().optional(),
    segment_id: z.number().int().positive().nullable().optional(),
    filter: z.unknown().optional(),
  }),
]);

crmRouter.post('/contacts/bulk', async (req, res) => {
  const userId = uid(req);
  const body = z.object({ selection: selectionSchema, action: bulkActionSchema }).parse(req.body);
  const sel = body.selection;
  if ('all' in sel && sel.filter !== undefined && sel.filter !== null) {
    (sel as { filter: SegmentFilter }).filter = await parseFilter(userId, sel.filter);
  }
  if ('all' in sel && sel.segment_id) {
    if (!(await db.selectFrom('segments').select('id').where('id', '=', sel.segment_id).where('user_id', '=', userId).executeTakeFirst())) throw notFound('Segment');
  }
  res.json(await runBulk(userId, sel as never, body.action));
});

export { segmentFilterSchema };
