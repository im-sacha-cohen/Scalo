// Payments: Stripe connection (encrypted keys), products / offers, order form → Stripe Checkout → paid order (tag,
// campaign, purchase automation, confirmation email, hooks), order bump, one-click upsell, webhook (signature,
// idempotency), refunds, subscriptions / installments, revenue, public API. Stripe is a fake injected through
// AppOptions.stripe: no network.
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { db } from '../src/db';
import { registerOrderHook, type OrderHookContext } from '../src/services/order-hooks';
import { decryptSecret } from '../src/services/secretbox';
import {
  encodeForm,
  signStripePayload,
  StripeError,
  verifyStripeEvent,
  type CheckoutSessionParams,
  type OffSessionPaymentParams,
  type StripeCheckoutSession,
  type StripeClient,
  type StripeFactory,
  type StripePaymentIntent,
} from '../src/services/stripe';
import { EmailWorker } from '../src/worker';
import { client, http, registerUser, shutdown, startApp, type TestCtx } from './helpers';

// ---------- fake Stripe ----------

class FakeStripe {
  keys: string[] = [];
  sessions = new Map<string, StripeCheckoutSession>();
  sessionParams = new Map<string, CheckoutSessionParams>();
  offSession: OffSessionPaymentParams[] = [];
  offSessionMode: 'succeed' | 'authentication_required' | 'declined' | 'outage' = 'succeed';
  refunds: { payment_intent: string; amount: number }[] = [];
  canceled: string[] = [];
  accountError: string | null = null;
  refundError: string | null = null;
  private n = 0;
  private idem = new Map<string, StripePaymentIntent | StripeError>();
  private paid = new Map<string, number>();
  private id = (p: string) => `${p}_test_${++this.n}${'x'.repeat(10)}`;

  factory: StripeFactory = (key) => {
    this.keys.push(key);
    return this.client;
  };

  /** The buyer pays on the hosted page. */
  pay(sessionId: string) {
    const s = this.sessions.get(sessionId)!;
    const customer = s.customer ?? this.id('cus');
    const pm = this.id('pm');
    const pi = this.id('pi');
    this.paid.set(pi, s.amount_total!);
    const metadata = s.metadata;
    Object.assign(s, { status: 'complete', payment_status: 'paid', customer });
    if (s.mode === 'payment') {
      s.payment_intent = { id: pi, status: 'succeeded', amount: s.amount_total!, amount_received: s.amount_total!, currency: s.currency!, customer, payment_method: pm, metadata };
    } else {
      const sub = this.id('sub');
      s.subscription = { id: sub, status: 'active', customer, default_payment_method: pm, metadata };
      s.invoice = { id: this.id('in'), amount_paid: s.amount_total!, currency: s.currency!, customer, subscription: sub, payment_intent: pi, billing_reason: 'subscription_create' };
    }
    return s;
  }

  client: StripeClient = {
    retrieveAccount: async () => {
      if (this.accountError) throw new StripeError(this.accountError, 401, 'api_key_invalid', 'invalid_request_error');
      return { id: 'acct_1', name: 'Boutique Test' };
    },
    createCheckoutSession: async (params) => {
      const id = this.id('cs');
      const s: StripeCheckoutSession = {
        id,
        url: `https://checkout.stripe.test/pay/${id}`,
        status: 'open',
        payment_status: 'unpaid',
        mode: params.mode,
        amount_total: params.line_items.reduce((n, l) => n + l.unit_amount, 0),
        currency: params.line_items[0].currency,
        customer: params.customer ?? null,
        customer_details: { email: params.customer_email ?? null },
        payment_intent: null,
        subscription: null,
        invoice: null,
        metadata: params.metadata,
      };
      this.sessions.set(id, s);
      this.sessionParams.set(id, params);
      return structuredClone(s);
    },
    retrieveCheckoutSession: async (id) => {
      const s = this.sessions.get(id);
      if (!s) throw new StripeError('No such checkout.session', 404, 'resource_missing');
      return structuredClone(s);
    },
    createOffSessionPayment: async (params, key) => {
      const prev = this.idem.get(key);
      if (prev instanceof StripeError) throw prev;
      if (prev) return prev;
      this.offSession.push(params);
      const base = { id: this.id('pi'), amount: params.amount, currency: params.currency, customer: params.customer, payment_method: params.payment_method, metadata: params.metadata };
      if (this.offSessionMode === 'outage') throw new StripeError('Stripe injoignable', 0, 'network_error');
      if (this.offSessionMode !== 'succeed') {
        const err = new StripeError(
          this.offSessionMode === 'declined' ? 'Your card was declined.' : 'This payment requires authentication.',
          402,
          this.offSessionMode === 'declined' ? 'card_declined' : 'authentication_required',
          'card_error',
          null,
          { ...base, status: 'requires_payment_method' },
        );
        this.idem.set(key, err);
        throw err;
      }
      const pi: StripePaymentIntent = { ...base, status: 'succeeded', amount_received: params.amount };
      this.paid.set(pi.id, params.amount);
      this.idem.set(key, pi);
      return pi;
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
      return { id, status: 'canceled' };
    },
  };
}

// ---------- harness ----------

let ctx: TestCtx;
const stripe = new FakeStripe();
const hookCalls: { event: string; order: number; amount: number; full?: boolean; status: string; visitor: unknown }[] = [];
let unregister: () => void;
before(async () => {
  ctx = await startApp({ stripe: stripe.factory });
  unregister = registerOrderHook('test', async (c: OrderHookContext) => {
    hookCalls.push({ event: c.event, order: c.order.id, amount: c.amount, full: c.full, status: c.order.status, visitor: c.order.visitor });
  });
});
after(async () => {
  unregister();
  await shutdown(ctx);
});
beforeEach(async () => {
  await db.deleteFrom('auth_attempts').execute(); // checkout rate limit (per IP)
});
afterEach(() => {
  stripe.offSessionMode = 'succeed';
  stripe.accountError = null;
  stripe.refundError = null;
});

type Api = ReturnType<typeof client>;
const SK = `sk_test_${'a1B2'.repeat(6)}9f3Q`;
const PK = `pk_test_${'c3D4'.repeat(6)}`;
const WH = `whsec_${'e5F6'.repeat(8)}`;
const drain = () => new EmailWorker({ throttle: false }).drain();

async function seller(connect = true) {
  const reg = await registerUser(ctx);
  const api = client(ctx, reg.token);
  let webhookUrl = '';
  if (connect) {
    const r = await api.put('/api/payments/settings', { secret_key: SK, publishable_key: PK, webhook_secret: WH });
    assert.equal(r.status, 200, r.text);
    webhookUrl = new URL(r.body.webhook_url).pathname;
  }
  return { api, userId: reg.user.id, webhookUrl };
}

async function product(api: Api, body: Record<string, unknown>) {
  const r = await api.post('/api/products', body);
  assert.equal(r.status, 201, r.text);
  return r.body as { id: number; tag_id: number | null; prices: { id: number }[] };
}
const oneTime = (amount: number, extra: Record<string, unknown> = {}) => ({ type: 'one_time', amount, currency: 'eur', ...extra });

let seq = 0;
/** Funnel with 3 steps: order form → one-click offer → thank you. */
async function funnel(api: Api, checkout: Record<string, unknown>, upsell?: Record<string, unknown>) {
  const f = (await api.post('/api/funnels', { name: `Vente ${++seq}`, template: 'sales' })).body;
  const [s1, s2, s3] = f.steps as { id: number; slug: string }[];
  await api.patch(`/api/steps/${s1.id}`, { content: { settings: {}, blocks: [{ id: 'pay1', type: 'checkout', submitLabel: 'Commander', ...checkout }] } });
  await api.patch(`/api/steps/${s2.id}`, { content: { settings: {}, blocks: [{ id: 'up1', type: 'upsell', acceptLabel: 'Oui', declineLabel: 'Non merci', ...(upsell ?? {}) }] } });
  await api.patch(`/api/steps/${s3.id}`, { content: { settings: {}, blocks: [{ id: 't', type: 'text', text: 'Merci' }] } });
  const base = `/p/${f.slug}`;
  return { id: f.id as number, base, order: `${base}/${s1.slug}`, offer: `${base}/${s2.slug}`, thanks: `${base}/${s3.slug}`, steps: [s1, s2, s3] };
}

const sessionIdOf = (location: string | null) => {
  assert.match(location ?? '', /^https:\/\/checkout\.stripe\.test\/pay\/cs_test_/);
  return location!.split('/').pop()!;
};

/** Submits the order form; returns the Stripe session the buyer was sent to. */
async function startCheckout(f: { order: string }, form: Record<string, string>, cookies: Record<string, string> = {}) {
  const r = await http(ctx, 'POST', `${f.order}/checkout`, { form: { _block: 'pay1', ...form }, cookies });
  assert.equal(r.status, 303, r.text);
  return sessionIdOf(r.headers.get('location'));
}

/** Order form → payment on the fake hosted page → return to the funnel. */
async function buy(f: { order: string }, form: Record<string, string>, cookies: Record<string, string> = {}) {
  const sid = await startCheckout(f, form, cookies);
  stripe.pay(sid);
  const back = await http(ctx, 'GET', `${f.order}/paid?session_id=${sid}`, { cookies });
  assert.equal(back.status, 303, back.text);
  return { sid, back, cookies: { ...cookies, ...back.cookies } };
}

const orderBySession = (sid: string) => db.selectFrom('orders').selectAll().where('stripe_session_id', '=', sid).executeTakeFirstOrThrow();
const tagsOf = async (api: Api, contactId: number) => ((await api.get(`/api/contacts/${contactId}`)).body.tags as { name: string }[]).map((t) => t.name).sort();

let evt = 0;
async function webhook(path: string, type: string, object: Record<string, unknown>, opts: { id?: string; secret?: string; signature?: string } = {}) {
  const payload = JSON.stringify({ id: opts.id ?? `evt_${++evt}_${crypto.randomBytes(4).toString('hex')}`, type, livemode: false, data: { object } });
  const res = await fetch(ctx.base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': opts.signature ?? signStripePayload(payload, opts.secret ?? WH) },
    body: payload,
  });
  return { status: res.status, body: (await res.json()) as { result?: string; error?: string } };
}

async function v1Token(userId: number, scopes: string[]) {
  const now = new Date().toISOString();
  const c = await db
    .insertInto('oauth_clients')
    .values({
      client_id: `scalo_app_${crypto.randomBytes(12).toString('hex')}`, user_id: userId, name: 'Test', type: 'public', secret_hash: null, secret_hint: null,
      website: null, logo_url: null, redirect_uris: ['http://localhost:3000/cb'], scopes, created_at: now, updated_at: now,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const token = `scalo_at_${crypto.randomBytes(32).toString('base64url')}`;
  await db
    .insertInto('oauth_tokens')
    .values({ token_hash: crypto.createHash('sha256').update(token).digest('hex'), type: 'access', family_id: crypto.randomUUID(), client_id: c.id, user_id: userId, scopes, expires_at: new Date(Date.now() + 3600_000).toISOString(), created_at: now })
    .execute();
  return token;
}

// ---------- tests ----------

describe('Stripe connection', () => {
  test('keys are validated, stored encrypted, never returned; mode from the prefix; test connection; disconnect', async () => {
    const { api, userId } = await seller(false);
    const empty = await api.get('/api/payments/settings');
    assert.equal(empty.body.connected, false);
    assert.equal(empty.body.mode, null);
    assert.match(empty.body.webhook_url, /\/api\/payments\/webhook\/[\w-]{20,}$/);
    assert.ok(empty.body.webhook_events.includes('checkout.session.completed'));
    assert.equal((await api.post('/api/payments/settings/test')).status, 409);

    assert.equal((await api.put('/api/payments/settings', { secret_key: 'pk_test_abcdefghijklmnop' })).status, 400);
    assert.equal((await api.put('/api/payments/settings', { secret_key: 'nope' })).status, 400);
    assert.equal((await api.put('/api/payments/settings', { secret_key: SK, publishable_key: PK.replace('pk_test', 'pk_live') })).status, 400);
    assert.equal((await api.put('/api/payments/settings', { secret_key: SK, webhook_secret: 'secret' })).status, 400);
    assert.equal((await api.get('/api/payments/settings')).body.connected, false, 'a refused update stores nothing');

    const saved = await api.put('/api/payments/settings', { secret_key: SK, publishable_key: PK, webhook_secret: WH });
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual(
      { connected: saved.body.connected, mode: saved.body.mode, hint: saved.body.secret_key_hint, pk: saved.body.publishable_key, wh: saved.body.webhook_secret_set, whHint: saved.body.webhook_secret_hint },
      { connected: true, mode: 'test', hint: '9f3Q', pk: PK, wh: true, whHint: WH.slice(-4) },
    );
    assert.ok(!saved.text.includes(SK) && !saved.text.includes(WH), 'secrets never leave the server');
    assert.ok(!(await api.get('/api/payments/settings')).text.includes(SK));

    const row = await db.selectFrom('payment_settings').selectAll().where('user_id', '=', userId).executeTakeFirstOrThrow();
    assert.match(row.stripe_secret_key!, /^v1\./);
    assert.ok(!row.stripe_secret_key!.includes(SK) && !row.stripe_webhook_secret!.includes(WH), 'encrypted at rest');
    assert.equal(decryptSecret(row.stripe_secret_key!, 'stripe:secret-key'), SK);
    assert.equal(decryptSecret(row.stripe_secret_key!, 'stripe:webhook-secret'), null, 'one key space per usage');
    assert.equal(decryptSecret(row.stripe_secret_key!.slice(0, -2) + 'AA', 'stripe:secret-key'), null, 'tampered value rejected');

    // test connection: the decrypted key reaches the Stripe client
    stripe.keys.length = 0;
    const ok = await api.post('/api/payments/settings/test');
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(stripe.keys, [SK]);
    assert.equal(ok.body.settings.account_name, 'Boutique Test');
    assert.ok(ok.body.settings.verified_at);
    stripe.accountError = `Invalid API Key provided: ${SK}`;
    const ko = await api.post('/api/payments/settings/test');
    assert.equal(ko.status, 502);
    assert.ok(!ko.text.includes(SK), 'a key echoed by Stripe is masked');

    // empty secret = unchanged; a live key switches the mode and drops the test publishable key
    assert.equal((await api.put('/api/payments/settings', { secret_key: '' })).body.secret_key_hint, '9f3Q');
    const live = await api.put('/api/payments/settings', { secret_key: `sk_live_${'z9'.repeat(12)}LIVE` });
    assert.deepEqual([live.body.mode, live.body.secret_key_hint, live.body.publishable_key, live.body.account_name], ['live', 'LIVE', null, null]);

    // tenant isolation, disconnect
    const other = await seller(false);
    assert.equal((await other.api.get('/api/payments/settings')).body.connected, false);
    const off = await api.del('/api/payments/settings');
    assert.equal(off.body.connected, false);
    assert.equal(off.body.webhook_url, saved.body.webhook_url, 'the webhook URL survives a reconnection');
    assert.equal((await http(ctx, 'GET', '/api/payments/settings')).status, 401);
  });

  test('webhook signatures: HMAC of the raw body, tolerance window, form encoding of Stripe requests', () => {
    const payload = JSON.stringify({ id: 'evt_1', type: 'x', data: { object: {} } });
    assert.equal(verifyStripeEvent(payload, signStripePayload(payload, WH), WH)?.id, 'evt_1');
    assert.equal(verifyStripeEvent(payload, signStripePayload(payload, 'whsec_other'), WH), null);
    assert.equal(verifyStripeEvent(payload + ' ', signStripePayload(payload, WH), WH), null, 'body changed');
    assert.equal(verifyStripeEvent(payload, signStripePayload(payload, WH, Math.floor(Date.now() / 1000) - 3600), WH), null, 'too old');
    assert.equal(verifyStripeEvent(payload, undefined, WH), null);
    assert.equal(verifyStripeEvent(payload, 't=abc,v1=zz', WH), null);
    assert.equal(
      encodeForm({ mode: 'payment', line_items: [{ quantity: 1, price_data: { currency: 'eur', unit_amount: 9700 } }], metadata: { order_id: '7' }, skip: undefined }),
      'mode=payment&line_items%5B0%5D%5Bquantity%5D=1&line_items%5B0%5D%5Bprice_data%5D%5Bcurrency%5D=eur&line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=9700&metadata%5Border_id%5D=7',
    );
  });
});

describe('products & offers', () => {
  test('CRUD, offers (one-time / subscription / installments), VAT, validation, isolation', async () => {
    const { api } = await seller();
    const camp = (await api.post('/api/campaigns', { name: 'Clients' })).body;
    const p = await api.post('/api/products', {
      name: 'Formation',
      description: 'Le programme complet',
      tag_name: 'client-formation',
      campaign_id: camp.id,
      prices: [
        oneTime(9700, { tax_rate: 20, tax_inclusive: true }),
        { type: 'subscription', amount: 2900, currency: 'eur', interval: 'month', tax_rate: 20, tax_inclusive: false, name: 'Mensuel' },
        { type: 'installments', amount: 3300, currency: 'eur', installments: 3, name: '3 fois' },
      ],
    });
    assert.equal(p.status, 201, p.text);
    assert.equal(p.body.tag_name, 'client-formation');
    assert.equal(p.body.revoke_on_refund, true);
    assert.deepEqual(p.body.prices.map((x: { type: string; interval: string | null; installments: number | null }) => [x.type, x.interval, x.installments]), [
      ['one_time', null, null],
      ['subscription', 'month', null],
      ['installments', 'month', 3],
    ]);

    const offers = (await api.get('/api/offers')).body as { id: number; amount_total: number; amount_tax: number; price_label: string; product_name: string }[];
    assert.deepEqual(offers.map((o) => [o.amount_total, o.amount_tax, o.price_label.replace(/\s/g, ' ')]), [
      [9700, 1617, '97,00 €'], // 97 TTC → 80,83 HT + 16,17 TVA
      [3480, 580, '34,80 € / mois'], // 29 HT + 20 %
      [3300, 0, '3 × 33,00 €'],
    ]);

    // validation
    for (const bad of [
      { name: '', prices: [] },
      { name: 'X', prices: [oneTime(10)] }, // below the minimum
      { name: 'X', prices: [oneTime(99.5)] }, // not an integer
      { name: 'X', prices: [{ type: 'one_time', amount: 1000, currency: 'xyz' }] },
      { name: 'X', prices: [{ type: 'installments', amount: 1000, currency: 'eur' }] }, // count required
      { name: 'X', image_url: 'javascript:alert(1)' },
      { name: 'X', tag_id: 999999 },
      { name: 'X', campaign_id: 999999 },
    ]) {
      const r = await api.post('/api/products', bad);
      assert.ok([400, 404].includes(r.status), `${JSON.stringify(bad)} → ${r.status}`);
    }

    // update: offers are synced (kept ids updated, missing ones removed, new ones created)
    const [first, second] = p.body.prices as { id: number }[];
    const upd = await api.patch(`/api/products/${p.body.id}`, { name: 'Formation Pro', prices: [{ id: first.id, ...oneTime(14700) }, oneTime(4700, { name: 'Promo', active: false })] });
    assert.equal(upd.status, 200, upd.text);
    assert.equal(upd.body.name, 'Formation Pro');
    assert.deepEqual(upd.body.prices.map((x: { id: number; amount: number }) => [x.id === first.id, x.amount]), [[true, 14700], [false, 4700]]);
    assert.ok(!upd.body.prices.some((x: { id: number }) => x.id === second.id));
    assert.deepEqual((await api.get('/api/offers')).body.map((o: { amount_total: number }) => o.amount_total), [14700], 'inactive offers are not sellable');

    await api.patch(`/api/products/${p.body.id}`, { archived: true });
    assert.equal((await api.get('/api/products')).body.length, 0);
    assert.equal((await api.get('/api/products?archived=1')).body.length, 1);
    assert.equal((await api.get('/api/offers')).body.length, 0);

    const other = await seller();
    assert.equal((await other.api.get(`/api/products/${p.body.id}`)).status, 404);
    assert.equal((await other.api.patch(`/api/products/${p.body.id}`, { name: 'x' })).status, 404);
    assert.equal((await other.api.del(`/api/products/${p.body.id}`)).status, 404);
    assert.equal((await api.del(`/api/products/${p.body.id}`)).status, 200);
  });
});

describe('order form → Stripe Checkout → paid order', () => {
  test('page, server-side amounts, return from Stripe: contact, tag, campaign, purchase automation, email, attribution, hooks', async () => {
    const { api, userId } = await seller();
    const camp = (await api.post('/api/campaigns', { name: 'Onboarding' })).body;
    await api.post(`/api/campaigns/${camp.id}/emails`, { subject: 'Bienvenue', delay_days: 0 });
    const prod = await product(api, { name: 'Formation', tag_name: 'client', campaign_id: camp.id, prices: [oneTime(9700, { tax_rate: 20 })] });
    const vip = (await api.post('/api/tags', { name: 'vip' })).body;
    const auto = (await api.post('/api/automations', { name: 'Achat', enabled: true, trigger: { type: 'purchase', product: 'formation' }, actions: [{ type: 'add_tag', tag_id: vip.id }] })).body;
    const f = await funnel(api, { offerId: prod.prices[0].id, offerLabel: 'Faux libellé · 1,00 €' });

    // the page shows the current name and price of the offer (never the label remembered by the editor)
    const page = await http(ctx, 'GET', `${f.order}?utm_source=meta&utm_campaign=lancement`);
    assert.equal(page.status, 200);
    assert.match(page.text, new RegExp(`action="${f.order}/checkout"`));
    assert.match(page.text, /Formation/);
    assert.match(page.text, /97,00\s€/);
    assert.ok(!page.text.includes('Faux libellé'));
    const cookies = { scalo_vid: page.cookies.scalo_vid, scalo_src: page.cookies.scalo_src, scalo_aff_ref: 'partner-42', other: 'ignored' };

    const bad = await http(ctx, 'POST', `${f.order}/checkout`, { form: { email: 'nope', _block: 'pay1' } });
    assert.equal(bad.headers.get('location'), `${f.order}?pay=email`);
    assert.match((await http(ctx, 'GET', `${f.order}?pay=cancel`)).text, /Paiement annulé/);
    assert.equal((await http(ctx, 'POST', `${f.order}/checkout?preview=1`, { form: { email: 'a@b.fr' } })).headers.get('location'), `${f.order}?pay=preview&preview=1`);

    hookCalls.length = 0;
    // amounts sent by the browser are ignored
    const sid = await startCheckout(f, { email: 'Alice@Mail.fr', first_name: 'Alice', amount: '1', unit_amount: '1', price: '1' }, cookies);
    const params = stripe.sessionParams.get(sid)!;
    assert.equal(params.mode, 'payment');
    assert.deepEqual(params.line_items.map((l) => [l.name, l.unit_amount, l.currency, l.recurring]), [['Formation', 9700, 'eur', undefined]]);
    assert.equal(params.customer_email, 'alice@mail.fr');
    assert.equal(params.save_payment_method, true);
    assert.match(params.success_url, new RegExp(`${f.order}/paid\\?session_id=\\{CHECKOUT_SESSION_ID\\}$`));
    let order = await orderBySession(sid);
    assert.deepEqual([order.status, order.amount_total, order.amount_tax, order.amount_subtotal, order.currency, order.livemode], ['pending', 9700, 1617, 8083, 'eur', false]);
    assert.equal(params.metadata.order_id, String(order.id));
    assert.equal((await api.get('/api/contacts')).body.total, 0, 'nothing happens before the payment');

    // back on the funnel before paying: still open → order form again
    const early = await http(ctx, 'GET', `${f.order}/paid?session_id=${sid}`);
    assert.equal(early.headers.get('location'), `${f.order}?pay=cancel`);
    assert.equal((await orderBySession(sid)).status, 'pending');

    stripe.pay(sid);
    const back = await http(ctx, 'GET', `${f.order}/paid?session_id=${sid}`, { cookies });
    assert.equal(back.status, 303);
    assert.equal(back.headers.get('location'), f.offer);
    assert.ok(back.cookies.scalo_cid && back.cookies.scalo_order);

    order = await orderBySession(sid);
    assert.deepEqual([order.status, order.amount_paid, order.subscription_status], ['paid', 9700, null]);
    assert.ok(order.paid_at && order.contact_id && order.stripe_customer_id && order.stripe_payment_method_id && order.stripe_payment_intent_id);
    assert.deepEqual(order.attribution, { utm_source: 'meta', utm_campaign: 'lancement' });
    assert.deepEqual(order.visitor, { visitor_id: cookies.scalo_vid, cookies: { scalo_aff_ref: 'partner-42' } }, 'visitor context kept for extensions');

    const contact = (await api.get(`/api/contacts/${order.contact_id}`)).body;
    assert.equal(contact.email, 'alice@mail.fr');
    assert.equal(contact.first_name, 'Alice');
    assert.deepEqual(contact.tags.map((t: { name: string }) => t.name), ['client']);
    assert.equal((await api.get(`/api/campaigns/${camp.id}`)).body.subscribers, 1);
    const purchase = contact.events.find((e: { type: string }) => e.type === 'purchase');
    assert.deepEqual([purchase.data.product, purchase.data.amount, purchase.data.currency, purchase.data.source], ['Formation', 97, 'EUR', 'stripe']);
    assert.deepEqual(hookCalls.map((h) => [h.event, h.order, h.amount, h.status]), [['paid', order.id, 9700, 'paid']]);
    assert.deepEqual((await db.selectFrom('contacts').select('source').where('id', '=', order.contact_id!).executeTakeFirstOrThrow()).source, { utm_source: 'meta', utm_campaign: 'lancement' });

    // « a acheté » segment condition, purchase automation, confirmation email
    assert.equal((await api.post('/api/segments/preview', { filter: { match: 'all', conditions: [{ type: 'purchase', op: 'did', product: 'Formation' }] } })).body.count, 1);
    await drain();
    assert.deepEqual(await tagsOf(api, order.contact_id!), ['client', 'vip']);
    assert.equal((await api.get(`/api/automations/${auto.id}/runs`)).body.items.length, 1);
    const mail = await db.selectFrom('email_sends').select(['status', 'subject', 'html', 'to_email']).where('user_id', '=', userId).where('kind', '=', 'order').executeTakeFirstOrThrow();
    assert.equal(mail.status, 'sent');
    assert.equal(mail.to_email, 'alice@mail.fr');
    assert.match(mail.subject, new RegExp(`commande n° ${order.id}`));
    assert.match(mail.html!, /Formation/);
    assert.match(mail.html!, /97,00/);

    // the return page and the webhook may both report the payment: applied once
    await http(ctx, 'GET', `${f.order}/paid?session_id=${sid}`, { cookies });
    assert.equal((await db.selectFrom('order_transactions').selectAll().where('order_id', '=', order.id).execute()).length, 1);
    assert.equal(hookCalls.length, 1);
    assert.equal((await db.selectFrom('email_sends').select('id').where('user_id', '=', userId).where('kind', '=', 'order').execute()).length, 1);
    assert.equal((await http(ctx, 'GET', `${f.order}/paid?session_id=cs_test_unknown12345`)).headers.get('location'), f.order);

    // orders API
    const list = await api.get('/api/orders?status=paid&search=alice');
    assert.equal(list.body.total, 1);
    assert.equal(list.body.items[0].items[0].product_name, 'Formation');
    assert.equal(list.body.items[0].funnel_id, f.id);
    assert.equal((await api.get('/api/orders?status=refunded')).body.total, 0);
    assert.equal((await api.get(`/api/orders?product_id=${prod.id}`)).body.total, 1);
    const detail = await api.get(`/api/orders/${order.id}`);
    assert.equal(detail.body.transactions.length, 1);
    assert.match(detail.body.stripe_url, /^https:\/\/dashboard\.stripe\.com\/test\/payments\/pi_/);
    assert.ok(!/cus_test|pm_test|sk_test/.test(list.text), 'Stripe identifiers are not exposed by the list');
    assert.equal((await api.get(`/api/contacts/${order.contact_id}/orders`)).body.length, 1);
    assert.equal((await (await seller()).api.get(`/api/orders/${order.id}`)).status, 404);
    assert.equal((await api.get('/api/products')).body[0].sales_count, 1);
  });

  test('unavailable offers, Stripe not connected, Stripe outage', async () => {
    const { api } = await seller(false);
    const prod = await product(api, { name: 'Ebook', prices: [oneTime(1900)] });
    const f = await funnel(api, { offerId: prod.prices[0].id });
    const go = () => http(ctx, 'POST', `${f.order}/checkout`, { form: { email: 'a@b.fr', _block: 'pay1' } });
    assert.equal((await go()).headers.get('location'), `${f.order}?pay=unavailable`, 'Stripe not connected');

    await api.put('/api/payments/settings', { secret_key: SK });
    const real = stripe.client.createCheckoutSession;
    stripe.client.createCheckoutSession = async () => {
      throw new StripeError('Stripe injoignable', 0, 'network_error');
    };
    const down = await go();
    stripe.client.createCheckoutSession = real;
    assert.equal(down.headers.get('location'), `${f.order}?pay=error`);
    const failed = await api.get('/api/orders?status=failed');
    assert.equal(failed.body.total, 1);
    assert.match(failed.body.items[0].failure_message, /Session de paiement/);

    // an offer of another account, an archived product and an unknown block offer are all « indisponible »
    const other = await seller();
    const foreign = await product(other.api, { name: 'Autre', prices: [oneTime(500)] });
    const f2 = await funnel(api, { offerId: foreign.prices[0].id });
    assert.equal((await http(ctx, 'POST', `${f2.order}/checkout`, { form: { email: 'a@b.fr' } })).headers.get('location'), `${f2.order}?pay=unavailable`);
    assert.match((await http(ctx, 'GET', f2.order)).text, /pas disponible/);
    await api.patch(`/api/products/${prod.id}`, { archived: true });
    assert.equal((await go()).headers.get('location'), `${f.order}?pay=unavailable`);
  });

  test('order bump: added only when ticked, both products delivered', async () => {
    const { api } = await seller();
    const main = await product(api, { name: 'Formation', tag_name: 'client', prices: [oneTime(9700)] });
    const bump = await product(api, { name: 'Templates', tag_name: 'templates', prices: [oneTime(2700, { tax_rate: 20, tax_inclusive: false })] });
    const f = await funnel(api, { offerId: main.prices[0].id, bumpOfferId: bump.prices[0].id, bumpTitle: 'Ajoutez les templates' });
    const page = await http(ctx, 'GET', f.order);
    assert.match(page.text, /name="bump"/);
    assert.match(page.text, /Ajoutez les templates/);
    assert.match(page.text, /32,40\s€/);

    const without = await buy(f, { email: 'no-bump@mail.fr' });
    assert.deepEqual(stripe.sessionParams.get(without.sid)!.line_items.map((l) => l.unit_amount), [9700]);
    const o1 = await orderBySession(without.sid);
    assert.deepEqual(await tagsOf(api, o1.contact_id!), ['client']);

    const withBump = await buy(f, { email: 'bump@mail.fr', bump: '1' });
    assert.deepEqual(stripe.sessionParams.get(withBump.sid)!.line_items.map((l) => [l.name, l.unit_amount]), [['Formation', 9700], ['Templates', 3240]]);
    const o2 = await orderBySession(withBump.sid);
    assert.deepEqual([o2.amount_total, o2.amount_tax, o2.amount_paid], [12940, 540, 12940]);
    const items = (await api.get(`/api/orders/${o2.id}`)).body.items as { kind: string; product_name: string; amount_total: number }[];
    assert.deepEqual(items.map((i) => [i.kind, i.product_name, i.amount_total]), [['main', 'Formation', 9700], ['bump', 'Templates', 3240]]);
    assert.deepEqual(await tagsOf(api, o2.contact_id!), ['client', 'templates']);
    const purchases = (await api.get(`/api/contacts/${o2.contact_id}`)).body.events.filter((e: { type: string }) => e.type === 'purchase');
    assert.equal(purchases.length, 2);
  });
});

describe('one-click upsell', () => {
  async function setup(upsell: Record<string, unknown> = {}) {
    const s = await seller();
    const main = await product(s.api, { name: 'Formation', tag_name: 'client', prices: [oneTime(9700)] });
    const extra = await product(s.api, { name: 'Coaching', tag_name: 'coaching', prices: [oneTime(19700)] });
    const f = await funnel(s.api, { offerId: main.prices[0].id }, { offerId: extra.prices[0].id, ...upsell });
    return { ...s, f, main, extra };
  }

  test('accept: the saved card is charged off-session, once; decline goes to the next step', async () => {
    const { api, f } = await setup();
    const page = await http(ctx, 'GET', f.offer);
    assert.match(page.text, new RegExp(`action="${f.offer}/upsell"`));
    assert.match(page.text, /Coaching — 197,00\s€/);
    assert.match(page.text, new RegExp(`href="${f.thanks}"[^>]*>Non merci`), 'declining is a link to the next step');

    // no paid order in this browser: nothing can be charged
    assert.equal((await http(ctx, 'POST', `${f.offer}/upsell`, { form: { _block: 'up1' } })).headers.get('location'), `${f.offer}?pay=expired`);
    assert.equal((await http(ctx, 'POST', `${f.offer}/upsell`, { form: { _block: 'up1' }, cookies: { scalo_order: '1.forged' } })).headers.get('location'), `${f.offer}?pay=expired`);

    const { sid, cookies } = await buy(f, { email: 'up@mail.fr', first_name: 'Ugo' });
    const root = await orderBySession(sid);
    stripe.offSession.length = 0;
    hookCalls.length = 0;
    const yes = await http(ctx, 'POST', `${f.offer}/upsell`, { form: { _block: 'up1' }, cookies });
    assert.equal(yes.status, 303);
    assert.equal(yes.headers.get('location'), f.thanks);
    assert.equal(stripe.offSession.length, 1);
    assert.deepEqual(
      [stripe.offSession[0].amount, stripe.offSession[0].currency, stripe.offSession[0].customer, stripe.offSession[0].payment_method],
      [19700, 'eur', root.stripe_customer_id, root.stripe_payment_method_id],
    );
    const up = await db.selectFrom('orders').selectAll().where('parent_order_id', '=', root.id).executeTakeFirstOrThrow();
    assert.deepEqual([up.kind, up.status, up.amount_paid, up.contact_id, up.email], ['upsell', 'paid', 19700, root.contact_id, 'up@mail.fr']);
    assert.equal(stripe.offSession[0].metadata.order_id, String(up.id));
    assert.deepEqual(await tagsOf(api, root.contact_id!), ['client', 'coaching']);
    assert.deepEqual(hookCalls.map((h) => [h.event, h.order]), [['paid', up.id]]);

    // double click / reload: never charged twice
    const again = await Promise.all([1, 2].map(() => http(ctx, 'POST', `${f.offer}/upsell`, { form: { _block: 'up1' }, cookies })));
    assert.deepEqual(again.map((r) => r.headers.get('location')), [f.thanks, f.thanks]);
    assert.equal(stripe.offSession.length, 1);
    assert.equal((await db.selectFrom('orders').select('id').where('parent_order_id', '=', root.id).execute()).length, 1);
    assert.equal((await api.get(`/api/orders/${root.id}`)).body.upsells.length, 1);
  });

  test('authentication required → Stripe Checkout fallback; refused card → same; outage → error', async () => {
    const { api, f, webhookUrl } = await setup({ skipNextOnAccept: true });
    const { sid, cookies } = await buy(f, { email: 'sca@mail.fr' });
    const root = await orderBySession(sid);

    stripe.offSessionMode = 'authentication_required';
    const r = await http(ctx, 'POST', `${f.offer}/upsell`, { form: { _block: 'up1' }, cookies });
    assert.equal(r.status, 303);
    const upSid = sessionIdOf(r.headers.get('location'));
    const p = stripe.sessionParams.get(upSid)!;
    assert.deepEqual([p.mode, p.customer, p.line_items[0].unit_amount], ['payment', root.stripe_customer_id, 19700]);
    assert.match(p.success_url, /&skip=1$/);
    let up = await db.selectFrom('orders').selectAll().where('parent_order_id', '=', root.id).executeTakeFirstOrThrow();
    assert.equal(up.status, 'pending');
    assert.deepEqual(await tagsOf(api, root.contact_id!), ['client'], 'nothing delivered before the payment');

    // Stripe also reports the failed off-session attempt: the order can still be paid on the hosted page
    const failed = await webhook(webhookUrl, 'payment_intent.payment_failed', { id: 'pi_failed_1', metadata: { order_id: String(up.id) }, last_payment_error: { message: 'authentication_required' } });
    assert.equal(failed.status, 200);
    assert.equal((await db.selectFrom('orders').select('status').where('id', '=', up.id).executeTakeFirstOrThrow()).status, 'failed');
    // clicking again goes straight to a new hosted session (same order, no second off-session attempt)
    const attempts = stripe.offSession.length;
    const retry = await http(ctx, 'POST', `${f.offer}/upsell`, { form: { _block: 'up1' }, cookies });
    const upSid2 = sessionIdOf(retry.headers.get('location'));
    assert.equal(stripe.offSession.length, attempts);
    assert.equal((await db.selectFrom('orders').select('id').where('parent_order_id', '=', root.id).execute()).length, 1);

    stripe.pay(upSid2);
    const back = await http(ctx, 'GET', `${f.offer}/paid?session_id=${upSid2}&skip=1`, { cookies });
    assert.equal(back.headers.get('location'), f.thanks, 'last step: nothing to skip to');
    up = await db.selectFrom('orders').selectAll().where('id', '=', up.id).executeTakeFirstOrThrow();
    assert.deepEqual([up.status, up.amount_paid, up.failure_message], ['paid', 19700, null]);
    assert.deepEqual(await tagsOf(api, root.contact_id!), ['client', 'coaching']);

    // refused card: hosted page too; network failure: error message, nothing charged
    const second = await setup();
    const b2 = await buy(second.f, { email: 'declined@mail.fr' });
    stripe.offSessionMode = 'declined';
    const declined = await http(ctx, 'POST', `${second.f.offer}/upsell`, { form: { _block: 'up1' }, cookies: b2.cookies });
    sessionIdOf(declined.headers.get('location'));
    const third = await setup();
    const b3 = await buy(third.f, { email: 'outage@mail.fr' });
    stripe.offSessionMode = 'outage';
    const out = await http(ctx, 'POST', `${third.f.offer}/upsell`, { form: { _block: 'up1' }, cookies: b3.cookies });
    assert.equal(out.headers.get('location'), `${third.f.offer}?pay=error`);
    assert.equal((await third.api.get('/api/orders?status=failed')).body.total, 1);
  });
});

describe('Stripe webhook', () => {
  test('signature required, idempotent replay, paid without the return page, failures and abandoned sessions', async () => {
    const { api, webhookUrl, userId } = await seller();
    const prod = await product(api, { name: 'Formation', tag_name: 'client', prices: [oneTime(9700)] });
    const f = await funnel(api, { offerId: prod.prices[0].id });
    const sid = await startCheckout(f, { email: 'hook@mail.fr' });
    const session = stripe.pay(sid);
    const order = await orderBySession(sid);

    assert.equal((await webhook('/api/payments/webhook/unknown-token-0123456789', 'checkout.session.completed', { id: sid })).status, 404);
    assert.equal((await webhook(webhookUrl, 'checkout.session.completed', { id: sid }, { secret: 'whsec_wrongwrongwrongwrong' })).status, 400);
    assert.equal((await webhook(webhookUrl, 'checkout.session.completed', { id: sid }, { signature: '' })).status, 400);
    assert.equal((await orderBySession(sid)).status, 'pending', 'an unsigned event changes nothing');

    hookCalls.length = 0;
    const ok = await webhook(webhookUrl, 'checkout.session.completed', { id: sid, payment_status: 'paid' }, { id: 'evt_paid_1' });
    assert.deepEqual([ok.status, ok.body.result], [200, 'processed']);
    const paid = await orderBySession(sid);
    assert.deepEqual([paid.status, paid.amount_paid], ['paid', 9700]);
    assert.deepEqual(await tagsOf(api, paid.contact_id!), ['client']);

    // replay of the same event, then the other events Stripe sends for the same payment
    const replay = await webhook(webhookUrl, 'checkout.session.completed', { id: sid }, { id: 'evt_paid_1' });
    assert.deepEqual([replay.status, replay.body.result], [200, 'duplicate']);
    const pi = session.payment_intent as StripePaymentIntent;
    assert.equal((await webhook(webhookUrl, 'payment_intent.succeeded', { ...pi })).body.result, 'processed');
    assert.equal((await webhook(webhookUrl, 'customer.created', { id: 'cus_1' })).body.result, 'ignored');
    assert.equal((await db.selectFrom('order_transactions').select('id').where('order_id', '=', order.id).execute()).length, 1);
    assert.equal((await db.selectFrom('contact_events').select('id').where('user_id', '=', userId).where('type', '=', 'purchase').execute()).length, 1);
    assert.equal((await db.selectFrom('email_sends').select('id').where('user_id', '=', userId).where('kind', '=', 'order').execute()).length, 1);
    assert.deepEqual(hookCalls.map((h) => h.event), ['paid']);

    // an event of another account's order is not applied (orders are looked up within the account of the URL)
    const other = await seller();
    const otherSid = await startCheckout(await funnel(other.api, { offerId: (await product(other.api, { name: 'P', prices: [oneTime(1000)] })).prices[0].id }), { email: 'x@y.fr' });
    stripe.pay(otherSid);
    await webhook(webhookUrl, 'checkout.session.completed', { id: otherSid });
    assert.equal((await orderBySession(otherSid)).status, 'pending');

    // refused payment → failed (a paid order never goes back); abandoned session → canceled
    const sid2 = await startCheckout(f, { email: 'fail@mail.fr' });
    const o2 = await orderBySession(sid2);
    await webhook(webhookUrl, 'payment_intent.payment_failed', { id: 'pi_x', metadata: { order_id: String(o2.id) }, last_payment_error: { message: 'Votre carte a été refusée.' } });
    assert.deepEqual([(await orderBySession(sid2)).status, (await orderBySession(sid2)).failure_message], ['failed', 'Votre carte a été refusée.']);
    await webhook(webhookUrl, 'payment_intent.payment_failed', { id: 'pi_y', metadata: { order_id: String(order.id) } });
    assert.equal((await orderBySession(sid)).status, 'paid');
    const sid3 = await startCheckout(f, { email: 'gone@mail.fr' });
    await webhook(webhookUrl, 'checkout.session.expired', { id: sid3 });
    assert.equal((await orderBySession(sid3)).status, 'canceled');
    assert.equal((await api.get('/api/orders?status=canceled')).body.total, 1);

    // no signing secret configured → refused
    await api.put('/api/payments/settings', { webhook_secret: null });
    assert.equal((await webhook(webhookUrl, 'checkout.session.completed', { id: sid })).status, 400);
  });
});

describe('refunds', () => {
  test('full refund from the UI: Stripe refund, status, tag removed (optional), hooks; webhook is then a no-op', async () => {
    const { api, webhookUrl } = await seller();
    const prod = await product(api, { name: 'Formation', tag_name: 'client', prices: [oneTime(9700)] });
    const keep = await product(api, { name: 'Ebook', tag_name: 'lecteur', revoke_on_refund: false, prices: [oneTime(1900)] });
    const f = await funnel(api, { offerId: prod.prices[0].id, bumpOfferId: keep.prices[0].id });
    const { sid } = await buy(f, { email: 'refund@mail.fr', bump: '1' });
    const order = await orderBySession(sid);
    assert.deepEqual(await tagsOf(api, order.contact_id!), ['client', 'lecteur']);

    hookCalls.length = 0;
    assert.equal((await api.post(`/api/orders/${order.id}/refund`, { amount: 999999 })).status, 400);
    stripe.refundError = 'Charge already refunded';
    assert.equal((await api.post(`/api/orders/${order.id}/refund`, {})).status, 502);
    stripe.refundError = null;

    // partial: still paid, access kept
    const partial = await api.post(`/api/orders/${order.id}/refund`, { amount: 1600 });
    assert.equal(partial.status, 200, partial.text);
    assert.deepEqual([partial.body.status, partial.body.amount_refunded], ['paid', 1600]);
    assert.deepEqual(await tagsOf(api, order.contact_id!), ['client', 'lecteur']);

    // the rest: refunded, the product's tag is removed — except for the product that keeps it
    const full = await api.post(`/api/orders/${order.id}/refund`, {});
    assert.deepEqual([full.body.status, full.body.amount_refunded, full.body.amount_paid], ['refunded', 11600, 11600]);
    assert.ok(full.body.refunded_at);
    assert.deepEqual(stripe.refunds.filter((r) => r.payment_intent === order.stripe_payment_intent_id).map((r) => r.amount), [1600, 10000]);
    assert.deepEqual(await tagsOf(api, order.contact_id!), ['lecteur']);
    assert.deepEqual(hookCalls.map((h) => [h.event, h.amount, h.full, h.status]), [['refunded', 1600, false, 'paid'], ['refunded', 10000, true, 'refunded']]);
    assert.equal((await api.post(`/api/orders/${order.id}/refund`, {})).status, 409);

    // Stripe's own notification of the same refund changes nothing
    const ev = await webhook(webhookUrl, 'charge.refunded', { id: 'ch_1', payment_intent: order.stripe_payment_intent_id, amount: 11600, amount_refunded: 11600, refunded: true });
    assert.equal(ev.body.result, 'processed');
    assert.equal(hookCalls.length, 2);
    assert.equal((await api.get(`/api/orders/${order.id}`)).body.amount_refunded, 11600);

    // refund made in the Stripe dashboard (webhook only); `revoke: false` keeps the access
    const b2 = await buy(f, { email: 'dash@mail.fr' });
    const o2 = await orderBySession(b2.sid);
    await webhook(webhookUrl, 'charge.refunded', { id: 'ch_2', payment_intent: o2.stripe_payment_intent_id, amount: 9700, amount_refunded: 9700, refunded: true });
    assert.equal((await orderBySession(b2.sid)).status, 'refunded');
    assert.deepEqual(await tagsOf(api, o2.contact_id!), []);
    const b3 = await buy(f, { email: 'keep@mail.fr' });
    const o3 = await orderBySession(b3.sid);
    assert.equal((await api.post(`/api/orders/${o3.id}/refund`, { revoke: false })).body.status, 'refunded');
    assert.deepEqual(await tagsOf(api, o3.contact_id!), ['client']);

    // bought twice, one refund: the other order still grants the tag
    const b4 = await buy(f, { email: 'twice@mail.fr' });
    const b5 = await buy(f, { email: 'twice@mail.fr' });
    const o4 = await orderBySession(b4.sid);
    assert.equal((await orderBySession(b5.sid)).contact_id, o4.contact_id);
    await api.post(`/api/orders/${o4.id}/refund`, {});
    assert.deepEqual(await tagsOf(api, o4.contact_id!), ['client']);

    // revenue: payments − refunds
    const stats = (await api.get('/api/sales/stats?days=7')).body;
    assert.equal(stats.totals.length, 1);
    const paidTotal = 11600 + 9700 * 4;
    const refundedTotal = 11600 + 9700 * 3;
    assert.deepEqual([stats.totals[0].currency, stats.totals[0].revenue, stats.totals[0].refunds, stats.totals[0].net, stats.totals[0].orders], ['eur', paidTotal, refundedTotal, paidTotal - refundedTotal, 5]);
    assert.equal(stats.daily.length, 7);
    assert.equal(stats.daily[6].revenue, paidTotal - refundedTotal);
    assert.equal((await api.get('/api/sales/stats?from=2030-01-01T00:00:00Z&to=2020-01-01T00:00:00Z')).status, 400);
  });
});

describe('subscriptions & installments', () => {
  test('subscription: Checkout in subscription mode, renewals recorded, cancellation removes the access', async () => {
    const { api, webhookUrl } = await seller();
    const prod = await product(api, { name: 'Club', tag_name: 'membre', prices: [{ type: 'subscription', amount: 2900, currency: 'eur', interval: 'month' }] });
    const f = await funnel(api, { offerId: prod.prices[0].id });
    assert.match((await http(ctx, 'GET', f.order)).text, /29,00\s€ \/ mois/);
    const { sid } = await buy(f, { email: 'sub@mail.fr' });
    const p = stripe.sessionParams.get(sid)!;
    assert.equal(p.mode, 'subscription');
    assert.deepEqual(p.line_items[0].recurring, { interval: 'month' });
    let order = await orderBySession(sid);
    assert.deepEqual([order.status, order.subscription_status, order.amount_paid], ['paid', 'active', 2900]);
    assert.ok(order.stripe_subscription_id && order.stripe_payment_method_id);
    assert.deepEqual(await tagsOf(api, order.contact_id!), ['membre']);
    const sub = order.stripe_subscription_id!;

    // the first invoice is the payment already recorded; the next ones add up
    hookCalls.length = 0;
    const session = stripe.sessions.get(sid)!;
    const first = session.invoice as { id: string };
    await webhook(webhookUrl, 'invoice.paid', { id: first.id, amount_paid: 2900, currency: 'eur', subscription: sub, payment_intent: 'pi_first', billing_reason: 'subscription_create' });
    assert.equal((await orderBySession(sid)).amount_paid, 2900);
    const renewal = { id: 'in_renew_1', amount_paid: 2900, currency: 'eur', subscription: sub, payment_intent: 'pi_renew_1', billing_reason: 'subscription_cycle' };
    await webhook(webhookUrl, 'invoice.paid', renewal);
    await webhook(webhookUrl, 'invoice.paid', renewal); // other event id, same invoice
    order = await orderBySession(sid);
    assert.equal(order.amount_paid, 5800);
    assert.deepEqual(hookCalls.map((h) => [h.event, h.amount]), [['subscription_payment', 2900]]);
    assert.equal((await api.get('/api/orders?status=subscription')).body.total, 1);
    assert.equal((await api.get('/api/sales/stats')).body.active_subscriptions, 1);

    await webhook(webhookUrl, 'invoice.payment_failed', { id: 'in_x', subscription: sub });
    assert.equal((await orderBySession(sid)).subscription_status, 'past_due');
    await webhook(webhookUrl, 'customer.subscription.updated', { id: sub, status: 'active' });
    assert.equal((await orderBySession(sid)).subscription_status, 'active');

    await webhook(webhookUrl, 'customer.subscription.deleted', { id: sub, status: 'canceled' });
    order = await orderBySession(sid);
    assert.deepEqual([order.status, order.subscription_status], ['paid', 'canceled']);
    assert.deepEqual(await tagsOf(api, order.contact_id!), []);
    assert.equal(hookCalls.at(-1)!.event, 'subscription_canceled');

    // cancelled from the UI
    const b2 = await buy(f, { email: 'sub2@mail.fr' });
    const o2 = await orderBySession(b2.sid);
    const cancel = await api.post(`/api/orders/${o2.id}/cancel-subscription`, {});
    assert.equal(cancel.status, 200, cancel.text);
    assert.equal(cancel.body.subscription_status, 'canceled');
    assert.ok(stripe.canceled.includes(o2.stripe_subscription_id!));
    assert.deepEqual(await tagsOf(api, o2.contact_id!), []);
    assert.equal((await api.post(`/api/orders/${o2.id}/cancel-subscription`, {})).status, 409);

    // invoice paid before the session event (order still pending): it pays the order
    const sid3 = await startCheckout(f, { email: 'early@mail.fr' });
    const o3 = await orderBySession(sid3);
    await webhook(webhookUrl, 'invoice.paid', { id: 'in_early', amount_paid: 2900, currency: 'eur', subscription: 'sub_early', customer: 'cus_early', payment_intent: 'pi_early', subscription_details: { metadata: { order_id: String(o3.id) } } });
    const paid3 = await orderBySession(sid3);
    assert.deepEqual([paid3.status, paid3.subscription_status, paid3.stripe_subscription_id, paid3.amount_paid], ['paid', 'active', 'sub_early', 2900]);
  });

  test('installments: the plan ends by itself after the last payment and the buyer keeps the product', async () => {
    const { api, webhookUrl } = await seller();
    const prod = await product(api, { name: 'Formation', tag_name: 'client', prices: [{ type: 'installments', amount: 3300, currency: 'eur', installments: 2 }] });
    const f = await funnel(api, { offerId: prod.prices[0].id });
    assert.match((await http(ctx, 'GET', f.order)).text, /2 × 33,00\s€/);
    const { sid } = await buy(f, { email: 'x2@mail.fr' });
    let order = await orderBySession(sid);
    const sub = order.stripe_subscription_id!;
    assert.deepEqual([order.subscription_status, order.amount_paid], ['active', 3300]);
    assert.ok(!stripe.canceled.includes(sub));

    await webhook(webhookUrl, 'invoice.paid', { id: 'in_2nd', amount_paid: 3300, currency: 'eur', subscription: sub, payment_intent: 'pi_2nd', billing_reason: 'subscription_cycle' });
    assert.ok(stripe.canceled.includes(sub), 'last installment paid → subscription cancelled at Stripe');
    order = await orderBySession(sid);
    assert.deepEqual([order.subscription_status, order.amount_paid], ['completed', 6600]);
    await webhook(webhookUrl, 'customer.subscription.deleted', { id: sub, status: 'canceled' });
    assert.equal((await orderBySession(sid)).subscription_status, 'completed');
    assert.deepEqual(await tagsOf(api, order.contact_id!), ['client'], 'access kept');
  });
});

describe('public API v1', () => {
  test('products and orders are readable with the sales:read scope only', async () => {
    const { api, userId } = await seller();
    const prod = await product(api, { name: 'Formation', prices: [oneTime(9700)] });
    const f = await funnel(api, { offerId: prod.prices[0].id });
    const { sid } = await buy(f, { email: 'api@mail.fr' });
    const order = await orderBySession(sid);
    const token = await v1Token(userId, ['sales:read']);
    const products = await http(ctx, 'GET', '/api/v1/products', { token });
    assert.equal(products.status, 200, products.text);
    assert.equal(products.body[0].prices[0].amount, 9700);
    const orders = await http(ctx, 'GET', '/api/v1/orders?status=paid', { token });
    assert.deepEqual([orders.body.total, orders.body.items[0].email, orders.body.items[0].amount_total, orders.body.limit], [1, 'api@mail.fr', 9700, 50]);
    const one = await http(ctx, 'GET', `/api/v1/orders/${order.id}`, { token });
    assert.equal(one.body.transactions.length, 1);
    assert.ok(!/cus_test|pm_test|pi_test|sk_test/.test(orders.text + one.text + products.text));
    const noScope = await v1Token(userId, ['contacts:read']);
    assert.equal((await http(ctx, 'GET', '/api/v1/orders', { token: noScope })).status, 403);
    assert.equal((await http(ctx, 'GET', '/api/v1/products', { token: noScope })).status, 403);
    const other = await seller();
    assert.equal((await http(ctx, 'GET', `/api/v1/orders/${order.id}`, { token: await v1Token(other.userId, ['sales:read']) })).status, 404);
  });
});

describe('extension point', () => {
  test('a failing hook never blocks the payment; what a hook writes is committed with the order', async () => {
    const { api } = await seller();
    const prod = await product(api, { name: 'Formation', prices: [oneTime(9700)] });
    const f = await funnel(api, { offerId: prod.prices[0].id });
    const marker = (await api.post('/api/tags', { name: 'commission' })).body;
    const off1 = registerOrderHook('boom', async (_c, trx) => {
      await trx.insertInto('contact_tags').values({ contact_id: -1, tag_id: -1, created_at: new Date().toISOString() }).execute(); // FK violation
    });
    const off2 = registerOrderHook('writer', async (c, trx) => {
      if (c.event === 'paid') await trx.insertInto('contact_tags').values({ contact_id: c.order.contact_id!, tag_id: marker.id, created_at: new Date().toISOString() }).execute();
    });
    try {
      const { sid } = await buy(f, { email: 'hooks@mail.fr' });
      const order = await orderBySession(sid);
      assert.equal(order.status, 'paid');
      assert.deepEqual(await tagsOf(api, order.contact_id!), ['commission']);
    } finally {
      off1();
      off2();
    }
  });
});
