// Funnel export (versioned JSON), import (strict validation) and cloning through a share link.
// Export: funnel + steps + contents + access rules (never the password hash) + A/B variants + settings; tags by name,
// email campaigns detached (a form's campaign is not exported), steps referenced by index.
import crypto from 'node:crypto';
import { z } from 'zod';
import {
  FUNNEL_EXPORT_FORMAT,
  FUNNEL_EXPORT_VERSION,
  PAGE_BLOCK_TYPES,
  uid as blockUid,
  type Block,
  type FunnelExport,
  type FunnelExportStep,
  type FunnelImportResult,
  type PageContent,
  type StepAccess,
} from '@scalo/shared';
import { db, nowIso, type Db } from '../db';
import { HttpError, slugify } from '../util';
import { insertStep, parseAccess, uniqueFunnelSlug, withFreeSlug } from '../routes/funnels';
import { getOrCreateTag } from './contacts';
import { clean, funnelSettingsInput, readFunnelSettings } from './tracking';

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const MAX_STEPS = 50;
const MAX_BLOCKS = 1500;
const MAX_DEPTH = 8;

// ---------- content normalization ----------

const BLOCK_TYPES = new Set<string>(PAGE_BLOCK_TYPES);
const ID_RE = /^[\w-]{1,64}$/;

/**
 * Validates a page tree strictly (known block types, bounded size and depth) and returns a copy where invalid or
 * duplicate block / column ids are regenerated and form campaigns are detached.
 */
export function normalizeContent(raw: unknown, where: string): PageContent {
  if (!raw || typeof raw !== 'object') throw new HttpError(400, `${where} : contenu invalide`);
  const c = raw as { settings?: unknown; blocks?: unknown };
  if (!c.settings || typeof c.settings !== 'object' || Array.isArray(c.settings)) throw new HttpError(400, `${where} : réglages de page invalides`);
  if (!Array.isArray(c.blocks)) throw new HttpError(400, `${where} : liste de blocs invalide`);
  const seen = new Set<string>();
  let count = 0;
  const freshId = (id: unknown) => {
    let v = typeof id === 'string' && ID_RE.test(id) && !seen.has(id) ? id : blockUid();
    while (seen.has(v)) v = blockUid();
    seen.add(v);
    return v;
  };
  const walk = (list: unknown, depth: number): Block[] => {
    if (!Array.isArray(list)) throw new HttpError(400, `${where} : liste de blocs invalide`);
    if (depth > MAX_DEPTH) throw new HttpError(400, `${where} : imbrication de blocs trop profonde`);
    return list.map((b) => {
      if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, `${where} : bloc invalide`);
      const block = { ...(b as Record<string, unknown>) };
      if (typeof block.type !== 'string' || !BLOCK_TYPES.has(block.type)) {
        throw new HttpError(400, `${where} : type de bloc inconnu « ${String(block.type).slice(0, 30)} »`);
      }
      if (++count > MAX_BLOCKS) throw new HttpError(400, `${where} : trop de blocs`);
      block.id = freshId(block.id);
      if (block.type === 'form') delete block.campaignId; // email campaigns are not exported
      if (block.type === 'checkout' || block.type === 'upsell') {
        // products / offers belong to the account: the imported block must be pointed to an offer again
        for (const k of ['offerId', 'offerLabel', 'bumpOfferId', 'bumpOfferLabel']) delete block[k];
      }
      if (block.type === 'section') block.children = walk(block.children ?? [], depth + 1);
      if (block.type === 'columns') {
        if (!Array.isArray(block.columns) || block.columns.length > 4) throw new HttpError(400, `${where} : colonnes invalides`);
        block.columns = block.columns.map((col: unknown) => {
          if (!col || typeof col !== 'object') throw new HttpError(400, `${where} : colonne invalide`);
          const cc = { ...(col as Record<string, unknown>) };
          cc.id = freshId(cc.id);
          cc.children = walk(cc.children ?? [], depth + 1);
          return cc;
        });
      }
      return block as unknown as Block;
    });
  };
  return { settings: c.settings as PageContent['settings'], blocks: walk(c.blocks, 0) };
}

// ---------- export ----------

export async function buildExport(funnelId: number, ex: Db = db): Promise<FunnelExport> {
  const f = await ex.selectFrom('funnels').selectAll().where('id', '=', funnelId).executeTakeFirstOrThrow();
  const steps = await ex.selectFrom('steps').selectAll().where('funnel_id', '=', f.id).orderBy('position').orderBy('id').execute();
  const variants = steps.length
    ? await ex.selectFrom('step_variants').selectAll().where('step_id', 'in', steps.map((s) => s.id)).orderBy('id').execute()
    : [];
  const tagIds = steps.map((s) => parseAccess(s.access).tag_id).filter((x): x is number => !!x);
  const tags = tagIds.length ? await ex.selectFrom('tags').select(['id', 'name']).where('id', 'in', tagIds).execute() : [];
  const index = new Map(steps.map((s, i) => [s.id, i]));
  const settings = readFunnelSettings(f.settings);
  const strip = (c: PageContent) => normalizeContent(c, 'Export');

  const outSteps: FunnelExportStep[] = steps.map((s) => {
    const a = parseAccess(s.access);
    const vs = variants.filter((v) => v.step_id === s.id);
    return {
      name: s.name,
      slug: s.slug,
      type: s.type,
      content: strip(s.content),
      access: {
        mode: a.mode,
        ...(a.mode === 'tag' ? { tag: tags.find((t) => t.id === a.tag_id)?.name ?? null } : {}),
        ...(a.redirect ? { redirect: a.redirect } : {}),
        ...(a.redirect === 'url' && a.redirect_url ? { redirect_url: a.redirect_url } : {}),
      },
      ...(vs.length
        ? { ab: { status: s.ab_status, control_weight: s.ab_control_weight, variants: vs.map((v) => ({ name: v.name, content: strip(v.content), weight: v.weight, active: v.active })) } }
        : {}),
    };
  });
  const { privacy_step_id, ...banner } = settings.cookie_banner ?? { enabled: false };
  return {
    format: FUNNEL_EXPORT_FORMAT,
    version: FUNNEL_EXPORT_VERSION,
    exported_at: nowIso(),
    funnel: {
      name: f.name,
      slug: f.slug,
      settings: {
        ...(settings.kit ? { kit: settings.kit } : {}),
        ...(settings.tracking ? { tracking: settings.tracking } : {}),
        ...(settings.cookie_banner ? { cookie_banner: { ...banner, privacy_step: privacy_step_id ? (index.get(privacy_step_id) ?? null) : null } } : {}),
        ...(settings.legal ? { legal: { footer: settings.legal.footer, steps: settings.legal.step_ids.map((id) => index.get(id)).filter((i): i is number => i !== undefined) } } : {}),
      },
    },
    steps: outSteps,
  };
}

// ---------- import ----------

const contentShape = z.object({ settings: z.looseObject({}), blocks: z.array(z.unknown()).max(500) });
const stepShape = z
  .object({
    name: z.string().trim().min(1).max(120),
    slug: z.string().trim().max(80).optional(),
    type: z.enum(['optin', 'sales', 'thankyou', 'custom']),
    content: contentShape,
    access: z
      .object({
        mode: z.enum(['public', 'funnel', 'tag', 'password']),
        tag: z.string().trim().max(100).nullable().optional(),
        redirect: z.enum(['first', 'previous', 'url']).optional(),
        redirect_url: z.string().trim().max(500).optional(),
      })
      .strict()
      .optional(),
    ab: z
      .object({
        status: z.enum(['off', 'running', 'paused']),
        control_weight: z.number().int().min(0).max(100),
        variants: z
          .array(z.object({ name: z.string().trim().min(1).max(120), content: contentShape, weight: z.number().int().min(0).max(100), active: z.boolean() }).strict())
          .max(4),
      })
      .strict()
      .optional(),
  })
  .strict();
const index = z.number().int().min(0).max(MAX_STEPS - 1);
export const funnelExportSchema = z
  .object({
    format: z.literal(FUNNEL_EXPORT_FORMAT, { message: 'Ce fichier n’est pas un export de tunnel Scalo' }),
    version: z.number().int().min(1).max(FUNNEL_EXPORT_VERSION, { message: 'Version d’export trop récente : mettez à jour l’application' }),
    exported_at: z.string().max(40).optional(),
    funnel: z
      .object({
        name: z.string().trim().min(1).max(120),
        slug: z.string().trim().max(80).optional(),
        settings: z
          .object({
            kit: funnelSettingsInput.shape.kit,
            tracking: funnelSettingsInput.shape.tracking,
            cookie_banner: z
              .object({
                enabled: z.boolean(),
                text: z.string().trim().max(1000).optional(),
                accept_label: z.string().trim().max(40).optional(),
                decline_label: z.string().trim().max(40).optional(),
                privacy_url: z.string().trim().max(500).optional(),
                privacy_step: index.nullable().optional(),
              })
              .strict()
              .optional(),
            legal: z.object({ footer: z.boolean(), steps: z.array(index).max(10) }).strict().optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    steps: z.array(stepShape).min(1, 'Le tunnel ne contient aucune étape').max(MAX_STEPS, `${MAX_STEPS} étapes maximum`),
  })
  .strict();

/** Imports an export into the account: new funnel (fresh slug), tags created by name, imported tests are stopped. */
export async function importFunnel(userId: number, raw: unknown, opts: { name?: string } = {}): Promise<FunnelImportResult> {
  const data = funnelExportSchema.parse(raw);
  const warnings: string[] = [];
  // validate every content before writing anything
  const steps = data.steps.map((s, i) => ({
    ...s,
    content: normalizeContent(s.content, `Étape ${i + 1}`),
    variants: (s.ab?.variants ?? []).map((v, j) => ({ ...v, content: normalizeContent(v.content, `Étape ${i + 1}, variante ${j + 1}`) })),
  }));
  const name = (opts.name ?? data.funnel.name).slice(0, 120);

  const id = await withFreeSlug(db, async (trx) => {
    const f = await trx
      .insertInto('funnels')
      .values({ user_id: userId, name, slug: await uniqueFunnelSlug(data.funnel.slug || name, trx), created_at: nowIso() })
      .returning('id')
      .executeTakeFirstOrThrow();
    const usedSlugs = new Set<string>();
    const ids: number[] = [];
    for (const s of steps) {
      const base = slugify(s.slug || s.name, 'page');
      let slug = base;
      for (let n = 2; usedSlugs.has(slug); n++) slug = `${base}-${n}`;
      usedSlugs.add(slug);
      let access: StepAccess = { mode: 'public' };
      const a = s.access;
      if (a && a.mode !== 'public') {
        const redirect = a.redirect === 'url' && !/^(https?:\/\/|\/)/i.test(a.redirect_url ?? '') ? 'first' : (a.redirect ?? 'first');
        access = { mode: a.mode, redirect, ...(redirect === 'url' ? { redirect_url: a.redirect_url } : {}) };
        if (a.mode === 'tag') {
          if (a.tag?.trim()) access.tag_id = (await getOrCreateTag(userId, a.tag, trx)).id;
          else {
            access = { mode: 'funnel', redirect };
            warnings.push(`« ${s.name} » : le tag requis est inconnu, l’accès est réservé aux inscrits du tunnel.`);
          }
        }
        if (a.mode === 'password') warnings.push(`« ${s.name} » était protégée par mot de passe : définissez un nouveau mot de passe (la page reste fermée d’ici là).`);
      }
      const stepId = await insertStep(trx, f.id, { name: s.name, type: s.type, content: s.content, slug, access });
      ids.push(stepId);
      if (s.variants.length) {
        await trx
          .insertInto('step_variants')
          .values(s.variants.map((v) => ({ step_id: stepId, name: v.name, content: JSON.stringify(v.content), weight: v.weight, active: v.active, created_at: nowIso() })))
          .execute();
        await trx.updateTable('steps').set({ ab_control_weight: s.ab?.control_weight ?? 50 }).where('id', '=', stepId).execute();
        if (s.ab?.status === 'running') warnings.push(`« ${s.name} » : le test A/B importé est arrêté, relancez-le quand vous êtes prêt.`);
      }
    }
    const st = data.funnel.settings ?? {};
    const settings = clean(
      funnelSettingsInput.parse({
        ...(st.kit ? { kit: st.kit } : {}),
        ...(st.tracking ? { tracking: st.tracking } : {}),
        ...(st.cookie_banner
          ? {
              cookie_banner: {
                enabled: st.cookie_banner.enabled,
                text: st.cookie_banner.text,
                accept_label: st.cookie_banner.accept_label,
                decline_label: st.cookie_banner.decline_label,
                privacy_url: /^https?:\/\//i.test(st.cookie_banner.privacy_url ?? '') ? st.cookie_banner.privacy_url : undefined,
                privacy_step_id: st.cookie_banner.privacy_step != null ? (ids[st.cookie_banner.privacy_step] ?? null) : null,
              },
            }
          : {}),
        ...(st.legal ? { legal: { footer: st.legal.footer, step_ids: st.legal.steps.map((i) => ids[i]).filter((x): x is number => !!x) } } : {}),
      }),
    );
    await trx.updateTable('funnels').set({ settings: JSON.stringify(settings) }).where('id', '=', f.id).execute();
    return f.id;
  });
  return { id, warnings };
}

// ---------- share link ----------

export const hashShareToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
/** 32 random bytes (256 bits), prefixed so leaked tokens are easy to spot. Only the SHA-256 is stored. */
export const newShareToken = () => `scalo_sh_${crypto.randomBytes(32).toString('base64url')}`;
export const SHARE_TOKEN_RE = /^scalo_sh_[\w-]{43}$/;

export async function funnelByShareToken(token: string) {
  if (!SHARE_TOKEN_RE.test(token)) return undefined;
  return db
    .selectFrom('funnels as f')
    .innerJoin('users as u', 'u.id', 'f.user_id')
    .select(['f.id', 'f.name', 'f.user_id', 'u.name as owner'])
    .where('f.share_token_hash', '=', hashShareToken(token))
    .executeTakeFirst();
}
