// Payments (Stripe): products, offers (prices), orders. Amounts are always integers in the currency's minor unit
// (cents). Shared by the API, the builder (offer pickers) and the public renderer (checkout / one-click upsell blocks).

/** Two-decimal currencies only (amounts are stored in cents). */
export const CURRENCIES = ['eur', 'usd', 'gbp', 'chf', 'cad', 'aud'] as const;
export type Currency = (typeof CURRENCIES)[number];
export const isCurrency = (c: unknown): c is Currency => typeof c === 'string' && (CURRENCIES as readonly string[]).includes(c);

/**
 * - one_time:     a single payment
 * - subscription: charged every `interval` until cancelled
 * - installments: `installments` monthly payments of `amount`, then the subscription ends by itself
 */
export type PriceType = 'one_time' | 'subscription' | 'installments';
export type PriceInterval = 'month' | 'year';

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
  installments: number | null;
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
  installments: number | null;
  /** Charged per payment, tax included. */
  amount_total: number;
  amount_tax: number;
  tax_rate: number;
  /** « 97,00 € », « 29,00 € / mois », « 3 × 99,00 € » */
  price_label: string;
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
  installments: number | null;
  tax_rate: number;
  tax_inclusive: boolean;
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
  /** First payment (one-time total, or first period of a subscription), tax included. */
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

export function priceLabel(p: { type: PriceType; interval: PriceInterval | null; installments: number | null; currency: string }, total: number): string {
  const m = formatMoney(total, p.currency);
  if (p.type === 'subscription') return `${m} / ${p.interval === 'year' ? 'an' : 'mois'}`;
  if (p.type === 'installments') return `${p.installments ?? 2} × ${m}`;
  return m;
}
