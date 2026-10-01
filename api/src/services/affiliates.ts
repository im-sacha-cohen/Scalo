// Affiliate program: settings, affiliates, tracking cookie and clicks, commissions (through the order hooks of the
// payments module — services/order-hooks.ts), validation by the worker, manual payouts. See SPEC.md « Affiliation ».
//
// - An affiliate is a contact of the account. His link is any funnel page with `?aff=<code>`.
// - The visit sets an opaque, authenticated cookie (AES-256-GCM, key bound to the account) holding the code and the time
//   of the click; the checkout copies it to `orders.visitor.cookies` (VISITOR_COOKIE_RE) and the `paid` hook reads it
//   back. The code in the URL is untrusted: an unknown code gets the very same response as a valid one.
// - Commissions are always computed here, on the amount collected excluding tax; every order event is idempotent.
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { sql, type Selectable } from 'kysely';
import {
  DEFAULT_EMAIL_SETTINGS,
  esc,
  uid as blockId,
  type Affiliate,
  type AffiliateBalance,
  type AffiliateCommission,
  type AffiliateCommissionRule,
  type AffiliatePayable,
  type AffiliatePayout,
  type AffiliateProgram,
  type AffiliateStats,
  type AffiliateStatus,
  type AffiliationSummary,
  type Block,
  type CommissionRate,
  type PageContent,
} from '@scalo/shared';
import {
  db,
  inTx,
  isUniqueViolation,
  nowIso,
  type AffiliateCommissionRulesTable,
  type AffiliateCommissionsTable,
  type AffiliateProgramsTable,
  type AffiliatesTable,
  type ContactRow,
  type Db,
} from '../db';
import { HttpError, likeEscape, notFound, PUBLIC_URL, slugify } from '../util';
import { logEvent } from './contacts';
import { getSettingsRow, renderEmail } from './email';
import { hashLoginToken, LOGIN_TTL_MS } from './members';
import { registerOrderHook, type OrderHookContext, type OrderItemRow, type OrderRow } from './order-hooks';
import { decryptSecret, encryptSecret } from './secretbox';

export type ProgramRow = Selectable<AffiliateProgramsTable>;
export type AffiliateRow = Selectable<AffiliatesTable>;
export type CommissionRow = Selectable<AffiliateCommissionsTable>;
type RuleRow = Selectable<AffiliateCommissionRulesTable>;

const DAY_MS = 86400_000;
/** Path segments of the affiliate area that cannot be a program address. */
export const RESERVED_PROGRAM_SLUGS = new Set(['login', 'logout', 'auth', 'signup', 'conditions', 'paiement']);
export const PROGRAM_SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,58}[a-z0-9])?$/;
export const AFFILIATE_CODE_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const PAYOUT_PURPOSE = 'affiliate:payout-details';

// ---------- program ----------

export const programPath = (p: Pick<ProgramRow, 'slug'>) => `/a/${p.slug}`;
export const programUrl = (p: Pick<ProgramRow, 'slug'>) => `${PUBLIC_URL}${programPath(p)}`;

/** Program of an account, created (disabled, address from the account name) on first access. */
export async function getProgram(userId: number, ex: Db = db): Promise<ProgramRow> {
  const found = await ex.selectFrom('affiliate_programs').selectAll().where('user_id', '=', userId).executeTakeFirst();
  if (found) return found;
  const user = await ex.selectFrom('users').select(['name']).where('id', '=', userId).executeTakeFirstOrThrow();
  const base = slugify(user.name, 'partenaires').slice(0, 48).replace(/-+$/g, '') || 'partenaires';
  for (let i = 0; i < 100; i++) {
    const slug = i === 0 ? base : i < 50 ? `${base}-${i + 1}` : `${base}-${crypto.randomBytes(4).toString('hex')}`;
    if (RESERVED_PROGRAM_SLUGS.has(slug)) continue;
    // a savepoint-free attempt: outside a transaction a unique violation is simply the next candidate
    const taken = await ex.selectFrom('affiliate_programs').select('user_id').where('slug', '=', slug).executeTakeFirst();
    if (taken) continue;
    try {
      await ex
        .insertInto('affiliate_programs')
        .values({ user_id: userId, slug, name: `Programme d’affiliation ${user.name.trim()}`.slice(0, 120) })
        .onConflict((oc) => oc.column('user_id').doNothing())
        .execute();
      break;
    } catch (e) {
      if (ex.isTransaction || !isUniqueViolation(e, 'affiliate_programs_slug_key')) throw e;
    }
  }
  return ex.selectFrom('affiliate_programs').selectAll().where('user_id', '=', userId).executeTakeFirstOrThrow();
}

const rateOf = (type: 'percent' | 'fixed', value: number): CommissionRate => ({ type, value: Number(value) });

export async function listRules(userId: number, ex: Db = db): Promise<AffiliateCommissionRule[]> {
  const rows = await ex
    .selectFrom('affiliate_commission_rules as r')
    .innerJoin('products as p', 'p.id', 'r.product_id')
    .leftJoin('product_prices as pp', 'pp.id', 'r.price_id')
    .select(['r.id', 'r.product_id', 'r.price_id', 'r.commission_type', 'r.commission_value', 'p.name as product_name', 'pp.name as price_name'])
    .where('r.user_id', '=', userId)
    .orderBy('p.name')
    .orderBy('r.id')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    product_id: r.product_id,
    price_id: r.price_id,
    product_name: r.product_name,
    price_name: r.price_id ? (r.price_name ?? '') : null,
    commission: rateOf(r.commission_type, r.commission_value),
  }));
}

export async function publicProgram(p: ProgramRow, ex: Db = db): Promise<AffiliateProgram> {
  return {
    enabled: p.enabled,
    slug: p.slug,
    name: p.name,
    url: programUrl(p),
    commission: rateOf(p.commission_type, p.commission_value),
    recurring: p.recurring,
    recurring_months: p.recurring_months,
    cookie_days: p.cookie_days,
    attribution: p.attribution,
    validation_days: p.validation_days,
    min_payout: p.min_payout,
    signup_mode: p.signup_mode,
    terms: p.terms,
    rules: await listRules(p.user_id, ex),
  };
}

export interface ProgramInput {
  enabled?: boolean;
  slug?: string;
  name?: string;
  commission?: CommissionRate;
  recurring?: boolean;
  recurring_months?: number | null;
  cookie_days?: number;
  attribution?: 'last_click' | 'first_click';
  validation_days?: number;
  min_payout?: number;
  signup_mode?: 'open' | 'approval';
  terms?: string;
  /** Full set of product / offer overrides (replaces the current one). */
  rules?: { product_id: number; price_id?: number | null; commission: CommissionRate }[];
}

/** percent: 0–100 with 2 decimals; fixed: whole minor units. */
export function cleanRate(c: CommissionRate): CommissionRate {
  if (c.type === 'percent') {
    if (!(c.value >= 0 && c.value <= 100)) throw new HttpError(400, 'Le pourcentage de commission doit être compris entre 0 et 100');
    return { type: 'percent', value: Math.round(c.value * 100) / 100 };
  }
  if (!(c.value >= 0 && c.value <= 99_999_999)) throw new HttpError(400, 'Le montant fixe de la commission est invalide');
  return { type: 'fixed', value: Math.round(c.value) };
}

export async function saveProgram(userId: number, input: ProgramInput): Promise<ProgramRow> {
  await getProgram(userId);
  return db.transaction().execute(async (trx) => {
    const set: Record<string, unknown> = { updated_at: nowIso() };
    for (const k of ['enabled', 'name', 'recurring', 'recurring_months', 'cookie_days', 'attribution', 'validation_days', 'min_payout', 'signup_mode', 'terms'] as const) {
      if (input[k] !== undefined) set[k] = input[k];
    }
    if (input.slug !== undefined) {
      if (!PROGRAM_SLUG_RE.test(input.slug) || RESERVED_PROGRAM_SLUGS.has(input.slug)) throw new HttpError(400, 'Adresse invalide : lettres minuscules, chiffres et tirets uniquement');
      const taken = await trx.selectFrom('affiliate_programs').select('user_id').where('slug', '=', input.slug).where('user_id', '!=', userId).executeTakeFirst();
      if (taken) throw new HttpError(409, 'Cette adresse est déjà utilisée par un autre programme');
      set.slug = input.slug;
    }
    if (input.commission) {
      const c = cleanRate(input.commission);
      set.commission_type = c.type;
      set.commission_value = c.value;
    }
    await trx.updateTable('affiliate_programs').set(set).where('user_id', '=', userId).execute();
    if (input.rules) {
      const productIds = [...new Set(input.rules.map((r) => r.product_id))];
      const priceIds = [...new Set(input.rules.map((r) => r.price_id).filter((x): x is number => !!x))];
      const products = productIds.length ? await trx.selectFrom('products').select('id').where('user_id', '=', userId).where('id', 'in', productIds).execute() : [];
      const prices = priceIds.length ? await trx.selectFrom('product_prices').select(['id', 'product_id']).where('user_id', '=', userId).where('id', 'in', priceIds).execute() : [];
      const seen = new Set<string>();
      const values = input.rules.map((r) => {
        if (!products.some((p) => p.id === r.product_id)) throw notFound('Produit');
        if (r.price_id && !prices.some((p) => p.id === r.price_id && p.product_id === r.product_id)) throw notFound('Offre');
        const key = `${r.product_id}:${r.price_id ?? 0}`;
        if (seen.has(key)) throw new HttpError(400, 'Une seule commission par produit ou par offre');
        seen.add(key);
        const c = cleanRate(r.commission);
        return { user_id: userId, product_id: r.product_id, price_id: r.price_id ?? null, commission_type: c.type, commission_value: c.value };
      });
      await trx.deleteFrom('affiliate_commission_rules').where('user_id', '=', userId).execute();
      if (values.length) await trx.insertInto('affiliate_commission_rules').values(values).execute();
    }
    return trx.selectFrom('affiliate_programs').selectAll().where('user_id', '=', userId).executeTakeFirstOrThrow();
  });
}

// ---------- tracking cookie ----------

/** One cookie per account (several accounts share the app's host): `scalo_aff_<account id>`, matches VISITOR_COOKIE_RE. */
export const affCookieName = (userId: number) => `scalo_aff_${userId}`;
const cookiePurpose = (userId: number) => `affiliate:cookie:${userId}`;

export interface AffCookie {
  code: string;
  /** Time of the click (ms). */
  ts: number;
}

export const encodeAffCookie = (userId: number, c: AffCookie) => encryptSecret(JSON.stringify({ c: c.code, t: c.ts }), cookiePurpose(userId));

/** Code and click time of a cookie issued for this account; null when missing, forged or issued for another account. */
export function decodeAffCookie(userId: number, value: unknown): AffCookie | null {
  if (typeof value !== 'string' || value.length > 300) return null;
  const plain = decryptSecret(value, cookiePurpose(userId));
  if (!plain) return null;
  try {
    const o = JSON.parse(plain) as { c?: unknown; t?: unknown };
    if (typeof o.c !== 'string' || !AFFILIATE_CODE_RE.test(o.c) || typeof o.t !== 'number' || !Number.isFinite(o.t)) return null;
    return { code: o.c, ts: o.t };
  } catch {
    return null;
  }
}

const alive = (c: AffCookie | null, program: Pick<ProgramRow, 'cookie_days'>, at: number): c is AffCookie =>
  !!c && c.ts <= at + 60_000 && at - c.ts <= program.cookie_days * DAY_MS;

const approvedByCode = (ex: Db, userId: number, code: string) =>
  ex.selectFrom('affiliates').selectAll().where('user_id', '=', userId).where('code', '=', code).where('status', '=', 'approved').executeTakeFirst();

/**
 * Funnel page visited with `?aff=<code>` (any page, custom domains included): sets / keeps the tracking cookie
 * according to the attribution model and records the click (one per affiliate, visitor and day).
 * Whatever the code (unknown, suspended affiliate…), the response is the same: a cookie whose content is opaque.
 */
export async function trackAffiliateVisit(req: Request, res: Response, target: { userId: number; funnelId: number; stepId?: number | null; visitorId?: string | null }): Promise<void> {
  const raw = req.query.aff;
  if (typeof raw !== 'string') return;
  const code = raw.trim().toLowerCase();
  if (!AFFILIATE_CODE_RE.test(code)) return;
  try {
    const program = await db.selectFrom('affiliate_programs').selectAll().where('user_id', '=', target.userId).executeTakeFirst();
    if (!program?.enabled) return;
    const now = Date.now();
    const name = affCookieName(target.userId);
    const current = decodeAffCookie(target.userId, req.cookies?.[name]);
    const kept = alive(current, program, now) ? current : null;
    const affiliate = await approvedByCode(db, target.userId, code);
    let next: AffCookie;
    if (!affiliate) next = kept ?? { code, ts: now }; // unknown code: nothing changes (a cookie that leads nowhere otherwise)
    else if (kept && kept.code === code) next = program.attribution === 'first_click' ? kept : { code, ts: now };
    else if (kept && program.attribution === 'first_click' && (await approvedByCode(db, target.userId, kept.code))) next = kept;
    else next = { code, ts: now };
    res.cookie(name, encodeAffCookie(target.userId, next), { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: program.cookie_days * DAY_MS, path: '/' });
    const vid = target.visitorId && /^[\w-]{8,64}$/.test(target.visitorId) ? target.visitorId : null;
    if (affiliate && vid) {
      await db
        .insertInto('affiliate_clicks')
        .values({ user_id: target.userId, affiliate_id: affiliate.id, visitor_id: vid, day: new Date(now).toISOString().slice(0, 10), funnel_id: target.funnelId, step_id: target.stepId ?? null })
        .onConflict((oc) => oc.columns(['affiliate_id', 'visitor_id', 'day']).doNothing())
        .execute();
    }
  } catch (e) {
    // tracking never breaks a page
    console.error('[affiliates] visite :', (e as Error).message);
  }
}

/** Approved affiliate designated by the visitor's cookies at `at` (cookie not expired for the program), if any. */
async function affiliateOfCookies(ex: Db, program: ProgramRow, cookies: unknown, at: number): Promise<AffiliateRow | null> {
  if (!cookies || typeof cookies !== 'object') return null;
  const c = decodeAffCookie(program.user_id, (cookies as Record<string, unknown>)[affCookieName(program.user_id)]);
  if (!alive(c, program, at)) return null;
  return (await approvedByCode(ex, program.user_id, c.code)) ?? null;
}

/** `a+tag@x.fr` and `A@x.fr` are the same person for the self-referral check. */
const emailKey = (email: string) => {
  const [local, domain = ''] = email.trim().toLowerCase().split('@');
  return `${local.split('+')[0]}@${domain}`;
};

/**
 * Optin of a funnel form: the contact becomes a lead of the visitor's affiliate (statistics only, no commission).
 * A contact is the lead of one affiliate only (the first one), and never of himself.
 */
export async function recordAffiliateLead(trx: Db, req: Request, userId: number, contact: Pick<ContactRow, 'id' | 'email'>): Promise<void> {
  if (!req.cookies?.[affCookieName(userId)]) return;
  const program = await trx.selectFrom('affiliate_programs').selectAll().where('user_id', '=', userId).executeTakeFirst();
  if (!program?.enabled) return;
  const affiliate = await affiliateOfCookies(trx, program, req.cookies, Date.now());
  if (!affiliate || affiliate.contact_id === contact.id) return;
  await trx
    .insertInto('affiliate_referrals')
    .values({ user_id: userId, affiliate_id: affiliate.id, kind: 'lead', contact_id: contact.id })
    .onConflict((oc) => oc.doNothing())
    .execute();
}

// ---------- affiliates ----------

async function freeCode(ex: Db, userId: number, contact: Pick<ContactRow, 'email' | 'first_name'>): Promise<string> {
  const seed = slugify(contact.first_name?.trim() || contact.email.split('@')[0], 'partenaire').replace(/-+/g, '-').slice(0, 20).replace(/^-+|-+$/g, '');
  const base = seed.length >= 3 ? seed : `${seed}${'partenaire'.slice(0, 10)}`.slice(0, 20);
  const taken = new Set((await ex.selectFrom('affiliates').select('code').where('user_id', '=', userId).where('code', 'like', `${likeEscape(base)}%`).execute()).map((r) => r.code));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 200; i++) if (!taken.has(`${base}${i}`)) return `${base}${i}`;
  return `${base}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Makes a contact an affiliate (idempotent: an existing affiliate is returned unchanged). An approved affiliate gets
 * the `affiliate_joined` timeline event, which fires the « nouvel affilié approuvé » automations.
 */
export function createAffiliate(userId: number, contact: ContactRow, status: 'pending' | 'approved', ex: Db = db): Promise<{ affiliate: AffiliateRow; created: boolean }> {
  return inTx(ex, async (trx) => {
    const existing = await trx.selectFrom('affiliates').selectAll().where('user_id', '=', userId).where('contact_id', '=', contact.id).executeTakeFirst();
    if (existing) return { affiliate: existing, created: false };
    const now = nowIso();
    const row = await trx
      .insertInto('affiliates')
      .values({ user_id: userId, contact_id: contact.id, code: await freeCode(trx, userId, contact), status, approved_at: status === 'approved' ? now : null, created_at: now, updated_at: now })
      .onConflict((oc) => oc.columns(['user_id', 'contact_id']).doNothing())
      .returningAll()
      .executeTakeFirst();
    if (!row) return { affiliate: await trx.selectFrom('affiliates').selectAll().where('user_id', '=', userId).where('contact_id', '=', contact.id).executeTakeFirstOrThrow(), created: false };
    if (status === 'approved') await logEvent(userId, contact.id, 'affiliate_joined', { code: row.code }, {}, trx);
    return { affiliate: row, created: true };
  });
}

export interface AffiliatePatch {
  status?: AffiliateStatus;
  commission?: CommissionRate | null;
  code?: string;
}

export function updateAffiliate(userId: number, id: number, patch: AffiliatePatch): Promise<AffiliateRow> {
  return db.transaction().execute(async (trx) => {
    const cur = await trx.selectFrom('affiliates').selectAll().where('id', '=', id).where('user_id', '=', userId).forUpdate().executeTakeFirst();
    if (!cur) throw notFound('Affilié');
    const set: Record<string, unknown> = { updated_at: nowIso() };
    if (patch.commission !== undefined) {
      const c = patch.commission ? cleanRate(patch.commission) : null;
      set.commission_type = c?.type ?? null;
      set.commission_value = c?.value ?? null;
    }
    if (patch.code !== undefined && patch.code !== cur.code) {
      if (!AFFILIATE_CODE_RE.test(patch.code)) throw new HttpError(400, 'Code invalide : 3 à 32 lettres minuscules, chiffres ou tirets');
      const taken = await trx.selectFrom('affiliates').select('id').where('user_id', '=', userId).where('code', '=', patch.code).executeTakeFirst();
      if (taken) throw new HttpError(409, 'Ce code est déjà utilisé par un autre affilié');
      set.code = patch.code;
    }
    let joined = false;
    if (patch.status !== undefined && patch.status !== cur.status) {
      if (patch.status === 'pending') throw new HttpError(400, 'Un affilié ne peut pas repasser en attente');
      if (patch.status === 'suspended' && cur.status !== 'approved') throw new HttpError(409, 'Seul un affilié approuvé peut être suspendu');
      if (patch.status === 'rejected' && cur.status !== 'pending') throw new HttpError(409, 'Seule une demande en attente peut être refusée');
      set.status = patch.status;
      if (patch.status === 'approved' && !cur.approved_at) {
        set.approved_at = nowIso();
        joined = true;
      }
    }
    const row = await trx.updateTable('affiliates').set(set).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    if (joined) await logEvent(userId, row.contact_id, 'affiliate_joined', { code: row.code }, {}, trx);
    return row;
  });
}

export const encryptPayoutDetails = (text: string) => encryptSecret(text, PAYOUT_PURPOSE);
/** null when nothing is stored; '' when the stored value can no longer be read (encryption key changed). */
export const readPayoutDetails = (a: Pick<AffiliateRow, 'payout_details_enc'>): string | null =>
  a.payout_details_enc ? (decryptSecret(a.payout_details_enc, PAYOUT_PURPOSE) ?? '') : null;

// ---------- statistics and balances ----------

export async function statsOf(affiliateIds: number[], ex: Db = db, since?: string): Promise<Map<number, AffiliateStats>> {
  const out = new Map<number, AffiliateStats>();
  for (const id of affiliateIds) out.set(id, { clicks: 0, leads: 0, sales: 0, conversion: 0 });
  if (!affiliateIds.length) return out;
  const clicks = await ex
    .selectFrom('affiliate_clicks')
    .select(['affiliate_id', (eb) => eb.fn.countAll<number>().as('n')])
    .where('affiliate_id', 'in', affiliateIds)
    .$if(!!since, (q) => q.where('created_at', '>=', since!))
    .groupBy('affiliate_id')
    .execute();
  const refs = await ex
    .selectFrom('affiliate_referrals')
    .select(['affiliate_id', 'kind', (eb) => eb.fn.countAll<number>().as('n')])
    .where('affiliate_id', 'in', affiliateIds)
    .$if(!!since, (q) => q.where('created_at', '>=', since!))
    .groupBy(['affiliate_id', 'kind'])
    .execute();
  for (const c of clicks) out.get(c.affiliate_id)!.clicks = Number(c.n);
  for (const r of refs) out.get(r.affiliate_id)![r.kind === 'lead' ? 'leads' : 'sales'] = Number(r.n);
  for (const s of out.values()) s.conversion = s.clicks ? Math.round((s.sales / s.clicks) * 10000) / 10000 : 0;
  return out;
}

/** Per affiliate and currency: pending, validated-and-unpaid (clawbacks included, may be negative), paid. */
export async function balancesOf(affiliateIds: number[], ex: Db = db): Promise<Map<number, AffiliateBalance[]>> {
  const out = new Map<number, AffiliateBalance[]>();
  for (const id of affiliateIds) out.set(id, []);
  if (!affiliateIds.length) return out;
  const rows = await ex
    .selectFrom('affiliate_commissions')
    .select([
      'affiliate_id',
      'currency',
      sql<number>`COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0)`.as('pending'),
      sql<number>`COALESCE(SUM(amount) FILTER (WHERE status = 'approved'), 0)`.as('approved'),
      sql<number>`COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0)`.as('paid'),
    ])
    .where('affiliate_id', 'in', affiliateIds)
    .groupBy(['affiliate_id', 'currency'])
    .orderBy('currency')
    .execute();
  for (const r of rows) out.get(r.affiliate_id)!.push({ currency: r.currency, pending: Number(r.pending), approved: Number(r.approved), paid: Number(r.paid) });
  return out;
}

type AffiliateWithContact = AffiliateRow & { email: string; first_name: string | null; last_name: string | null };

const withContact = (ex: Db) =>
  ex
    .selectFrom('affiliates as a')
    .innerJoin('contacts as c', 'c.id', 'a.contact_id')
    .selectAll('a')
    .select(['c.email', 'c.first_name', 'c.last_name']);

export async function toAffiliates(rows: AffiliateWithContact[], ex: Db = db): Promise<Affiliate[]> {
  const ids = rows.map((r) => r.id);
  const [stats, balances] = await Promise.all([statsOf(ids, ex), balancesOf(ids, ex)]);
  return rows.map((r) => ({
    id: r.id,
    contact_id: r.contact_id,
    email: r.email,
    first_name: r.first_name,
    last_name: r.last_name,
    code: r.code,
    status: r.status,
    commission: r.commission_type && r.commission_value !== null ? rateOf(r.commission_type, r.commission_value) : null,
    created_at: r.created_at,
    approved_at: r.approved_at,
    stats: stats.get(r.id)!,
    balances: balances.get(r.id)!,
  }));
}

export async function listAffiliates(userId: number, q: { status?: AffiliateStatus; search?: string; page: number; limit: number }) {
  const base = () => {
    let b = withContact(db).where('a.user_id', '=', userId);
    if (q.status) b = b.where('a.status', '=', q.status);
    if (q.search) {
      const like = `%${likeEscape(q.search.toLowerCase())}%`;
      b = b.where((eb) => eb.or([eb('c.email', 'like', like), eb(sql<string>`lower(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, ''))`, 'like', like), eb('a.code', 'like', like)]));
    }
    return b;
  };
  const total = await base().clearSelect().select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
  const rows = await base().orderBy('a.id', 'desc').limit(q.limit).offset((q.page - 1) * q.limit).execute();
  return { items: await toAffiliates(rows), total: Number(total.n) };
}

export async function getAffiliate(userId: number, id: number, ex: Db = db): Promise<AffiliateWithContact> {
  const row = await withContact(ex).where('a.user_id', '=', userId).where('a.id', '=', id).executeTakeFirst();
  if (!row) throw notFound('Affilié');
  return row;
}

/** Links an affiliate can share: the first public page of each funnel (on its custom domain when it has one). */
export async function affiliateLinks(userId: number, code: string): Promise<{ funnel: string; pages: { name: string; url: string }[] }[]> {
  const funnels = await db.selectFrom('funnels').select(['id', 'name', 'slug', 'settings']).where('user_id', '=', userId).orderBy('id').execute();
  if (!funnels.length) return [];
  const ids = funnels.map((f) => f.id);
  const steps = await db.selectFrom('steps').select(['id', 'funnel_id', 'name', 'slug', 'access']).where('funnel_id', 'in', ids).orderBy('position').orderBy('id').execute();
  const domains = await db.selectFrom('custom_domains').select(['funnel_id', 'domain']).where('funnel_id', 'in', ids).where('status', '=', 'verified').orderBy('id').execute();
  return funnels
    .map((f) => {
      const legal = new Set<number>(((f.settings as { legal?: { step_ids?: number[] } } | null)?.legal?.step_ids ?? []).map(Number));
      const domain = domains.find((d) => d.funnel_id === f.id)?.domain;
      const origin = domain ? `https://${domain}` : `${PUBLIC_URL}/p/${encodeURIComponent(f.slug)}`;
      const pages = steps
        .filter((s) => s.funnel_id === f.id && !legal.has(s.id) && ((s.access as { mode?: string } | null)?.mode ?? 'public') === 'public')
        .map((s) => ({ name: s.name, url: `${origin}/${encodeURIComponent(s.slug)}?aff=${encodeURIComponent(code)}` }));
      return { funnel: f.name, pages };
    })
    .filter((f) => f.pages.length);
}

// ---------- commissions (order hooks) ----------

/** Commission rate of a line: offer override, then product override, then the affiliate's own rate, then the program's. */
export function resolveRate(program: ProgramRow, affiliate: AffiliateRow, rules: RuleRow[], item: Pick<OrderItemRow, 'product_id' | 'price_id'>): CommissionRate {
  const byPrice = item.price_id ? rules.find((r) => r.price_id === item.price_id) : undefined;
  const byProduct = item.product_id ? rules.find((r) => r.product_id === item.product_id && r.price_id === null) : undefined;
  const rule = byPrice ?? byProduct;
  if (rule) return rateOf(rule.commission_type, rule.commission_value);
  if (affiliate.commission_type && affiliate.commission_value !== null) return rateOf(affiliate.commission_type, affiliate.commission_value);
  return rateOf(program.commission_type, program.commission_value);
}

/** Commission (minor units) on `base` (collected, excluding tax). A fixed commission never exceeds what was collected. */
export const commissionAmount = (rate: CommissionRate, base: number) =>
  base <= 0 ? 0 : rate.type === 'percent' ? Math.round((base * rate.value) / 100) : Math.min(Math.round(rate.value), base);

const itemName = (i: Pick<OrderItemRow, 'product_name' | 'price_name'>) => (i.price_name ? `${i.product_name} — ${i.price_name}` : i.product_name);

/** Affiliate of an order, decided once when the order is paid: the parent order's for an upsell, the cookie otherwise. */
async function referralOfOrder(trx: Db, program: ProgramRow, order: OrderRow): Promise<number | null> {
  const known = await trx.selectFrom('affiliate_referrals').select('affiliate_id').where('order_id', '=', order.id).where('kind', '=', 'sale').executeTakeFirst();
  if (known) return known.affiliate_id;
  let affiliate: AffiliateRow | null = null;
  if (order.parent_order_id) {
    const parent = await trx.selectFrom('affiliate_referrals').select('affiliate_id').where('order_id', '=', order.parent_order_id).where('kind', '=', 'sale').executeTakeFirst();
    if (!parent) return null;
    affiliate = (await trx.selectFrom('affiliates').selectAll().where('id', '=', parent.affiliate_id).where('user_id', '=', order.user_id).executeTakeFirst()) ?? null;
  } else {
    affiliate = await affiliateOfCookies(trx, program, (order.visitor as { cookies?: unknown } | null)?.cookies, new Date(order.created_at).getTime());
  }
  if (!affiliate || affiliate.status !== 'approved') return null;
  // no self-referral: the buyer cannot be his own affiliate
  const self = await trx.selectFrom('contacts').select(['id', 'email']).where('id', '=', affiliate.contact_id).executeTakeFirst();
  if (!self || self.id === order.contact_id || emailKey(self.email) === emailKey(order.email)) return null;
  const ins = await trx
    .insertInto('affiliate_referrals')
    .values({ user_id: order.user_id, affiliate_id: affiliate.id, kind: 'sale', contact_id: order.contact_id, order_id: order.id })
    .onConflict((oc) => oc.doNothing())
    .returning('affiliate_id')
    .executeTakeFirst();
  return ins?.affiliate_id ?? null;
}

async function onPayment(ctx: OrderHookContext, trx: Db): Promise<void> {
  const { order, items, amount } = ctx;
  const program = await trx.selectFrom('affiliate_programs').selectAll().where('user_id', '=', order.user_id).executeTakeFirst();
  if (!program?.enabled) return;
  const first = ctx.event === 'paid';
  const affiliateId = first
    ? await referralOfOrder(trx, program, order)
    : ((await trx.selectFrom('affiliate_referrals').select('affiliate_id').where('order_id', '=', order.id).where('kind', '=', 'sale').executeTakeFirst())?.affiliate_id ?? null);
  if (!affiliateId) return;
  if (amount <= 0) return; // free order: no commission
  const affiliate = await trx.selectFrom('affiliates').selectAll().where('id', '=', affiliateId).executeTakeFirst();
  if (!affiliate || affiliate.status !== 'approved') return;

  // lines this payment pays for: every line of the order the first time, the recurring ones afterwards
  const covered = first ? items : items.filter((i) => i.type !== 'one_time');
  // share of each line in this payment (an installment plan only brings one installment), tax excluded
  const charged = (i: OrderItemRow) =>
    i.type !== 'installments' || !i.installments || i.installment_amount === null ? i.amount_total : first ? i.amount_total - i.installment_amount * (i.installments - 1) : i.installment_amount;
  const denom = covered.reduce((n, i) => n + charged(i), 0);
  if (denom <= 0) return;
  const withinMonths = () => {
    if (!program.recurring_months) return true;
    const limit = new Date(order.paid_at ?? order.created_at);
    limit.setUTCMonth(limit.getUTCMonth() + program.recurring_months);
    return Date.now() <= limit.getTime();
  };
  // later payments: installments are one sale paid in several times (always commissioned); subscriptions follow the program
  const eligible = first ? covered : covered.filter((i) => i.type === 'installments' || (program.recurring && withinMonths()));
  if (!eligible.length) return;

  const productIds = [...new Set(eligible.map((i) => i.product_id).filter((x): x is number => !!x))];
  const rules = productIds.length ? await trx.selectFrom('affiliate_commission_rules').selectAll().where('user_id', '=', order.user_id).where('product_id', 'in', productIds).execute() : [];
  // the payment just recorded for this order (the hook runs in its transaction): idempotency key of the commissions
  const tx = await trx.selectFrom('order_transactions').select('id').where('order_id', '=', order.id).where('type', '=', 'payment').orderBy('id', 'desc').executeTakeFirst();
  const sourceKey = tx ? `tx:${tx.id}` : `order:${order.id}`;
  const now = new Date();
  const approveAt = new Date(now.getTime() + program.validation_days * DAY_MS).toISOString();
  let total = 0;
  const names: string[] = [];
  for (const item of eligible) {
    const base = Math.round((amount * charged(item) * (item.amount_total ? item.amount_subtotal / item.amount_total : 1)) / denom);
    const rate = resolveRate(program, affiliate, rules, item);
    const value = commissionAmount(rate, base);
    if (value <= 0) continue;
    const ins = await trx
      .insertInto('affiliate_commissions')
      .values({
        user_id: order.user_id,
        affiliate_id: affiliate.id,
        order_id: order.id,
        order_item_id: item.id,
        kind: first ? 'sale' : 'recurring',
        source_key: sourceKey,
        product_name: itemName(item).slice(0, 400),
        currency: order.currency,
        base_amount: base,
        rate_type: rate.type,
        rate_value: rate.value,
        amount_initial: value,
        amount: value,
        approve_at: approveAt,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      })
      .onConflict((oc) => oc.doNothing())
      .returning('id')
      .executeTakeFirst();
    if (ins) {
      total += value;
      names.push(item.product_name);
    }
  }
  if (total > 0) {
    await logEvent(order.user_id, affiliate.contact_id, 'affiliate_commission', { amount: total / 100, currency: order.currency, product: names.join(', ').slice(0, 300), order_id: order.id, recurring: !first }, {}, trx);
  }
}

/**
 * Refund: commissions of the order not paid out yet are cancelled (full refund) or reduced pro rata (partial);
 * commissions already paid out are taken back by a negative `clawback` row, validated at once — the affiliate's
 * payable balance goes down, possibly below zero, and the difference is deducted from his next payout.
 */
async function onRefund(ctx: OrderHookContext, trx: Db): Promise<void> {
  const { order, amount: delta, full } = ctx;
  const rows = await trx
    .selectFrom('affiliate_commissions')
    .selectAll()
    .where('order_id', '=', order.id)
    .where('user_id', '=', order.user_id)
    .where('kind', '!=', 'clawback')
    .where('status', '!=', 'cancelled')
    .orderBy('id')
    .forUpdate()
    .execute();
  if (!rows.length) return;
  const now = nowIso();
  const paidTotal = Math.max(order.amount_paid, 1);
  const share = (c: CommissionRow) => Math.round((c.amount_initial * Math.min(delta, paidTotal)) / paidTotal);
  const sourceKey = `refund:${order.amount_refunded}`;
  for (const c of rows) {
    if (c.status === 'paid') {
      const prev = await trx.selectFrom('affiliate_commissions').select((eb) => eb.fn.coalesce(eb.fn.sum<number>('amount'), eb.val(0)).as('n')).where('reverses_id', '=', c.id).executeTakeFirstOrThrow();
      const remaining = c.amount + Number(prev.n); // clawbacks are negative
      const back = full ? remaining : Math.min(remaining, share(c));
      if (back <= 0) continue;
      await trx
        .insertInto('affiliate_commissions')
        .values({
          user_id: c.user_id,
          affiliate_id: c.affiliate_id,
          order_id: c.order_id,
          order_item_id: c.order_item_id,
          kind: 'clawback',
          source_key: sourceKey,
          reverses_id: c.id,
          product_name: c.product_name,
          currency: c.currency,
          base_amount: 0,
          rate_type: c.rate_type,
          rate_value: c.rate_value,
          amount_initial: -back,
          amount: -back,
          status: 'approved',
          approve_at: now,
          approved_at: now,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
      continue;
    }
    const left = full ? 0 : Math.max(0, c.amount - share(c));
    if (left <= 0) {
      await trx
        .updateTable('affiliate_commissions')
        .set({ status: 'cancelled', amount: 0, cancelled_at: now, cancel_reason: full ? 'Commande remboursée' : 'Commande remboursée (remboursements partiels)', updated_at: now })
        .where('id', '=', c.id)
        .execute();
    } else {
      await trx.updateTable('affiliate_commissions').set({ amount: left, updated_at: now }).where('id', '=', c.id).execute();
    }
  }
}

registerOrderHook('affiliates', async (ctx, trx) => {
  if (ctx.event === 'paid' || ctx.event === 'subscription_payment') await onPayment(ctx, trx);
  else if (ctx.event === 'refunded') await onRefund(ctx, trx);
});

/** Worker: pending commissions whose validation delay is over become payable. Returns how many. */
export async function approveDueCommissions(ex: Db = db): Promise<number> {
  const now = nowIso();
  const r = await ex
    .updateTable('affiliate_commissions')
    .set({ status: 'approved', approved_at: now, updated_at: now })
    .where('status', '=', 'pending')
    .where('approve_at', '<=', now)
    .executeTakeFirst();
  return Number(r.numUpdatedRows);
}

const commissionsQuery = (ex: Db) =>
  ex
    .selectFrom('affiliate_commissions as m')
    .innerJoin('affiliates as a', 'a.id', 'm.affiliate_id')
    .innerJoin('contacts as c', 'c.id', 'a.contact_id')
    .selectAll('m')
    .select(['c.email as affiliate_email', 'a.code as affiliate_code']);

type CommissionJoined = CommissionRow & { affiliate_email: string; affiliate_code: string };

export const toCommission = (m: CommissionJoined): AffiliateCommission => ({
  id: m.id,
  affiliate_id: m.affiliate_id,
  affiliate_email: m.affiliate_email,
  affiliate_code: m.affiliate_code,
  order_id: m.order_id,
  kind: m.kind,
  product_name: m.product_name,
  currency: m.currency,
  base_amount: m.base_amount,
  rate: rateOf(m.rate_type, m.rate_value),
  amount_initial: m.amount_initial,
  amount: m.amount,
  status: m.status,
  approve_at: m.approve_at,
  approved_at: m.approved_at,
  paid_at: m.paid_at,
  payout_id: m.payout_id,
  cancelled_at: m.cancelled_at,
  cancel_reason: m.cancel_reason,
  created_at: m.created_at,
});

export interface CommissionQuery {
  status?: 'pending' | 'approved' | 'paid' | 'cancelled';
  affiliate_id?: number;
  order_id?: number;
  from?: string;
  to?: string;
  page: number;
  limit: number;
}

export async function listCommissions(userId: number, q: CommissionQuery) {
  const base = () => {
    let b = commissionsQuery(db).where('m.user_id', '=', userId);
    if (q.status) b = b.where('m.status', '=', q.status);
    if (q.affiliate_id) b = b.where('m.affiliate_id', '=', q.affiliate_id);
    if (q.order_id) b = b.where('m.order_id', '=', q.order_id);
    if (q.from) b = b.where('m.created_at', '>=', q.from);
    if (q.to) b = b.where('m.created_at', '<', q.to);
    return b;
  };
  const total = await base().clearSelect().select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
  const rows = await base().orderBy('m.id', 'desc').limit(q.limit).offset((q.page - 1) * q.limit).execute();
  return { items: rows.map(toCommission), total: Number(total.n) };
}

/** Manual cancellation (reason required) of a commission not paid out yet. */
export async function cancelCommission(userId: number, id: number, reason: string): Promise<AffiliateCommission> {
  const now = nowIso();
  const done = await db
    .updateTable('affiliate_commissions')
    .set({ status: 'cancelled', amount: 0, cancelled_at: now, cancel_reason: reason, updated_at: now })
    .where('id', '=', id)
    .where('user_id', '=', userId)
    .where('kind', '!=', 'clawback')
    .where('status', 'in', ['pending', 'approved'])
    .returning('id')
    .executeTakeFirst();
  if (!done) {
    const cur = await db.selectFrom('affiliate_commissions').select(['status', 'kind']).where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
    if (!cur) throw notFound('Commission');
    throw new HttpError(409, cur.status === 'paid' ? 'Cette commission a déjà été payée : elle ne peut plus être annulée' : cur.kind === 'clawback' ? 'Une reprise de commission ne peut pas être annulée' : 'Cette commission est déjà annulée');
  }
  return toCommission(await commissionsQuery(db).where('m.id', '=', id).executeTakeFirstOrThrow());
}

// ---------- payouts ----------

/** What a payout would pay now, per affiliate and currency (validated commissions minus clawbacks, not paid yet). */
export async function listPayables(userId: number, ex: Db = db): Promise<AffiliatePayable[]> {
  const program = await getProgram(userId, ex);
  const rows = await ex
    .selectFrom('affiliate_commissions as m')
    .innerJoin('affiliates as a', 'a.id', 'm.affiliate_id')
    .innerJoin('contacts as c', 'c.id', 'a.contact_id')
    .select([
      'a.id as affiliate_id',
      'c.email',
      'c.first_name',
      'c.last_name',
      'a.code',
      'a.status',
      'm.currency',
      sql<boolean>`a.payout_details_enc IS NOT NULL`.as('has_details'),
      (eb) => eb.fn.sum<number>('m.amount').as('amount'),
      (eb) => eb.fn.countAll<number>().as('n'),
    ])
    .where('m.user_id', '=', userId)
    .where('m.status', '=', 'approved')
    .groupBy(['a.id', 'c.email', 'c.first_name', 'c.last_name', 'a.code', 'a.status', 'm.currency', 'a.payout_details_enc'])
    .orderBy('c.email')
    .orderBy('m.currency')
    .execute();
  return rows.map((r) => {
    const amount = Number(r.amount);
    return {
      affiliate_id: r.affiliate_id,
      email: r.email,
      first_name: r.first_name,
      last_name: r.last_name,
      code: r.code,
      status: r.status,
      currency: r.currency,
      amount,
      commissions_count: Number(r.n),
      payable: amount > 0 && amount >= program.min_payout,
      has_payout_details: !!r.has_details,
    };
  });
}

export interface PayoutInput {
  affiliate_id: number;
  currency: string;
  method?: string;
  reference?: string;
  note?: string;
}

/**
 * Records a payout (the money itself is sent outside Scalo): every validated, unpaid commission of the affiliate in
 * that currency — clawbacks included — is marked as paid by this payout. Refused when the balance is not positive or
 * below the program's minimum.
 */
export function createPayout(userId: number, input: PayoutInput, ex: Db = db): Promise<AffiliatePayout> {
  return inTx(ex, async (trx) => {
    const affiliate = await trx.selectFrom('affiliates').select(['id']).where('id', '=', input.affiliate_id).where('user_id', '=', userId).forUpdate().executeTakeFirst();
    if (!affiliate) throw notFound('Affilié');
    const program = await getProgram(userId, trx);
    const rows = await trx
      .selectFrom('affiliate_commissions')
      .select(['id', 'amount'])
      .where('affiliate_id', '=', affiliate.id)
      .where('user_id', '=', userId)
      .where('currency', '=', input.currency)
      .where('status', '=', 'approved')
      .forUpdate()
      .execute();
    const amount = rows.reduce((n, r) => n + r.amount, 0);
    if (!rows.length || amount <= 0) throw new HttpError(409, 'Aucun montant à payer pour cet affilié');
    if (amount < program.min_payout) throw new HttpError(409, 'Le solde de cet affilié est inférieur au seuil minimum de paiement');
    const now = nowIso();
    const payout = await trx
      .insertInto('affiliate_payouts')
      .values({ user_id: userId, affiliate_id: affiliate.id, currency: input.currency, amount, method: input.method ?? '', reference: input.reference ?? '', note: input.note ?? '', created_at: now })
      .returningAll()
      .executeTakeFirstOrThrow();
    await trx
      .updateTable('affiliate_commissions')
      .set({ status: 'paid', payout_id: payout.id, paid_at: now, updated_at: now })
      .where('id', 'in', rows.map((r) => r.id))
      .execute();
    const { user_id: _u, ...out } = payout;
    return { ...out, commissions_count: rows.length };
  });
}

/** One payout per payable (affiliate, currency) — all of them, or only `only`. */
export async function createPayoutBatch(userId: number, opts: { only?: { affiliate_id: number; currency: string }[]; method?: string; reference?: string; note?: string }): Promise<AffiliatePayout[]> {
  return db.transaction().execute(async (trx) => {
    const payables = (await listPayables(userId, trx)).filter((p) => p.payable && (!opts.only || opts.only.some((o) => o.affiliate_id === p.affiliate_id && o.currency === p.currency)));
    const out: AffiliatePayout[] = [];
    for (const p of payables) out.push(await createPayout(userId, { affiliate_id: p.affiliate_id, currency: p.currency, method: opts.method, reference: opts.reference, note: opts.note }, trx));
    return out;
  });
}

export async function listPayouts(userId: number, q: { affiliate_id?: number; page: number; limit: number }) {
  const base = () => {
    let b = db.selectFrom('affiliate_payouts as p').innerJoin('affiliates as a', 'a.id', 'p.affiliate_id').innerJoin('contacts as c', 'c.id', 'a.contact_id').where('p.user_id', '=', userId);
    if (q.affiliate_id) b = b.where('p.affiliate_id', '=', q.affiliate_id);
    return b;
  };
  const total = await base().select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
  const rows = await base()
    .selectAll('p')
    .select(['c.email as affiliate_email', 'a.code as affiliate_code', (eb) => eb.selectFrom('affiliate_commissions as m').select((e) => e.fn.countAll<number>().as('n')).whereRef('m.payout_id', '=', 'p.id').as('commissions_count')])
    .orderBy('p.id', 'desc')
    .limit(q.limit)
    .offset((q.page - 1) * q.limit)
    .execute();
  const items: AffiliatePayout[] = rows.map(({ user_id: _u, ...r }) => ({ ...r, commissions_count: Number(r.commissions_count ?? 0) }));
  return { items, total: Number(total.n) };
}

// ---------- summary, mentions ----------

export async function affiliationSummary(userId: number): Promise<AffiliationSummary> {
  const program = await db.selectFrom('affiliate_programs').select('enabled').where('user_id', '=', userId).executeTakeFirst();
  const since = new Date(Date.now() - 30 * DAY_MS).toISOString();
  const [counts, clicks, refs, balances] = await Promise.all([
    db
      .selectFrom('affiliates')
      .select([(eb) => eb.fn.countAll<number>().as('total'), sql<number>`COUNT(*) FILTER (WHERE status = 'approved')`.as('approved'), sql<number>`COUNT(*) FILTER (WHERE status = 'pending')`.as('pending')])
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow(),
    db.selectFrom('affiliate_clicks').select((eb) => eb.fn.countAll<number>().as('n')).where('user_id', '=', userId).where('created_at', '>=', since).executeTakeFirstOrThrow(),
    db.selectFrom('affiliate_referrals').select(['kind', (eb) => eb.fn.countAll<number>().as('n')]).where('user_id', '=', userId).where('created_at', '>=', since).groupBy('kind').execute(),
    db
      .selectFrom('affiliate_commissions')
      .select([
        'currency',
        sql<number>`COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0)`.as('pending'),
        sql<number>`COALESCE(SUM(amount) FILTER (WHERE status = 'approved'), 0)`.as('approved'),
        sql<number>`COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0)`.as('paid'),
      ])
      .where('user_id', '=', userId)
      .groupBy('currency')
      .orderBy('currency')
      .execute(),
  ]);
  return {
    enabled: !!program?.enabled,
    affiliates: { total: Number(counts.total), approved: Number(counts.approved), pending: Number(counts.pending) },
    clicks: Number(clicks.n),
    leads: Number(refs.find((r) => r.kind === 'lead')?.n ?? 0),
    sales: Number(refs.find((r) => r.kind === 'sale')?.n ?? 0),
    balances: balances.map((b) => ({ currency: b.currency, pending: Number(b.pending), approved: Number(b.approved), paid: Number(b.paid) })),
  };
}

const mentionOf = (ex: Db, userId: number, affiliateId: number) =>
  withContact(ex)
    .where('a.user_id', '=', userId)
    .where('a.id', '=', affiliateId)
    .executeTakeFirst()
    .then((a) => (a ? { id: a.id, code: a.code, email: a.email, first_name: a.first_name, last_name: a.last_name, status: a.status } : null));

/** Affiliate who brought an order (the parent order's for an upsell) and the commissions it generated. */
export async function orderMention(userId: number, orderId: number) {
  const order = await db.selectFrom('orders').select(['id']).where('id', '=', orderId).where('user_id', '=', userId).executeTakeFirst();
  if (!order) throw notFound('Commande');
  const ref = await db.selectFrom('affiliate_referrals').select('affiliate_id').where('order_id', '=', orderId).where('kind', '=', 'sale').where('user_id', '=', userId).executeTakeFirst();
  if (!ref) return { affiliate: null, commissions: [] };
  const commissions = await db.selectFrom('affiliate_commissions').select(['currency', 'amount', 'status']).where('order_id', '=', orderId).where('user_id', '=', userId).orderBy('id').execute();
  return { affiliate: await mentionOf(db, userId, ref.affiliate_id), commissions };
}

/** Affiliate who brought a contact (lead, or first sale), and whether the contact is an affiliate himself. */
export async function contactMention(userId: number, contactId: number) {
  const contact = await db.selectFrom('contacts').select('id').where('id', '=', contactId).where('user_id', '=', userId).executeTakeFirst();
  if (!contact) throw notFound('Contact');
  const ref = await db
    .selectFrom('affiliate_referrals')
    .select('affiliate_id')
    .where('contact_id', '=', contactId)
    .where('user_id', '=', userId)
    .orderBy(sql`CASE WHEN kind = 'lead' THEN 0 ELSE 1 END`)
    .orderBy('id')
    .executeTakeFirst();
  const own = await db.selectFrom('affiliates').select(['id', 'code', 'status']).where('contact_id', '=', contactId).where('user_id', '=', userId).executeTakeFirst();
  return { affiliate: ref ? await mentionOf(db, userId, ref.affiliate_id) : null, is_affiliate: own ?? null };
}

// ---------- affiliate area: magic link ----------

export const affiliateLoginUrl = (p: Pick<ProgramRow, 'slug'>, token: string) => `${programUrl(p)}/auth/${token}`;

/**
 * One-time login link of the affiliate area. Same mechanism and table as the members area (services/members.ts):
 * hashed token, 20 minutes, single use, sent as a pre-rendered untracked top-priority email.
 */
export async function requestAffiliateLink(program: ProgramRow, contact: ContactRow, redirectPath: string | null, signup = false): Promise<void> {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = nowIso();
  const settings = await getSettingsRow(program.user_id);
  const hello = contact.first_name?.trim() ? `Bonjour ${contact.first_name.trim()},` : 'Bonjour,';
  const subject = signup ? `Confirmez votre inscription — ${program.name}` : `Votre lien de connexion — ${program.name}`;
  const blocks: Block[] = [
    { id: blockId(), type: 'text', text: hello } as Block,
    {
      id: blockId(),
      type: 'text',
      text: signup
        ? `Cliquez sur le bouton ci-dessous pour confirmer votre adresse et finaliser votre inscription au programme « ${program.name} ».`
        : `Cliquez sur le bouton ci-dessous pour vous connecter à votre espace affilié « ${program.name} ».`,
    } as Block,
    { id: blockId(), type: 'button', label: signup ? 'Confirmer mon inscription' : 'Accéder à mon espace affilié', action: 'url', url: affiliateLoginUrl(program, token), style: { align: 'center' } } as Block,
    { id: blockId(), type: 'text', text: 'Ce lien est valable 20 minutes et ne peut être utilisé qu’une seule fois.', style: { align: 'center', color: '#64748b', fontSize: 13 } } as Block,
  ];
  const content: PageContent = { settings: { ...DEFAULT_EMAIL_SETTINGS }, blocks };
  const footer = esc(`Vous recevez cet email car une connexion au programme d’affiliation « ${program.name} » a été demandée avec cette adresse. Si vous n’êtes pas à l’origine de cette demande, ignorez simplement cet email.`);
  const html = renderEmail(content, subject, { first_name: contact.first_name ?? '', last_name: contact.last_name ?? '', email: contact.email, phone: contact.phone ?? '' }, footer);
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('member_login_tokens')
      .values({ user_id: program.user_id, contact_id: contact.id, token_hash: hashLoginToken(token), redirect_path: redirectPath, expires_at: new Date(Date.now() + LOGIN_TTL_MS).toISOString(), created_at: now })
      .execute();
    await trx
      .insertInto('email_sends')
      .values({ user_id: settings.user_id, contact_id: contact.id, kind: 'confirmation', to_email: contact.email, subject, html, status: 'pending', send_at: now, created_at: now })
      .execute();
  });
}
