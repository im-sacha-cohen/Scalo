// Payments (Stripe): products, offers (prices), orders. Amounts are always integers in the currency's minor unit
// (cents). Shared by the API, the builder (offer pickers) and the public renderer (checkout / one-click upsell blocks).

/** Two-decimal currencies only (amounts are stored in cents). */
export const CURRENCIES = ['eur', 'usd', 'gbp', 'chf', 'cad', 'aud'] as const;
export type Currency = (typeof CURRENCIES)[number];
export const isCurrency = (c: unknown): c is Currency => typeof c === 'string' && (CURRENCIES as readonly string[]).includes(c);

/**
 * - one_time:     a single payment
 * - subscription: charged every `interval` until cancelled
 * - installments: `amount` is the price paid in one go; the buyer chooses to pay it in `installments_min` to
 *                 `installments_max` times (1 = in one go), every `interval_count` × `interval`, with an optional
 *                 surcharge per number of installments. The plan ends by itself after the last installment.
 */
export type PriceType = 'one_time' | 'subscription' | 'installments';
/** Subscriptions: month / year. Installments: week / month (× `interval_count`). */
export type PriceInterval = 'week' | 'month' | 'year';

/** Rhythms offered for installments. */
export const INSTALLMENT_RHYTHMS = [
  { id: 'month', interval: 'month', count: 1, label: 'Chaque mois' },
  { id: '2week', interval: 'week', count: 2, label: 'Toutes les 2 semaines' },
  { id: 'week', interval: 'week', count: 1, label: 'Chaque semaine' },
] as const;
export const MAX_INSTALLMENTS = 36;

/** An offer of a product ("prix"). `amount` is tax included when `tax_inclusive`, tax excluded otherwise. */
export interface ProductPrice {
  id: number;
  product_id: number;
  /** Label shown to buyers when the product has several offers (e.g. « Paiement en 3 fois »). */
  name: string;
  type: PriceType;
  amount: number;
  currency: Currency;
  interval: PriceInterval | null;
  /** Every `interval_count` × `interval` (installments: 1 or 2 weeks, 1 month). */
  interval_count: number;
  /** Installments: the buyer chooses between these two numbers of payments (min 1 = may also pay in one go). */
  installments_min: number | null;
  installments_max: number | null;
  /** Installments: surcharge in percent per number of payments (`{ "3": 5 }` = +5 % in 3 times). */
  installment_fees: Record<string, number>;
  /** VAT rate in percent (0–100, 2 decimals). */
  tax_rate: number;
  tax_inclusive: boolean;
  active: boolean;
  created_at: string;
}

export interface Product {
  id: number;
  name: string;
  description: string;
  image_url: string | null;
  /** Tag given to the buyer once the order is paid (grants access to courses, fires campaigns / automations). */
  tag_id: number | null;
  tag_name?: string | null;
  /** Email campaign the buyer is enrolled in. */
  campaign_id: number | null;
  /** Remove the tag when the order is fully refunded or the subscription ends. */
  revoke_on_refund: boolean;
  archived: boolean;
  created_at: string;
  updated_at: string;
  prices: ProductPrice[];
  /** Paid orders containing this product, and what they brought in (first currency found). */
  sales_count?: number;
}

/** A sellable offer, flattened for pickers and for the public renderer. */
export interface Offer {
  /** = price id */
  id: number;
  product_id: number;
  product_name: string;
  price_name: string;
  description: string;
  image_url: string | null;
  type: PriceType;
  currency: Currency;
  interval: PriceInterval | null;
  interval_count: number;
  /** Price in one go (installments: without surcharge), or per period (subscriptions), tax included. */
  amount_total: number;
  amount_tax: number;
  tax_rate: number;
  /** « 97,00 € », « 29,00 € / mois », « 297,00 € ou jusqu’à 3 × 99,00 € / mois » */
  price_label: string;
  /** Installments: the plans the buyer chooses from (fewest payments first). Empty otherwise. */
  options: InstallmentOption[];
}

/** One way to pay an installments offer. Amounts tax included, in minor units. */
export interface InstallmentOption {
  /** Number of payments (1 = in one go). */
  count: number;
  /** Whole plan (surcharge included). */
  total: number;
  subtotal: number;
  tax: number;
  /** Charged today: the regular installment plus the rounding cents. */
  first: number;
  /** Each following installment. */
  each: number;
  /** Surcharge applied, in percent. */
  fee: number;
}

export type OrderStatus = 'pending' | 'paid' | 'failed' | 'refunded' | 'canceled';
/** `completed`: every installment was paid. */
export type OrderSubscriptionStatus = 'active' | 'past_due' | 'canceled' | 'completed';
export type OrderKind = 'checkout' | 'upsell';
export type OrderItemKind = 'main' | 'bump' | 'upsell';

export interface OrderItem {
  id: number;
  product_id: number | null;
  price_id: number | null;
  kind: OrderItemKind;
  product_name: string;
  price_name: string;
  type: PriceType;
  interval: PriceInterval | null;
  interval_count: number;
  /** Installments: number of payments chosen, and each regular payment (the first one also takes the rounding cents). */
  installments: number | null;
  installment_amount: number | null;
  tax_rate: number;
  tax_inclusive: boolean;
  /** Whole line, tax included: one-time price, one subscription period, or the whole installment plan. */
  amount_subtotal: number;
  amount_tax: number;
  amount_total: number;
  tag_id: number | null;
  campaign_id: number | null;
  /** The tag is removed when the order is fully refunded / the subscription ends. */
  revoke_on_refund: boolean;
}

export interface OrderTransaction {
  id: number;
  type: 'payment' | 'refund';
  amount: number;
  currency: string;
  created_at: string;
}

export interface Order {
  id: number;
  kind: OrderKind;
  status: OrderStatus;
  subscription_status: OrderSubscriptionStatus | null;
  /** false = Stripe test mode */
  livemode: boolean;
  email: string;
  first_name: string | null;
  last_name: string | null;
  contact_id: number | null;
  funnel_id: number | null;
  step_id: number | null;
  funnel_name?: string | null;
  step_name?: string | null;
  parent_order_id: number | null;
  currency: string;
  /** Sum of the lines (one-time prices, first subscription period, whole installment plans), tax included. */
  amount_subtotal: number;
  amount_tax: number;
  amount_total: number;
  /** Everything collected so far (subscriptions: every paid invoice) and refunded so far. */
  amount_paid: number;
  amount_refunded: number;
  /** First-touch attribution of the visitor (utm_*, referrer). */
  attribution: Record<string, string> | null;
  failure_message: string | null;
  paid_at: string | null;
  refunded_at: string | null;
  created_at: string;
  items: OrderItem[];
  transactions?: OrderTransaction[];
  /** Stripe dashboard link of the payment (detail view). */
  stripe_url?: string | null;
  has_subscription?: boolean;
}

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  pending: 'En attente',
  paid: 'Payée',
  failed: 'Échouée',
  refunded: 'Remboursée',
  canceled: 'Abandonnée',
};
export const SUBSCRIPTION_STATUS_LABELS: Record<OrderSubscriptionStatus, string> = {
  active: 'Abonnement actif',
  past_due: 'Paiement en retard',
  canceled: 'Abonnement annulé',
  completed: 'Échéances terminées',
};

/** Settings → Paiements. Secrets are write-only: the API only returns a hint (last 4 characters). */
export interface PaymentSettings {
  connected: boolean;
  mode: 'test' | 'live' | null;
  secret_key_hint: string | null;
  publishable_key: string | null;
  webhook_secret_set: boolean;
  webhook_secret_hint: string | null;
  /** URL to register in Stripe (Developers → Webhooks). */
  webhook_url: string;
  /** Events the endpoint must listen to. */
  webhook_events: string[];
  account_name: string | null;
  verified_at: string | null;
  /** SEPA Direct Debit offered next to cards (EUR offers; must be activated in the Stripe dashboard). */
  sepa_debit: boolean;
}

export interface SalesStats {
  from: string;
  to: string;
  /** One entry per currency, biggest revenue first. */
  totals: { currency: string; revenue: number; refunds: number; net: number; orders: number; average: number }[];
  /** Net revenue per day in the main currency (`totals[0]`). */
  daily: { date: string; revenue: number; orders: number }[];
  pending: number;
  active_subscriptions: number;
}

export const STRIPE_WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'charge.refunded',
  'invoice.paid',
  'invoice.payment_failed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
];

// ---------- amounts ----------

export interface Amounts { subtotal: number; tax: number; total: number }

/** Splits a configured amount into tax excluded / tax / tax included (integers, tax rounded half up). */
export function computeAmounts(amount: number, taxRate: number, taxInclusive: boolean): Amounts {
  const a = Math.max(0, Math.round(amount));
  const rate = Math.min(100, Math.max(0, Number(taxRate) || 0));
  if (!rate) return { subtotal: a, tax: 0, total: a };
  if (taxInclusive) {
    const subtotal = Math.round(a / (1 + rate / 100));
    return { subtotal, tax: a - subtotal, total: a };
  }
  const tax = Math.round((a * rate) / 100);
  return { subtotal: a, tax, total: a + tax };
}

const SYMBOLS: Record<string, string> = { eur: '€', usd: '$', gbp: '£', chf: 'CHF', cad: '$ CA', aud: '$ AU' };

/** « 1 234,50 € » (French formatting, works without Intl data). */
export function formatMoney(minor: number, currency: string): string {
  const n = Math.round(Number(minor) || 0);
  const abs = Math.abs(n);
  const units = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const cents = String(abs % 100).padStart(2, '0');
  return `${n < 0 ? '-' : ''}${units},${cents} ${SYMBOLS[String(currency).toLowerCase()] ?? String(currency).toUpperCase()}`;
}

/** « mois », « semaine », « 2 semaines », « an » */
export function intervalLabel(interval: PriceInterval | string | null, count = 1): string {
  const one = interval === 'year' ? 'an' : interval === 'week' ? 'semaine' : 'mois';
  if (count <= 1) return one;
  return `${count} ${interval === 'year' ? 'ans' : interval === 'week' ? 'semaines' : 'mois'}`;
}

type Plannable = { amount: number; tax_rate: number; tax_inclusive: boolean; installment_fees?: Record<string, number> | null };

/** Surcharge (percent) for `count` payments. */
export const installmentFee = (p: Pick<Plannable, 'installment_fees'>, count: number) => {
  const v = Number(p.installment_fees?.[String(count)]);
  return count > 1 && Number.isFinite(v) && v > 0 ? Math.min(100, Math.round(v * 100) / 100) : 0;
};

/** Plan for `count` payments: surcharge, tax, then the total split in equal installments, the first one taking the rounding cents. */
export function installmentPlan(p: Plannable, count: number): InstallmentOption {
  const n = Math.max(1, Math.min(MAX_INSTALLMENTS, Math.round(count)));
  const fee = installmentFee(p, n);
  const a = computeAmounts(Math.round(p.amount * (1 + fee / 100)), p.tax_rate, p.tax_inclusive);
  const each = Math.floor(a.total / n);
  return { count: n, total: a.total, subtotal: a.subtotal, tax: a.tax, first: a.total - each * (n - 1), each, fee };
}

/** Every plan of an installments offer, fewest payments first. */
export function installmentOptions(p: Plannable & { installments_min: number | null; installments_max: number | null }): InstallmentOption[] {
  const min = Math.max(1, p.installments_min ?? 2);
  const max = Math.max(min, Math.min(MAX_INSTALLMENTS, p.installments_max ?? min));
  return Array.from({ length: max - min + 1 }, (_, i) => installmentPlan(p, min + i));
}

/** « 3 × 100,00 € / mois » (the first installment may be a few cents more: see `planDetail`). */
export function planLabel(o: Pick<InstallmentOption, 'count' | 'each' | 'total'>, currency: string, interval: PriceInterval | string | null, intervalCount = 1): string {
  if (o.count <= 1) return formatMoney(o.total, currency);
  return `${o.count} × ${formatMoney(o.each, currency)} / ${intervalLabel(interval, intervalCount)}`;
}

/** « 100,01 € aujourd’hui, puis 2 × 100,00 € tous les mois · total 300,01 € » */
export function planDetail(o: InstallmentOption, currency: string, interval: PriceInterval | string | null, intervalCount = 1): string {
  if (o.count <= 1) return `${formatMoney(o.total, currency)} en une fois`;
  const every = interval === 'week' ? (intervalCount > 1 ? `toutes les ${intervalCount} semaines` : 'chaque semaine') : intervalCount > 1 ? `tous les ${intervalCount} mois` : 'chaque mois';
  return `${formatMoney(o.first, currency)} aujourd’hui, puis ${o.count - 1} × ${formatMoney(o.each, currency)} ${every} · total ${formatMoney(o.total, currency)}`;
}

/**
 * Label of a price. Installments offers: « 297,00 € ou jusqu’à 3 × 99,00 € / mois » (`total`: price in one go), or
 * one plan when `installments` is given (order lines: « 3 × 99,00 € / mois », `total`: the whole plan).
 */
export function priceLabel(
  p: {
    type: PriceType;
    interval: PriceInterval | null;
    interval_count?: number | null;
    currency: string;
    installments?: number | null;
    installment_amount?: number | null;
    installments_min?: number | null;
    installments_max?: number | null;
    amount?: number;
    tax_rate?: number;
    tax_inclusive?: boolean;
    installment_fees?: Record<string, number> | null;
  },
  total: number,
): string {
  const m = formatMoney(total, p.currency);
  const every = intervalLabel(p.interval, p.interval_count ?? 1);
  if (p.type === 'subscription') return `${m} / ${every}`;
  if (p.type !== 'installments') return m;
  if (p.installments) {
    const each = p.installment_amount ?? Math.floor(total / p.installments);
    return `${p.installments} × ${formatMoney(each, p.currency)} / ${every}`;
  }
  const max = p.installments_max ?? 2;
  const min = p.installments_min ?? max;
  const last = p.amount !== undefined ? installmentPlan({ amount: p.amount, tax_rate: p.tax_rate ?? 0, tax_inclusive: p.tax_inclusive ?? true, installment_fees: p.installment_fees }, max) : null;
  const each = last ? formatMoney(last.each, p.currency) : '';
  if (min === max) return last ? `${max} × ${each} / ${every}` : `${max} × ${m}`;
  if (min === 1) return `${m} ou jusqu’à ${max} × ${each} / ${every}`;
  return `de ${min} à ${max} fois (${m})`;
}
