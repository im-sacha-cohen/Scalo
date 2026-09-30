// Funnels growth API: custom domains, A/B tests of pages, attribution stats, pixels / cookie banner / legal settings,
// legal pages, export / import / share. Session-authenticated routes (under /api, after requireAuth), plus two public
// endpoints mounted before requireAuth (TLS on-demand check, shared funnel preview).
import { Router } from 'express';
import { z } from 'zod';
import { legalPageTemplate, LEGAL_PAGES, type LegalPageKind, type SharedFunnelPreview, type StepAccess } from '@scalo/shared';
import { db, isUniqueViolation, nowIso } from '../db';
import { env } from '../env';
import { HttpError, notFound, pageContentSchema, paramId, uid } from '../util';
import { systemResolver, type DnsResolver } from '../services/dns';
import { newVerifyToken, normalizeCustomDomain, toCustomDomain, verifyCustomDomain } from '../services/domains';
import { abTestOf, MAX_VARIANTS, resetAbAttribution, toVariant } from '../services/ab';
import { funnelStats, GROUPS, PERIODS } from '../services/funnel-stats';
import { clean, funnelSettingsInput, readFunnelSettings } from '../services/tracking';
import { buildExport, funnelByShareToken, hashShareToken, importFunnel, MAX_IMPORT_BYTES, newShareToken } from '../services/funnel-transfer';
import { getSettingsRow } from '../services/email';
import { funnelDetail, insertStep, ownedFunnel, ownedStep, parseAccess } from './funnels';

const MAX_DOMAINS_PER_USER = 20;
const DOMAIN_TAKEN = 'Ce domaine est déjà utilisé par un autre tunnel';

const shareUrl = (token: string) => `${env.PUBLIC_URL}/share/${token}`;

export function createGrowthRouter(opts: { dns?: DnsResolver } = {}) {
  const resolver = opts.dns ?? systemResolver();
  const r = Router();

  // ---------- custom domains ----------

  r.get('/funnels/:id/domains', async (req, res) => {
    const f = await ownedFunnel(uid(req), req.params.id);
    const rows = await db.selectFrom('custom_domains').selectAll().where('funnel_id', '=', f.id).orderBy('created_at').orderBy('id').execute();
    res.json(rows.map(toCustomDomain));
  });

  const rootStepSchema = z.number().int().positive().nullable().optional();
  async function checkRootStep(funnelId: number, stepId: number | null | undefined) {
    if (!stepId) return null;
    const s = await db.selectFrom('steps').select('id').where('id', '=', stepId).where('funnel_id', '=', funnelId).executeTakeFirst();
    if (!s) throw notFound('Étape');
    return s.id;
  }

  r.post('/funnels/:id/domains', async (req, res) => {
    const userId = uid(req);
    const f = await ownedFunnel(userId, req.params.id);
    const body = z.object({ domain: z.string().max(300), root_step_id: rootStepSchema }).parse(req.body);
    const n = normalizeCustomDomain(body.domain);
    if ('error' in n) throw new HttpError(400, n.error);
    const count = await db.selectFrom('custom_domains').select((eb) => eb.fn.countAll<number>().as('n')).where('user_id', '=', userId).executeTakeFirstOrThrow();
    if (count.n >= MAX_DOMAINS_PER_USER) throw new HttpError(409, `Limite de ${MAX_DOMAINS_PER_USER} domaines atteinte`);
    const root = await checkRootStep(f.id, body.root_step_id);
    try {
      const row = await db
        .insertInto('custom_domains')
        .values({ user_id: userId, funnel_id: f.id, domain: n.domain, root_step_id: root, verify_token: newVerifyToken(), created_at: nowIso() })
        .returningAll()
        .executeTakeFirstOrThrow();
      res.status(201).json(toCustomDomain(row));
    } catch (e) {
      if (isUniqueViolation(e, 'custom_domains_domain_key')) throw new HttpError(409, DOMAIN_TAKEN);
      throw e;
    }
  });

  async function ownedDomain(userId: number, rawId: unknown) {
    const row = await db.selectFrom('custom_domains').selectAll().where('id', '=', paramId(rawId, 'Domaine')).where('user_id', '=', userId).executeTakeFirst();
    if (!row) throw notFound('Domaine');
    return row;
  }

  r.patch('/domains/:id', async (req, res) => {
    const userId = uid(req);
    const d = await ownedDomain(userId, req.params.id);
    const body = z.object({ root_step_id: rootStepSchema }).parse(req.body);
    const root = body.root_step_id === undefined ? d.root_step_id : await checkRootStep(d.funnel_id, body.root_step_id);
    const row = await db.updateTable('custom_domains').set({ root_step_id: root }).where('id', '=', d.id).returningAll().executeTakeFirstOrThrow();
    res.json(toCustomDomain(row));
  });

  r.post('/domains/:id/verify', async (req, res) => {
    const d = await ownedDomain(uid(req), req.params.id);
    const v = await verifyCustomDomain(resolver, d);
    const now = nowIso();
    const set = v.ok
      ? { status: 'verified' as const, verified_at: d.verified_at ?? now, last_checked_at: now, last_error: null }
      : // a DNS server error keeps a verified domain online
        { status: v.transient && d.status === 'verified' ? ('verified' as const) : ('error' as const), last_checked_at: now, last_error: v.error ?? null };
    const row = await db.updateTable('custom_domains').set(set).where('id', '=', d.id).returningAll().executeTakeFirstOrThrow();
    res.json(toCustomDomain(row));
  });

  r.delete('/domains/:id', async (req, res) => {
    const d = await ownedDomain(uid(req), req.params.id);
    await db.deleteFrom('custom_domains').where('id', '=', d.id).execute();
    res.json({ ok: true });
  });

  // ---------- funnel settings: pixels, cookie banner, legal footer ----------

  r.get('/funnels/:id/settings', async (req, res) => {
    const f = await ownedFunnel(uid(req), req.params.id);
    res.json(readFunnelSettings(f.settings));
  });

  r.put('/funnels/:id/settings', async (req, res) => {
    const f = await ownedFunnel(uid(req), req.params.id);
    const body = funnelSettingsInput.parse(req.body ?? {});
    const current = readFunnelSettings(f.settings);
    const next = clean({ ...current, ...body });
    const stepIds = new Set((await db.selectFrom('steps').select('id').where('funnel_id', '=', f.id).execute()).map((s) => s.id));
    if (next.cookie_banner?.privacy_step_id && !stepIds.has(next.cookie_banner.privacy_step_id)) throw notFound('Étape');
    if (next.legal) next.legal.step_ids = next.legal.step_ids.filter((id) => stepIds.has(id));
    await db.updateTable('funnels').set({ settings: JSON.stringify(next) }).where('id', '=', f.id).execute();
    res.json(next);
  });

  // ---------- legal pages ----------

  r.post('/funnels/:id/legal-pages', async (req, res) => {
    const userId = uid(req);
    const f = await ownedFunnel(userId, req.params.id);
    const { kind } = z.object({ kind: z.enum(['mentions', 'privacy', 'cgv']) }).parse(req.body);
    const s = await getSettingsRow(userId);
    const meta = LEGAL_PAGES[kind as LegalPageKind];
    // the legal page takes the kit of the funnel (fonts, colors), if it has one
    const content = legalPageTemplate(kind, { company: s.sender_name, address: s.company_address, email: s.sender_email, site: f.name }, readFunnelSettings(f.settings).kit);
    const stepId = await db.transaction().execute(async (trx) => {
      const taken = new Set((await trx.selectFrom('steps').select('slug').where('funnel_id', '=', f.id).execute()).map((x) => x.slug));
      let slug = meta.slug;
      for (let n = 2; taken.has(slug); n++) slug = `${meta.slug}-${n}`;
      const id = await insertStep(trx, f.id, { name: meta.name, type: 'custom', content, slug });
      // footer link + skipped by "next step" links; the privacy policy also feeds the cookie banner link
      const settings = readFunnelSettings((await trx.selectFrom('funnels').select('settings').where('id', '=', f.id).forUpdate().executeTakeFirstOrThrow()).settings);
      settings.legal = { footer: true, step_ids: [...new Set([...(settings.legal?.step_ids ?? []), id])].slice(0, 10) };
      if (kind === 'privacy' && settings.cookie_banner && !settings.cookie_banner.privacy_step_id && !settings.cookie_banner.privacy_url) {
        settings.cookie_banner.privacy_step_id = id;
      }
      await trx.updateTable('funnels').set({ settings: JSON.stringify(settings) }).where('id', '=', f.id).execute();
      return id;
    });
    const detail = await funnelDetail(await ownedFunnel(userId, f.id));
    res.status(201).json({ step: detail.steps?.find((x) => x.id === stepId), funnel: detail });
  });

  // ---------- stats ----------

  r.get('/funnels/:id/stats', async (req, res) => {
    const f = await ownedFunnel(uid(req), req.params.id);
    const q = z
      .object({ period: z.enum(PERIODS as [string, ...string[]]).default('30'), group: z.enum(GROUPS as [string, ...string[]]).default('source') })
      .parse(req.query);
    res.json(await funnelStats(f.id, q.period as (typeof PERIODS)[number], q.group as (typeof GROUPS)[number]));
  });

  // ---------- A/B tests ----------

  r.get('/steps/:id/ab', async (req, res) => {
    const s = await ownedStep(uid(req), req.params.id);
    res.json(await abTestOf(s));
  });

  r.post('/steps/:id/variants', async (req, res) => {
    const s = await ownedStep(uid(req), req.params.id);
    const body = z.object({ name: z.string().trim().min(1).max(120).optional(), from_variant_id: z.number().int().positive().optional() }).parse(req.body ?? {});
    const existing = await db.selectFrom('step_variants').select(['id', 'content']).where('step_id', '=', s.id).execute();
    if (existing.length >= MAX_VARIANTS) throw new HttpError(409, `${MAX_VARIANTS} variantes maximum par page`);
    const source = body.from_variant_id ? existing.find((v) => v.id === body.from_variant_id) : null;
    if (body.from_variant_id && !source) throw notFound('Variante');
    const row = await db
      .insertInto('step_variants')
      .values({
        step_id: s.id,
        name: body.name ?? `Variante ${String.fromCharCode(66 + existing.length)}`, // B, C, D, E
        content: JSON.stringify(source?.content ?? s.content),
        weight: 50,
        created_at: nowIso(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    res.status(201).json({ ...toVariant(row), content: row.content });
  });

  async function ownedVariant(userId: number, rawId: unknown) {
    const row = await db
      .selectFrom('step_variants as v')
      .innerJoin('steps as s', 's.id', 'v.step_id')
      .innerJoin('funnels as f', 'f.id', 's.funnel_id')
      .selectAll('v')
      .select(['s.funnel_id', 's.ab_status'])
      .where('v.id', '=', paramId(rawId, 'Variante'))
      .where('f.user_id', '=', userId)
      .executeTakeFirst();
    if (!row) throw notFound('Variante');
    return row;
  }

  r.get('/variants/:id', async (req, res) => {
    const v = await ownedVariant(uid(req), req.params.id);
    res.json({ ...toVariant(v), content: v.content });
  });

  r.patch('/variants/:id', async (req, res) => {
    const v = await ownedVariant(uid(req), req.params.id);
    const body = z
      .object({
        name: z.string().trim().min(1).max(120).optional(),
        content: pageContentSchema.optional(),
        weight: z.number().int().min(0).max(100).optional(),
        active: z.boolean().optional(),
      })
      .parse(req.body);
    const row = await db
      .updateTable('step_variants')
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.content ? { content: JSON.stringify(body.content) } : {}),
        ...(body.weight !== undefined ? { weight: body.weight } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
      })
      .where('id', '=', v.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    res.json({ ...toVariant(row), content: row.content });
  });

  r.delete('/variants/:id', async (req, res) => {
    const v = await ownedVariant(uid(req), req.params.id);
    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom('step_variants').where('id', '=', v.id).execute();
      const left = await trx.selectFrom('step_variants').select('id').where('step_id', '=', v.step_id).executeTakeFirst();
      if (!left) await trx.updateTable('steps').set({ ab_status: 'off' }).where('id', '=', v.step_id).execute();
    });
    res.json({ ok: true });
  });

  r.patch('/steps/:id/ab', async (req, res) => {
    const s = await ownedStep(uid(req), req.params.id);
    const body = z.object({ status: z.enum(['off', 'running', 'paused']).optional(), control_weight: z.number().int().min(0).max(100).optional() }).parse(req.body);
    await db.transaction().execute(async (trx) => {
      if (body.status === 'running') {
        const active = await trx.selectFrom('step_variants').select('id').where('step_id', '=', s.id).where('active', '=', true).executeTakeFirst();
        if (!active) throw new HttpError(409, 'Ajoutez au moins une variante active avant de lancer le test');
      }
      // a new test (not a resume after a pause) starts from zero
      const starting = body.status === 'running' && s.ab_status === 'off';
      if (starting) await resetAbAttribution(s.id, trx);
      await trx
        .updateTable('steps')
        .set({
          ...(body.status ? { ab_status: body.status } : {}),
          ...(body.control_weight !== undefined ? { ab_control_weight: body.control_weight } : {}),
          ...(starting ? { ab_started_at: nowIso() } : {}),
        })
        .where('id', '=', s.id)
        .execute();
    });
    res.json(await abTestOf(await ownedStep(uid(req), s.id)));
  });

  /** Declare the winner: its content becomes the page (variant_id 0 = keep the original) and the test ends. */
  r.post('/steps/:id/ab/winner', async (req, res) => {
    const s = await ownedStep(uid(req), req.params.id);
    const { variant_id } = z.object({ variant_id: z.number().int().min(0) }).parse(req.body);
    await db.transaction().execute(async (trx) => {
      if (variant_id > 0) {
        const v = await trx.selectFrom('step_variants').select('content').where('id', '=', variant_id).where('step_id', '=', s.id).executeTakeFirst();
        if (!v) throw notFound('Variante');
        await trx.updateTable('steps').set({ content: JSON.stringify(v.content) }).where('id', '=', s.id).execute();
      }
      await trx.updateTable('steps').set({ ab_status: 'off' }).where('id', '=', s.id).execute();
      await trx.updateTable('step_variants').set({ active: false }).where('step_id', '=', s.id).execute();
    });
    res.json(await abTestOf(await ownedStep(uid(req), s.id)));
  });

  // ---------- export / import / share ----------

  r.get('/funnels/:id/export', async (req, res) => {
    const f = await ownedFunnel(uid(req), req.params.id);
    const data = await buildExport(f.id);
    res.setHeader('Content-Disposition', `attachment; filename="tunnel-${f.slug}.json"`);
    res.json(data);
  });

  r.post('/funnels/import', async (req, res) => {
    const size = Number(req.headers['content-length'] ?? 0) || JSON.stringify(req.body ?? null).length;
    if (size > MAX_IMPORT_BYTES) throw new HttpError(413, 'Fichier trop volumineux (2 Mo maximum)');
    const result = await importFunnel(uid(req), req.body);
    res.status(201).json(result);
  });

  r.get('/funnels/:id/share', async (req, res) => {
    const f = await ownedFunnel(uid(req), req.params.id);
    res.json({ active: !!f.share_token_hash, created_at: f.share_created_at });
  });

  /** Creates (or replaces) the share link. The token is only shown now: it is stored hashed. */
  r.post('/funnels/:id/share', async (req, res) => {
    const f = await ownedFunnel(uid(req), req.params.id);
    const token = newShareToken();
    const now = nowIso();
    await db.updateTable('funnels').set({ share_token_hash: hashShareToken(token), share_created_at: now }).where('id', '=', f.id).execute();
    res.status(201).json({ active: true, created_at: now, url: shareUrl(token) });
  });

  r.delete('/funnels/:id/share', async (req, res) => {
    const f = await ownedFunnel(uid(req), req.params.id);
    await db.updateTable('funnels').set({ share_token_hash: null, share_created_at: null }).where('id', '=', f.id).execute();
    res.json({ active: false, created_at: null });
  });

  /** Clones a shared funnel into the signed-in account. */
  r.post('/share/:token/import', async (req, res) => {
    const src = await funnelByShareToken(String(req.params.token));
    if (!src) throw new HttpError(404, 'Ce lien de partage est invalide ou a été désactivé');
    const data = await buildExport(src.id);
    res.status(201).json(await importFunnel(uid(req), data));
  });

  return r;
}

/** Public endpoints (no session): TLS on-demand check for the reverse proxy, preview of a shared funnel. */
export function createGrowthPublicRouter() {
  const r = Router();

  // Caddy `on_demand_tls { ask … }`: 200 only for verified custom domains, so certificates are never requested for
  // arbitrary host names pointed at the server.
  r.get('/domains/allowed', async (req, res) => {
    const raw = typeof req.query.domain === 'string' ? req.query.domain : '';
    const n = normalizeCustomDomain(raw);
    const row = 'domain' in n
      ? await db.selectFrom('custom_domains').select('id').where('domain', '=', n.domain).where('status', '=', 'verified').executeTakeFirst()
      : undefined;
    res.setHeader('Cache-Control', 'no-store');
    if (!row) return res.status(404).json({ error: 'Domaine inconnu' });
    res.json({ ok: true });
  });

  r.get('/share/:token', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const src = await funnelByShareToken(String(req.params.token));
    if (!src) throw new HttpError(404, 'Ce lien de partage est invalide ou a été désactivé');
    const steps = await db.selectFrom('steps').select(['name', 'type', 'content', 'access']).where('funnel_id', '=', src.id).orderBy('position').orderBy('id').execute();
    const out: SharedFunnelPreview = {
      name: src.name,
      owner: src.owner,
      steps: steps.map((s) => ({ name: s.name, type: s.type, content: s.content, protected: (parseAccess(s.access) as StepAccess).mode !== 'public' })),
    };
    res.json(out);
  });

  return r;
}
