// In-memory Stripe for the payment tests (injected through AppOptions.stripe: no network). Payment intents and
// subscriptions are created as the real API does for Stripe Elements (waiting for the buyer); `confirm` plays the
// buyer confirming the payment in the Payment Element.
import {
  StripeError,
  type CustomerParams,
  type OffSessionPaymentParams,
  type PaymentIntentParams,
  type ProductParams,
  type StripeCheckoutSession,
  type StripeClient,
  type StripeFactory,
  type StripeInvoice,
  type StripePaymentIntent,
  type StripeSubscription,
  type SubscriptionParams,
} from '../src/services/stripe';

type Invoice = StripeInvoice & { status: string };

export class FakeStripe {
  keys: string[] = [];
  intents = new Map<string, StripePaymentIntent>();
  intentParams = new Map<string, PaymentIntentParams>();
  subs = new Map<string, StripeSubscription>();
  subParams = new Map<string, SubscriptionParams>();
  invoices = new Map<string, Invoice>();
  /** Checkout sessions created before 0015 (seeded by the tests). */
  sessions = new Map<string, StripeCheckoutSession>();
  customers: CustomerParams[] = [];
  products: ProductParams[] = [];
  domains: string[] = [];
  offSession: OffSessionPaymentParams[] = [];
  offSessionMode: 'succeed' | 'authentication_required' | 'declined' | 'outage' = 'succeed';
  /** Next payment intent / subscription creation fails (Stripe outage). */
  createError: string | null = null;
  refunds: { payment_intent: string; amount: number }[] = [];
  canceled: string[] = [];
  accountError: string | null = null;
  refundError: string | null = null;
  private n = 0;
  private idem = new Map<string, unknown>();
  private paid = new Map<string, number>();
  id = (p: string) => `${p}_test_${++this.n}${'x'.repeat(10)}`;

  factory: StripeFactory = (key) => {
    this.keys.push(key);
    return this.client;
  };

  private newIntent(amount: number, currency: string, customer: string | null, metadata: Record<string, string>): StripePaymentIntent {
    const id = this.id('pi');
    const pi: StripePaymentIntent = { id, status: 'requires_payment_method', amount, currency, customer, payment_method: null, metadata, client_secret: `${id}_secret_${'s'.repeat(8)}` };
    this.intents.set(id, pi);
    return pi;
  }

  private invoiceOfIntent(piId: string) {
    return [...this.invoices.values()].find((i) => i.payment_intent === piId) ?? null;
  }

  private settle(pi: StripePaymentIntent, pm: string, status: 'succeeded' | 'processing') {
    Object.assign(pi, { status, payment_method: pm, amount_received: status === 'succeeded' ? pi.amount : 0 });
    if (status === 'succeeded') this.paid.set(pi.id, pi.amount);
    const inv = this.invoiceOfIntent(pi.id);
    if (inv && status === 'succeeded') {
      Object.assign(inv, { status: 'paid', amount_paid: pi.amount });
      const sub = this.subs.get(inv.subscription!)!;
      Object.assign(sub, { status: 'active', default_payment_method: pm });
    }
  }

  /** The buyer confirms the payment in Stripe Elements (`processing`: SEPA Direct Debit, confirmed days later). */
  confirm(clientSecret: string, status: 'succeeded' | 'processing' = 'succeeded') {
    const pi = [...this.intents.values()].find((x) => x.client_secret === clientSecret);
    if (!pi) throw new Error(`unknown client secret ${clientSecret}`);
    this.settle(pi, this.id('pm'), status);
    return { pi: structuredClone(pi), invoice: this.invoiceOfIntent(pi.id), subscription: this.invoiceOfIntent(pi.id)?.subscription ?? null };
  }

  /** The bank confirms a payment that was processing. */
  succeed(piId: string) {
    const pi = this.intents.get(piId)!;
    this.settle(pi, pi.payment_method ?? this.id('pm'), 'succeeded');
    return structuredClone(pi);
  }

  private expandSub(id: string): StripeSubscription {
    const s = structuredClone(this.subs.get(id)!);
    const inv = typeof s.latest_invoice === 'string' ? this.invoices.get(s.latest_invoice) : null;
    if (inv) s.latest_invoice = { ...structuredClone(inv), payment_intent: inv.payment_intent ? structuredClone(this.intents.get(inv.payment_intent)!) : null };
    return s;
  }

  private once<T>(key: string, make: () => T): T {
    if (this.idem.has(key)) {
      const v = this.idem.get(key);
      if (v instanceof StripeError) throw v;
      return v as T;
    }
    try {
      const v = make();
      this.idem.set(key, v);
      return v;
    } catch (e) {
      if (e instanceof StripeError && e.status !== 0) this.idem.set(key, e);
      throw e;
    }
  }

  client: StripeClient = {
    retrieveAccount: async () => {
      if (this.accountError) throw new StripeError(this.accountError, 401, 'api_key_invalid', 'invalid_request_error');
      return { id: 'acct_1', name: 'Boutique Test' };
    },
    retrieveCheckoutSession: async (id) => {
      const s = this.sessions.get(id);
      if (!s) throw new StripeError('No such checkout.session', 404, 'resource_missing');
      return structuredClone(s);
    },
    createCustomer: async (p, key) =>
      this.once(`cus:${key}`, () => {
        this.customers.push(p);
        return { id: this.id('cus') };
      }),
    createPaymentIntent: async (p, key) => {
      if (this.createError) throw new StripeError(this.createError, 0, 'network_error');
      return structuredClone(
        this.once(`pi:${key}`, () => {
          const pi = this.newIntent(p.amount, p.currency, p.customer, p.metadata);
          this.intentParams.set(pi.id, p);
          return pi;
        }),
      );
    },
    retrievePaymentIntent: async (id) => {
      const pi = this.intents.get(id);
      if (!pi) throw new StripeError('No such payment_intent', 404, 'resource_missing');
      return structuredClone(pi);
    },
    createProduct: async (p) => {
      this.products.push(p);
      return { id: this.id('prod') };
    },
    createSubscription: async (p, key) => {
      if (this.createError) throw new StripeError(this.createError, 0, 'network_error');
      if (p.off_session_payment_method && this.offSessionMode === 'outage') throw new StripeError('Stripe injoignable', 0, 'network_error');
      const id = this.once(`sub:${key}`, () => {
        const sid = this.id('sub');
        const amount = p.item.unit_amount + p.add_invoice_items.reduce((n, i) => n + i.unit_amount, 0);
        const pi = this.newIntent(amount, p.currency, p.customer, {});
        const inv: Invoice = { id: this.id('in'), amount_paid: 0, currency: p.currency, customer: p.customer, subscription: sid, payment_intent: pi.id, billing_reason: 'subscription_create', status: 'open', subscription_details: { metadata: p.metadata } };
        this.invoices.set(inv.id, inv);
        this.subs.set(sid, { id: sid, status: 'incomplete', customer: p.customer, default_payment_method: null, metadata: p.metadata, latest_invoice: inv.id });
        this.subParams.set(sid, p);
        if (p.off_session_payment_method) {
          if (this.offSessionMode === 'succeed') this.settle(pi, p.off_session_payment_method, 'succeeded');
          else if (this.offSessionMode === 'authentication_required') pi.status = 'requires_action';
        }
        return sid;
      });
      return this.expandSub(id);
    },
    retrieveSubscription: async (id) => {
      if (!this.subs.has(id)) throw new StripeError('No such subscription', 404, 'resource_missing');
      return this.expandSub(id);
    },
    registerPaymentMethodDomain: async (domain) => {
      this.domains.push(domain);
    },
    createOffSessionPayment: async (params, key) => {
      if (this.offSessionMode === 'outage') throw new StripeError('Stripe injoignable', 0, 'network_error');
      return this.once(`off:${key}`, () => {
        this.offSession.push(params);
        const base = { id: this.id('pi'), amount: params.amount, currency: params.currency, customer: params.customer, payment_method: params.payment_method, metadata: params.metadata };
        if (this.offSessionMode !== 'succeed') {
          throw new StripeError(
            this.offSessionMode === 'declined' ? 'Your card was declined.' : 'This payment requires authentication.',
            402,
            this.offSessionMode === 'declined' ? 'card_declined' : 'authentication_required',
            'card_error',
            null,
            { ...base, status: 'requires_payment_method' },
          );
        }
        const pi: StripePaymentIntent = { ...base, status: 'succeeded', amount_received: params.amount };
        this.paid.set(pi.id, params.amount);
        this.intents.set(pi.id, pi);
        return pi;
      });
    },
    createRefund: async (params) => {
      if (this.refundError) throw new StripeError(this.refundError, 400, 'charge_already_refunded');
      const done = this.refunds.filter((r) => r.payment_intent === params.payment_intent).reduce((n, r) => n + r.amount, 0);
      const amount = params.amount ?? (this.paid.get(params.payment_intent) ?? 0) - done;
      this.refunds.push({ payment_intent: params.payment_intent, amount });
      return { id: this.id('re'), amount, currency: 'eur', payment_intent: params.payment_intent, status: 'succeeded' };
    },
    cancelSubscription: async (id) => {
      this.canceled.push(id);
      const s = this.subs.get(id);
      if (s) s.status = 'canceled';
      return { id, status: 'canceled' };
    },
  };
}
