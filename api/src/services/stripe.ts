// Stripe gateway. The rest of the app only talks to the narrow `StripeClient` interface below, built from the account's
// own secret key ("bring your own Stripe"). The default implementation calls the Stripe REST API with `fetch` (pinned
// API version, idempotency keys, timeout) — no card data ever goes through Scalo: buyers pay on the funnel's page in
// Stripe Elements (Stripe's iframes), the server only creates and reads payment intents and subscriptions.
// Tests inject a fake factory through `AppOptions.stripe` (no network).
//
// Secret keys are never logged nor put in error messages.
import crypto from 'node:crypto';

export const STRIPE_API_VERSION = '2024-06-20';
const API_BASE = 'https://api.stripe.com/v1';
const TIMEOUT_MS = 20_000;

// ---------- objects (subset of the Stripe API actually used) ----------

export interface StripePaymentIntent {
  id: string;
  status: 'succeeded' | 'processing' | 'requires_action' | 'requires_payment_method' | 'requires_confirmation' | 'requires_capture' | 'canceled';
  amount: number;
  amount_received?: number;
  currency: string;
  customer?: string | null;
  payment_method?: string | null;
  latest_charge?: string | null;
  metadata?: Record<string, string>;
  last_payment_error?: { message?: string; code?: string } | null;
  /** Given to the buyer's browser (Stripe Elements) to confirm the payment. */
  client_secret?: string | null;
}

export interface StripeSubscription {
  id: string;
  status: string; // active | past_due | canceled | unpaid | incomplete | incomplete_expired | trialing | paused
  customer?: string | null;
  default_payment_method?: string | null;
  metadata?: Record<string, string>;
  /** Expanded (with its payment intent) by `createSubscription` / `retrieveSubscription`. */
  latest_invoice?: (Omit<StripeInvoice, 'payment_intent'> & { payment_intent?: StripePaymentIntent | string | null; status?: string | null }) | string | null;
}

export interface StripeInvoice {
  id: string;
  amount_paid: number;
  currency: string;
  customer?: string | null;
  customer_email?: string | null;
  subscription?: string | null;
  payment_intent?: string | null;
  billing_reason?: string | null;
  subscription_details?: { metadata?: Record<string, string> | null } | null;
  lines?: { data?: { metadata?: Record<string, string> }[] };
}

export interface StripeCheckoutSession {
  id: string;
  url: string | null;
  status: 'open' | 'complete' | 'expired' | null;
  payment_status: 'paid' | 'unpaid' | 'no_payment_required';
  mode: 'payment' | 'subscription' | 'setup';
  amount_total: number | null;
  currency: string | null;
  customer: string | null;
  customer_details?: { email?: string | null; name?: string | null } | null;
  /** Expanded by `retrieveCheckoutSession`; plain ids in webhook payloads. */
  payment_intent: StripePaymentIntent | string | null;
  subscription: StripeSubscription | string | null;
  invoice: StripeInvoice | string | null;
  metadata?: Record<string, string>;
}

export interface StripeRefund {
  id: string;
  amount: number;
  currency: string;
  charge?: string | null;
  payment_intent?: string | null;
  status?: string | null;
}

export interface StripeCharge {
  id: string;
  amount: number;
  amount_refunded: number;
  currency: string;
  refunded: boolean;
  payment_intent?: string | null;
}

export interface StripeAccount {
  id: string;
  /** Business / display name when available. */
  name: string | null;
}

export interface StripeEvent {
  id: string;
  type: string;
  livemode?: boolean;
  created?: number;
  data: { object: Record<string, unknown> };
}

// ---------- parameters ----------

export interface CustomerParams {
  email: string;
  name?: string;
  metadata: Record<string, string>;
}

/** A payment the buyer confirms in Stripe Elements (on-session). */
export interface PaymentIntentParams {
  amount: number;
  currency: string;
  customer: string;
  /** card (Apple Pay / Google Pay included), sepa_debit. Never a method that leaves the page. */
  payment_method_types: string[];
  description?: string;
  metadata: Record<string, string>;
}

export interface ProductParams {
  name: string;
  description?: string;
  image?: string;
  metadata: Record<string, string>;
}

/** Amounts in minor units, tax included. */
export interface SubscriptionParams {
  customer: string;
  currency: string;
  /** The recurring line: subscription period or regular installment. */
  item: { product: string; unit_amount: number; interval: 'week' | 'month' | 'year'; interval_count: number };
  /** Added to the first invoice only: one-time lines (order bump), rounding cents of the first installment. */
  add_invoice_items: { product: string; unit_amount: number }[];
  payment_method_types: string[];
  metadata: Record<string, string>;
  /** One-click upsell: charge the saved payment method now, without the buyer. Otherwise the first invoice waits for
   * the buyer to confirm it in Stripe Elements (`default_incomplete`). */
  off_session_payment_method?: string;
}

export interface OffSessionPaymentParams {
  amount: number;
  currency: string;
  customer: string;
  payment_method: string;
  description?: string;
  metadata: Record<string, string>;
}

export interface RefundParams {
  payment_intent: string;
  /** Omitted = everything that is left. */
  amount?: number;
  metadata?: Record<string, string>;
}

/** What Scalo needs from Stripe. One instance per secret key. */
export interface StripeClient {
  /** Checks the key (« Tester la connexion »). */
  retrieveAccount(): Promise<StripeAccount>;
  /** With `payment_intent`, `subscription` and `invoice` expanded. Orders paid on Stripe Checkout before 0015 only. */
  retrieveCheckoutSession(id: string): Promise<StripeCheckoutSession>;
  createCustomer(params: CustomerParams, idempotencyKey: string): Promise<{ id: string }>;
  /** Payment intent saving the payment method for later off-session charges (one-click upsells). */
  createPaymentIntent(params: PaymentIntentParams, idempotencyKey: string): Promise<StripePaymentIntent>;
  retrievePaymentIntent(id: string): Promise<StripePaymentIntent>;
  createProduct(params: ProductParams, idempotencyKey: string): Promise<{ id: string }>;
  /** With `latest_invoice.payment_intent` expanded. */
  createSubscription(params: SubscriptionParams, idempotencyKey: string): Promise<StripeSubscription>;
  /** With `latest_invoice.payment_intent` expanded. */
  retrieveSubscription(id: string): Promise<StripeSubscription>;
  /** Apple Pay / Google Pay on that host. */
  registerPaymentMethodDomain(domain: string): Promise<void>;
  /**
   * Charges a saved card without the buyer (`off_session`, `confirm`). Resolves with the intent when Stripe accepted
   * the request; rejects with a `StripeError` (`code: 'authentication_required'`, `card_declined`…) otherwise.
   */
  createOffSessionPayment(params: OffSessionPaymentParams, idempotencyKey: string): Promise<StripePaymentIntent>;
  createRefund(params: RefundParams, idempotencyKey: string): Promise<StripeRefund>;
  /** Ends the subscription now. */
  cancelSubscription(id: string): Promise<StripeSubscription>;
}

export type StripeFactory = (secretKey: string) => StripeClient;

export class StripeError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string | null = null,
    public type: string | null = null,
    public declineCode: string | null = null,
    public paymentIntent: StripePaymentIntent | null = null,
  ) {
    super(message);
  }
}

// ---------- REST implementation ----------

/** `{a: {b: [1, {c: 2}]}}` → `a[b][0]=1&a[b][1][c]=2` (Stripe's form encoding). */
export function encodeForm(obj: Record<string, unknown>): string {
  const out: string[] = [];
  const walk = (key: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(`${key}[${i}]`, x));
    else if (typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(`${key}[${k}]`, x);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  };
  for (const [k, v] of Object.entries(obj)) walk(k, v);
  return out.join('&');
}

export function createStripeClient(secretKey: string, fetchImpl: typeof fetch = fetch): StripeClient {
  async function call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, params?: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
    const body = params ? encodeForm(params) : '';
    const headers: Record<string, string> = { Authorization: `Bearer ${secretKey}`, 'Stripe-Version': STRIPE_API_VERSION };
    if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let res: Response;
    try {
      res = await fetchImpl(`${API_BASE}${path}${method !== 'POST' && body ? `?${body}` : ''}`, {
        method,
        headers,
        body: method === 'POST' ? body : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      // never include the request (it carries the key)
      throw new StripeError(`Stripe injoignable (${(e as Error).name === 'TimeoutError' ? 'délai dépassé' : 'erreur réseau'})`, 0, 'network_error');
    }
    const json = (await res.json().catch(() => null)) as { error?: { message?: string; code?: string; type?: string; decline_code?: string; payment_intent?: StripePaymentIntent } } | null;
    if (!res.ok) {
      const e = json?.error;
      throw new StripeError(e?.message ?? `Erreur Stripe ${res.status}`, res.status, e?.code ?? null, e?.type ?? null, e?.decline_code ?? null, e?.payment_intent ?? null);
    }
    return json as T;
  }

  return {
    async retrieveAccount() {
      const a = await call<{ id: string; business_profile?: { name?: string | null } | null; settings?: { dashboard?: { display_name?: string | null } | null } | null; email?: string | null }>('GET', '/account');
      return { id: a.id, name: a.business_profile?.name || a.settings?.dashboard?.display_name || a.email || null };
    },
    retrieveCheckoutSession(id) {
      return call<StripeCheckoutSession>('GET', `/checkout/sessions/${encodeURIComponent(id)}`, { expand: ['payment_intent', 'subscription', 'invoice'] });
    },
    createCustomer(p, idempotencyKey) {
      return call<{ id: string }>('POST', '/customers', { email: p.email, name: p.name || undefined, metadata: p.metadata }, idempotencyKey);
    },
    createPaymentIntent(p, idempotencyKey) {
      return call<StripePaymentIntent>(
        'POST',
        '/payment_intents',
        {
          amount: p.amount,
          currency: p.currency,
          customer: p.customer,
          payment_method_types: p.payment_method_types,
          setup_future_usage: 'off_session',
          description: p.description,
          metadata: p.metadata,
        },
        idempotencyKey,
      );
    },
    retrievePaymentIntent(id) {
      return call<StripePaymentIntent>('GET', `/payment_intents/${encodeURIComponent(id)}`);
    },
    createProduct(p, idempotencyKey) {
      return call<{ id: string }>(
        'POST',
        '/products',
        { name: p.name, ...(p.description ? { description: p.description.slice(0, 500) } : {}), ...(p.image ? { images: [p.image] } : {}), metadata: p.metadata },
        idempotencyKey,
      );
    },
    createSubscription(p, idempotencyKey) {
      const offSession = !!p.off_session_payment_method;
      return call<StripeSubscription>(
        'POST',
        '/subscriptions',
        {
          customer: p.customer,
          items: [{ price_data: { currency: p.currency, product: p.item.product, unit_amount: p.item.unit_amount, recurring: { interval: p.item.interval, interval_count: p.item.interval_count } } }],
          add_invoice_items: p.add_invoice_items.map((i) => ({ price_data: { currency: p.currency, product: i.product, unit_amount: i.unit_amount } })),
          payment_behavior: offSession ? 'allow_incomplete' : 'default_incomplete',
          ...(offSession ? { default_payment_method: p.off_session_payment_method, off_session: true } : {}),
          payment_settings: { payment_method_types: p.payment_method_types, save_default_payment_method: 'on_subscription' },
          metadata: p.metadata,
          expand: ['latest_invoice.payment_intent'],
        },
        idempotencyKey,
      );
    },
    retrieveSubscription(id) {
      return call<StripeSubscription>('GET', `/subscriptions/${encodeURIComponent(id)}`, { expand: ['latest_invoice.payment_intent'] });
    },
    async registerPaymentMethodDomain(domain) {
      await call('POST', '/payment_method_domains', { domain_name: domain }, `scalo-pmd-${domain}`);
    },
    createOffSessionPayment(p, idempotencyKey) {
      return call<StripePaymentIntent>(
        'POST',
        '/payment_intents',
        {
          amount: p.amount,
          currency: p.currency,
          customer: p.customer,
          payment_method: p.payment_method,
          off_session: true,
          confirm: true,
          description: p.description,
          metadata: p.metadata,
        },
        idempotencyKey,
      );
    },
    createRefund(p, idempotencyKey) {
      return call<StripeRefund>('POST', '/refunds', { payment_intent: p.payment_intent, amount: p.amount, metadata: p.metadata }, idempotencyKey);
    },
    cancelSubscription(id) {
      return call<StripeSubscription>('DELETE', `/subscriptions/${encodeURIComponent(id)}`);
    },
  };
}

// ---------- factory used by the app (replaced by tests) ----------

let factory: StripeFactory = (key) => createStripeClient(key);

/** Called by createApp: `null` restores the real client. */
export function setStripeFactory(f: StripeFactory | null | undefined) {
  factory = f ?? ((key) => createStripeClient(key));
}
export const stripeFor = (secretKey: string): StripeClient => factory(secretKey);

// ---------- keys ----------

export const SECRET_KEY_RE = /^(sk|rk)_(test|live)_[A-Za-z0-9]{10,250}$/;
export const PUBLISHABLE_KEY_RE = /^pk_(test|live)_[A-Za-z0-9]{10,250}$/;
export const WEBHOOK_SECRET_RE = /^whsec_[A-Za-z0-9+/=_-]{10,250}$/;

/** Test / live mode of a key, from its prefix. */
export const keyMode = (key: string): 'test' | 'live' | null => (/^(sk|rk|pk)_test_/.test(key) ? 'test' : /^(sk|rk|pk)_live_/.test(key) ? 'live' : null);
export const keyHint = (key: string) => key.slice(-4);

// ---------- webhook signatures ----------

const SIGNATURE_TOLERANCE_S = 300;

/** `Stripe-Signature` header value for a payload (used by the tests and by nothing else). */
export function signStripePayload(payload: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const sig = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

/**
 * Verifies the `Stripe-Signature` header (HMAC-SHA256 of `<t>.<raw body>` with the endpoint's signing secret, within a
 * 5-minute window) and returns the event. Returns null when the signature is missing, invalid or too old.
 */
export function verifyStripeEvent(rawBody: Buffer | string, header: string | undefined, secret: string, now = Date.now()): StripeEvent | null {
  if (!header || !secret) return null;
  let t = '';
  const sigs: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1') sigs.push(v);
  }
  if (!/^\d{1,12}$/.test(t) || !sigs.length) return null;
  if (Math.abs(now / 1000 - Number(t)) > SIGNATURE_TOLERANCE_S) return null;
  const payload = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex'));
  const ok = sigs.some((s) => {
    const given = Buffer.from(s);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
  if (!ok) return null;
  try {
    const ev = JSON.parse(payload) as StripeEvent;
    return ev && typeof ev.id === 'string' && typeof ev.type === 'string' && ev.data && typeof ev.data.object === 'object' ? ev : null;
  } catch {
    return null;
  }
}

export const idOf = (v: { id: string } | string | null | undefined): string | null => (typeof v === 'string' ? v : v?.id ?? null);
