import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { FUNNEL_TEMPLATES, stepTemplate, type Funnel, type PageContent, type Step, type StepAccess, type StepType } from '@scalo/shared';
import { db, isUniqueViolation, nowIso, type Db, type FunnelRow, type StepRow } from '../db';
import { HttpError, notFound, pageContentSchema, paramId, previewToken, slugify, uid } from '../util';
import { readFunnelSettings } from '../services/tracking';

export const funnelsRouter = Router();

const STEP_TYPES = ['optin', 'sales', 'thankyou', 'custom'] as const;
const ACCESS_MODES = ['public', 'funnel', 'tag', 'password'] as const;
const slugSchema = z.string().trim().min(1).max(80);

const FUNNEL_SLUG_TAKEN = 'Ce slug est déjà utilisé';
const STEP_SLUG_TAKEN = 'Ce slug est déjà utilisé dans ce funnel';

export function parseAccess(raw: unknown): StepAccess {
  const a = raw && typeof raw === 'object' ? (raw as StepAccess) : null;
  return a && (ACCESS_MODES as readonly string[]).includes(a.mode) ? a : { mode: 'public' };
}

const emptyPage = (): PageContent => ({ settings: {} as PageContent['settings'], blocks: [] });

// ---------- helpers ----------

export async function uniqueFunnelSlug(name: string, ex: Db, exceptId?: number) {
  const base = slugify(name, 'funnel');
  const taken = new Set(
    (
      await ex
        .selectFrom('funnels')
        .select(['id', 'slug'])
        .where((eb) => eb.or([eb('slug', '=', base), eb('slug', 'like', `${base}-%`)]))
        .execute()
    )
      .filter((r) => r.id !== exceptId)
      .map((r) => r.slug),
  );
  for (let i = 1; ; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    if (!taken.has(slug)) return slug;
  }
}

async function uniqueStepSlug(funnelId: number, name: string, ex: Db) {
  const base = slugify(name, 'page');
  const taken = new Set((await ex.selectFrom('steps').select('slug').where('funnel_id', '=', funnelId).execute()).map((r) => r.slug));
  for (let i = 1; ; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    if (!taken.has(slug)) return slug;
  }
}

export async function insertStep(
  ex: Db,
  funnelId: number,
  s: { name: string; type: StepType; content: PageContent; slug?: string; access?: StepAccess; password_hash?: string | null; created_at?: string },
) {
  const { p } = await ex
    .selectFrom('steps')
    .select(sql<number>`COALESCE(MAX(position), -1) + 1`.as('p'))
    .where('funnel_id', '=', funnelId)
    .executeTakeFirstOrThrow();
  const row = await ex
    .insertInto('steps')
    .values({
      funnel_id: funnelId,
      name: s.name,
      slug: s.slug ?? (await uniqueStepSlug(funnelId, s.name, ex)),
      type: s.type,
      position: p,
      content: JSON.stringify(s.content),
      ...(s.access ? { access: JSON.stringify(s.access) } : {}),
      password_hash: s.password_hash ?? null,
      created_at: s.created_at ?? nowIso(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Runs a funnel insertion in a transaction, retrying if another request took the chosen slug meanwhile. */
export async function withFreeSlug<T>(ex: Db, fn: (trx: Db) => Promise<T>): Promise<T> {
  if (ex.isTransaction) return fn(ex);
  for (let attempt = 1; ; attempt++) {
    try {
      return await ex.transaction().execute(fn);
    } catch (e) {
      if (attempt < 5 && isUniqueViolation(e, 'funnels_slug_key')) continue;
      throw e;
    }
  }
}

export function createFunnel(userId: number, name: string, template: keyof typeof FUNNEL_TEMPLATES, createdAt = nowIso(), ex: Db = db) {
  return withFreeSlug(ex, async (trx) => {
    const f = await trx
      .insertInto('funnels')
      .values({ user_id: userId, name, slug: await uniqueFunnelSlug(name, trx), created_at: createdAt })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const s of FUNNEL_TEMPLATES[template].steps) {
      await insertStep(trx, f.id, { name: s.name, type: s.type, content: stepTemplate(s.type), created_at: createdAt });
    }
    return f.id;
  });
}

const previewUrl = (funnelSlug: string, r: StepRow) =>
  `/p/${encodeURIComponent(funnelSlug)}/${encodeURIComponent(r.slug)}?preview=${previewToken(r.funnel_id)}`;

const toStep = (r: StepRow, funnelSlug: string, stats?: { views: number; optins: number }): Step => ({
  id: r.id,
  funnel_id: r.funnel_id,
  name: r.name,
  slug: r.slug,
  type: r.type,
  position: r.position,
  content: r.content ?? emptyPage(),
  access: { ...parseAccess(r.access), password_set: !!r.password_hash },
  preview_url: previewUrl(funnelSlug, r),
  ab_status: r.ab_status,
  ...(stats ?? {}),
});

/** Views & optins per step, in one round trip. */
export async function stepStats(stepIds: number[]) {
  const map = new Map<number, { views: number; optins: number }>();
  for (const id of stepIds) map.set(id, { views: 0, optins: 0 });
  if (!stepIds.length) return map;
  const { rows } = await sql<{ step_id: number; views: number; optins: number }>`
    SELECT s.id AS step_id,
      (SELECT COUNT(*) FROM page_views v WHERE v.step_id = s.id) AS views,
      (SELECT COUNT(*) FROM contact_events e WHERE e.step_id = s.id AND e.type = 'optin') AS optins
    FROM steps s WHERE s.id = ANY(${stepIds}::bigint[])`.execute(db);
  for (const r of rows) map.set(r.step_id, { views: r.views, optins: r.optins });
  return map;
}

export async function ownedFunnel(userId: number, rawId: unknown): Promise<FunnelRow> {
  const row = await db.selectFrom('funnels').selectAll().where('id', '=', paramId(rawId, 'Funnel')).where('user_id', '=', userId).executeTakeFirst();
  if (!row) throw notFound('Funnel');
  return row;
}

export async function ownedStep(userId: number, rawId: unknown): Promise<StepRow & { funnel_slug: string }> {
  const row = await db
    .selectFrom('steps as s')
    .innerJoin('funnels as f', 'f.id', 's.funnel_id')
    .selectAll('s')
    .select('f.slug as funnel_slug')
    .where('s.id', '=', paramId(rawId, 'Étape'))
    .where('f.user_id', '=', userId)
    .executeTakeFirst();
  if (!row) throw notFound('Étape');
  return row;
}

async function stepsWithStats(f: { id: number; slug: string }) {
  const rows = await db.selectFrom('steps').selectAll().where('funnel_id', '=', f.id).orderBy('position').orderBy('id').execute();
  const [stats, variants] = await Promise.all([
    stepStats(rows.map((r) => r.id)),
    rows.length
      ? db
          .selectFrom('step_variants')
          .select(['step_id', (eb) => eb.fn.countAll<number>().as('n')])
          .where('step_id', 'in', rows.map((r) => r.id))
          .groupBy('step_id')
          .execute()
      : [],
  ]);
  return rows.map((s) => ({ ...toStep(s, f.slug, stats.get(s.id)), variants_count: variants.find((v) => v.step_id === s.id)?.n ?? 0 }));
}

export async function funnelDetail(f: FunnelRow): Promise<Funnel> {
  const [steps, optins] = await Promise.all([
    stepsWithStats(f),
    db
      .selectFrom('contact_events')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('funnel_id', '=', f.id)
      .where('type', '=', 'optin')
      .executeTakeFirstOrThrow(),
  ]);
  return {
    id: f.id,
    name: f.name,
    slug: f.slug,
    created_at: f.created_at,
    steps_count: steps.length,
    views: steps.reduce((a, s) => a + (s.views ?? 0), 0),
    optins: optins.n,
    steps,
    settings: readFunnelSettings(f.settings),
  };
}

async function reposition(ex: Db, funnelId: number) {
  await sql`
    UPDATE steps s SET position = o.pos
      FROM (SELECT id, (ROW_NUMBER() OVER (ORDER BY position, id) - 1)::int AS pos FROM steps WHERE funnel_id = ${funnelId}) o
     WHERE s.id = o.id AND s.position IS DISTINCT FROM o.pos`.execute(ex);
}

// ---------- funnels ----------

funnelsRouter.get('/funnels', async (req, res) => {
  const { rows } = await sql<Funnel>`
    SELECT f.id, f.name, f.slug, f.created_at,
      (SELECT COUNT(*) FROM steps s WHERE s.funnel_id = f.id) AS steps_count,
      (SELECT COUNT(*) FROM page_views v WHERE v.funnel_id = f.id) AS views,
      (SELECT COUNT(*) FROM contact_events e WHERE e.funnel_id = f.id AND e.type = 'optin') AS optins
    FROM funnels f WHERE f.user_id = ${uid(req)} ORDER BY f.created_at DESC, f.id DESC`.execute(db);
  res.json(rows);
});

funnelsRouter.post('/funnels', async (req, res) => {
  const userId = uid(req);
  const body = z
    .object({ name: z.string().trim().min(1).max(120), template: z.enum(['optin', 'sales', 'blank']).default('blank') })
    .parse(req.body);
  const id = await createFunnel(userId, body.name, body.template);
  res.status(201).json(await funnelDetail(await ownedFunnel(userId, id)));
});

funnelsRouter.get('/funnels/:id', async (req, res) => {
  res.json(await funnelDetail(await ownedFunnel(uid(req), req.params.id)));
});

funnelsRouter.patch('/funnels/:id', async (req, res) => {
  const userId = uid(req);
  const f = await ownedFunnel(userId, req.params.id);
  const body = z.object({ name: z.string().trim().min(1).max(120).optional(), slug: slugSchema.optional() }).parse(req.body);
  let slug = f.slug;
  if (body.slug !== undefined) {
    slug = slugify(body.slug, '');
    if (!slug) throw new HttpError(400, 'Slug invalide');
    const taken = await db.selectFrom('funnels').select('id').where('slug', '=', slug).where('id', '!=', f.id).executeTakeFirst();
    if (taken) throw new HttpError(409, FUNNEL_SLUG_TAKEN);
  }
  try {
    await db.updateTable('funnels').set({ name: body.name ?? f.name, slug }).where('id', '=', f.id).execute();
  } catch (e) {
    if (isUniqueViolation(e, 'funnels_slug_key')) throw new HttpError(409, FUNNEL_SLUG_TAKEN);
    throw e;
  }
  res.json(await funnelDetail(await ownedFunnel(userId, f.id)));
});

funnelsRouter.delete('/funnels/:id', async (req, res) => {
  const f = await ownedFunnel(uid(req), req.params.id);
  await db.deleteFrom('funnels').where('id', '=', f.id).execute();
  res.json({ ok: true });
});

funnelsRouter.post('/funnels/:id/duplicate', async (req, res) => {
  const userId = uid(req);
  const f = await ownedFunnel(userId, req.params.id);
  const newId = await withFreeSlug(db, async (trx) => {
    const copy = await trx
      .insertInto('funnels')
      .values({ user_id: userId, name: `${f.name} (copie)`, slug: await uniqueFunnelSlug(`${f.slug}-copie`, trx), created_at: nowIso() })
      .returning('id')
      .executeTakeFirstOrThrow();
    const steps = await trx.selectFrom('steps').selectAll().where('funnel_id', '=', f.id).orderBy('position').orderBy('id').execute();
    for (const s of steps) {
      await insertStep(trx, copy.id, {
        name: s.name,
        type: s.type,
        content: s.content ?? stepTemplate(s.type),
        slug: s.slug,
        access: parseAccess(s.access),
        password_hash: s.password_hash,
      });
    }
    return copy.id;
  });
  res.status(201).json(await funnelDetail(await ownedFunnel(userId, newId)));
});

// ---------- steps ----------

funnelsRouter.post('/funnels/:id/steps', async (req, res) => {
  const userId = uid(req);
  const f = await ownedFunnel(userId, req.params.id);
  const body = z
    .object({ name: z.string().trim().min(1).max(120), type: z.enum(STEP_TYPES), content: pageContentSchema.optional() })
    .parse(req.body);
  // `content`: page chosen in the template gallery (otherwise the default template of the step type)
  const content = (body.content as unknown as PageContent | undefined) ?? stepTemplate(body.type);
  const id = await db.transaction().execute((trx) => insertStep(trx, f.id, { name: body.name, type: body.type, content }));
  const s = await ownedStep(userId, id);
  res.status(201).json(toStep(s, s.funnel_slug, { views: 0, optins: 0 }));
});

funnelsRouter.post('/funnels/:id/steps/reorder', async (req, res) => {
  const userId = uid(req);
  const f = await ownedFunnel(userId, req.params.id);
  const { ids } = z.object({ ids: z.array(z.number().int().positive()).max(500) }).parse(req.body);
  await db.transaction().execute(async (trx) => {
    // lock the funnel's steps so concurrent reorders / inserts serialize
    const current = (await trx.selectFrom('steps').select('id').where('funnel_id', '=', f.id).forUpdate().execute()).map((r) => r.id);
    const set = new Set(ids);
    if (set.size !== ids.length || ids.length !== current.length || !current.every((id) => set.has(id))) {
      throw new HttpError(400, 'La liste des étapes ne correspond pas au funnel');
    }
    await sql`
      UPDATE steps s SET position = (v.ord - 1)::int
        FROM unnest(${ids}::bigint[]) WITH ORDINALITY AS v(id, ord)
       WHERE s.id = v.id AND s.funnel_id = ${f.id}`.execute(trx);
  });
  res.json(await stepsWithStats(f));
});

funnelsRouter.get('/steps/:id', async (req, res) => {
  const s = await ownedStep(uid(req), req.params.id);
  res.json(toStep(s, s.funnel_slug, (await stepStats([s.id])).get(s.id)));
});

funnelsRouter.patch('/steps/:id', async (req, res) => {
  const userId = uid(req);
  const s = await ownedStep(userId, req.params.id);
  const body = z
    .object({
      name: z.string().trim().min(1).max(120).optional(),
      slug: slugSchema.optional(),
      type: z.enum(STEP_TYPES).optional(),
      content: pageContentSchema.optional(),
      access: z
        .object({
          mode: z.enum(ACCESS_MODES),
          tag_id: z.number().int().positive().nullable().optional(),
          redirect: z.enum(['first', 'previous', 'url']).optional(),
          redirect_url: z.string().trim().max(500).optional(),
          password: z.string().min(4, 'Le mot de passe doit faire au moins 4 caractères').max(100).optional(),
        })
        .optional(),
    })
    .parse(req.body);
  let slug = s.slug;
  let access: StepAccess | undefined;
  let passwordHash = s.password_hash;
  if (body.access) {
    const a = body.access;
    if (a.mode === 'tag') {
      if (!a.tag_id) throw new HttpError(400, 'Choisissez le tag requis');
      if (!(await db.selectFrom('tags').select('id').where('id', '=', a.tag_id).where('user_id', '=', userId).executeTakeFirst())) throw notFound('Tag');
    }
    if (a.redirect === 'url' && !/^(https?:\/\/|\/)/i.test(a.redirect_url ?? '')) {
      throw new HttpError(400, 'L’URL de redirection doit commencer par http(s):// ou /');
    }
    if (a.password) passwordHash = await bcrypt.hash(a.password, 10);
    if (a.mode === 'password' && !passwordHash) throw new HttpError(400, 'Définissez un mot de passe');
    access = {
      mode: a.mode,
      ...(a.mode === 'tag' ? { tag_id: a.tag_id } : {}),
      redirect: a.redirect ?? 'first',
      ...(a.redirect === 'url' ? { redirect_url: a.redirect_url } : {}),
    };
  }
  if (body.slug !== undefined) {
    slug = slugify(body.slug, '');
    if (!slug) throw new HttpError(400, 'Slug invalide');
    const taken = await db
      .selectFrom('steps')
      .select('id')
      .where('funnel_id', '=', s.funnel_id)
      .where('slug', '=', slug)
      .where('id', '!=', s.id)
      .executeTakeFirst();
    if (taken) throw new HttpError(409, STEP_SLUG_TAKEN);
  }
  try {
    await db
      .updateTable('steps')
      .set({
        name: body.name ?? s.name,
        slug,
        type: body.type ?? s.type,
        ...(body.content ? { content: JSON.stringify(body.content) } : {}),
        ...(access ? { access: JSON.stringify(access) } : {}),
        password_hash: passwordHash,
      })
      .where('id', '=', s.id)
      .execute();
  } catch (e) {
    if (isUniqueViolation(e, 'steps_funnel_slug_key')) throw new HttpError(409, STEP_SLUG_TAKEN);
    throw e;
  }
  const updated = await ownedStep(userId, s.id);
  res.json(toStep(updated, updated.funnel_slug, (await stepStats([s.id])).get(s.id)));
});

funnelsRouter.delete('/steps/:id', async (req, res) => {
  const s = await ownedStep(uid(req), req.params.id);
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('steps').where('id', '=', s.id).execute();
    await reposition(trx, s.funnel_id);
  });
  res.json({ ok: true });
});
