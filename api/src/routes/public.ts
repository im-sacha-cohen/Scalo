import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { blocksOfType, esc, pageHasCustomCode, renderPageDocument, type PageContent } from '@scalo/shared';
import bcrypt from 'bcryptjs';
import type { StepAccess } from '@scalo/shared';
import { db, nowIso } from '../db';
import { addTag, enrollInCampaign, getOrCreateTag, logEvent, upsertContact } from '../services/contacts';
import { getSettingsRow } from '../services/email';
import { poweredByPageHtml } from '../services/branding';
import { fieldVars, formFieldChanges, listFieldDefs } from '../services/fields';
import { confirmOptin, lookupOptin, requestOptin } from '../services/optin';
import { paymentRenderContext } from '../services/payments';
import { recordAffiliateLead, trackAffiliateVisit } from '../services/affiliates';
import { hmac, signId, verifyPreviewToken, verifySignedId } from '../util';
import { parseAccess } from './funnels';
import { hit, LIMITS } from '../services/ratelimit';
import type { FunnelSettings } from '@scalo/shared';
import { chooseArm, submitArm } from '../services/ab';
import { isEmptyAttribution, submitAttribution, visitAttribution } from '../services/attribution';
import { CONSENT_COOKIE, CONSENT_MAX_AGE, pageExtras, readFunnelSettings } from '../services/tracking';
import type { Db } from '../db';

export const publicRouter = Router();

/**
 * `base`: URL prefix of the funnel's pages — `/p/<slug>` (default) or `''` on a verified custom domain, so every internal
 * URL (next step, form action, redirects, cookie paths) is right in both modes.
 */
export interface FunnelRow { id: number; user_id: number; name: string; slug: string; settings: FunnelSettings; base?: string }
interface StepRow {
  id: number; funnel_id: number; name: string; slug: string; position: number; content: PageContent; access: StepAccess; password_hash: string | null;
  ab_status: 'off' | 'running' | 'paused'; ab_control_weight: number;
}

const YEAR_MS = 365 * 86400_000;
const cookieOpts = { httpOnly: true, sameSite: 'lax' as const, maxAge: YEAR_MS, path: '/' };

function simplePage(title: string, heading: string, body: string, status = 200) {
  return {
    status,
    html: `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f1f5f9;font-family:Inter,'Helvetica Neue',Arial,sans-serif;color:#0f172a}
.card{background:#fff;max-width:460px;margin:24px;padding:40px 36px;border-radius:16px;box-shadow:0 10px 30px rgba(15,23,42,.08);text-align:center}
.icon{width:56px;height:56px;border-radius:50%;background:#e0e7ff;color:#2563eb;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:28px}
h1{font-size:24px;margin:0 0 12px}p{color:#475569;line-height:1.6;margin:0}</style></head>
<body><div class="card">${heading}${body}</div></body></html>`,
  };
}

export function sendSimple(res: Response, p: { status: number; html: string }) {
  res.status(p.status).type('html').send(p.html);
}

const emptyPage = (): PageContent => ({ settings: {} as PageContent['settings'], blocks: [] });

export const notFoundPage = () => simplePage('Page introuvable', '<div class="icon">?</div><h1>Page introuvable</h1>', '<p>Cette page n’existe pas ou a été supprimée.</p>', 404);

async function loadFunnel(slug: string): Promise<FunnelRow | undefined> {
  const f = await db.selectFrom('funnels').select(['id', 'user_id', 'name', 'slug', 'settings']).where('slug', '=', slug).executeTakeFirst();
  return f ? { ...f, settings: readFunnelSettings(f.settings) } : undefined;
}
function loadSteps(funnelId: number): Promise<StepRow[]> {
  return db
    .selectFrom('steps')
    .select(['id', 'funnel_id', 'name', 'slug', 'position', 'content', 'access', 'password_hash', 'ab_status', 'ab_control_weight'])
    .where('funnel_id', '=', funnelId)
    .orderBy('position')
    .orderBy('id')
    .execute();
}
/** URL prefix of the funnel's pages (`/p/<slug>` or `''` on its custom domain). */
const funnelBase = (f: FunnelRow) => f.base ?? `/p/${encodeURIComponent(f.slug)}`;
/** Path of the cookies scoped to the funnel (password, consent, A/B arm, attribution). */
const funnelCookiePath = (f: FunnelRow) => funnelBase(f) || '/';
const stepUrl = (f: FunnelRow, s: Pick<StepRow, 'slug'>) => `${funnelBase(f)}/${encodeURIComponent(s.slug)}`;

async function resolve(req: Request) {
  const funnel = await loadFunnel(String(req.params.funnelSlug));
  if (!funnel) return null;
  return resolveIn(funnel, String(req.params.stepSlug));
}

/**
 * Step of a funnel by slug (`null` = the root step: `rootStepId` or the first one). Legal pages of the funnel are
 * skipped by "next step" links.
 */
export async function resolveIn(funnel: FunnelRow, stepSlug: string | null, rootStepId?: number | null) {
  const steps = await loadSteps(funnel.id);
  let idx = stepSlug === null ? Math.max(0, steps.findIndex((s) => s.id === rootStepId)) : steps.findIndex((s) => s.slug === stepSlug);
  if (!steps.length) idx = -1;
  if (idx < 0) return null;
  const step = steps[idx];
  const legal = new Set(funnel.settings.legal?.step_ids ?? []);
  const next = steps.slice(idx + 1).find((s) => !legal.has(s.id)) ?? step;
  return { funnel, steps, idx, step, nextUrl: stepUrl(funnel, next) };
}

// ---------- access control ----------

export type Resolved = NonNullable<Awaited<ReturnType<typeof resolveIn>>>;

const pwCookieName = (stepId: number) => `scalo_pw_${stepId}`;
const pwCookieValue = (step: StepRow) => hmac('steppw', `${step.id}:${step.password_hash}`);

async function visitorContact(req: Request, userId: number) {
  const cid = verifySignedId('cid', req.cookies?.scalo_cid);
  return cid ? db.selectFrom('contacts').selectAll().where('id', '=', cid).where('user_id', '=', userId).executeTakeFirst() : undefined;
}

async function hasAccess(req: Request, r: Resolved, step: StepRow, access: StepAccess): Promise<boolean> {
  switch (access.mode) {
    case 'public':
      return true;
    case 'password':
      return !!step.password_hash && req.cookies?.[pwCookieName(step.id)] === pwCookieValue(step);
    case 'funnel': {
      const c = await visitorContact(req, r.funnel.user_id);
      if (!c) return false;
      const optin = await db
        .selectFrom('contact_events')
        .select('id')
        .where('contact_id', '=', c.id)
        .where('funnel_id', '=', r.funnel.id)
        .where('type', '=', 'optin')
        .limit(1)
        .executeTakeFirst();
      return !!optin;
    }
    case 'tag': {
      const c = await visitorContact(req, r.funnel.user_id);
      if (!c || !access.tag_id) return false;
      const t = await db.selectFrom('contact_tags').select('tag_id').where('contact_id', '=', c.id).where('tag_id', '=', access.tag_id).executeTakeFirst();
      return !!t;
    }
    default:
      return false;
  }
}

/** Where to send a denied visitor: a public step before this one (never another protected step, to avoid loops). */
function deniedTarget(r: Resolved, access: StepAccess, qs: string): string | null {
  if (access.redirect === 'url' && access.redirect_url) return access.redirect_url;
  const earlier = r.steps.slice(0, r.idx).filter((s) => parseAccess(s.access).mode === 'public');
  const target = access.redirect === 'previous' ? earlier[earlier.length - 1] : earlier[0];
  return target ? stepUrl(r.funnel, target) + qs : null;
}

const restrictedPage = () =>
  simplePage(
    'Accès réservé',
    '<div class="icon">🔒</div><h1>Accès réservé</h1>',
    '<p>Cette page est réservée. Inscrivez-vous d’abord via la page d’accueil de ce tunnel pour y accéder.</p>',
    403,
  );

function passwordPage(r: Resolved, qs: string, error: boolean) {
  const action = `${stepUrl(r.funnel, r.step)}/unlock${qs}`;
  return simplePage(
    'Page protégée',
    '<div class="icon">🔒</div><h1>Page protégée</h1>',
    `<p>Saisissez le mot de passe pour accéder à cette page.</p>
     <form method="post" action="${esc(action)}" style="margin-top:20px;display:flex;flex-direction:column;gap:10px">
       <input type="password" name="password" required autofocus placeholder="Mot de passe" autocomplete="current-password"
         style="padding:12px 14px;border:1px solid ${error ? '#f87171' : '#cbd5e1'};border-radius:8px;font-size:16px">
       ${error ? '<p style="color:#b91c1c;font-size:14px;margin:0">Mot de passe incorrect.</p>' : ''}
       <button type="submit" style="background:#0f172a;color:#fff;border:0;border-radius:8px;padding:12px;font-size:15px;font-weight:600;cursor:pointer">Accéder à la page</button>
     </form>`,
    401,
  );
}

/** Returns true if the request may proceed; otherwise the response has been sent. */
async function enforceAccess(req: Request, res: Response, r: Resolved, qs: string, ownerPreview: boolean) {
  const access = parseAccess(r.step.access);
  if (access.mode === 'public') return true;
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'no-store');
  if (ownerPreview || (await hasAccess(req, r, r.step, access))) return true;
  if (access.mode === 'password') {
    sendSimple(res, passwordPage(r, qs, req.query.error === 'pw'));
    return false;
  }
  const target = deniedTarget(r, access, qs);
  if (target) res.redirect(302, target);
  else sendSimple(res, restrictedPage());
  return false;
}

function visitorId(req: Request, res: Response) {
  let vid = req.cookies?.scalo_vid as string | undefined;
  if (!vid || !/^[\w-]{8,64}$/.test(vid)) {
    vid = crypto.randomUUID();
    res.cookie('scalo_vid', vid, cookieOpts);
  }
  return vid;
}

publicRouter.get('/p/:funnelSlug', async (req, res) => {
  const funnel = await loadFunnel(String(req.params.funnelSlug));
  const first = funnel ? (await loadSteps(funnel.id))[0] : undefined;
  if (!funnel || !first) return sendSimple(res, notFoundPage());
  const qs = req.query.preview ? `?preview=${encodeURIComponent(String(req.query.preview))}` : '';
  // affiliate link on the funnel's root: the code follows the visitor to the first step, which records the visit
  const aff = typeof req.query.aff === 'string' && req.query.aff ? `${qs ? '&' : '?'}aff=${encodeURIComponent(req.query.aff.slice(0, 40))}` : '';
  res.redirect(302, stepUrl(funnel, first) + qs + aff);
});

publicRouter.get('/p/:funnelSlug/:stepSlug', async (req, res) => {
  const r = await resolve(req);
  if (!r) return sendSimple(res, notFoundPage());
  await viewStep(req, res, r);
});

/** Renders a step (`/p/:funnel/:step` or `https://<custom domain>/<step>`). */
export async function viewStep(req: Request, res: Response, r: Resolved) {
  const { funnel, step } = r;
  // Any ?preview=… skips view counting; only a valid signed token (owner) also bypasses access rules.
  const preview = typeof req.query.preview === 'string' && req.query.preview !== '';
  const ownerPreview = preview && verifyPreviewToken(funnel.id, req.query.preview);
  const qs = preview ? `?preview=${encodeURIComponent(String(req.query.preview))}` : '';
  if (!(await enforceAccess(req, res, r, qs, ownerPreview))) return;

  // A/B test: sticky arm of the visitor (the owner preview may force one with ?variant=<id>)
  const arm = await chooseArm(req, res, step, funnelCookiePath(funnel), ownerPreview);
  if (!preview) {
    const vid = visitorId(req, res);
    // affiliation: `?aff=<code>` sets the tracking cookie and records the click (services/affiliates.ts)
    if (req.query.aff !== undefined) await trackAffiliateVisit(req, res, { userId: funnel.user_id, funnelId: funnel.id, stepId: step.id, visitorId: vid });
    const src = visitAttribution(req, res, funnelCookiePath(funnel));
    // unique (step_id, visitor_id): one view per visitor and step. A visitor seen before the test started gets the
    // arm of their first view during the test.
    await db
      .insertInto('page_views')
      .values({
        user_id: funnel.user_id,
        funnel_id: funnel.id,
        step_id: step.id,
        visitor_id: vid,
        variant_id: arm.variantId,
        utm_source: src.utm_source ?? null,
        utm_medium: src.utm_medium ?? null,
        utm_campaign: src.utm_campaign ?? null,
        utm_content: src.utm_content ?? null,
        utm_term: src.utm_term ?? null,
        referrer_host: src.referrer ?? null,
        created_at: nowIso(),
      })
      .onConflict((oc) =>
        arm.variantId === null
          ? oc.columns(['step_id', 'visitor_id']).doNothing()
          : oc
              .columns(['step_id', 'visitor_id'])
              .doUpdateSet({ variant_id: arm.variantId })
              .where('page_views.variant_id', 'is', null),
      )
      .execute();
  }

  const vars: Record<string, string> = { first_name: '', last_name: '', email: '', phone: '' };
  const cid = verifySignedId('cid', req.cookies?.scalo_cid);
  // {{field.key}}: custom fields ('' for an unknown visitor)
  const fieldDefs = await listFieldDefs(funnel.user_id);
  Object.assign(vars, fieldVars(fieldDefs, null));
  if (cid) {
    const c = await db.selectFrom('contacts').selectAll().where('id', '=', cid).where('user_id', '=', funnel.user_id).executeTakeFirst();
    if (c) Object.assign(vars, { first_name: c.first_name ?? '', last_name: c.last_name ?? '', email: c.email, phone: c.phone ?? '' }, fieldVars(fieldDefs, c.fields));
  }

  const content = arm.content ?? emptyPage();
  // pixels (after consent when the cookie banner is on), cookie banner, legal pages footer
  const lead = req.cookies?.scalo_lead === String(funnel.id);
  if (lead) res.clearCookie('scalo_lead', { path: funnelCookiePath(funnel) });
  const extras = pageExtras({
    settings: funnel.settings,
    consent: req.cookies?.scalo_consent,
    lead: lead && !preview,
    consentAction: `${stepUrl(funnel, step)}/consent${qs}`,
    stepHref: (id) => {
      const s = r.steps.find((x) => x.id === id);
      return s ? { name: s.name, href: stepUrl(funnel, s) + qs } : null;
    },
  });
  let html = renderPageDocument(content, {
    title: step.name,
    nextUrl: r.nextUrl + qs,
    formAction: `${stepUrl(funnel, step)}/submit${qs}`,
    // payment blocks: form targets + current name / price of the offers they sell ({} when the page has none)
    ...(await paymentRenderContext(funnel.user_id, content, stepUrl(funnel, step), qs, req.query.pay)),
    vars,
    headExtra: extras.headExtra,
    bodyEnd: extras.bodyEnd + (await poweredByPageHtml(funnel.user_id)),
  });
  if (req.query.error === 'email') {
    const banner = `<div role="alert" style="max-width:${Number(content.settings?.maxWidth) || 880}px;margin:0 auto;background:#fee2e2;color:#b91c1c;border:1px solid #fecaca;padding:12px 16px;font-family:Arial,sans-serif;font-size:15px;text-align:center">Adresse email invalide. Merci de vérifier et de réessayer.</div>`;
    html = html.replace('<main', `${banner}<main`);
  }
  if (req.query.doi === '1') {
    const banner = `<div role="status" style="max-width:${Number(content.settings?.maxWidth) || 880}px;margin:0 auto;background:#e0f2fe;color:#075985;border:1px solid #bae6fd;padding:12px 16px;font-family:Arial,sans-serif;font-size:15px;text-align:center">📬 Vérifiez votre boîte mail : cliquez sur le lien que nous venons de vous envoyer pour confirmer votre inscription.</div>`;
    html = html.replace('<main', `${banner}<main`);
  }
  if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-store');
  if (pageHasCustomCode(content)) {
    // Owner-authored HTML/JS runs in an opaque origin: it cannot read the app's storage or cookies
    // (public pages are served from the same origin as the app), but forms, links and scripts keep working.
    res.setHeader(
      'Content-Security-Policy',
      'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation allow-modals',
    );
  }
  res.type('html').send(html);
}

const submitSchema = z.object({
  email: z.string().trim().max(254).optional().default(''),
  first_name: z.string().max(200).optional(),
  last_name: z.string().max(200).optional(),
  phone: z.string().max(60).optional(),
  _block: z.string().max(100).optional(),
});
const emailCheck = z.email();

publicRouter.post('/p/:funnelSlug/:stepSlug/submit', async (req, res) => {
  const r = await resolve(req);
  if (!r) return sendSimple(res, notFoundPage());
  await submitStep(req, res, r);
});

/** Form submission of a step (optin). */
export async function submitStep(req: Request, res: Response, r: Resolved) {
  const { funnel, step } = r;
  const preview = typeof req.query.preview === 'string' && req.query.preview !== '';
  const qs = preview ? `?preview=${encodeURIComponent(String(req.query.preview))}` : '';
  // A form on a protected step can only be submitted by visitors allowed to see that step.
  const access = parseAccess(step.access);
  if (access.mode !== 'public' && !verifyPreviewToken(funnel.id, req.query.preview) && !(await hasAccess(req, r, step, access))) {
    return res.redirect(303, stepUrl(funnel, step) + qs);
  }
  const parsed = submitSchema.safeParse(req.body ?? {});
  const body = parsed.success ? parsed.data : { email: '' } as z.infer<typeof submitSchema>;
  const email = body.email.toLowerCase();
  if (!emailCheck.safeParse(email).success) {
    return res.redirect(303, `${stepUrl(funnel, step)}?error=email${preview ? `&preview=${encodeURIComponent(String(req.query.preview))}` : ''}`);
  }

  // A/B test: the form (tag, campaign, double opt-in…) is the one of the arm the visitor saw
  const arm = await submitArm(req, step);
  const attribution = submitAttribution(req);
  const content = arm.content ?? emptyPage();
  const forms = blocksOfType(content.blocks ?? [], 'form'); // forms can be nested in sections / columns
  const block = forms.find((b) => b.id === body._block) ?? forms[0];

  const settings = await getSettingsRow(funnel.user_id);
  const doubleOptin = block?.doubleOptin ?? settings.double_optin_default;
  const campaignId = Number(block?.campaignId);
  const validCampaign = !!block?.campaignId && Number.isSafeInteger(campaignId) && campaignId > 0;
  // inputs `field.<key>` of the form → custom fields of the contact (invalid values ignored)
  const customFields = await formFieldChanges(funnel.user_id, req.body, block);

  const contactId = await db.transaction().execute(async (trx) => {
    const { contact } = await upsertContact(
      funnel.user_id,
      { email, first_name: body.first_name, last_name: body.last_name, phone: body.phone, fields: customFields },
      { optin: doubleOptin ? 'pending' : 'confirmed' },
      trx,
    );
    await logEvent(funnel.user_id, contact.id, 'optin', { funnel: funnel.name, step: step.name, ...(doubleOptin ? { double_optin: true } : {}) }, { funnel_id: funnel.id, step_id: step.id }, trx);
    await recordOptinAttribution(trx, contact.id, step.id, arm.variantId, attribution);
    // affiliation: the lead is attributed to the visitor's affiliate (statistics only)
    await recordAffiliateLead(trx, req, funnel.user_id, contact);
    if (doubleOptin) {
      // Nothing is applied yet (tag, campaign, re-subscription): only once the contact clicks the confirmation link.
      await requestOptin(
        {
          userId: funnel.user_id,
          contact,
          tagName: block?.tagName,
          campaignId: validCampaign ? campaignId : null,
          funnelId: funnel.id,
          stepId: step.id,
          redirectUrl: block?.doubleOptinRedirect,
          subject: block?.doubleOptinSubject,
          text: block?.doubleOptinText,
        },
        trx,
      );
      return contact.id;
    }
    if (contact.unsubscribed) await trx.updateTable('contacts').set({ unsubscribed: false }).where('id', '=', contact.id).execute(); // explicit re-optin
    if (block?.tagName?.trim()) {
      await addTag(funnel.user_id, contact.id, await getOrCreateTag(funnel.user_id, block.tagName, trx), undefined, trx);
    }
    if (validCampaign) await enrollInCampaign(funnel.user_id, campaignId, contact.id, undefined, trx); // ownership checked inside
    return contact.id;
  });

  res.cookie('scalo_cid', signId('cid', contactId), cookieOpts);
  // the next page fires the pixels' Lead / generate_lead event (once)
  res.cookie('scalo_lead', String(funnel.id), { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60_000, path: funnelCookiePath(funnel) });
  // double opt-in: the next page shows a "check your inbox" notice
  res.redirect(303, doubleOptin ? `${r.nextUrl}${qs ? `${qs}&` : '?'}doi=1` : r.nextUrl + qs);
}

/**
 * Stores the A/B arm and the first-touch attribution on the optin event just logged, and on the contact when it has
 * no source yet (never overwritten).
 */
async function recordOptinAttribution(trx: Db, contactId: number, stepId: number, variantId: number | null, a: ReturnType<typeof submitAttribution>) {
  const json = isEmptyAttribution(a) ? null : JSON.stringify(a);
  if (variantId !== null || json) {
    await trx
      .updateTable('contact_events')
      .set({ variant_id: variantId, attribution: json })
      .where('id', '=', (eb) =>
        eb.selectFrom('contact_events').select(eb.fn.max('id').as('m')).where('contact_id', '=', contactId).where('step_id', '=', stepId).where('type', '=', 'optin'),
      )
      .execute();
  }
  await trx
    .updateTable('contacts')
    .set({ source: json ?? '{}' }) // {} = direct visit
    .where('id', '=', contactId)
    .where('source', 'is', null)
    .execute();
}

publicRouter.post('/p/:funnelSlug/:stepSlug/unlock', async (req, res) => {
  const r = await resolve(req);
  if (!r) return sendSimple(res, notFoundPage());
  await unlockStep(req, res, r);
});

publicRouter.post('/p/:funnelSlug/:stepSlug/consent', async (req, res) => {
  const r = await resolve(req);
  if (!r) return sendSimple(res, notFoundPage());
  consentStep(req, res, r);
});

/** Cookie banner choice (plain form POST: works without JavaScript and in sandboxed pages). Always back to the same step. */
export function consentStep(req: Request, res: Response, r: Resolved) {
  const qs = typeof req.query.preview === 'string' && req.query.preview ? `?preview=${encodeURIComponent(req.query.preview)}` : '';
  const choice = req.body?.choice === 'granted' ? 'granted' : req.body?.choice === 'denied' ? 'denied' : null;
  if (choice) res.cookie(CONSENT_COOKIE, choice, { httpOnly: true, sameSite: 'lax', maxAge: CONSENT_MAX_AGE, path: funnelCookiePath(r.funnel) });
  res.redirect(303, stepUrl(r.funnel, r.step) + qs);
}

/** Password form of a protected step. */
export async function unlockStep(req: Request, res: Response, r: Resolved) {
  const qs = typeof req.query.preview === 'string' && req.query.preview ? `?preview=${encodeURIComponent(req.query.preview)}` : '';
  const back = stepUrl(r.funnel, r.step);
  const access = parseAccess(r.step.access);
  if (access.mode !== 'password' || !r.step.password_hash) return res.redirect(303, back + qs);
  // Brute-force protection: 10 attempts / 15 min per IP and step, counted in the database (shared by all instances).
  const limited = await hit(`step:${r.step.id}:${req.ip ?? ''}`, LIMITS.stepPassword);
  if (limited.blocked) {
    res.setHeader('Retry-After', String(limited.retryAfter));
    return sendSimple(res, simplePage('Trop de tentatives', '<div class="icon">⏳</div><h1>Trop de tentatives</h1>', '<p>Réessayez dans quelques minutes.</p>', 429));
  }
  const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 200) : '';
  const ok = password !== '' && (await bcrypt.compare(password, r.step.password_hash));
  if (!ok) return res.redirect(303, `${back}${qs ? `${qs}&` : '?'}error=pw`);
  res.cookie(pwCookieName(r.step.id), pwCookieValue(r.step), { ...cookieOpts, maxAge: 30 * 86400_000, path: funnelCookiePath(r.funnel) });
  res.redirect(303, back + qs);
}

// ---------- tracking ----------

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** First open only (atomic: concurrent pixel loads log a single event). */
async function markOpened(sendId: number) {
  const s = await db
    .updateTable('email_sends')
    .set({ opened_at: nowIso() })
    .where('id', '=', sendId)
    .where('opened_at', 'is', null)
    .returning(['id', 'user_id', 'contact_id'])
    .executeTakeFirst();
  if (s?.contact_id) await logEvent(s.user_id, s.contact_id, 'email_opened', {});
}

const safeId = (v: string) => (/^\d{1,15}$/.test(v) ? Number(v) : null);

publicRouter.get('/t/o/:file', async (req, res) => {
  const m = /^(\d+)(?:\.gif)?$/.exec(String(req.params.file));
  const id = m ? safeId(m[1]) : null;
  if (id) {
    try {
      await markOpened(id);
    } catch (e) {
      console.error('[track open]', e);
    }
  }
  res.set({
    'Content-Type': 'image/gif',
    'Content-Length': String(GIF.length),
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Pragma: 'no-cache',
  });
  res.end(GIF);
});

publicRouter.get('/t/c/:id', async (req, res) => {
  const raw = typeof req.query.u === 'string' ? req.query.u : '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return res.status(400).type('text').send('Lien invalide');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return res.status(400).type('text').send('Lien invalide');

  const id = safeId(String(req.params.id));
  const s = id
    ? await db.selectFrom('email_sends').select(['id', 'user_id', 'contact_id', 'clicked_at', 'html', 'broadcast_id', 'campaign_id']).where('id', '=', id).executeTakeFirst()
    : undefined;
  // Only redirect to links that were actually part of this email (prevents open redirects).
  if (!s || !s.html || !s.html.includes(esc(`?u=${encodeURIComponent(raw)}`))) {
    return res.status(404).type('text').send('Lien introuvable');
  }
  await markOpened(s.id);
  if (!s.clicked_at) {
    await db.updateTable('email_sends').set({ clicked_at: nowIso() }).where('id', '=', s.id).where('clicked_at', 'is', null).execute();
  }
  // broadcast / campaign: "clic sur un lien" automations can be restricted to one email
  if (s.contact_id) await logEvent(s.user_id, s.contact_id, 'email_clicked', { url: url.toString(), broadcast_id: s.broadcast_id, campaign_id: s.campaign_id });
  res.redirect(302, url.toString());
});

// ---------- double opt-in confirmation ----------
// Same 2-step pattern as unsubscribe: mail scanners open links automatically, so GET only shows a button.

const optinPage = {
  invalid: () =>
    simplePage('Lien invalide', '<div class="icon">!</div><h1>Lien invalide</h1>', '<p>Ce lien de confirmation est invalide ou a déjà été remplacé par un lien plus récent.</p>', 404),
  expired: () =>
    simplePage(
      'Lien expiré',
      '<div class="icon">⏳</div><h1>Lien expiré</h1>',
      '<p>Ce lien de confirmation a expiré (il est valable 7 jours). Inscrivez-vous à nouveau via le formulaire pour recevoir un nouveau lien.</p>',
      410,
    ),
  confirmed: (email: string, redirect: string | null) =>
    simplePage(
      'Inscription confirmée',
      '<div class="icon">✓</div><h1>Inscription confirmée !</h1>',
      `<p>Merci ! L’adresse <strong>${esc(email)}</strong> est bien confirmée. Vous recevrez nos prochains emails.</p>${
        redirect ? `<p style="margin-top:20px"><a href="${esc(redirect)}" style="color:#2563eb;font-weight:600">Continuer</a></p>` : ''
      }`,
    ),
};

publicRouter.get('/c/:token', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const o = await lookupOptin(String(req.params.token));
  if (o.state === 'invalid') return sendSimple(res, optinPage.invalid());
  if (o.state === 'expired') return sendSimple(res, optinPage.expired());
  if (o.state === 'confirmed') return sendSimple(res, optinPage.confirmed(o.email, o.redirect));
  sendSimple(
    res,
    simplePage(
      'Confirmer mon inscription',
      '<div class="icon">✉</div><h1>Confirmez votre inscription</h1>',
      `<p>Cliquez sur le bouton ci-dessous pour confirmer l’adresse <strong>${esc(o.email)}</strong>.</p>
       <form method="post" style="margin-top:20px"><button type="submit" style="background:#2563eb;color:#fff;border:0;border-radius:8px;padding:12px 24px;font-size:15px;font-weight:600;cursor:pointer">Confirmer mon inscription</button></form>`,
    ),
  );
});

publicRouter.post('/c/:token', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const o = await confirmOptin(String(req.params.token));
  if (o.state === 'invalid') return sendSimple(res, optinPage.invalid());
  if (o.state === 'expired') return sendSimple(res, optinPage.expired());
  if (o.state === 'confirmed' && o.redirect) return res.redirect(303, o.redirect);
  if (o.state === 'confirmed') return sendSimple(res, optinPage.confirmed(o.email, null));
  sendSimple(res, optinPage.invalid());
});

// ---------- unsubscribe ----------

async function unsubContact(token: string) {
  const contactId = verifySignedId('unsub', token);
  return contactId ? db.selectFrom('contacts').selectAll().where('id', '=', contactId).executeTakeFirst() : undefined;
}

const invalidUnsub = () =>
  simplePage('Lien invalide', '<div class="icon">!</div><h1>Lien invalide</h1>', '<p>Ce lien de désinscription est invalide ou a expiré.</p>', 404);

// GET only asks for confirmation: mail scanners and link previewers open links automatically and must not unsubscribe people.
publicRouter.get('/u/:token', async (req, res) => {
  const contact = await unsubContact(String(req.params.token));
  if (!contact) return sendSimple(res, invalidUnsub());
  if (contact.unsubscribed) {
    return sendSimple(res, simplePage('Déjà désinscrit', '<div class="icon">✓</div><h1>Vous êtes déjà désinscrit</h1>', `<p>L’adresse <strong>${esc(contact.email)}</strong> ne reçoit plus nos emails.</p>`));
  }
  sendSimple(
    res,
    simplePage(
      'Se désinscrire',
      '<h1>Se désinscrire ?</h1>',
      `<p>L’adresse <strong>${esc(contact.email)}</strong> ne recevra plus nos emails.</p>
       <form method="post" style="margin-top:20px"><button type="submit" style="background:#0f172a;color:#fff;border:0;border-radius:8px;padding:12px 24px;font-size:15px;font-weight:600;cursor:pointer">Confirmer la désinscription</button></form>`,
    ),
  );
});

// POST: confirmation form, and RFC 8058 one-click unsubscribe from mail clients (List-Unsubscribe-Post).
publicRouter.post('/u/:token', async (req, res) => {
  const contact = await unsubContact(String(req.params.token));
  if (!contact) return sendSimple(res, invalidUnsub());
  if (!contact.unsubscribed) {
    await db.transaction().execute(async (trx) => {
      const r = await trx
        .updateTable('contacts')
        .set({ unsubscribed: true })
        .where('id', '=', contact.id)
        .where('unsubscribed', '=', false)
        .executeTakeFirst();
      if (!Number(r.numUpdatedRows)) return; // concurrent request already did it
      await trx
        .updateTable('email_sends')
        .set({ status: 'failed', error: 'unsubscribed' })
        .where('contact_id', '=', contact.id)
        .where('status', '=', 'pending')
        .execute();
      await trx
        .updateTable('campaign_subscriptions')
        .set({ status: 'unsubscribed', stopped_at: nowIso(), stopped_reason: 'Désinscrit des emails' })
        .where('contact_id', '=', contact.id)
        .where('status', 'in', ['active', 'completed'])
        .execute();
      await logEvent(contact.user_id, contact.id, 'unsubscribed', { via: req.body?.['List-Unsubscribe'] ? 'one-click' : 'lien' }, {}, trx);
    });
  }
  sendSimple(
    res,
    simplePage(
      'Désinscription confirmée',
      '<div class="icon">✓</div><h1>Vous êtes désinscrit</h1>',
      `<p>L’adresse <strong>${esc(contact.email)}</strong> ne recevra plus nos emails.</p><p style="margin-top:12px;font-size:14px;color:#94a3b8">Vous pourrez vous réinscrire à tout moment via l’un de nos formulaires.</p>`,
    ),
  );
});
