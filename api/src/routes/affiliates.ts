// Affiliate program, admin side (session-authenticated, under /api/affiliation). The public affiliate area is in
// routes/affiliate-space.ts, the tracking / commission logic in services/affiliates.ts. See SPEC.md « Affiliation ».
//
// Roles (api/src/access.ts): `/affiliation/settings` and `/affiliation/payouts` are administration sub-areas — an
// editor can read them but never write. On top of the generic rule, payout details (IBAN…) and the manual
// cancellation of a commission are reserved to the owner and administrators here.
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AffiliateDetail } from '@scalo/shared';
import { db } from '../db';
import { normEmail, upsertContact } from '../services/contacts';
import {
  affiliateLinks,
  affiliationSummary,
  AFFILIATE_CODE_RE,
  cancelCommission,
  contactMention,
  createAffiliate,
  createPayout,
  createPayoutBatch,
  getAffiliate,
  getProgram,
  listAffiliates,
  listCommissions,
  listPayables,
  listPayouts,
  orderMention,
  publicProgram,
  readPayoutDetails,
  saveProgram,
  toAffiliates,
  updateAffiliate,
} from '../services/affiliates';
import { HttpError, notFound, paramId, uid } from '../util';

export const affiliatesRouter = Router();

const isAdmin = (req: Request) => req.role === 'owner' || req.role === 'admin';
const requireAdmin = (req: Request) => {
  if (!isAdmin(req)) throw new HttpError(403, 'Cette action est réservée aux administrateurs du compte');
};

const rate = z.object({ type: z.enum(['percent', 'fixed']), value: z.number().min(0).max(99_999_999) });
const page = z.coerce.number().int().min(1).max(100_000).default(1);
const limit = z.coerce.number().int().min(1).max(100).default(50);
const optDate = z.iso.datetime({ offset: true }).optional();
const currency = z.string().trim().toLowerCase().regex(/^[a-z]{3}$/, 'Devise invalide');

// ---------- program ----------

affiliatesRouter.get('/affiliation/settings', async (req, res) => {
  res.json(await publicProgram(await getProgram(uid(req))));
});

const programSchema = z
  .object({
    enabled: z.boolean(),
    slug: z.string().trim().toLowerCase().min(1).max(60),
    name: z.string().trim().min(1).max(120),
    commission: rate,
    recurring: z.boolean(),
    recurring_months: z.number().int().min(1).max(120).nullable(),
    cookie_days: z.number().int().min(1).max(365),
    attribution: z.enum(['last_click', 'first_click']),
    validation_days: z.number().int().min(0).max(365),
    min_payout: z.number().int().min(0).max(99_999_999),
    signup_mode: z.enum(['open', 'approval']),
    terms: z.string().max(20000),
    rules: z.array(z.object({ product_id: z.number().int().positive(), price_id: z.number().int().positive().nullable().optional(), commission: rate })).max(200),
  })
  .partial()
  .strict();

affiliatesRouter.put('/affiliation/settings', async (req, res) => {
  res.json(await publicProgram(await saveProgram(uid(req), programSchema.parse(req.body))));
});

affiliatesRouter.get('/affiliation/summary', async (req, res) => {
  res.json(await affiliationSummary(uid(req)));
});

// ---------- affiliates ----------

const listSchema = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'suspended']).optional(), search: z.string().trim().max(200).optional(), page, limit });

affiliatesRouter.get('/affiliation/affiliates', async (req, res) => {
  res.json(await listAffiliates(uid(req), listSchema.parse(req.query)));
});

const createSchema = z
  .object({
    contact_id: z.number().int().positive().optional(),
    email: z.string().trim().max(254).optional(),
    first_name: z.string().trim().max(200).optional(),
    last_name: z.string().trim().max(200).optional(),
    status: z.enum(['pending', 'approved']).default('approved'),
  })
  .refine((b) => !!b.contact_id !== !!b.email, 'Indiquez un contact ou une adresse email');

/** Adds an affiliate by hand (an existing contact, or an email: the contact is created if needed). Approved by default. */
affiliatesRouter.post('/affiliation/affiliates', async (req, res) => {
  const userId = uid(req);
  const body = createSchema.parse(req.body);
  const result = await db.transaction().execute(async (trx) => {
    let contact;
    if (body.contact_id) {
      contact = await trx.selectFrom('contacts').selectAll().where('id', '=', body.contact_id).where('user_id', '=', userId).executeTakeFirst();
      if (!contact) throw notFound('Contact');
    } else {
      const email = normEmail(body.email!);
      if (!z.email().safeParse(email).success) throw new HttpError(400, 'Adresse email invalide');
      contact = (await upsertContact(userId, { email, first_name: body.first_name, last_name: body.last_name }, { overwrite: false }, trx)).contact;
    }
    return createAffiliate(userId, contact, body.status, trx);
  });
  if (!result.created) throw new HttpError(409, 'Ce contact est déjà affilié');
  res.status(201).json((await toAffiliates([await getAffiliate(userId, result.affiliate.id)]))[0]);
});

async function detail(req: Request, id: number): Promise<AffiliateDetail> {
  const userId = uid(req);
  const row = await getAffiliate(userId, id);
  const [base] = await toAffiliates([row]);
  const links = await affiliateLinks(userId, row.code);
  const payouts = await listPayouts(userId, { affiliate_id: id, page: 1, limit: 100 });
  const admin = isAdmin(req);
  return { ...base, link: links[0]?.pages[0]?.url ?? null, payout_details: admin ? readPayoutDetails(row) : null, payout_details_visible: admin, payouts: payouts.items };
}

affiliatesRouter.get('/affiliation/affiliates/:id', async (req, res) => {
  res.json(await detail(req, paramId(req.params.id, 'Affilié')));
});

const patchSchema = z
  .object({
    status: z.enum(['approved', 'rejected', 'suspended']),
    commission: rate.nullable(),
    code: z.string().trim().toLowerCase().regex(AFFILIATE_CODE_RE, 'Code invalide : 3 à 32 lettres minuscules, chiffres ou tirets'),
  })
  .partial()
  .strict();

affiliatesRouter.patch('/affiliation/affiliates/:id', async (req, res) => {
  const id = paramId(req.params.id, 'Affilié');
  const body = patchSchema.parse(req.body);
  // the commission of an affiliate is a program setting: administrators only
  if (body.commission !== undefined) requireAdmin(req);
  await updateAffiliate(uid(req), id, body);
  res.json(await detail(req, id));
});

// ---------- commissions ----------

const commissionsSchema = z.object({
  status: z.enum(['pending', 'approved', 'paid', 'cancelled']).optional(),
  affiliate_id: z.coerce.number().int().positive().optional(),
  order_id: z.coerce.number().int().positive().optional(),
  from: optDate,
  to: optDate,
  page,
  limit,
});

affiliatesRouter.get('/affiliation/commissions', async (req, res) => {
  res.json(await listCommissions(uid(req), commissionsSchema.parse(req.query)));
});

affiliatesRouter.post('/affiliation/commissions/:id/cancel', async (req, res) => {
  requireAdmin(req);
  const { reason } = z.object({ reason: z.string().trim().min(3, 'Indiquez le motif de l’annulation').max(500) }).parse(req.body);
  res.json(await cancelCommission(uid(req), paramId(req.params.id, 'Commission'), reason));
});

// ---------- payouts ----------

affiliatesRouter.get('/affiliation/payouts/balances', async (req, res) => {
  res.json(await listPayables(uid(req)));
});

const csvCell = (v: unknown) => {
  let s = String(v ?? '');
  // spreadsheet formula injection: values typed by affiliates (payout details) are exported
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV of the amounts to pay (one line per affiliate and currency). Payout details only for administrators. */
affiliatesRouter.get('/affiliation/payouts/export', async (req, res) => {
  const userId = uid(req);
  const admin = isAdmin(req);
  const rows = (await listPayables(userId)).filter((p) => p.payable);
  const details = new Map<number, string>();
  if (admin && rows.length) {
    const affs = await db.selectFrom('affiliates').select(['id', 'payout_details_enc']).where('user_id', '=', userId).where('id', 'in', rows.map((r) => r.affiliate_id)).execute();
    for (const a of affs) details.set(a.id, readPayoutDetails(a) ?? '');
  }
  const head = ['email', 'prenom', 'nom', 'code', 'devise', 'montant', 'commissions', ...(admin ? ['coordonnees_de_paiement'] : [])];
  const lines = rows.map((r) =>
    [r.email, r.first_name ?? '', r.last_name ?? '', r.code, r.currency.toUpperCase(), (r.amount / 100).toFixed(2), r.commissions_count, ...(admin ? [details.get(r.affiliate_id) ?? ''] : [])].map(csvCell).join(';'),
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="paiements-affilies.csv"');
  res.setHeader('Cache-Control', 'no-store');
  res.send(`﻿${[head.join(';'), ...lines].join('\n')}\n`);
});

affiliatesRouter.get('/affiliation/payouts', async (req, res) => {
  res.json(await listPayouts(uid(req), z.object({ affiliate_id: z.coerce.number().int().positive().optional(), page, limit }).parse(req.query)));
});

const payoutMeta = { method: z.string().trim().max(80).optional(), reference: z.string().trim().max(200).optional(), note: z.string().trim().max(1000).optional() };

affiliatesRouter.post('/affiliation/payouts', async (req, res) => {
  const body = z.object({ affiliate_id: z.number().int().positive(), currency, ...payoutMeta }).parse(req.body);
  res.status(201).json(await createPayout(uid(req), body));
});

/** One payout per payable balance (all of them, or only `items`), with the same method / reference. */
affiliatesRouter.post('/affiliation/payouts/batch', async (req, res) => {
  const body = z.object({ items: z.array(z.object({ affiliate_id: z.number().int().positive(), currency })).max(1000).optional(), ...payoutMeta }).parse(req.body);
  const payouts = await createPayoutBatch(uid(req), { only: body.items, method: body.method, reference: body.reference, note: body.note });
  res.status(201).json({ payouts, count: payouts.length });
});

// ---------- mentions (order / contact screens) ----------

affiliatesRouter.get('/affiliation/orders/:id', async (req, res) => {
  res.json(await orderMention(uid(req), paramId(req.params.id, 'Commande')));
});

affiliatesRouter.get('/affiliation/contacts/:id', async (req, res) => {
  res.json(await contactMention(uid(req), paramId(req.params.id, 'Contact')));
});
