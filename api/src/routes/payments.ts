// Sales (session-authenticated): Stripe connection, products & offers, orders, refunds, revenue.
// Public side (checkout, webhook): routes/payments-public.ts. See SPEC.md « Paiements ».
import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { CURRENCIES, INSTALLMENT_RHYTHMS, installmentPlan, MAX_INSTALLMENTS, type Product, type ProductPrice } from '@scalo/shared';
import { db, nowIso, type Db } from '../db';
import { getContactRow, getOrCreateTag } from '../services/contacts';
import {
  applyRefund,
  encryptStripeKey,
  encryptWebhookSecret,
  endSubscription,
  getPaymentSettingsRow,
  loadSellables,
  publicPaymentSettings,
  requireStripe,
  salesStats,
  toOffer,
  toOrders,
} from '../services/payments';
import { keyMode, PUBLISHABLE_KEY_RE, SECRET_KEY_RE, StripeError, WEBHOOK_SECRET_RE } from '../services/stripe';
import { HttpError, likeEscape, notFound, paramId, uid } from '../util';

export const paymentsRouter = Router();

/** Stripe error messages may echo (masked) keys: never forward anything that looks like one. */
const safeStripeMessage = (e: unknown) =>
  (e instanceof StripeError ? e.message : 'erreur inattendue').replace(/\b(sk|rk|pk|whsec)_[A-Za-z0-9_*.]+/g, '•••').slice(0, 300);

// ---------- Stripe connection ----------

paymentsRouter.get('/payments/settings', async (req, res) => {
  res.json(publicPaymentSettings(await getPaymentSettingsRow(uid(req))));
});

const settingsSchema = z.object({
  secret_key: z.string().trim().max(300).optional(),
  publishable_key: z.string().trim().max(300).nullable().optional(),
  webhook_secret: z.string().trim().max(300).nullable().optional(),
  sepa_debit: z.boolean().optional(),
});

/** Empty / missing secret = unchanged (secrets are write-only). `null` clears the publishable key / webhook secret. */
paymentsRouter.put('/payments/settings', async (req, res) => {
  const userId = uid(req);
  const body = settingsSchema.parse(req.body);
  const cur = await getPaymentSettingsRow(userId);
  const set: Record<string, unknown> = {};
  let mode = cur.stripe_secret_key ? cur.mode : null;
  if (body.secret_key) {
    if (!SECRET_KEY_RE.test(body.secret_key)) throw new HttpError(400, 'Clé secrète invalide : elle commence par sk_test_, sk_live_, rk_test_ ou rk_live_');
    const enc = encryptStripeKey(body.secret_key);
    mode = keyMode(body.secret_key);
    Object.assign(set, { stripe_secret_key: enc.value, stripe_secret_hint: enc.hint, mode, account_name: null, verified_at: null, payment_domains: '[]' });
  }
  if (body.publishable_key !== undefined) {
    const pk = body.publishable_key || null;
    if (pk && !PUBLISHABLE_KEY_RE.test(pk)) throw new HttpError(400, 'Clé publique invalide : elle commence par pk_test_ ou pk_live_');
    if (pk && mode && keyMode(pk) !== mode) throw new HttpError(400, 'La clé publique et la clé secrète ne sont pas du même mode (test / live)');
    set.stripe_publishable_key = pk;
  } else if (body.secret_key && cur.stripe_publishable_key && keyMode(cur.stripe_publishable_key) !== mode) {
    set.stripe_publishable_key = null; // the stored publishable key belongs to the other mode
  }
  if (body.webhook_secret !== undefined && body.webhook_secret !== '') {
    if (body.webhook_secret === null) Object.assign(set, { stripe_webhook_secret: null, stripe_webhook_hint: null });
    else {
      if (!WEBHOOK_SECRET_RE.test(body.webhook_secret)) throw new HttpError(400, 'Secret de webhook invalide : il commence par whsec_');
      const enc = encryptWebhookSecret(body.webhook_secret);
      Object.assign(set, { stripe_webhook_secret: enc.value, stripe_webhook_hint: enc.hint });
    }
  }
  if (body.sepa_debit !== undefined) set.sepa_debit = body.sepa_debit;
  if (Object.keys(set).length) await db.updateTable('payment_settings').set({ ...set, updated_at: nowIso() }).where('user_id', '=', userId).execute();
  res.json(publicPaymentSettings(await getPaymentSettingsRow(userId)));
});

/** « Tester la connexion »: asks Stripe who the key belongs to. */
paymentsRouter.post('/payments/settings/test', async (req, res) => {
  const userId = uid(req);
  const { client } = await requireStripe(userId);
  try {
    const account = await client.retrieveAccount();
    await db.updateTable('payment_settings').set({ account_name: account.name ?? account.id, verified_at: nowIso(), updated_at: nowIso() }).where('user_id', '=', userId).execute();
  } catch (e) {
    throw new HttpError(502, `Connexion à Stripe impossible : ${safeStripeMessage(e)}`);
  }
  res.json({ ok: true, settings: publicPaymentSettings(await getPaymentSettingsRow(userId)) });
});

/** Disconnects Stripe (the webhook URL stays the same). Existing orders are kept. */
paymentsRouter.delete('/payments/settings', async (req, res) => {
  const userId = uid(req);
  await getPaymentSettingsRow(userId);
  await db
    .updateTable('payment_settings')
    .set({
      stripe_secret_key: null, stripe_secret_hint: null, stripe_publishable_key: null, stripe_webhook_secret: null, stripe_webhook_hint: null,
      mode: null, account_name: null, verified_at: null, payment_domains: '[]', updated_at: nowIso(),
    })
    .where('user_id', '=', userId)
    .execute();
  res.json(publicPaymentSettings(await getPaymentSettingsRow(userId)));
});

// ---------- products & offers ----------

const priceSchema = z
  .object({
    id: z.number().int().positive().optional(),
    name: z.string().trim().max(120).optional().default(''),
    type: z.enum(['one_time', 'subscription', 'installments']),
    /** One-time / installments: price paid in one go. Subscription: price per period. */
    amount: z.number().int('Montant en centimes (entier)').min(50, 'Montant minimum : 0,50').max(99_999_999),
    currency: z.enum(CURRENCIES),
    interval: z.enum(['week', 'month', 'year']).nullable().optional(),
    interval_count: z.number().int().min(1).max(12).optional(),
    installments_min: z.number().int().min(1).max(MAX_INSTALLMENTS).nullable().optional(),
    installments_max: z.number().int().min(2).max(MAX_INSTALLMENTS).nullable().optional(),
    /** Surcharge in percent per number of payments. */
    installment_fees: z.record(z.string().regex(/^\d{1,2}$/), z.number().min(0).max(100)).optional(),
    tax_rate: z.number().min(0).max(100).optional().default(0),
    tax_inclusive: z.boolean().optional().default(true),
    active: z.boolean().optional().default(true),
  })
  .transform((p, ctx) => {
    const base = { ...p, tax_rate: Math.round(p.tax_rate * 100) / 100 };
    if (p.type !== 'installments') {
      return {
        ...base,
        interval: p.type === 'one_time' ? null : p.interval === 'year' ? ('year' as const) : ('month' as const),
        interval_count: 1,
        installments_min: null,
        installments_max: null,
        installment_fees: '{}',
      };
    }
    const max = p.installments_max ?? null;
    const min = p.installments_min ?? max;
    if (!max || !min) {
      ctx.addIssue({ code: 'custom', path: ['installments_max'], message: `Indiquez le nombre maximum d’échéances (2 à ${MAX_INSTALLMENTS})` });
      return z.NEVER;
    }
    if (min > max) {
      ctx.addIssue({ code: 'custom', path: ['installments_min'], message: 'Le minimum d’échéances dépasse le maximum' });
      return z.NEVER;
    }
    const rhythm = INSTALLMENT_RHYTHMS.find((r) => r.interval === (p.interval ?? 'month') && r.count === (p.interval_count ?? 1));
    if (!rhythm) {
      ctx.addIssue({ code: 'custom', path: ['interval'], message: 'Rythme des échéances : chaque mois, toutes les 2 semaines ou chaque semaine' });
      return z.NEVER;
    }
    // surcharges only for the counts on offer, rounded to 2 decimals
    const fees: Record<string, number> = {};
    for (const [k, v] of Object.entries(p.installment_fees ?? {})) if (Number(k) >= Math.max(2, min) && Number(k) <= max && v > 0) fees[k] = Math.round(v * 100) / 100;
    const each = installmentPlan({ amount: p.amount, tax_rate: base.tax_rate, tax_inclusive: p.tax_inclusive, installment_fees: fees }, max).each;
    if (each < 50) {
      ctx.addIssue({ code: 'custom', path: ['installments_max'], message: `Échéance trop faible en ${max} fois (0,50 minimum) : réduisez le nombre d’échéances` });
      return z.NEVER;
    }
    return { ...base, interval: rhythm.interval, interval_count: rhythm.count, installments_min: min, installments_max: max, installment_fees: JSON.stringify(fees) };
  });

const imageUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => v === '' || /^https?:\/\//i.test(v) || /^\/uploads\/[\w./-]+$/.test(v), 'URL d’image invalide')
  .nullable()
  .optional();

const productSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  image_url: imageUrl,
  tag_id: z.number().int().positive().nullable().optional(),
  /** Convenience: tag by name, created if needed (wins over tag_id). */
  tag_name: z.string().trim().max(60).optional(),
  campaign_id: z.number().int().positive().nullable().optional(),
  revoke_on_refund: z.boolean().optional(),
  archived: z.boolean().optional(),
  prices: z.array(priceSchema).max(20).optional(),
});

async function checkRefs(userId: number, b: { tag_id?: number | null; campaign_id?: number | null }, ex: Db) {
  if (b.tag_id && !(await ex.selectFrom('tags').select('id').where('id', '=', b.tag_id).where('user_id', '=', userId).executeTakeFirst())) throw notFound('Tag');
  if (b.campaign_id && !(await ex.selectFrom('campaigns').select('id').where('id', '=', b.campaign_id).where('user_id', '=', userId).executeTakeFirst())) throw notFound('Campagne');
}

export async function listProducts(userId: number, opts: { id?: number; archived?: boolean } = {}, ex: Db = db): Promise<Product[]> {
  let q = ex
    .selectFrom('products as p')
    .leftJoin('tags as t', 't.id', 'p.tag_id')
    .select(['p.id', 'p.name', 'p.description', 'p.image_url', 'p.tag_id', 't.name as tag_name', 'p.campaign_id', 'p.revoke_on_refund', 'p.archived', 'p.created_at', 'p.updated_at'])
    .select((eb) =>
      eb
        .selectFrom('order_items as i')
        .innerJoin('orders as o', 'o.id', 'i.order_id')
        .select(eb.fn.countAll<number>().as('n'))
        .whereRef('i.product_id', '=', 'p.id')
        .where('o.status', 'in', ['paid', 'refunded'])
        .as('sales_count'),
    )
    .where('p.user_id', '=', userId);
  if (opts.id) q = q.where('p.id', '=', opts.id);
  else if (!opts.archived) q = q.where('p.archived', '=', false);
  const rows = await q.orderBy('p.created_at', 'desc').orderBy('p.id', 'desc').execute();
  if (!rows.length) return [];
  const prices = await ex.selectFrom('product_prices').selectAll().where('product_id', 'in', rows.map((r) => r.id)).orderBy('id').execute();
  return rows.map((r) => ({
    ...r,
    sales_count: Number(r.sales_count ?? 0),
    prices: prices
      .filter((p) => p.product_id === r.id)
      .map(({ user_id: _u, ...p }): ProductPrice => ({ ...p, currency: p.currency as ProductPrice['currency'], tax_rate: Number(p.tax_rate), installment_fees: p.installment_fees ?? {} })),
  }));
}

/** Replaces the offers of a product: given ids are updated, new ones created, the others deleted (orders keep a snapshot). */
async function syncPrices(trx: Db, userId: number, productId: number, prices: z.infer<typeof priceSchema>[]) {
  const existing = await trx.selectFrom('product_prices').select('id').where('product_id', '=', productId).execute();
  const keep = new Set<number>();
  for (const p of prices) {
    const { id, ...values } = p;
    if (id && existing.some((e) => e.id === id)) {
      await trx.updateTable('product_prices').set(values).where('id', '=', id).where('product_id', '=', productId).execute();
      keep.add(id);
    } else {
      const created = await trx.insertInto('product_prices').values({ ...values, user_id: userId, product_id: productId, created_at: nowIso() }).returning('id').executeTakeFirstOrThrow();
      keep.add(created.id);
    }
  }
  const gone = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
  if (gone.length) await trx.deleteFrom('product_prices').where('id', 'in', gone).execute();
}

paymentsRouter.get('/products', async (req, res) => {
  res.json(await listProducts(uid(req), { archived: req.query.archived === '1' }));
});

paymentsRouter.post('/products', async (req, res) => {
  const userId = uid(req);
  const b = productSchema.parse(req.body);
  const { n } = await db.selectFrom('products').select((eb) => eb.fn.countAll<number>().as('n')).where('user_id', '=', userId).executeTakeFirstOrThrow();
  if (Number(n) >= 500) throw new HttpError(409, 'Limite de 500 produits atteinte');
  const id = await db.transaction().execute(async (trx) => {
    const tagId = b.tag_name ? (await getOrCreateTag(userId, b.tag_name, trx)).id : b.tag_id ?? null;
    await checkRefs(userId, { tag_id: tagId, campaign_id: b.campaign_id }, trx);
    const now = nowIso();
    const p = await trx
      .insertInto('products')
      .values({
        user_id: userId, name: b.name, description: b.description ?? '', image_url: b.image_url || null, tag_id: tagId, campaign_id: b.campaign_id ?? null,
        revoke_on_refund: b.revoke_on_refund ?? true, archived: b.archived ?? false, created_at: now, updated_at: now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (b.prices?.length) await syncPrices(trx, userId, p.id, b.prices);
    return p.id;
  });
  res.status(201).json((await listProducts(userId, { id }))[0]);
});

paymentsRouter.get('/products/:id', async (req, res) => {
  const p = (await listProducts(uid(req), { id: paramId(req.params.id, 'Produit') }))[0];
  if (!p) throw notFound('Produit');
  res.json(p);
});

paymentsRouter.patch('/products/:id', async (req, res) => {
  const userId = uid(req);
  const id = paramId(req.params.id, 'Produit');
  const b = productSchema.partial().parse(req.body);
  await db.transaction().execute(async (trx) => {
    const cur = await trx.selectFrom('products').select('id').where('id', '=', id).where('user_id', '=', userId).forUpdate().executeTakeFirst();
    if (!cur) throw notFound('Produit');
    const tagId = b.tag_name ? (await getOrCreateTag(userId, b.tag_name, trx)).id : b.tag_id;
    await checkRefs(userId, { tag_id: tagId, campaign_id: b.campaign_id }, trx);
    await trx
      .updateTable('products')
      .set({
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.description !== undefined ? { description: b.description } : {}),
        ...(b.image_url !== undefined ? { image_url: b.image_url || null } : {}),
        ...(tagId !== undefined ? { tag_id: tagId } : {}),
        ...(b.campaign_id !== undefined ? { campaign_id: b.campaign_id } : {}),
        ...(b.revoke_on_refund !== undefined ? { revoke_on_refund: b.revoke_on_refund } : {}),
        ...(b.archived !== undefined ? { archived: b.archived } : {}),
        updated_at: nowIso(),
      })
      .where('id', '=', id)
      .execute();
    if (b.prices) await syncPrices(trx, userId, id, b.prices);
  });
  res.json((await listProducts(userId, { id }))[0]);
});

/** Orders keep their lines (names and amounts are snapshots); funnel blocks selling the product show « offre indisponible ». */
paymentsRouter.delete('/products/:id', async (req, res) => {
  const r = await db.deleteFrom('products').where('id', '=', paramId(req.params.id, 'Produit')).where('user_id', '=', uid(req)).executeTakeFirst();
  if (!Number(r.numDeletedRows)) throw notFound('Produit');
  res.json({ ok: true });
});

/** Sellable offers (active prices of non-archived products), for the builder's pickers. */
paymentsRouter.get('/offers', async (req, res) => {
  res.json((await loadSellables(uid(req))).map(toOffer));
});

// ---------- orders ----------

export const orderListSchema = z.object({
  status: z.enum(['pending', 'paid', 'failed', 'refunded', 'canceled', 'subscription']).optional(),
  search: z.string().trim().max(200).optional(),
  product_id: z.coerce.number().int().positive().optional(),
  funnel_id: z.coerce.number().int().positive().optional(),
  contact_id: z.coerce.number().int().positive().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
});

export async function listOrders(userId: number, q: z.infer<typeof orderListSchema>) {
  let base = db.selectFrom('orders as o').where('o.user_id', '=', userId);
  if (q.status === 'subscription') base = base.where('o.status', '=', 'paid').where('o.subscription_status', 'in', ['active', 'past_due']);
  else if (q.status) base = base.where('o.status', '=', q.status);
  if (q.search) {
    const like = `%${likeEscape(q.search.toLowerCase())}%`;
    const asId = /^#?\d{1,15}$/.test(q.search) ? Number(q.search.replace('#', '')) : null;
    base = base.where((eb) =>
      eb.or([
        eb('o.email', 'like', like),
        eb(sql<string>`lower(coalesce(o.first_name, '') || ' ' || coalesce(o.last_name, ''))`, 'like', like),
        ...(asId ? [eb('o.id', '=', asId)] : []),
      ]),
    );
  }
  if (q.product_id) base = base.where((eb) => eb.exists(eb.selectFrom('order_items as i').select('i.id').whereRef('i.order_id', '=', 'o.id').where('i.product_id', '=', q.product_id!)));
  if (q.funnel_id) base = base.where('o.funnel_id', '=', q.funnel_id);
  if (q.contact_id) base = base.where('o.contact_id', '=', q.contact_id);
  if (q.from) base = base.where('o.created_at', '>=', q.from);
  if (q.to) base = base.where('o.created_at', '<', q.to);
  const [{ n }, rows] = await Promise.all([
    base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
    base.selectAll('o').orderBy('o.created_at', 'desc').orderBy('o.id', 'desc').limit(q.limit).offset((q.page - 1) * q.limit).execute(),
  ]);
  return { items: await toOrders(rows), total: Number(n) };
}

export async function orderDetail(userId: number, id: number) {
  const row = await db.selectFrom('orders').selectAll().where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
  if (!row) return null;
  const [order] = await toOrders([row]);
  const transactions = await db.selectFrom('order_transactions').select(['id', 'type', 'amount', 'currency', 'created_at']).where('order_id', '=', id).orderBy('id').execute();
  const upsells = await db.selectFrom('orders').select(['id', 'status', 'amount_total', 'currency']).where('parent_order_id', '=', id).where('user_id', '=', userId).orderBy('id').execute();
  return { ...order, transactions, upsells, visitor_id: typeof row.visitor?.visitor_id === 'string' ? row.visitor.visitor_id : null };
}

paymentsRouter.get('/orders', async (req, res) => {
  res.json(await listOrders(uid(req), orderListSchema.parse(req.query)));
});

paymentsRouter.get('/orders/:id', async (req, res) => {
  const userId = uid(req);
  const id = paramId(req.params.id, 'Commande');
  const o = await orderDetail(userId, id);
  if (!o) throw notFound('Commande');
  const row = await db.selectFrom('orders').select(['stripe_payment_intent_id', 'stripe_subscription_id', 'livemode']).where('id', '=', id).executeTakeFirstOrThrow();
  const dash = `https://dashboard.stripe.com/${row.livemode ? '' : 'test/'}`;
  res.json({
    ...o,
    stripe_url: row.stripe_payment_intent_id ? `${dash}payments/${row.stripe_payment_intent_id}` : row.stripe_subscription_id ? `${dash}subscriptions/${row.stripe_subscription_id}` : null,
  });
});

const refundSchema = z.object({
  /** Minor units; omitted = everything left on the last payment. */
  amount: z.number().int().min(1).optional(),
  /** Remove the tags given by the order (default: what each product says, and only on a full refund). */
  revoke: z.boolean().optional(),
  /** Also end the subscription / installment plan (default: true). */
  cancel_subscription: z.boolean().optional(),
});

/** Refunds the latest payment of the order through Stripe, then applies it (the `charge.refunded` webhook is a no-op afterwards). */
paymentsRouter.post('/orders/:id/refund', async (req, res) => {
  const userId = uid(req);
  const id = paramId(req.params.id, 'Commande');
  const b = refundSchema.parse(req.body ?? {});
  const order = await db.selectFrom('orders').selectAll().where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
  if (!order) throw notFound('Commande');
  if (order.status !== 'paid') throw new HttpError(409, order.status === 'refunded' ? 'Cette commande est déjà remboursée' : 'Seule une commande payée peut être remboursée');
  // latest payment that still has something to give back
  const payments = await db
    .selectFrom('order_transactions')
    .select(['id', 'amount', 'stripe_payment_intent_id'])
    .where('order_id', '=', id)
    .where('type', '=', 'payment')
    .where('stripe_payment_intent_id', 'is not', null)
    .orderBy('id', 'desc')
    .execute();
  const refunds = await db.selectFrom('order_transactions').select(['amount', 'stripe_payment_intent_id']).where('order_id', '=', id).where('type', '=', 'refund').execute();
  const already = (pi: string | null) => refunds.find((r) => r.stripe_payment_intent_id === pi)?.amount ?? 0;
  const target = payments.find((p) => p.amount - already(p.stripe_payment_intent_id) > 0);
  if (!target?.stripe_payment_intent_id) throw new HttpError(409, 'Aucun paiement remboursable sur cette commande');
  const done = already(target.stripe_payment_intent_id);
  const left = target.amount - done;
  const amount = b.amount ?? left;
  if (amount > left) throw new HttpError(400, `Montant maximum remboursable : ${(left / 100).toFixed(2)}`);

  const { client } = await requireStripe(userId);
  let refunded: number;
  try {
    const r = await client.createRefund({ payment_intent: target.stripe_payment_intent_id, amount, metadata: { order_id: String(id) } }, `scalo-refund-${id}-${target.id}-${done}-${amount}`);
    refunded = r.amount;
  } catch (e) {
    throw new HttpError(502, `Remboursement refusé par Stripe : ${safeStripeMessage(e)}`);
  }
  await applyRefund(userId, target.stripe_payment_intent_id, done + refunded, { revoke: b.revoke });
  if ((b.cancel_subscription ?? true) && order.stripe_subscription_id && (order.subscription_status === 'active' || order.subscription_status === 'past_due')) {
    try {
      await client.cancelSubscription(order.stripe_subscription_id);
      await endSubscription(userId, order.stripe_subscription_id, id, { revoke: b.revoke });
    } catch (e) {
      throw new HttpError(502, `Remboursement effectué, mais l’abonnement n’a pas pu être annulé : ${safeStripeMessage(e)}`);
    }
  }
  res.json(await orderDetail(userId, id));
});

/** Ends the subscription now (no refund). The tags of the recurring lines are removed unless `revoke: false`. */
paymentsRouter.post('/orders/:id/cancel-subscription', async (req, res) => {
  const userId = uid(req);
  const id = paramId(req.params.id, 'Commande');
  const b = z.object({ revoke: z.boolean().optional() }).parse(req.body ?? {});
  const order = await db.selectFrom('orders').select(['id', 'stripe_subscription_id', 'subscription_status']).where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
  if (!order) throw notFound('Commande');
  if (!order.stripe_subscription_id || (order.subscription_status !== 'active' && order.subscription_status !== 'past_due')) throw new HttpError(409, 'Cette commande n’a pas d’abonnement actif');
  const { client } = await requireStripe(userId);
  try {
    await client.cancelSubscription(order.stripe_subscription_id);
  } catch (e) {
    throw new HttpError(502, `Annulation refusée par Stripe : ${safeStripeMessage(e)}`);
  }
  await endSubscription(userId, order.stripe_subscription_id, id, { revoke: b.revoke });
  res.json(await orderDetail(userId, id));
});

/** Purchases of a contact (contact page). */
paymentsRouter.get('/contacts/:id/orders', async (req, res) => {
  const userId = uid(req);
  const contact = await getContactRow(userId, paramId(req.params.id, 'Contact'));
  if (!contact) throw notFound('Contact');
  const rows = await db.selectFrom('orders').selectAll().where('user_id', '=', userId).where('contact_id', '=', contact.id).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(100).execute();
  res.json(await toOrders(rows));
});

// ---------- revenue ----------

const statsSchema = z.object({
  days: z.coerce.number().int().min(1).max(366).optional().default(30),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

/** Revenue over a period: `?days=30` (default, ending now, whole UTC days) or `?from=&to=` (ISO dates, at most 366 days). */
paymentsRouter.get('/sales/stats', async (req, res) => {
  const q = statsSchema.parse(req.query);
  const to = q.to ? new Date(q.to) : new Date();
  const start = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate() - (q.days - 1)));
  const from = q.from ? new Date(q.from) : start;
  if (from >= to) throw new HttpError(400, 'Période invalide');
  if (to.getTime() - from.getTime() > 367 * 86400_000) throw new HttpError(400, 'Période de 366 jours au maximum');
  res.json(await salesStats(uid(req), from.toISOString(), to.toISOString()));
});
