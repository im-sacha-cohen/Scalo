// Payments on the funnel's own pages (Stripe Elements). The order is created first (amounts from the database), then
// Stripe is asked for what the buyer's browser confirms in Stripe Elements:
//   - only one-time lines → a payment intent of the whole amount;
//   - a subscription or an installment plan → a Stripe subscription whose first invoice waits for the buyer
//     (`default_incomplete`): the recurring line, plus the one-time lines (order bump) and the rounding cents of the
//     first installment as one-off invoice items.
// The payment method is saved on the Stripe customer for the one-click offers of the next steps. Every Stripe object is
// created with an idempotency key derived from the order, and an order that already has one reuses it (a reload or a
// second click never creates a second payment). The webhook and the return page (`syncPayment`) both apply the result.
import { db, nowIso, type Db } from '../db';
import { signId, verifySignedId } from '../util';
import {
  completeInstallments,
  getPaymentSettingsRow,
  stripeOfRow,
  itemLabel,
  markOrderPaid,
  paidInfoOfIntent,
  recordInvoicePaid,
  type OrderItemRow,
  type OrderRow,
  type PaymentSettingsRow,
} from './payments';
import { idOf, StripeError, type StripeClient, type StripeInvoice, type StripePaymentIntent, type StripeSubscription } from './stripe';

/** Signed order id given to the buyer's browser (pay / return URLs). Distinct from the one-click order cookie. */
export const payToken = (orderId: number) => signId('pay', orderId);
export const orderOfPayToken = (token: unknown) => (typeof token === 'string' ? verifySignedId('pay', token) : null);

const isRecurring = (i: Pick<OrderItemRow, 'type' | 'installments'>) => i.type === 'subscription' || (i.type === 'installments' && (i.installments ?? 0) > 1);

/** Installments: the regular payment (old lines, before 0015, stored one installment in amount_total). */
const eachOf = (i: OrderItemRow) => i.installment_amount ?? i.amount_total;

/** What a line costs at the first payment: one-time price, first period, or first installment (with the rounding cents). */
export function firstPaymentOf(i: OrderItemRow): number {
  if (i.type !== 'installments' || !i.installments || i.installment_amount === null) return i.amount_total;
  return i.amount_total - i.installment_amount * (i.installments - 1);
}
export const dueNow = (items: OrderItemRow[]) => items.reduce((n, i) => n + firstPaymentOf(i), 0);

/** Card (Apple Pay / Google Pay are cards) and, when the seller turned it on, SEPA Direct Debit for EUR. Never a method
 * that sends the buyer away from the page. */
export const paymentMethodTypes = (row: Pick<PaymentSettingsRow, 'sepa_debit'>, currency: string) => ['card', ...(row.sepa_debit && currency === 'eur' ? ['sepa_debit'] : [])];

export type PayState =
  | { state: 'confirm'; clientSecret: string; amount: number; currency: string }
  | { state: 'paid'; order: OrderRow }
  | { state: 'processing' }
  | { state: 'failed'; message: string };

const REUSABLE = new Set(['requires_payment_method', 'requires_confirmation', 'requires_action']);
const reload = (orderId: number) => db.selectFrom('orders').selectAll().where('id', '=', orderId).executeTakeFirstOrThrow();
const itemsOf = (orderId: number) => db.selectFrom('order_items').selectAll().where('order_id', '=', orderId).orderBy('id').execute();
const meta = (o: OrderRow): Record<string, string> => ({
  order_id: String(o.id),
  scalo_user: String(o.user_id),
  ...(o.parent_order_id ? { parent_order_id: String(o.parent_order_id) } : {}),
});

async function customerOf(client: StripeClient, o: OrderRow): Promise<string> {
  if (o.stripe_customer_id) return o.stripe_customer_id;
  const name = [o.first_name, o.last_name].filter(Boolean).join(' ');
  const c = await client.createCustomer({ email: o.email, name: name || undefined, metadata: { scalo_user: String(o.user_id) } }, `scalo-customer-${o.id}`);
  await db.updateTable('orders').set({ stripe_customer_id: c.id, updated_at: nowIso() }).where('id', '=', o.id).execute();
  return c.id;
}

/** Stripe Product of an order line (cached per Scalo product and mode; a deleted product gets a one-off one). */
async function stripeProductOf(client: StripeClient, o: OrderRow, item: OrderItemRow): Promise<string> {
  if (!item.product_id) return (await client.createProduct({ name: itemLabel(item), metadata: { scalo_user: String(o.user_id) } }, `scalo-product-item-${item.id}`)).id;
  const cached = await db.selectFrom('stripe_products').select('stripe_product_id').where('product_id', '=', item.product_id).where('livemode', '=', o.livemode).executeTakeFirst();
  if (cached) return cached.stripe_product_id;
  const p = await db.selectFrom('products').select(['name', 'description', 'image_url']).where('id', '=', item.product_id).executeTakeFirst();
  const created = await client.createProduct(
    {
      name: p?.name ?? item.product_name,
      description: p?.description || undefined,
      image: p?.image_url && /^https:\/\//i.test(p.image_url) ? p.image_url : undefined,
      metadata: { scalo_user: String(o.user_id), scalo_product: String(item.product_id) },
    },
    `scalo-product-${item.product_id}-${o.livemode ? 'live' : 'test'}-${Date.now()}`,
  );
  await db
    .insertInto('stripe_products')
    .values({ user_id: o.user_id, product_id: item.product_id, livemode: o.livemode, stripe_product_id: created.id, created_at: nowIso() })
    .onConflict((oc) => oc.columns(['product_id', 'livemode']).doUpdateSet({ stripe_product_id: created.id }))
    .execute();
  return created.id;
}

/** The latest invoice of a subscription, with its payment intent (expanded by the client). */
function invoiceOf(sub: StripeSubscription): { invoice: StripeInvoice | null; intent: StripePaymentIntent | null; paid: boolean } {
  const inv = typeof sub.latest_invoice === 'object' ? sub.latest_invoice : null;
  const intent = inv && typeof inv.payment_intent === 'object' ? inv.payment_intent : null;
  const invoice = inv ? ({ ...inv, payment_intent: idOf(inv.payment_intent ?? null), subscription: sub.id, customer: inv.customer ?? sub.customer ?? null } as StripeInvoice) : null;
  return { invoice, intent, paid: inv?.status === 'paid' || intent?.status === 'succeeded' };
}

/** First invoice paid → order paid (and, should the plan already be over, its end). */
async function applyPaidInvoice(userId: number, orderId: number, client: StripeClient, sub: StripeSubscription, invoice: StripeInvoice, intent: StripePaymentIntent | null) {
  const r = await recordInvoicePaid(userId, invoice, db, intent?.payment_method ?? sub.default_payment_method ?? null);
  if (r?.cancelSubscription) {
    await client.cancelSubscription(r.cancelSubscription);
    await completeInstallments(userId, r.orderId);
  }
  return reload(orderId);
}

async function stateOfSubscription(userId: number, o: OrderRow, client: StripeClient, sub: StripeSubscription): Promise<PayState | null> {
  const { invoice, intent, paid } = invoiceOf(sub);
  if (paid && invoice) return { state: 'paid', order: await applyPaidInvoice(userId, o.id, client, sub, invoice, intent) };
  if (sub.status === 'incomplete_expired' || sub.status === 'canceled' || !intent) return null; // start again
  if (intent.status === 'processing') return { state: 'processing' };
  if (REUSABLE.has(intent.status) && intent.client_secret) return { state: 'confirm', clientSecret: intent.client_secret, amount: intent.amount, currency: intent.currency };
  return null;
}

async function stateOfIntent(userId: number, o: OrderRow, pi: StripePaymentIntent): Promise<PayState | null> {
  if (pi.status === 'succeeded') {
    const r = await markOrderPaid(userId, o.id, paidInfoOfIntent(pi));
    return { state: 'paid', order: r?.order ?? (await reload(o.id)) };
  }
  if (pi.status === 'processing') return { state: 'processing' };
  if (REUSABLE.has(pi.status) && pi.client_secret) return { state: 'confirm', clientSecret: pi.client_secret, amount: pi.amount, currency: pi.currency };
  return null; // canceled: start again
}

async function createSubscription(client: StripeClient, row: PaymentSettingsRow, o: OrderRow, items: OrderItemRow[], customer: string, attempt: string, offSessionPm?: string) {
  const build = async () => {
    const rec = items.find(isRecurring)!;
    const extra: { product: string; unit_amount: number }[] = [];
    for (const i of items) if (i !== rec && i.amount_total > 0) extra.push({ product: await stripeProductOf(client, o, i), unit_amount: firstPaymentOf(i) });
    const product = await stripeProductOf(client, o, rec);
    // the first installment takes the rounding cents
    const each = rec.type === 'installments' ? eachOf(rec) : rec.amount_total;
    if (firstPaymentOf(rec) > each) extra.push({ product, unit_amount: firstPaymentOf(rec) - each });
    return client.createSubscription(
      {
        customer,
        currency: o.currency,
        item: { product, unit_amount: each, interval: (rec.interval as 'week' | 'month' | 'year' | null) ?? 'month', interval_count: rec.interval_count || 1 },
        add_invoice_items: extra,
        payment_method_types: paymentMethodTypes(row, o.currency),
        metadata: meta(o),
        off_session_payment_method: offSessionPm,
      },
      `scalo-sub-${o.id}-${attempt}`,
    );
  };
  try {
    return await build();
  } catch (e) {
    // the cached Stripe products belong to another account (keys changed): forget them and try once more
    if (!(e instanceof StripeError) || e.code !== 'resource_missing') throw e;
    await db.deleteFrom('stripe_products').where('user_id', '=', o.user_id).where('livemode', '=', o.livemode).execute();
    attempt += 'r';
    return build();
  }
}

/**
 * Prepares the payment of a pending order and says what the buyer's browser must do: confirm it in Stripe Elements
 * (`clientSecret`), nothing (already paid / being processed by the bank).
 */
export async function preparePayment(userId: number, order: OrderRow, client: StripeClient): Promise<PayState> {
  if (order.status === 'paid' || order.status === 'refunded') return { state: 'paid', order };
  const row = await getPaymentSettingsRow(userId);
  const items = await itemsOf(order.id);
  const recurring = items.some(isRecurring);
  let o = order;
  // what already exists for this order is reused (reload, second click, retry after a refused card)
  if (recurring && o.stripe_subscription_id) {
    const st = await stateOfSubscription(userId, o, client, await client.retrieveSubscription(o.stripe_subscription_id));
    if (st) return st;
  } else if (!recurring && o.stripe_payment_intent_id) {
    const st = await stateOfIntent(userId, o, await client.retrievePaymentIntent(o.stripe_payment_intent_id));
    if (st) return st;
  }
  const attempt = o.stripe_subscription_id || o.stripe_payment_intent_id ? String(Date.now()) : '1';
  const customer = await customerOf(client, o);
  o = await reload(o.id);
  if (recurring) {
    const sub = await createSubscription(client, row, o, items, customer, attempt);
    await db.updateTable('orders').set({ stripe_subscription_id: sub.id, updated_at: nowIso() }).where('id', '=', o.id).execute();
    o = await reload(o.id);
    return (await stateOfSubscription(userId, o, client, sub)) ?? { state: 'failed', message: 'Paiement impossible à préparer' };
  }
  const pi = await client.createPaymentIntent(
    {
      amount: dueNow(items),
      currency: o.currency,
      customer,
      payment_method_types: paymentMethodTypes(row, o.currency),
      description: items.map(itemLabel).join(', ').slice(0, 500),
      metadata: meta(o),
    },
    `scalo-pi-${o.id}-${attempt}`,
  );
  await db.updateTable('orders').set({ stripe_payment_intent_id: pi.id, updated_at: nowIso() }).where('id', '=', o.id).execute();
  return (await stateOfIntent(userId, await reload(o.id), pi)) ?? { state: 'failed', message: 'Paiement impossible à préparer' };
}

/** One-click offer on a recurring offer: subscription charged now on the saved payment method. */
export async function chargeSubscriptionOffSession(userId: number, order: OrderRow, client: StripeClient, customer: string, paymentMethod: string): Promise<PayState> {
  const row = await getPaymentSettingsRow(userId);
  const items = await itemsOf(order.id);
  const sub = await createSubscription(client, row, order, items, customer, 'oneclick', paymentMethod);
  await db.updateTable('orders').set({ stripe_subscription_id: sub.id, stripe_customer_id: customer, updated_at: nowIso() }).where('id', '=', order.id).execute();
  const { invoice, intent, paid } = invoiceOf(sub);
  if (paid && invoice) return { state: 'paid', order: await applyPaidInvoice(userId, order.id, client, sub, invoice, intent) };
  if (intent?.status === 'processing') return { state: 'processing' };
  return { state: 'failed', message: intent?.last_payment_error?.message ?? 'Paiement à confirmer' };
}

/** Asks Stripe where the payment of an order stands and applies it (return page: no need to wait for the webhook). */
export async function syncPayment(userId: number, order: OrderRow, client: StripeClient): Promise<PayState | null> {
  if (order.status === 'paid' || order.status === 'refunded') return { state: 'paid', order };
  if (order.stripe_subscription_id) return stateOfSubscription(userId, order, client, await client.retrieveSubscription(order.stripe_subscription_id));
  if (order.stripe_payment_intent_id) return stateOfIntent(userId, order, await client.retrievePaymentIntent(order.stripe_payment_intent_id));
  return null;
}

// ---------- Apple Pay / Google Pay ----------

const pendingDomains = new Set<string>();

/**
 * Registers the host of a page selling something as a payment method domain of the seller's Stripe account (needed
 * for Apple Pay / Google Pay in Stripe Elements). Once per host and key; never blocks nor fails the page.
 */
export async function ensurePaymentDomain(userId: number, client: StripeClient, host: string, ex: Db = db) {
  const h = host.toLowerCase().replace(/:\d+$/, '');
  if (!h.includes('.') || /^[\d.]+$/.test(h) || h.endsWith('.localhost') || h.endsWith('.test') || pendingDomains.has(`${userId}:${h}`)) return;
  const row = await ex.selectFrom('payment_settings').select('payment_domains').where('user_id', '=', userId).executeTakeFirst();
  if (!row || (row.payment_domains ?? []).includes(h)) return;
  pendingDomains.add(`${userId}:${h}`);
  try {
    await client.registerPaymentMethodDomain(h);
  } catch (e) {
    // already registered by hand: fine; anything else is retried on a later page view
    if (!(e instanceof StripeError && /already/i.test(e.message))) {
      console.warn(`[stripe] domaine de paiement ${h} :`, (e as Error).message);
      return;
    }
  } finally {
    pendingDomains.delete(`${userId}:${h}`);
  }
  await ex
    .updateTable('payment_settings')
    .set({ payment_domains: JSON.stringify([...new Set([...(row.payment_domains ?? []), h])].slice(-50)) })
    .where('user_id', '=', userId)
    .execute();
}

/** Background registration of the host a page selling something is served on (first views). */
export function registerPaymentHost(req: { hostname?: string }, userId: number) {
  const host = req.hostname;
  if (!host) return;
  void (async () => {
    const client = stripeOfRow(await getPaymentSettingsRow(userId));
    if (client) await ensurePaymentDomain(userId, client, host);
  })().catch(() => {});
}
