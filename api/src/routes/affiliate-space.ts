// Affiliate area (public, server-rendered, `/a/<slug>/…`): program page and signup, magic-link login, dashboard, links,
// payout details, terms. Every request is resolved inside ONE account (the program's owner) and, once logged in, ONE
// affiliate: statistics, commissions and payouts are always looked up with that affiliate id.
//
// Authentication is the members area's (services/members.ts): one-time emailed link (hashed token, 20 min) and a signed
// httpOnly session cookie bound to the account — here scoped to `/a/<slug>`.
import crypto from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { db, nowIso, type ContactRow } from '../db';
import {
  affiliateLinks,
  balancesOf,
  createAffiliate,
  encryptPayoutDetails,
  programPath,
  PROGRAM_SLUG_RE,
  readPayoutDetails,
  requestAffiliateLink,
  statsOf,
  type AffiliateRow,
  type ProgramRow,
} from '../services/affiliates';
import {
  badLinkPage,
  confirmLoginPage,
  dashboardPage,
  landingPage,
  linkSentPage,
  loginPage,
  messagePage,
  notFoundAffPage,
  statusPage,
  termsPage,
  unknownProgramHtml,
  type AffChrome,
  type Page,
} from '../services/affiliate-pages';
import { normEmail, upsertContact } from '../services/contacts';
import { afterResponse, cleanupLoginTokens, consumeLoginToken, hashLoginToken, lookupLoginToken, MEMBER_LIMITS, SESSION_TTL_MS, signSession, verifySession } from '../services/members';
import { hit } from '../services/ratelimit';
import { PUBLIC_URL } from '../util';

export const affiliateSpaceRouter = Router();

export const AFFILIATE_SESSION_COOKIE = 'scalo_affiliate';

interface Viewer extends AffChrome {
  contact: ContactRow | null;
  affiliate: AffiliateRow | null;
}

const send = (res: Response, p: Page) => void res.status(p.status).type('html').send(p.html);
const viewer = (res: Response) => res.locals.affViewer as Viewer;
const emailCheck = z.email().max(254);
const cookieOptions = (p: ProgramRow, maxAge: number) => ({ httpOnly: true, sameSite: 'lax' as const, secure: PUBLIC_URL.startsWith('https://'), maxAge, path: programPath(p) });
/** Destination stored with a signup link: the affiliate is created when the link is used (email ownership proven). */
const welcomePath = (p: ProgramRow) => `${programPath(p)}/bienvenue`;

/** State-changing forms must come from the app itself (the session cookie is SameSite=Lax already). */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return origin !== 'null';
  try {
    const host = new URL(origin).host;
    return host === req.headers.host || host === new URL(PUBLIC_URL).host;
  } catch {
    return false;
  }
}

// ---------- program resolution, session ----------

affiliateSpaceRouter.use('/a/:space', async (req: Request, res: Response, next: NextFunction) => {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
  );
  const slug = String(req.params.space);
  const program = PROGRAM_SLUG_RE.test(slug) ? await db.selectFrom('affiliate_programs').selectAll().where('slug', '=', slug).executeTakeFirst() : undefined;
  if (!program) return void res.status(404).type('html').send(unknownProgramHtml);
  if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) {
    return send(res, messagePage({ program, email: null, nonce }, 'Requête refusée', 'Cette action doit être lancée depuis l’espace affilié.', 403));
  }
  const contactId = verifySession(program.user_id, req.cookies?.[AFFILIATE_SESSION_COOKIE]);
  const contact = contactId ? ((await db.selectFrom('contacts').selectAll().where('id', '=', contactId).where('user_id', '=', program.user_id).executeTakeFirst()) ?? null) : null;
  const affiliate = contact ? ((await db.selectFrom('affiliates').selectAll().where('contact_id', '=', contact.id).where('user_id', '=', program.user_id).executeTakeFirst()) ?? null) : null;
  res.locals.affViewer = { program, nonce, email: contact?.email ?? null, contact, affiliate } satisfies Viewer;
  next();
});

// ---------- login and signup (magic link) ----------

affiliateSpaceRouter.get('/a/:space/login', (_req, res) => {
  const v = viewer(res);
  if (v.contact) return res.redirect(302, programPath(v.program));
  send(res, loginPage(v));
});

/** Visible limit per IP (429); returns true when the response has been sent. */
async function ipLimited(req: Request, res: Response, v: Viewer): Promise<boolean> {
  const ip = await hit(`alogin:ip:${v.program.user_id}:${req.ip ?? ''}`, MEMBER_LIMITS.loginIp);
  if (!ip.blocked) return false;
  res.setHeader('Retry-After', String(ip.retryAfter));
  send(res, messagePage(v, 'Trop de tentatives', 'Trop de demandes de lien. Réessayez dans quelques minutes.', 429));
  return true;
}
/** Invisible limit per address: beyond it nothing is sent, the response is the same. */
const emailLimited = async (v: Viewer, email: string) => (await hit(`alogin:em:${v.program.user_id}:${hashLoginToken(email).slice(0, 32)}`, MEMBER_LIMITS.loginEmail)).blocked;

affiliateSpaceRouter.post('/a/:space/login', async (req, res) => {
  const v = viewer(res);
  if (await ipLimited(req, res, v)) return;
  const raw = typeof req.body?.email === 'string' ? req.body.email : '';
  const parsed = emailCheck.safeParse(normEmail(raw));
  if (!parsed.success) return send(res, loginPage(v, { error: 'Adresse email invalide. Merci de vérifier et de réessayer.', email: raw.slice(0, 254) }));
  const email = parsed.data;
  const blocked = await emailLimited(v, email);
  // same response whether the address is an affiliate, unknown or limited; the email is queued once the response is on its way
  send(res, linkSentPage(v));
  if (blocked) return;
  afterResponse(
    (async () => {
      const row = await db
        .selectFrom('contacts as c')
        .innerJoin('affiliates as a', 'a.contact_id', 'c.id')
        .selectAll('c')
        .where('c.user_id', '=', v.program.user_id)
        .where('a.user_id', '=', v.program.user_id)
        .where('c.email', '=', email)
        .executeTakeFirst();
      if (row && !row.bounced && !row.complained) await requestAffiliateLink(v.program, row, null);
      await cleanupLoginTokens();
    })(),
  );
});

affiliateSpaceRouter.post('/a/:space/signup', async (req, res) => {
  const v = viewer(res);
  if (!v.program.enabled) return send(res, landingPage(v));
  if (await ipLimited(req, res, v)) return;
  const raw = typeof req.body?.email === 'string' ? req.body.email : '';
  const firstName = typeof req.body?.first_name === 'string' ? req.body.first_name.trim().slice(0, 200) : '';
  const parsed = emailCheck.safeParse(normEmail(raw));
  if (!parsed.success) return send(res, landingPage(v, { error: 'Adresse email invalide. Merci de vérifier et de réessayer.', email: raw.slice(0, 254), firstName }));
  if (v.program.terms.trim() && req.body?.terms !== '1') return send(res, landingPage(v, { error: 'Merci d’accepter les conditions du programme.', email: raw.slice(0, 254), firstName }));
  const email = parsed.data;
  const blocked = await emailLimited(v, email);
  send(res, linkSentPage(v));
  if (blocked) return;
  afterResponse(
    (async () => {
      // a new contact is not subscribed to the account's emails: joining the program is not an optin
      const { contact } = await upsertContact(v.program.user_id, { email, first_name: firstName || undefined }, { overwrite: false, optin: 'pending' });
      if (contact.bounced || contact.complained) return;
      const known = await db.selectFrom('affiliates').select('id').where('contact_id', '=', contact.id).where('user_id', '=', v.program.user_id).executeTakeFirst();
      // the affiliate only exists once the link has been used (nobody can enrol somebody else's address)
      await requestAffiliateLink(v.program, contact, known ? null : welcomePath(v.program), !known);
      await cleanupLoginTokens();
    })(),
  );
});

// GET only shows a button: mail scanners and link previewers open links automatically and must not consume the token.
affiliateSpaceRouter.get('/a/:space/auth/:token', async (req, res) => {
  const v = viewer(res);
  const state = await lookupLoginToken(v.program.user_id, String(req.params.token));
  if (state !== 'pending') return send(res, badLinkPage(v, state));
  send(res, confirmLoginPage(v, `${programPath(v.program)}/auth/${encodeURIComponent(String(req.params.token))}`));
});

const joinStatus = (p: ProgramRow) => (p.signup_mode === 'open' ? ('approved' as const) : ('pending' as const));

affiliateSpaceRouter.post('/a/:space/auth/:token', async (req, res) => {
  const v = viewer(res);
  const token = String(req.params.token);
  const done = await consumeLoginToken(v.program.user_id, token);
  if (!done) {
    const state = await lookupLoginToken(v.program.user_id, token);
    return send(res, badLinkPage(v, state === 'pending' ? 'invalid' : state));
  }
  if (done.redirect === welcomePath(v.program) && v.program.enabled) {
    const contact = await db.selectFrom('contacts').selectAll().where('id', '=', done.contactId).where('user_id', '=', v.program.user_id).executeTakeFirst();
    if (contact) await createAffiliate(v.program.user_id, contact, joinStatus(v.program));
  }
  res.cookie(AFFILIATE_SESSION_COOKIE, signSession(v.program.user_id, done.contactId), cookieOptions(v.program, SESSION_TTL_MS));
  res.redirect(303, programPath(v.program));
});

affiliateSpaceRouter.post('/a/:space/logout', (_req, res) => {
  const v = viewer(res);
  res.clearCookie(AFFILIATE_SESSION_COOKIE, { path: programPath(v.program) });
  res.redirect(303, `${programPath(v.program)}/login`);
});

/** A logged-in contact (email already proven) who is not an affiliate yet asks to join. */
affiliateSpaceRouter.post('/a/:space/join', async (_req, res) => {
  const v = viewer(res);
  if (!v.contact) return res.redirect(303, `${programPath(v.program)}/login`);
  if (v.program.enabled && !v.affiliate) await createAffiliate(v.program.user_id, v.contact, joinStatus(v.program));
  res.redirect(303, programPath(v.program));
});

// ---------- pages ----------

affiliateSpaceRouter.get('/a/:space/conditions', (_req, res) => send(res, termsPage(viewer(res))));

const NOTICES: Record<string, string> = { paiement: 'Vos coordonnées de paiement ont été enregistrées.' };

affiliateSpaceRouter.get('/a/:space', async (req, res) => {
  const v = viewer(res);
  if (!v.contact) return send(res, landingPage(v));
  const a = v.affiliate;
  if (!a || a.status === 'pending' || a.status === 'rejected') return send(res, statusPage(v, a));
  // everything below is looked up with this affiliate's id only
  const [stats, balances, links, commissions, payouts] = await Promise.all([
    statsOf([a.id]),
    balancesOf([a.id]),
    a.status === 'approved' ? affiliateLinks(v.program.user_id, a.code) : [],
    db.selectFrom('affiliate_commissions').selectAll().where('affiliate_id', '=', a.id).where('user_id', '=', v.program.user_id).orderBy('id', 'desc').limit(100).execute(),
    db.selectFrom('affiliate_payouts').select(['id', 'currency', 'amount', 'method', 'reference', 'created_at']).where('affiliate_id', '=', a.id).where('user_id', '=', v.program.user_id).orderBy('id', 'desc').limit(100).execute(),
  ]);
  send(
    res,
    dashboardPage(v, {
      affiliate: a,
      stats: stats.get(a.id)!,
      balances: balances.get(a.id)!,
      links,
      commissions,
      payouts,
      payoutDetails: readPayoutDetails(a) ?? '',
      notice: typeof req.query.ok === 'string' ? NOTICES[req.query.ok] : undefined,
    }),
  );
});

affiliateSpaceRouter.post('/a/:space/paiement', async (req, res) => {
  const v = viewer(res);
  if (!v.contact) return res.redirect(303, `${programPath(v.program)}/login`);
  const a = v.affiliate;
  if (!a || a.status === 'pending' || a.status === 'rejected') return res.redirect(303, programPath(v.program));
  // eslint-disable-next-line no-control-regex
  const details = typeof req.body?.details === 'string' ? req.body.details.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, 1000) : '';
  await db
    .updateTable('affiliates')
    .set({ payout_details_enc: details ? encryptPayoutDetails(details) : null, updated_at: nowIso() })
    .where('id', '=', a.id)
    .where('user_id', '=', v.program.user_id)
    .execute();
  res.redirect(303, `${programPath(v.program)}?ok=paiement`);
});

// anything else under /a/<slug>
affiliateSpaceRouter.use('/a/:space', (_req, res) => send(res, notFoundAffPage(viewer(res))));
