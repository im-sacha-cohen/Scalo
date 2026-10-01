// Payments: Stripe connection of the account, offers, orders and their lifecycle (paid → tag / campaign / `purchase`
// event / confirmation email / hooks; refunds; subscriptions). Every state change is a single database transaction,
// idempotent on the Stripe object that caused it, so webhooks can be replayed and the "return from Stripe" page and
// the webhook can both report the same payment.
import crypto from 'node:crypto';
import { sql } from 'kysely';
import {
  computeAmounts,
  DEFAULT_EMAIL_SETTINGS,
  flattenBlocks,
  formatMoney,
  installmentOptions,
  installmentPlan,
  planDetail,
  planLabel,
  priceLabel,
  STRIPE_WEBHOOK_EVENTS,
  uid as blockId,
  type Block,
  type Offer,
  type Order,
  type OrderItem,
  type OrderItemKind,
  type PageContent,
  type PaymentSettings,
  type PayOption,
  type SalesStats,
} from '@scalo/shared';
import { db, inTx, nowIso, type Db, type PaymentSettingsTable } from '../db';
import type { Selectable } from 'kysely';
import { HttpError, PUBLIC_URL } from '../util';
import { recordPurchase } from './contact-actions';
import { addTag, enrollInCampaign, removeTag, upsertContact } from './contacts';
import { getSettingsRow, renderEmail } from './email';
import { runOrderHooks, type OrderItemRow, type OrderRow } from './order-hooks';
import { decryptSecret, encryptSecret } from './secretbox';
import {
  idOf,
  keyHint,
  stripeFor,
  type StripeCheckoutSession,
  type StripeClient,
  type StripeEvent,
  type StripeInvoice,
  type StripePaymentIntent,
  type StripeSubscription,
} from './stripe';

export type { OrderItemRow, OrderRow };
export type PaymentSettingsRow = Selectable<PaymentSettingsTable>;

const KEY_PURPOSE = 'stripe:secret-key';
const WEBHOOK_PURPOSE = 'stripe:webhook-secret';

// ---------- Stripe connection ----------

/** Payment settings of an account, created (with the secret token of its webhook URL) on first access. */
export async function getPaymentSettingsRow(userId: number, ex: Db = db): Promise<PaymentSettingsRow> {
  const row = await ex.selectFrom('payment_settings').selectAll().where('user_id', '=', userId).executeTakeFirst();
  if (row) return row;
  await ex
    .insertInto('payment_settings')
    .values({ user_id: userId, webhook_token: crypto.randomBytes(24).toString('base64url') })
    .onConflict((oc) => oc.column('user_id').doNothing())
    .execute();
  return ex.selectFrom('payment_settings').selectAll().where('user_id', '=', userId).executeTakeFirstOrThrow();
}

export const stripeWebhookUrl = (token: string) => `${PUBLIC_URL}/api/payments/webhook/${token}`;

/** What the API returns: never a secret, only hints. */
export function publicPaymentSettings(r: PaymentSettingsRow): PaymentSettings {
  return {
    connected: !!r.stripe_secret_key,
    mode: r.stripe_secret_key ? r.mode : null,
    secret_key_hint: r.stripe_secret_key ? r.stripe_secret_hint : null,
    publishable_key: r.stripe_publishable_key,
    webhook_secret_set: !!r.stripe_webhook_secret,
    webhook_secret_hint: r.stripe_webhook_secret ? r.stripe_webhook_hint : null,
    webhook_url: stripeWebhookUrl(r.webhook_token),
    webhook_events: STRIPE_WEBHOOK_EVENTS,
    account_name: r.account_name,
    verified_at: r.verified_at,
    sepa_debit: r.sepa_debit,
  };
}

export const encryptStripeKey = (key: string) => ({ value: encryptSecret(key, KEY_PURPOSE), hint: keyHint(key) });
export const encryptWebhookSecret = (secret: string) => ({ value: encryptSecret(secret, WEBHOOK_PURPOSE), hint: keyHint(secret) });

const UNREADABLE = 'Les clés Stripe enregistrées ne peuvent plus être lues (clé de chiffrement modifiée) : saisissez-les à nouveau dans Paramètres → Paiements';

/** Stripe client of an account, or null when Stripe is not connected. Throws 409 when the stored key is unreadable. */
export function stripeOfRow(row: PaymentSettingsRow): StripeClient | null {
  if (!row.stripe_secret_key) return null;
  const key = decryptSecret(row.stripe_secret_key, KEY_PURPOSE);
  if (!key) throw new HttpError(409, UNREADABLE);
  return stripeFor(key);
}

export async function requireStripe(userId: number): Promise<{ client: StripeClient; row: PaymentSettingsRow }> {
  const row = await getPaymentSettingsRow(userId);
  const client = stripeOfRow(row);
  if (!client) throw new HttpError(409, 'Stripe n’est pas connecté : ajoutez vos clés dans Paramètres → Paiements');
  return { client, row };
}

export function webhookSecretOfRow(row: PaymentSettingsRow): string | null {
  return row.stripe_webhook_secret ? decryptSecret(row.stripe_webhook_secret, WEBHOOK_PURPOSE) : null;
}

// ---------- offers ----------

export interface Sellable {
  price_id: number;
  product_id: number;
  product_name: string;
  description: string;
  image_url: string | null;
  tag_id: number | null;
  campaign_id: number | null;
  revoke_on_refund: boolean;
  price_name: string;
  type: 'one_time' | 'subscription' | 'installments';
  amount: number;
  currency: string;
  interval: 'week' | 'month' | 'year' | null;
  interval_count: number;
  installments_min: number | null;
  installments_max: number | null;
  installment_fees: Record<string, number>;
  tax_rate: number;
  tax_inclusive: boolean;
}

/** Active offers of non-archived products of the account (all of them, or only `priceIds`). */
export async function loadSellables(userId: number, priceIds?: number[], ex: Db = db): Promise<Sellable[]> {
  if (priceIds && !priceIds.length) return [];
  let q = ex
    .selectFrom('product_prices as pp')
    .innerJoin('products as p', 'p.id', 'pp.product_id')
    .select([
      'pp.id as price_id', 'p.id as product_id', 'p.name as product_name', 'p.description', 'p.image_url', 'p.tag_id', 'p.campaign_id', 'p.revoke_on_refund',
      'pp.name as price_name', 'pp.type', 'pp.amount', 'pp.currency', 'pp.interval', 'pp.interval_count', 'pp.installments_min', 'pp.installments_max', 'pp.installment_fees', 'pp.tax_rate', 'pp.tax_inclusive',
    ])
    .where('pp.user_id', '=', userId)
    .where('p.user_id', '=', userId)
    .where('pp.active', '=', true)
    .where('p.archived', '=', false);
  if (priceIds) q = q.where('pp.id', 'in', priceIds);
  const rows = await q.orderBy('p.name').orderBy('pp.id').execute();
  return rows.map((r) => ({ ...r, tax_rate: Number(r.tax_rate) }));
}

export function toOffer(s: Sellable): Offer {
  const a = computeAmounts(s.amount, s.tax_rate, s.tax_inclusive);
  return {
    id: s.price_id,
    product_id: s.product_id,
    product_name: s.product_name,
    price_name: s.price_name,
    description: s.description,
    image_url: s.image_url,
    type: s.type,
    currency: s.currency as Offer['currency'],
    interval: s.interval,
    interval_count: s.interval_count,
    amount_total: a.total,
    amount_tax: a.tax,
    tax_rate: s.tax_rate,
    price_label: priceLabel(s, a.total),
    options: s.type === 'installments' ? installmentOptions(s) : [],
  };
}

/** Number of payments actually used for an installments offer: the buyer's choice when it is allowed, else the smallest. */
export function chosenInstallments(s: Sellable, wanted: unknown): number | null {
  if (s.type !== 'installments') return null;
  const min = s.installments_min ?? 2;
  const max = s.installments_max ?? min;
  const n = Number(wanted);
  return Number.isInteger(n) && n >= min && n <= max ? n : min;
}

// ---------- public pages ----------

/** Messages shown in the payment blocks (after a redirect: `?pay=<code>`; JSON answers of the order form). */
export const PAY_NOTICES: Record<string, string> = {
  cancel: 'Paiement annulé : vous n’avez pas été débité. Vous pouvez réessayer.',
  error: 'Le paiement n’a pas pu être lancé. Merci de réessayer dans un instant.',
  email: 'Adresse email invalide. Merci de vérifier et de réessayer.',
  unavailable: 'Cette offre n’est pas disponible pour le moment.',
  expired: 'Cette offre n’est plus disponible.',
  preview: 'Le paiement est désactivé en mode aperçu : ouvrez la page publique pour tester.',
  limit: 'Trop de tentatives. Réessayez dans quelques minutes.',
  failed: 'Le paiement n’a pas abouti. Vous pouvez réessayer avec un autre moyen de paiement.',
};

/** What the renderer shows for an offer: name, price and — installments — the plans the buyer chooses from. */
export interface ShownOffer {
  name: string;
  price: string;
  description?: string;
  options?: PayOption[];
}

export function shownOffer(s: Sellable): ShownOffer {
  const o = toOffer(s);
  return {
    name: itemLabel(s),
    price: o.price_label,
    description: s.description,
    ...(o.options.length
      ? {
          options: o.options.map((p) => ({
            count: p.count,
            label: p.count === 1 ? 'En une fois' : `En ${p.count} fois`,
            price: planLabel(p, s.currency, s.interval, s.interval_count),
            detail: p.count === 1 ? '' : planDetail(p, s.currency, s.interval, s.interval_count),
          })),
        }
      : {}),
  };
}

/**
 * What the renderer needs for the payment blocks of a page (none → `{}`): form targets, the offers referenced by the
 * blocks with their current name and price (an unknown / inactive offer renders as « offre indisponible »), and the
 * Stripe publishable key the order forms pay with (Stripe Elements, on the page itself).
 */
export async function paymentRenderContext(userId: number, content: PageContent, stepUrl: string, qs: string, payCode: unknown) {
  const blocks = flattenBlocks(content?.blocks ?? []).filter((b) => b.type === 'checkout' || b.type === 'upsell');
  if (!blocks.length) return {};
  const ids = new Set<number>();
  for (const b of blocks) {
    if (b.type !== 'checkout' && b.type !== 'upsell') continue;
    for (const id of [b.offerId, b.type === 'checkout' ? b.bumpOfferId : undefined]) if (Number.isSafeInteger(id) && Number(id) > 0) ids.add(Number(id));
  }
  const offers: Record<number, ShownOffer> = {};
  for (const s of await loadSellables(userId, [...ids])) offers[s.price_id] = shownOffer(s);
  const code = typeof payCode === 'string' ? payCode : '';
  const settings = await db.selectFrom('payment_settings').select(['stripe_publishable_key', 'stripe_secret_key']).where('user_id', '=', userId).executeTakeFirst();
  return {
    checkoutAction: `${stepUrl}/checkout${qs}`,
    upsellAction: `${stepUrl}/upsell${qs}`,
    offers,
    payNotice: PAY_NOTICES[code],
    stripeKey: settings?.stripe_secret_key ? settings.stripe_publishable_key ?? undefined : undefined,
  };
}

// ---------- orders ----------

export interface NewOrder {
  userId: number;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  funnelId?: number | null;
  stepId?: number | null;
  variantId?: number | null;
  parentOrderId?: number | null;
  kind: 'checkout' | 'upsell';
  livemode: boolean;
  /** `installments`: number of payments chosen by the buyer for an installments offer (see `chosenInstallments`). */
  lines: { sellable: Sellable; kind: OrderItemKind; installments?: number | null }[];
  attribution?: Record<string, string> | null;
  visitor?: Record<string, unknown>;
  /** Known Stripe customer / saved card (upsells reuse the ones of the parent order). */
  customerId?: string | null;
  paymentMethodId?: string | null;
}

const cleanName = (v: string | null | undefined) => v?.trim().slice(0, 200) || null;

/** Order line of an offer: an installments offer paid in one go becomes a one-time line (at the price for 1 payment). */
function lineOf(s: Sellable, wanted: number | null | undefined) {
  const count = chosenInstallments(s, wanted);
  if (count === null) return { type: s.type, installments: null, installment_amount: null, amounts: computeAmounts(s.amount, s.tax_rate, s.tax_inclusive) };
  const plan = installmentPlan(s, count);
  return {
    type: count === 1 ? ('one_time' as const) : ('installments' as const),
    installments: count === 1 ? null : count,
    installment_amount: count === 1 ? null : plan.each,
    amounts: { subtotal: plan.subtotal, tax: plan.tax, total: plan.total },
  };
}

/** Creates a pending order. Amounts always come from the offers stored in the database, never from the request. */
export function createOrder(o: NewOrder, ex: Db = db): Promise<{ order: OrderRow; items: OrderItemRow[] }> {
  return inTx(ex, async (trx) => {
    if (!o.lines.length) throw new Error('Commande sans ligne');
    const currency = o.lines[0].sellable.currency;
    const lines = o.lines.filter((l) => l.sellable.currency === currency).map((l) => ({ ...l, ...lineOf(l.sellable, l.installments) }));
    const sum = (k: 'subtotal' | 'tax' | 'total') => lines.reduce((n, l) => n + l.amounts[k], 0);
    const now = nowIso();
    const order = await trx
      .insertInto('orders')
      .values({
        user_id: o.userId,
        email: o.email.trim().toLowerCase(),
        first_name: cleanName(o.first_name),
        last_name: cleanName(o.last_name),
        funnel_id: o.funnelId ?? null,
        step_id: o.stepId ?? null,
        variant_id: o.variantId ?? null,
        parent_order_id: o.parentOrderId ?? null,
        kind: o.kind,
        livemode: o.livemode,
        currency,
        amount_subtotal: sum('subtotal'),
        amount_tax: sum('tax'),
        amount_total: sum('total'),
        stripe_customer_id: o.customerId ?? null,
        stripe_payment_method_id: o.paymentMethodId ?? null,
        attribution: o.attribution && Object.keys(o.attribution).length ? JSON.stringify(o.attribution) : null,
        visitor: JSON.stringify(o.visitor ?? {}),
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const items = await trx
      .insertInto('order_items')
      .values(
        lines.map((l) => ({
          order_id: order.id,
          product_id: l.sellable.product_id,
          price_id: l.sellable.price_id,
          kind: l.kind,
          product_name: l.sellable.product_name,
          price_name: l.sellable.price_name,
          type: l.type,
          interval: l.type === 'one_time' ? null : l.sellable.interval,
          interval_count: l.type === 'one_time' ? 1 : l.sellable.interval_count,
          installments: l.installments,
          installment_amount: l.installment_amount,
          tax_rate: l.sellable.tax_rate,
          tax_inclusive: l.sellable.tax_inclusive,
          amount_subtotal: l.amounts.subtotal,
          amount_tax: l.amounts.tax,
          amount_total: l.amounts.total,
          tag_id: l.sellable.tag_id,
          campaign_id: l.sellable.campaign_id,
          revoke_on_refund: l.sellable.revoke_on_refund,
        })),
      )
      .returningAll()
      .execute();
    return { order, items };
  });
}

const lockOrder = (trx: Db, userId: number, orderId: number) =>
  trx.selectFrom('orders').selectAll().where('id', '=', orderId).where('user_id', '=', userId).forUpdate().executeTakeFirst();
const itemsOf = (ex: Db, orderId: number) => ex.selectFrom('order_items').selectAll().where('order_id', '=', orderId).orderBy('id').execute();
const reload = (trx: Db, orderId: number) => trx.selectFrom('orders').selectAll().where('id', '=', orderId).executeTakeFirstOrThrow();

export interface PaidInfo {
  /** Minor units actually collected. */
  amount: number;
  /** Stripe object that proves the payment: invoice id (subscriptions) or payment intent id. Idempotency key. */
  transactionKey: string;
  paymentIntentId?: string | null;
  customerId?: string | null;
  paymentMethodId?: string | null;
  subscriptionId?: string | null;
}

/**
 * Marks an order as paid (idempotent): contact created / updated, order linked to it, payment recorded, then for each
 * line the product's tag (→ course access, tag-triggered campaigns), its campaign, a `purchase` event (→ "Achat"
 * automations, « a acheté » segment condition), the confirmation email, and the `paid` hooks.
 * An order already paid only gets its missing Stripe ids filled in.
 */
export function markOrderPaid(userId: number, orderId: number, info: PaidInfo, ex: Db = db): Promise<{ order: OrderRow; newlyPaid: boolean } | null> {
  return inTx(ex, async (trx) => {
    const cur = await lockOrder(trx, userId, orderId);
    if (!cur) return null;
    const ids = {
      stripe_payment_intent_id: cur.stripe_payment_intent_id ?? info.paymentIntentId ?? null,
      stripe_customer_id: cur.stripe_customer_id ?? info.customerId ?? null,
      stripe_payment_method_id: info.paymentMethodId ?? cur.stripe_payment_method_id ?? null,
      stripe_subscription_id: cur.stripe_subscription_id ?? info.subscriptionId ?? null,
    };
    if (cur.status === 'paid' || cur.status === 'refunded') {
      await trx.updateTable('orders').set(ids).where('id', '=', cur.id).execute();
      return { order: await reload(trx, cur.id), newlyPaid: false };
    }
    const items = await itemsOf(trx, cur.id);
    const now = nowIso();
    const { contact } = await upsertContact(userId, { email: cur.email, first_name: cur.first_name, last_name: cur.last_name }, { overwrite: false }, trx);
    const tx = await trx
      .insertInto('order_transactions')
      .values({ user_id: userId, order_id: cur.id, type: 'payment', amount: info.amount, currency: cur.currency, stripe_id: info.transactionKey, stripe_payment_intent_id: info.paymentIntentId ?? null, created_at: now })
      .onConflict((oc) => oc.columns(['user_id', 'stripe_id']).doNothing())
      .returning('id')
      .executeTakeFirst();
    await trx
      .updateTable('orders')
      .set({
        ...ids,
        status: 'paid',
        paid_at: now,
        updated_at: now,
        contact_id: contact.id,
        failure_message: null,
        amount_paid: sql`amount_paid + ${tx ? info.amount : 0}`,
        subscription_status: items.some((i) => i.type !== 'one_time') ? 'active' : null,
      })
      .where('id', '=', cur.id)
      .execute();
    // first-touch attribution of a buyer who never opted in ({} = direct visit); never overwritten
    await trx.updateTable('contacts').set({ source: JSON.stringify(cur.attribution ?? {}) }).where('id', '=', contact.id).where('source', 'is', null).execute();

    for (const it of items) {
      if (it.tag_id) {
        const tag = await trx.selectFrom('tags').select(['id', 'name']).where('id', '=', it.tag_id).where('user_id', '=', userId).executeTakeFirst();
        if (tag) await addTag(userId, contact.id, tag, undefined, trx);
      }
      if (it.campaign_id) await enrollInCampaign(userId, it.campaign_id, contact.id, undefined, trx); // ownership checked inside
      const purchase = await recordPurchase(
        userId,
        contact.id,
        { product: it.product_name, amount: it.amount_total / 100, currency: cur.currency, external_id: `order:${cur.id}:${it.id}` },
        'stripe',
        trx,
      );
      if (purchase.created && (cur.funnel_id || cur.step_id)) {
        await trx.updateTable('contact_events').set({ funnel_id: cur.funnel_id, step_id: cur.step_id }).where('id', '=', purchase.id).execute();
      }
    }
    const order = await reload(trx, cur.id);
    await queueOrderEmail(trx, order, items, contact);
    await runOrderHooks({ event: 'paid', order, items, amount: info.amount }, trx);
    return { order, newlyPaid: true };
  });
}

/** Payment refused / abandoned. Only a pending (or already failed) order changes: a paid order never goes back. */
export async function markOrderUnpaid(userId: number, orderId: number, status: 'failed' | 'canceled', message: string | null, ex: Db = db): Promise<boolean> {
  const r = await ex
    .updateTable('orders')
    .set({ status, failure_message: message?.slice(0, 500) ?? null, updated_at: nowIso() })
    .where('id', '=', orderId)
    .where('user_id', '=', userId)
    .where('status', 'in', ['pending', 'failed'])
    .executeTakeFirst();
  return Number(r.numUpdatedRows) > 0;
}

/** Does the contact still own `tagId` through another paid order (not refunded, subscription not ended)? */
async function stillEntitled(trx: Db, contactId: number, tagId: number, exceptOrderId: number): Promise<boolean> {
  const other = await trx
    .selectFrom('order_items as i')
    .innerJoin('orders as o', 'o.id', 'i.order_id')
    .select('i.id')
    .where('o.contact_id', '=', contactId)
    .where('o.id', '!=', exceptOrderId)
    .where('o.status', '=', 'paid')
    .where('i.tag_id', '=', tagId)
    .where((eb) => eb.or([eb('i.type', '=', 'one_time'), eb('o.subscription_status', 'in', ['active', 'past_due', 'completed'])]))
    .limit(1)
    .executeTakeFirst();
  return !!other;
}

/** Removes the tags given by the order (`force`: even when the product says to keep them), unless another order still grants them. */
async function revokeTags(trx: Db, order: OrderRow, items: OrderItemRow[], force: boolean | undefined, only?: (i: OrderItemRow) => boolean) {
  if (!order.contact_id || force === false) return;
  for (const it of items) {
    if (!it.tag_id || (only && !only(it))) continue;
    if (!force && !it.revoke_on_refund) continue;
    if (await stillEntitled(trx, order.contact_id, it.tag_id, order.id)) continue;
    await removeTag(order.user_id, order.contact_id, it.tag_id, trx);
  }
}

/**
 * Records money given back for a payment (idempotent: `cumulative` is the total refunded so far for that payment
 * intent, as reported by Stripe). Fully refunded → status `refunded`, and the tags of the order are removed when the
 * product says so (`revoke`: true / false forces the choice). Fires the `refunded` hooks with the delta.
 */
export function applyRefund(userId: number, paymentIntentId: string, cumulative: number, opts: { revoke?: boolean } = {}, ex: Db = db): Promise<OrderRow | null> {
  return inTx(ex, async (trx) => {
    const found =
      (await trx.selectFrom('order_transactions').select('order_id').where('user_id', '=', userId).where('type', '=', 'payment').where('stripe_payment_intent_id', '=', paymentIntentId).executeTakeFirst())?.order_id ??
      (await trx.selectFrom('orders').select('id').where('user_id', '=', userId).where('stripe_payment_intent_id', '=', paymentIntentId).executeTakeFirst())?.id;
    if (!found) return null;
    const cur = await lockOrder(trx, userId, found);
    if (!cur) return null;
    const now = nowIso();
    await trx
      .insertInto('order_transactions')
      .values({ user_id: userId, order_id: cur.id, type: 'refund', amount: cumulative, currency: cur.currency, stripe_id: `refund:${paymentIntentId}`, stripe_payment_intent_id: paymentIntentId, created_at: now })
      .onConflict((oc) => oc.columns(['user_id', 'stripe_id']).doUpdateSet({ amount: sql`GREATEST(order_transactions.amount, excluded.amount)` }))
      .execute();
    const { total } = await trx
      .selectFrom('order_transactions')
      .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('amount'), eb.val(0)).as('total'))
      .where('order_id', '=', cur.id)
      .where('type', '=', 'refund')
      .executeTakeFirstOrThrow();
    const refunded = Number(total);
    const delta = refunded - cur.amount_refunded;
    if (delta <= 0) return cur;
    const full = refunded >= cur.amount_paid;
    await trx
      .updateTable('orders')
      .set({ amount_refunded: refunded, updated_at: now, ...(full ? { status: 'refunded' as const, refunded_at: now } : {}) })
      .where('id', '=', cur.id)
      .execute();
    const order = await reload(trx, cur.id);
    const items = await itemsOf(trx, cur.id);
    if (full) await revokeTags(trx, order, items, opts.revoke);
    await runOrderHooks({ event: 'refunded', order, items, amount: delta, full }, trx);
    return order;
  });
}

const paymentsCount = async (trx: Db, orderId: number) =>
  Number((await trx.selectFrom('order_transactions').select((eb) => eb.fn.countAll<number>().as('n')).where('order_id', '=', orderId).where('type', '=', 'payment').executeTakeFirstOrThrow()).n);

const installmentsOf = (items: OrderItemRow[]) => items.find((i) => i.type === 'installments')?.installments ?? null;

async function orderOfSubscription(trx: Db, userId: number, subscriptionId: string | null | undefined, metadataOrderId?: unknown) {
  if (subscriptionId) {
    const o = await trx.selectFrom('orders').select('id').where('user_id', '=', userId).where('stripe_subscription_id', '=', subscriptionId).executeTakeFirst();
    if (o) return o.id;
  }
  const id = Number(metadataOrderId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * A subscription invoice was paid. First invoice of a pending order → the order becomes paid; later invoices are
 * recorded as payments (`subscription_payment` hooks). Returns the subscription to cancel when the last installment
 * has just been paid (the caller cancels it at Stripe once the transaction is committed).
 */
export function recordInvoicePaid(userId: number, inv: StripeInvoice, ex: Db = db, paymentMethodId?: string | null): Promise<{ orderId: number; cancelSubscription: string | null } | null> {
  return inTx(ex, async (trx) => {
    if (!inv.subscription) return null;
    const orderId = await orderOfSubscription(trx, userId, inv.subscription, inv.subscription_details?.metadata?.order_id ?? inv.lines?.data?.[0]?.metadata?.order_id);
    if (!orderId) return null;
    const cur = await lockOrder(trx, userId, orderId);
    if (!cur) return null;
    const items = await itemsOf(trx, cur.id);
    if (!items.some((i) => i.type !== 'one_time')) return null;
    if (cur.status !== 'paid' && cur.status !== 'refunded') {
      await markOrderPaid(userId, cur.id, { amount: inv.amount_paid, transactionKey: inv.id, paymentIntentId: inv.payment_intent, customerId: inv.customer, subscriptionId: inv.subscription, paymentMethodId }, trx);
    } else {
      const now = nowIso();
      const tx = await trx
        .insertInto('order_transactions')
        .values({ user_id: userId, order_id: cur.id, type: 'payment', amount: inv.amount_paid, currency: cur.currency, stripe_id: inv.id, stripe_payment_intent_id: inv.payment_intent ?? null, created_at: now })
        .onConflict((oc) => oc.columns(['user_id', 'stripe_id']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (tx) {
        await trx
          .updateTable('orders')
          .set({
            amount_paid: sql`amount_paid + ${inv.amount_paid}`,
            updated_at: now,
            stripe_subscription_id: cur.stripe_subscription_id ?? inv.subscription,
            ...(cur.subscription_status === 'past_due' ? { subscription_status: 'active' as const } : {}),
          })
          .where('id', '=', cur.id)
          .execute();
        await runOrderHooks({ event: 'subscription_payment', order: await reload(trx, cur.id), items, amount: inv.amount_paid }, trx);
      }
    }
    const planned = installmentsOf(items);
    const done = planned !== null && cur.subscription_status !== 'completed' && cur.subscription_status !== 'canceled' && (await paymentsCount(trx, cur.id)) >= planned;
    return { orderId: cur.id, cancelSubscription: done ? inv.subscription : null };
  });
}

/** Every installment is paid and the Stripe subscription has been cancelled: the buyer keeps the product. */
export async function completeInstallments(userId: number, orderId: number, ex: Db = db) {
  await ex
    .updateTable('orders')
    .set({ subscription_status: 'completed', updated_at: nowIso() })
    .where('id', '=', orderId)
    .where('user_id', '=', userId)
    .where('subscription_status', 'in', ['active', 'past_due'])
    .execute();
}

/**
 * The subscription ended at Stripe. Installments all paid → `completed` (access kept). Otherwise `canceled`: the tags of
 * the recurring lines are removed (same rule as refunds) and the `subscription_canceled` hooks run.
 */
export function endSubscription(userId: number, subscriptionId: string, metadataOrderId?: unknown, opts: { revoke?: boolean } = {}, ex: Db = db): Promise<OrderRow | null> {
  return inTx(ex, async (trx) => {
    const orderId = await orderOfSubscription(trx, userId, subscriptionId, metadataOrderId);
    const cur = orderId ? await lockOrder(trx, userId, orderId) : undefined;
    if (!cur || cur.subscription_status === 'canceled' || cur.subscription_status === 'completed') return cur ?? null;
    if (cur.status !== 'paid' && cur.status !== 'refunded') {
      // never paid: nothing was granted. The first payment of its current subscription was abandoned → the order is too
      if (cur.stripe_subscription_id === subscriptionId) await markOrderUnpaid(userId, cur.id, 'canceled', 'Paiement abandonné', trx);
      return cur;
    }
    const items = await itemsOf(trx, cur.id);
    const planned = installmentsOf(items);
    const completed = planned !== null && (await paymentsCount(trx, cur.id)) >= planned;
    await trx
      .updateTable('orders')
      .set({ subscription_status: completed ? 'completed' : 'canceled', stripe_subscription_id: cur.stripe_subscription_id ?? subscriptionId, updated_at: nowIso() })
      .where('id', '=', cur.id)
      .execute();
    const order = await reload(trx, cur.id);
    if (!completed) {
      await revokeTags(trx, order, items, opts.revoke, (i) => i.type !== 'one_time');
      await runOrderHooks({ event: 'subscription_canceled', order, items, amount: 0 }, trx);
    }
    return order;
  });
}

export async function setSubscriptionState(userId: number, subscriptionId: string, state: 'active' | 'past_due', ex: Db = db) {
  await ex
    .updateTable('orders')
    .set({ subscription_status: state, updated_at: nowIso() })
    .where('user_id', '=', userId)
    .where('stripe_subscription_id', '=', subscriptionId)
    .where('subscription_status', 'in', ['active', 'past_due'])
    .execute();
}

// ---------- from Stripe objects ----------

export function paidInfoOfSession(s: StripeCheckoutSession, fallbackAmount: number): PaidInfo {
  const pi = typeof s.payment_intent === 'object' ? s.payment_intent : null;
  const sub = typeof s.subscription === 'object' ? s.subscription : null;
  const inv = typeof s.invoice === 'object' ? s.invoice : null;
  const paymentIntentId = idOf(s.payment_intent) ?? inv?.payment_intent ?? null;
  return {
    amount: s.amount_total ?? fallbackAmount,
    transactionKey: idOf(s.invoice) ?? paymentIntentId ?? s.id,
    paymentIntentId,
    customerId: s.customer,
    paymentMethodId: pi?.payment_method ?? sub?.default_payment_method ?? null,
    subscriptionId: idOf(s.subscription),
  };
}

export const paidInfoOfIntent = (pi: StripePaymentIntent): PaidInfo => ({
  amount: pi.amount_received || pi.amount,
  transactionKey: pi.id,
  paymentIntentId: pi.id,
  customerId: pi.customer ?? null,
  paymentMethodId: pi.payment_method ?? null,
});

const sessionPaid = (s: StripeCheckoutSession) => s.payment_status === 'paid' || s.payment_status === 'no_payment_required';

/** Applies a (retrieved, expanded) Checkout session to its order. */
export async function applySession(userId: number, s: StripeCheckoutSession, ex: Db = db): Promise<OrderRow | null> {
  const o = await ex.selectFrom('orders').select(['id', 'amount_total']).where('user_id', '=', userId).where('stripe_session_id', '=', s.id).executeTakeFirst();
  if (!o) return null;
  if (s.status === 'complete' && sessionPaid(s)) return (await markOrderPaid(userId, o.id, paidInfoOfSession(s, o.amount_total), ex))?.order ?? null;
  if (s.status === 'expired') await markOrderUnpaid(userId, o.id, 'canceled', 'Paiement abandonné', ex);
  return (await ex.selectFrom('orders').selectAll().where('id', '=', o.id).executeTakeFirst()) ?? null;
}

const metaOrderId = (m: Record<string, string> | undefined | null) => {
  const n = Number(m?.order_id);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/**
 * Applies a verified Stripe webhook event, exactly once: the event id is recorded in the same transaction as its
 * effects, so a replay is acknowledged (`duplicate`) without being applied again and a failure leaves no trace (Stripe
 * retries). Stripe is only called before (session retrieval) and after (end of an installment plan) the transaction.
 */
export async function handleStripeEvent(userId: number, ev: StripeEvent, client: StripeClient): Promise<'processed' | 'duplicate' | 'ignored'> {
  if (!STRIPE_WEBHOOK_EVENTS.includes(ev.type)) return 'ignored';
  if (await db.selectFrom('stripe_events').select('event_id').where('user_id', '=', userId).where('event_id', '=', ev.id).executeTakeFirst()) return 'duplicate';
  const obj = ev.data.object;
  // the payload of a session event is not expanded (and may be stale): ask Stripe for the current session
  const session =
    ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded'
      ? await client.retrieveCheckoutSession(String(obj.id))
      : null;
  let after: { orderId: number; cancelSubscription: string | null } | null = null;

  const fresh = await db.transaction().execute(async (trx) => {
    const ins = await trx
      .insertInto('stripe_events')
      .values({ user_id: userId, event_id: ev.id, type: ev.type, created_at: nowIso() })
      .onConflict((oc) => oc.columns(['user_id', 'event_id']).doNothing())
      .returning('event_id')
      .executeTakeFirst();
    if (!ins) return false; // concurrent delivery of the same event
    switch (ev.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        await applySession(userId, session!, trx);
        break;
      case 'checkout.session.async_payment_failed':
      case 'checkout.session.expired': {
        const o = await trx.selectFrom('orders').select('id').where('user_id', '=', userId).where('stripe_session_id', '=', String(obj.id)).executeTakeFirst();
        if (o) await markOrderUnpaid(userId, o.id, ev.type.endsWith('expired') ? 'canceled' : 'failed', ev.type.endsWith('expired') ? 'Paiement abandonné' : 'Paiement refusé', trx);
        break;
      }
      case 'payment_intent.succeeded': {
        const pi = obj as unknown as StripePaymentIntent;
        const id = metaOrderId(pi.metadata);
        if (id) await markOrderPaid(userId, id, paidInfoOfIntent(pi), trx);
        break;
      }
      case 'payment_intent.payment_failed': {
        const pi = obj as unknown as StripePaymentIntent;
        const id = metaOrderId(pi.metadata);
        if (id) await markOrderUnpaid(userId, id, 'failed', pi.last_payment_error?.message ?? 'Paiement refusé', trx);
        break;
      }
      case 'charge.refunded': {
        const pi = typeof obj.payment_intent === 'string' ? obj.payment_intent : null;
        if (pi) await applyRefund(userId, pi, Number(obj.amount_refunded) || 0, {}, trx);
        break;
      }
      case 'invoice.paid':
        after = await recordInvoicePaid(userId, obj as unknown as StripeInvoice, trx);
        break;
      case 'invoice.payment_failed': {
        const sub = typeof obj.subscription === 'string' ? obj.subscription : null;
        if (sub) await setSubscriptionState(userId, sub, 'past_due', trx);
        break;
      }
      case 'customer.subscription.updated': {
        const sub = obj as unknown as StripeSubscription;
        if (sub.status === 'active' || sub.status === 'past_due') await setSubscriptionState(userId, sub.id, sub.status, trx);
        else if (sub.status === 'canceled' || sub.status === 'unpaid' || sub.status === 'incomplete_expired') await endSubscription(userId, sub.id, sub.metadata?.order_id, {}, trx);
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = obj as unknown as StripeSubscription;
        await endSubscription(userId, sub.id, sub.metadata?.order_id, {}, trx);
        break;
      }
    }
    return true;
  });
  if (!fresh) return 'duplicate';

  const done = after as { orderId: number; cancelSubscription: string | null } | null;
  if (done?.cancelSubscription) {
    try {
      await client.cancelSubscription(done.cancelSubscription);
      await completeInstallments(userId, done.orderId);
    } catch (e) {
      // the buyer must not be charged again: forget the event so that Stripe's retry ends the plan
      await db.deleteFrom('stripe_events').where('user_id', '=', userId).where('event_id', '=', ev.id).execute();
      throw e;
    }
  }
  return 'processed';
}

// ---------- confirmation email ----------

export const itemLabel = (i: Pick<OrderItemRow, 'product_name' | 'price_name'>) => (i.price_name ? `${i.product_name} — ${i.price_name}` : i.product_name);

/** Queues the order confirmation (kind `order`: pre-rendered, sent like a transactional email by the worker). */
async function queueOrderEmail(trx: Db, order: OrderRow, items: OrderItemRow[], contact: { id: number; email: string; first_name: string | null; bounced: boolean }) {
  if (contact.bounced) return;
  const settings = await getSettingsRow(order.user_id, trx);
  const subject = `Confirmation de votre commande n° ${order.id}`;
  const hello = contact.first_name ? `Bonjour ${contact.first_name},` : 'Bonjour,';
  const text = (t: string, style?: Record<string, unknown>): Block => ({ id: blockId(), type: 'text', text: t, ...(style ? { style } : {}) }) as Block;
  const blocks: Block[] = [
    { id: blockId(), type: 'heading', level: 2, text: 'Merci pour votre commande !' } as Block,
    text(`${hello}\nNous avons bien reçu votre paiement. Voici le récapitulatif de votre commande n° ${order.id} :`),
    {
      id: blockId(),
      type: 'list',
      icon: 'check',
      items: items.map((i) => `${itemLabel(i)} : ${priceLabel({ ...i, interval: i.interval as OrderItem['interval'], currency: order.currency }, i.amount_total)}`),
    } as Block,
    text(`**Montant payé : ${formatMoney(order.amount_paid || order.amount_total, order.currency)}**${order.amount_tax ? ` (dont TVA ${formatMoney(order.amount_tax, order.currency)})` : ''}`),
    text('Conservez cet email : il fait office de confirmation de commande. Pour toute question, répondez simplement à ce message.', { color: '#64748b', fontSize: 13 }),
  ];
  const content: PageContent = { settings: { ...DEFAULT_EMAIL_SETTINGS }, blocks };
  const addr = settings.company_address.trim();
  const footer = [settings.sender_name, addr].filter(Boolean).map((l) => l.replace(/[<>&]/g, '')).join('<br>').replace(/\n/g, '<br>');
  const html = renderEmail(content, subject, {}, footer);
  const now = nowIso();
  await trx
    .insertInto('email_sends')
    .values({ user_id: order.user_id, contact_id: contact.id, kind: 'order', to_email: contact.email, subject, html, status: 'pending', send_at: now, created_at: now })
    .execute();
}

// ---------- API shapes ----------

export const toOrderItem = (i: OrderItemRow): OrderItem => ({
  id: i.id,
  product_id: i.product_id,
  price_id: i.price_id,
  kind: i.kind,
  product_name: i.product_name,
  price_name: i.price_name,
  type: i.type,
  interval: i.interval as OrderItem['interval'],
  interval_count: i.interval_count,
  installments: i.installments,
  installment_amount: i.installment_amount,
  tax_rate: Number(i.tax_rate),
  tax_inclusive: i.tax_inclusive,
  amount_subtotal: i.amount_subtotal,
  amount_tax: i.amount_tax,
  amount_total: i.amount_total,
  tag_id: i.tag_id,
  campaign_id: i.campaign_id,
  revoke_on_refund: i.revoke_on_refund,
});

/** Never exposes Stripe ids nor the visitor context (internal). */
export const toOrder = (o: OrderRow, items: OrderItemRow[]): Order => ({
  id: o.id,
  kind: o.kind,
  status: o.status,
  subscription_status: o.subscription_status,
  livemode: o.livemode,
  email: o.email,
  first_name: o.first_name,
  last_name: o.last_name,
  contact_id: o.contact_id,
  funnel_id: o.funnel_id,
  step_id: o.step_id,
  parent_order_id: o.parent_order_id,
  currency: o.currency,
  amount_subtotal: o.amount_subtotal,
  amount_tax: o.amount_tax,
  amount_total: o.amount_total,
  amount_paid: o.amount_paid,
  amount_refunded: o.amount_refunded,
  attribution: o.attribution,
  failure_message: o.failure_message,
  paid_at: o.paid_at,
  refunded_at: o.refunded_at,
  created_at: o.created_at,
  items: items.map(toOrderItem),
  has_subscription: !!o.stripe_subscription_id,
});

export async function toOrders(rows: OrderRow[], ex: Db = db): Promise<Order[]> {
  if (!rows.length) return [];
  const items = await ex.selectFrom('order_items').selectAll().where('order_id', 'in', rows.map((r) => r.id)).orderBy('id').execute();
  const funnelIds = [...new Set(rows.map((r) => r.funnel_id).filter((x): x is number => !!x))];
  const stepIds = [...new Set(rows.map((r) => r.step_id).filter((x): x is number => !!x))];
  const funnels = funnelIds.length ? await ex.selectFrom('funnels').select(['id', 'name']).where('id', 'in', funnelIds).execute() : [];
  const steps = stepIds.length ? await ex.selectFrom('steps').select(['id', 'name']).where('id', 'in', stepIds).execute() : [];
  return rows.map((r) => ({
    ...toOrder(r, items.filter((i) => i.order_id === r.id)),
    funnel_name: funnels.find((f) => f.id === r.funnel_id)?.name ?? null,
    step_name: steps.find((s) => s.id === r.step_id)?.name ?? null,
  }));
}

// ---------- revenue ----------

/** Revenue (payments − refunds, by transaction date) between two ISO dates, per currency; daily series in the main one. */
export async function salesStats(userId: number, from: string, to: string): Promise<SalesStats> {
  const { rows: totals } = await sql<{ currency: string; revenue: number; refunds: number; orders: number }>`
    SELECT t.currency,
           COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'payment'), 0) AS revenue,
           COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'refund'), 0) AS refunds,
           (SELECT COUNT(*) FROM orders o WHERE o.user_id = ${userId} AND o.currency = t.currency AND o.paid_at >= ${from} AND o.paid_at < ${to}) AS orders
      FROM order_transactions t
     WHERE t.user_id = ${userId} AND t.created_at >= ${from} AND t.created_at < ${to}
     GROUP BY t.currency
     ORDER BY 2 DESC`.execute(db);
  const main = totals[0]?.currency ?? 'eur';
  const { rows: daily } = await sql<{ date: string; revenue: number; orders: number }>`
    WITH days AS (
      SELECT d::date AS day FROM generate_series((${from}::timestamptz AT TIME ZONE 'UTC')::date, ((${to}::timestamptz - interval '1 second') AT TIME ZONE 'UTC')::date, interval '1 day') AS d
    ),
    t AS (SELECT (created_at AT TIME ZONE 'UTC')::date AS day, SUM(CASE WHEN type = 'payment' THEN amount ELSE -amount END) AS n
            FROM order_transactions WHERE user_id = ${userId} AND currency = ${main} AND created_at >= ${from} AND created_at < ${to} GROUP BY 1),
    o AS (SELECT (paid_at AT TIME ZONE 'UTC')::date AS day, COUNT(*) AS n
            FROM orders WHERE user_id = ${userId} AND currency = ${main} AND paid_at >= ${from} AND paid_at < ${to} GROUP BY 1)
    SELECT to_char(days.day, 'YYYY-MM-DD') AS date, COALESCE(t.n, 0) AS revenue, COALESCE(o.n, 0) AS orders
      FROM days LEFT JOIN t ON t.day = days.day LEFT JOIN o ON o.day = days.day
     ORDER BY days.day`.execute(db);
  const { rows: counts } = await sql<{ pending: number; subs: number }>`
    SELECT COUNT(*) FILTER (WHERE status = 'pending' AND created_at >= now() - interval '1 day') AS pending,
           COUNT(*) FILTER (WHERE status = 'paid' AND subscription_status IN ('active', 'past_due')) AS subs
      FROM orders WHERE user_id = ${userId}`.execute(db);
  return {
    from,
    to,
    totals: totals.map((t) => {
      const revenue = Number(t.revenue);
      const refunds = Number(t.refunds);
      const orders = Number(t.orders);
      return { currency: t.currency, revenue, refunds, net: revenue - refunds, orders, average: orders ? Math.round(revenue / orders) : 0 };
    }),
    daily: daily.map((d) => ({ date: d.date, revenue: Number(d.revenue), orders: Number(d.orders) })),
    pending: Number(counts[0]?.pending ?? 0),
    active_subscriptions: Number(counts[0]?.subs ?? 0),
  };
}
