// Affiliate program: settings, tracking cookie (attribution model, expiry, opaque), clicks, leads, commissions through
// the order hooks (percent / fixed / product and affiliate overrides, recurring, upsells, self-referral, suspension),
// refunds before and after validation / payout, idempotency, validation by the worker, payouts and balances, tenant
// isolation, affiliate area (signup, magic link, data limited to the affiliate). Stripe is a fake: no network.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sql } from 'kysely';
import { roleAllows } from '../src/access';
import { db } from '../src/db';
import { affCookieName, commissionAmount, decodeAffCookie, encodeAffCookie } from '../src/services/affiliates';
import { settleLoginLinks } from '../src/services/members';
import { markOrderPaid } from '../src/services/payments';
import { signStripePayload } from '../src/services/stripe';
import { EmailWorker } from '../src/worker';
import { FakeStripe } from './fake-stripe';
import { client, http, registerUser, shutdown, startApp, type TestCtx } from './helpers';

// ---------- harness ----------

let ctx: TestCtx;
const stripe = new FakeStripe();
before(async () => {
  ctx = await startApp({ stripe: stripe.factory });
});
after(async () => {
  await shutdown(ctx);
});
beforeEach(async () => {
  await db.deleteFrom('auth_attempts').execute(); // rate limits (per IP)
});

type Api = ReturnType<typeof client>;
const SK = `sk_test_${'a1B2'.repeat(6)}9f3Q`;
const PK = `pk_test_${'c3D4'.repeat(6)}`;
const WH = `whsec_${'e5F6'.repeat(8)}`;
const DAY = 86400_000;
const schedulers = () => new EmailWorker({ throttle: false }).runSchedulers();

let seq = 0;
async function seller(programPatch: Record<string, unknown> | null = {}) {
  const reg = await registerUser(ctx, `Boutique ${++seq}`);
  const api = client(ctx, reg.token);
  const r = await api.put('/api/payments/settings', { secret_key: SK, publishable_key: PK, webhook_secret: WH });
  assert.equal(r.status, 200, r.text);
  const webhookUrl = new URL(r.body.webhook_url).pathname;
  let slug = '';
  if (programPatch) {
    const p = await api.put('/api/affiliation/settings', { enabled: true, ...programPatch });
    assert.equal(p.status, 200, p.text);
    slug = p.body.slug;
  }
  return { api, userId: reg.user.id, token: reg.token, webhookUrl, slug, home: `/a/${slug}` };
}
type Seller = Awaited<ReturnType<typeof seller>>;

async function product(api: Api, body: Record<string, unknown>) {
  const r = await api.post('/api/products', body);
  assert.equal(r.status, 201, r.text);
  return r.body as { id: number; prices: { id: number }[] };
}
/** 120,00 € TTC, VAT 20 % included → 100,00 € excluding tax. */
const ttc120 = { type: 'one_time', amount: 12000, currency: 'eur', tax_rate: 20, tax_inclusive: true };

/** Funnel with 3 steps: order form → one-click offer → thank you. */
async function funnel(api: Api, offerId: number, upsellOfferId?: number) {
  const f = (await api.post('/api/funnels', { name: `Vente ${++seq}`, template: 'sales' })).body;
  const [s1, s2, s3] = f.steps as { id: number; slug: string }[];
  await api.patch(`/api/steps/${s1.id}`, { content: { settings: {}, blocks: [{ id: 'pay1', type: 'checkout', submitLabel: 'Commander', offerId }, { id: 'f1', type: 'form', submitLabel: 'Go', fields: [{ name: 'email', label: 'Email' }] }] } });
  await api.patch(`/api/steps/${s2.id}`, { content: { settings: {}, blocks: [{ id: 'up1', type: 'upsell', acceptLabel: 'Oui', declineLabel: 'Non', ...(upsellOfferId ? { offerId: upsellOfferId } : {}) }] } });
  await api.patch(`/api/steps/${s3.id}`, { content: { settings: {}, blocks: [{ id: 't', type: 'text', text: 'Merci' }] } });
  const base = `/p/${f.slug}`;
  return { id: f.id as number, base, order: `${base}/${s1.slug}`, offer: `${base}/${s2.slug}`, thanks: `${base}/${s3.slug}` };
}
type Funnel = Awaited<ReturnType<typeof funnel>>;

async function affiliate(api: Api, email: string, extra: Record<string, unknown> = {}) {
  const r = await api.post('/api/affiliation/affiliates', { email, ...extra });
  assert.equal(r.status, 201, r.text);
  return r.body as { id: number; code: string; contact_id: number; status: string };
}

type Jar = Record<string, string>;
/** Visits the order page through an affiliate link; returns the visitor's cookies. */
async function click(f: Funnel, code: string, jar: Jar = {}): Promise<Jar> {
  const r = await http(ctx, 'GET', `${f.order}?aff=${code}`, { cookies: jar });
  assert.equal(r.status, 200, r.text);
  return { ...jar, ...r.cookies };
}

/** The page's script sends the order form: order created, Stripe Elements gets its client secret. */
async function startCheckout(f: Funnel, email: string, jar: Jar = {}) {
  const r = await http(ctx, 'POST', `${f.order}/checkout`, { json: { _block: 'pay1', email }, cookies: jar });
  assert.equal(r.status, 200, r.text);
  return { ...(r.body as { o: string; clientSecret: string; returnUrl: string }), oid: Number(String(r.body.o).split('.')[0]) };
}
const pathOf = (url: string) => {
  const u = new URL(url);
  return u.pathname + u.search;
};
const orderById = (id: number) => db.selectFrom('orders').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

/** Order form → payment confirmed in Stripe Elements → return to the funnel. */
async function buy(f: Funnel, email: string, jar: Jar = {}) {
  const s = await startCheckout(f, email, jar);
  stripe.confirm(s.clientSecret);
  const back = await http(ctx, 'GET', pathOf(s.returnUrl), { cookies: jar });
  assert.equal(back.status, 303, back.text);
  return { ...s, order: await orderById(s.oid), jar: { ...jar, ...back.cookies } };
}

const commissionsOf = (orderId: number) => db.selectFrom('affiliate_commissions').selectAll().where('order_id', '=', orderId).orderBy('id').execute();
const summary = (rows: { kind: string; amount: number; status: string }[]) => rows.map((r) => [r.kind, r.amount, r.status]);
const makeDue = (orderId: number) => db.updateTable('affiliate_commissions').set({ approve_at: sql`now() - interval '1 minute'` }).where('order_id', '=', orderId).where('status', '=', 'pending').execute();
const balance = async (api: Api, affiliateId: number) => (await api.get(`/api/affiliation/affiliates/${affiliateId}`)).body.balances as { currency: string; pending: number; approved: number; paid: number }[];

let evt = 0;
async function webhook(path: string, type: string, object: Record<string, unknown>, id?: string) {
  const payload = JSON.stringify({ id: id ?? `evt_aff_${++evt}_${crypto.randomBytes(4).toString('hex')}`, type, livemode: false, data: { object } });
  const res = await fetch(ctx.base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signStripePayload(payload, WH) }, body: payload });
  return { status: res.status, body: (await res.json()) as { result?: string } };
}

const tokenOf = (html: string | null) => /\/auth\/([\w-]{20,})/.exec(html ?? '')?.[1] ?? '';
/** Token of the last magic-link email queued for the account ('' when none was queued since `since`). */
async function lastLink(userId: number, since: number) {
  await settleLoginLinks();
  const s = await db.selectFrom('email_sends').selectAll().where('user_id', '=', userId).where('id', '>', since).where('kind', '=', 'confirmation').orderBy('id', 'desc').executeTakeFirst();
  return { token: tokenOf(s?.html ?? null), send: s ?? null };
}
const lastSendId = async (userId: number) => (await db.selectFrom('email_sends').select((eb) => eb.fn.max('id').as('m')).where('user_id', '=', userId).executeTakeFirst())?.m ?? 0;

/** Logs an existing affiliate in; returns the session cookie jar. */
async function login(s: Seller, email: string): Promise<Jar> {
  const since = await lastSendId(s.userId);
  assert.equal((await http(ctx, 'POST', `${s.home}/login`, { form: { email } })).status, 200);
  const { token } = await lastLink(s.userId, since);
  assert.ok(token, 'login email queued');
  const r = await http(ctx, 'POST', `${s.home}/auth/${token}`);
  assert.equal(r.status, 303, r.text);
  assert.ok(r.cookies.scalo_affiliate);
  return { scalo_affiliate: r.cookies.scalo_affiliate };
}

// ---------- tests ----------

describe('program settings', () => {
  test('defaults, validation, product / offer overrides, roles, isolation', async () => {
    const s = await seller(null);
    const d = (await s.api.get('/api/affiliation/settings')).body;
    assert.deepEqual(
      [d.enabled, d.commission, d.recurring, d.recurring_months, d.cookie_days, d.attribution, d.validation_days, d.min_payout, d.signup_mode, d.rules],
      [false, { type: 'percent', value: 30 }, true, null, 30, 'last_click', 30, 0, 'approval', []],
    );
    assert.match(d.url, new RegExp(`/a/${d.slug}$`));

    const bad = (b: unknown) => s.api.put('/api/affiliation/settings', b);
    assert.equal((await bad({ commission: { type: 'percent', value: 120 } })).status, 400);
    assert.equal((await bad({ commission: { type: 'fixed', value: -1 } })).status, 400);
    assert.equal((await bad({ cookie_days: 0 })).status, 400);
    assert.equal((await bad({ attribution: 'random' })).status, 400);
    assert.equal((await bad({ slug: 'Pas Valide !' })).status, 400);
    assert.equal((await bad({ unknown: 1 })).status, 400);

    const p = await product(s.api, { name: 'Formation', prices: [ttc120, { ...ttc120, name: 'VIP', amount: 24000 }] });
    const saved = await s.api.put('/api/affiliation/settings', {
      enabled: true,
      commission: { type: 'fixed', value: 1500 },
      recurring: false,
      cookie_days: 60,
      attribution: 'first_click',
      validation_days: 14,
      min_payout: 5000,
      signup_mode: 'open',
      terms: 'Pas de publicité sur la marque.',
      rules: [{ product_id: p.id, commission: { type: 'percent', value: 50 } }, { product_id: p.id, price_id: p.prices[1].id, commission: { type: 'fixed', value: 4000 } }],
    });
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual([saved.body.commission, saved.body.cookie_days, saved.body.attribution, saved.body.min_payout, saved.body.signup_mode], [{ type: 'fixed', value: 1500 }, 60, 'first_click', 5000, 'open']);
    assert.deepEqual(saved.body.rules.map((r: any) => [r.product_name, r.price_id, r.commission]), [['Formation', null, { type: 'percent', value: 50 }], ['Formation', p.prices[1].id, { type: 'fixed', value: 4000 }]]);
    assert.equal((await bad({ rules: [{ product_id: p.id, commission: { type: 'percent', value: 10 } }, { product_id: p.id, commission: { type: 'percent', value: 20 } }] })).status, 400);

    // another account: its own program, cannot reference this account's products nor take its address
    const other = await seller(null);
    assert.equal((await other.api.get('/api/affiliation/settings')).body.enabled, false);
    assert.equal((await other.api.put('/api/affiliation/settings', { rules: [{ product_id: p.id, commission: { type: 'percent', value: 10 } }] })).status, 404);
    assert.equal((await other.api.put('/api/affiliation/settings', { slug: saved.body.slug })).status, 409);
    assert.equal((await http(ctx, 'GET', '/api/affiliation/settings')).status, 401);

    // roles (generic rule of api/src/access.ts): an editor reads, but never changes the program nor records payouts
    assert.equal(roleAllows('editor', 'GET', '/affiliation/settings'), true);
    assert.equal(roleAllows('editor', 'PUT', '/affiliation/settings'), false);
    assert.equal(roleAllows('editor', 'POST', '/affiliation/payouts'), false);
    assert.equal(roleAllows('editor', 'POST', '/affiliation/payouts/batch'), false);
    assert.equal(roleAllows('viewer', 'PATCH', '/affiliation/affiliates/1'), false);
    assert.equal(roleAllows('editor', 'PATCH', '/affiliation/affiliates/1'), true);
    assert.equal(roleAllows('admin', 'PUT', '/affiliation/settings'), true);
    assert.equal(roleAllows('admin', 'POST', '/affiliation/payouts'), true);
  });
});

describe('affiliate link: cookie, attribution model, clicks', () => {
  test('cookie set on any funnel page, opaque and bound to the account; clicks deduplicated per visitor and day', async () => {
    const s = await seller();
    const p = await product(s.api, { name: 'Formation', prices: [ttc120] });
    const f = await funnel(s.api, p.prices[0].id);
    const a = await affiliate(s.api, 'alice@partenaires.fr', { first_name: 'Alice' });
    assert.equal(a.code, 'alice');
    assert.equal(a.status, 'approved');
    const name = affCookieName(s.userId);

    const r = await http(ctx, 'GET', `${f.order}?aff=ALICE`);
    assert.ok(r.cookies[name], 'cookie set');
    const setCookie = r.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))!;
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Max-Age=2592000/);
    const value = decodeURIComponent(r.cookies[name]);
    assert.ok(!value.includes('alice'), 'the code is not readable in the cookie');
    assert.equal(decodeAffCookie(s.userId, value)?.code, 'alice');
    assert.equal(decodeAffCookie(s.userId + 1, value), null, 'a cookie is worthless for another account');
    assert.equal(decodeAffCookie(s.userId, value.slice(0, -3) + 'AAA'), null, 'tampered cookie rejected');
    const jar = { ...r.cookies };

    // same visitor, same day: one click; any page of the funnel; another visitor: a second click
    await http(ctx, 'GET', `${f.thanks}?aff=alice`, { cookies: jar });
    await http(ctx, 'GET', `${f.order}?aff=alice`, { cookies: jar });
    await click(f, 'alice');
    const clicks = await db.selectFrom('affiliate_clicks').selectAll().where('affiliate_id', '=', a.id).execute();
    assert.equal(clicks.length, 2);
    assert.deepEqual(Object.keys(clicks[0]).sort(), ['affiliate_id', 'created_at', 'day', 'funnel_id', 'id', 'step_id', 'user_id', 'visitor_id'], 'no IP, no user agent');

    // the funnel's root keeps the code while redirecting to the first step
    const root = await http(ctx, 'GET', `${f.base}?aff=alice`);
    assert.equal(root.headers.get('location'), `${f.order}?aff=alice`);

    // unknown code, malformed code: same kind of response (an opaque cookie), no click — affiliates cannot be enumerated
    const unknown = await http(ctx, 'GET', `${f.order}?aff=nobody`);
    assert.ok(unknown.cookies[name]);
    assert.equal(unknown.status, 200);
    assert.equal((await http(ctx, 'GET', `${f.order}?aff=%3Cscript%3E`)).cookies[name], undefined);
    assert.equal((await db.selectFrom('affiliate_clicks').select('id').where('user_id', '=', s.userId).execute()).length, 2);
    // an unknown code never erases a valid referral
    const kept = await http(ctx, 'GET', `${f.order}?aff=nobody`, { cookies: jar });
    assert.equal(decodeAffCookie(s.userId, decodeURIComponent(kept.cookies[name]))?.code, 'alice');

    // preview pages and a disabled program do nothing
    await s.api.put('/api/affiliation/settings', { enabled: false });
    assert.equal((await http(ctx, 'GET', `${f.order}?aff=alice`)).cookies[name], undefined);

    // the code of an account means nothing on another account's funnel
    const other = await seller();
    const of = await funnel(other.api, (await product(other.api, { name: 'Autre', prices: [ttc120] })).prices[0].id);
    const foreign = await click(of, 'alice');
    assert.equal(foreign[name], undefined);
    assert.equal((await db.selectFrom('affiliate_clicks').select('id').where('user_id', '=', other.userId).execute()).length, 0);
  });

  test('last click (default) vs first click; expired cookie; suspended affiliate', async () => {
    const s = await seller();
    const p = await product(s.api, { name: 'Formation', prices: [ttc120] });
    const f = await funnel(s.api, p.prices[0].id);
    const a = await affiliate(s.api, 'anna@partenaires.fr');
    const b = await affiliate(s.api, 'bruno@partenaires.fr');

    // last click: B wins
    let jar = await click(f, b.code, await click(f, a.code));
    let o = (await buy(f, 'client1@mail.fr', jar)).order;
    assert.deepEqual((await commissionsOf(o.id)).map((c) => [c.affiliate_id, c.amount]), [[b.id, 3000]]);

    // first click: A is kept
    await s.api.put('/api/affiliation/settings', { attribution: 'first_click' });
    jar = await click(f, b.code, await click(f, a.code));
    o = (await buy(f, 'client2@mail.fr', jar)).order;
    assert.deepEqual((await commissionsOf(o.id)).map((c) => [c.affiliate_id, c.amount]), [[a.id, 3000]]);

    // cookie older than the program's lifetime: no attribution (checked by the server, not only by the browser)
    const name = affCookieName(s.userId);
    const old = { [name]: encodeURIComponent(encodeAffCookie(s.userId, { code: a.code, ts: Date.now() - 31 * DAY })) };
    o = (await buy(f, 'client3@mail.fr', old)).order;
    assert.deepEqual(await commissionsOf(o.id), []);
    const recent = { [name]: encodeURIComponent(encodeAffCookie(s.userId, { code: a.code, ts: Date.now() - 29 * DAY })) };
    o = (await buy(f, 'client4@mail.fr', recent)).order;
    assert.equal((await commissionsOf(o.id)).length, 1);
    // an expired first click no longer blocks a new one
    jar = await click(f, b.code, old);
    o = (await buy(f, 'client5@mail.fr', jar)).order;
    assert.deepEqual((await commissionsOf(o.id)).map((c) => c.affiliate_id), [b.id]);
    // forged cookie
    o = (await buy(f, 'client6@mail.fr', { [name]: 'v1.aaaa.bbbb.cccc' })).order;
    assert.deepEqual(await commissionsOf(o.id), []);

    // affiliate suspended after the click: no commission, no sale attributed
    jar = await click(f, a.code);
    const sus = await s.api.patch(`/api/affiliation/affiliates/${a.id}`, { status: 'suspended' });
    assert.equal(sus.body.status, 'suspended');
    o = (await buy(f, 'client7@mail.fr', jar)).order;
    assert.deepEqual(await commissionsOf(o.id), []);
    assert.equal((await s.api.get(`/api/affiliation/orders/${o.id}`)).body.affiliate, null);
    // and his link no longer records clicks
    const before = (await db.selectFrom('affiliate_clicks').select('id').where('affiliate_id', '=', a.id).execute()).length;
    await click(f, a.code);
    assert.equal((await db.selectFrom('affiliate_clicks').select('id').where('affiliate_id', '=', a.id).execute()).length, before);
  });
});

describe('commissions', () => {
  test('percent of the amount excluding tax, fixed, product / offer / affiliate overrides, timeline, mentions', async () => {
    const s = await seller();
    const p = await product(s.api, { name: 'Formation', prices: [ttc120] });
    const f = await funnel(s.api, p.prices[0].id);
    const a = await affiliate(s.api, 'claire@partenaires.fr');

    // default: 30 % of 100,00 € excluding tax (120,00 € collected)
    const jar = await click(f, a.code);
    const o1 = (await buy(f, 'acheteur@mail.fr', jar)).order;
    let rows = await commissionsOf(o1.id);
    assert.equal(rows.length, 1);
    assert.deepEqual(
      [rows[0].affiliate_id, rows[0].kind, rows[0].status, rows[0].currency, rows[0].base_amount, rows[0].rate_type, rows[0].rate_value, rows[0].amount, rows[0].amount_initial, rows[0].product_name],
      [a.id, 'sale', 'pending', 'eur', 10000, 'percent', 30, 3000, 3000, 'Formation'],
    );
    const delay = new Date(rows[0].approve_at).getTime() - new Date(rows[0].created_at).getTime();
    assert.ok(Math.abs(delay - 30 * DAY) < 60_000, 'payable after the validation delay');

    // mention on the order and on the buyer; timeline of the affiliate
    const mention = (await s.api.get(`/api/affiliation/orders/${o1.id}`)).body;
    assert.deepEqual([mention.affiliate.id, mention.affiliate.code, mention.commissions], [a.id, a.code, [{ currency: 'eur', amount: 3000, status: 'pending' }]]);
    assert.equal((await s.api.get(`/api/affiliation/contacts/${o1.contact_id}`)).body.affiliate.id, a.id);
    const self = (await s.api.get(`/api/affiliation/contacts/${a.contact_id}`)).body;
    assert.deepEqual([self.affiliate, self.is_affiliate.code], [null, a.code]);
    const events = (await s.api.get(`/api/contacts/${a.contact_id}`)).body.events as { type: string; data: any }[];
    assert.ok(events.some((e) => e.type === 'affiliate_joined' && e.data.code === a.code));
    const earned = events.find((e) => e.type === 'affiliate_commission')!;
    assert.deepEqual([earned.data.amount, earned.data.currency, earned.data.order_id], [30, 'eur', o1.id]);

    // fixed default: 15,00 € per line sold
    await s.api.put('/api/affiliation/settings', { commission: { type: 'fixed', value: 1500 } });
    const o2 = (await buy(f, 'acheteur2@mail.fr', jar)).order;
    assert.deepEqual((await commissionsOf(o2.id)).map((c) => [c.rate_type, c.amount]), [['fixed', 1500]]);

    // personal commission of the affiliate: 40 %
    const patched = await s.api.patch(`/api/affiliation/affiliates/${a.id}`, { commission: { type: 'percent', value: 40 } });
    assert.deepEqual(patched.body.commission, { type: 'percent', value: 40 });
    const o3 = (await buy(f, 'acheteur3@mail.fr', jar)).order;
    assert.deepEqual((await commissionsOf(o3.id)).map((c) => c.amount), [4000]);

    // product override beats the affiliate's rate; an offer override beats the product's
    await s.api.put('/api/affiliation/settings', { rules: [{ product_id: p.id, commission: { type: 'percent', value: 50 } }] });
    const o4 = (await buy(f, 'acheteur4@mail.fr', jar)).order;
    assert.deepEqual((await commissionsOf(o4.id)).map((c) => c.amount), [5000]);
    await s.api.put('/api/affiliation/settings', { rules: [{ product_id: p.id, commission: { type: 'percent', value: 50 } }, { product_id: p.id, price_id: p.prices[0].id, commission: { type: 'fixed', value: 700 } }] });
    const o5 = (await buy(f, 'acheteur5@mail.fr', jar)).order;
    assert.deepEqual((await commissionsOf(o5.id)).map((c) => [c.rate_type, c.amount]), [['fixed', 700]]);
    // 0 % on a product: the sale is attributed, nothing is earned
    await s.api.put('/api/affiliation/settings', { rules: [{ product_id: p.id, commission: { type: 'percent', value: 0 } }] });
    const o6 = (await buy(f, 'acheteur6@mail.fr', jar)).order;
    assert.deepEqual(await commissionsOf(o6.id), []);
    assert.equal((await s.api.get(`/api/affiliation/orders/${o6.id}`)).body.affiliate.id, a.id);

    // a buyer without affiliate cookie: nothing
    const o7 = (await buy(f, 'direct@mail.fr')).order;
    assert.deepEqual(await commissionsOf(o7.id), []);
    assert.equal((await s.api.get(`/api/affiliation/orders/${o7.id}`)).body.affiliate, null);

    // amounts never come from the client; a fixed commission never exceeds what was collected
    assert.equal(commissionAmount({ type: 'fixed', value: 5000 }, 1000), 1000);
    assert.equal(commissionAmount({ type: 'percent', value: 33.33 }, 999), 333);
    assert.equal(commissionAmount({ type: 'percent', value: 30 }, 0), 0);

    // list, filters, stats
    const list = (await s.api.get(`/api/affiliation/commissions?affiliate_id=${a.id}&status=pending`)).body;
    assert.equal(list.total, 5);
    assert.deepEqual([list.items[0].affiliate_code, list.items[0].order_id], [a.code, o5.id]);
    const det = (await s.api.get(`/api/affiliation/affiliates/${a.id}`)).body;
    assert.deepEqual([det.stats.clicks, det.stats.sales, det.stats.conversion], [1, 6, 6]);
    assert.deepEqual(det.balances, [{ currency: 'eur', pending: 3000 + 1500 + 4000 + 5000 + 700, approved: 0, paid: 0 }]);
    assert.match(det.link, new RegExp(`\\?aff=${a.code}$`));
  });

  test('no self-referral, no commission on a free order, lead attributed on optin', async () => {
    const s = await seller();
    const p = await product(s.api, { name: 'Formation', prices: [ttc120] });
    const f = await funnel(s.api, p.prices[0].id);
    const a = await affiliate(s.api, 'dora@partenaires.fr');
    const jar = await click(f, a.code);

    // the affiliate buys through his own link (same address, or a +alias of it)
    for (const email of ['dora@partenaires.fr', 'Dora+promo@partenaires.fr']) {
      const o = (await buy(f, email, jar)).order;
      assert.deepEqual(await commissionsOf(o.id), []);
      assert.equal((await s.api.get(`/api/affiliation/orders/${o.id}`)).body.affiliate, null);
    }

    // order paid with nothing collected: sale attributed, no commission
    const pending = await orderById((await startCheckout(f, 'gratuit@mail.fr', jar)).oid);
    await markOrderPaid(s.userId, pending.id, { amount: 0, transactionKey: 'free_1' });
    assert.deepEqual(await commissionsOf(pending.id), []);

    // optin through the affiliate's link: a lead (statistics only); his own optin is not a lead
    const submit = (email: string) => http(ctx, 'POST', `${f.order}/submit`, { form: { email, _block: 'f1' }, cookies: jar });
    assert.equal((await submit('prospect@mail.fr')).status, 303);
    assert.equal((await submit('prospect@mail.fr')).status, 303);
    assert.equal((await submit('dora@partenaires.fr')).status, 303);
    assert.equal((await http(ctx, 'POST', `${f.order}/submit`, { form: { email: 'sanslien@mail.fr', _block: 'f1' } })).status, 303);
    const leads = await db.selectFrom('affiliate_referrals').selectAll().where('affiliate_id', '=', a.id).where('kind', '=', 'lead').execute();
    assert.equal(leads.length, 1);
    const det = (await s.api.get(`/api/affiliation/affiliates/${a.id}`)).body;
    assert.deepEqual([det.stats.leads, det.balances], [1, []]);
    assert.equal((await s.api.get(`/api/affiliation/contacts/${leads[0].contact_id}`)).body.affiliate.id, a.id);
  });

  test('idempotency: webhook replays and the return page never create a second commission', async () => {
    const s = await seller();
    const p = await product(s.api, { name: 'Formation', prices: [ttc120] });
    const f = await funnel(s.api, p.prices[0].id);
    const a = await affiliate(s.api, 'emma@partenaires.fr');
    const jar = await click(f, a.code);
    const started = await startCheckout(f, 'rejeu@mail.fr', jar);
    const { pi } = stripe.confirm(started.clientSecret);
    const order = await orderById(started.oid);
    const event = { ...pi, metadata: { order_id: String(order.id) } };

    assert.equal((await webhook(s.webhookUrl, 'payment_intent.succeeded', event, 'evt_once')).body.result, 'processed');
    assert.equal((await webhook(s.webhookUrl, 'payment_intent.succeeded', event, 'evt_once')).body.result, 'duplicate');
    assert.equal((await webhook(s.webhookUrl, 'payment_intent.succeeded', event)).body.result, 'processed');
    await http(ctx, 'GET', pathOf(started.returnUrl), { cookies: jar });
    assert.deepEqual(summary(await commissionsOf(order.id)), [['sale', 3000, 'pending']]);
    assert.equal((await db.selectFrom('affiliate_referrals').select('id').where('order_id', '=', order.id).execute()).length, 1);
    assert.equal((await db.selectFrom('contact_events').select('id').where('contact_id', '=', a.contact_id).where('type', '=', 'affiliate_commission').execute()).length, 1);
  });

  test('upsell: inherits the affiliate of the original order', async () => {
    const s = await seller();
    const main = await product(s.api, { name: 'Formation', prices: [ttc120] });
    const extra = await product(s.api, { name: 'Coaching', prices: [{ type: 'one_time', amount: 20000, currency: 'eur' }] });
    const f = await funnel(s.api, main.prices[0].id, extra.prices[0].id);
    const a = await affiliate(s.api, 'fanny@partenaires.fr');
    const b = await affiliate(s.api, 'gilles@partenaires.fr');
    const bought = await buy(f, 'upsell@mail.fr', await click(f, a.code));
    // the buyer then comes across another affiliate's link: the one-click offer still belongs to the first one
    const jar = await click(f, b.code, bought.jar);
    const yes = await http(ctx, 'POST', `${f.offer}/upsell`, { form: { _block: 'up1' }, cookies: jar });
    assert.equal(yes.headers.get('location'), f.thanks);
    const up = await db.selectFrom('orders').selectAll().where('parent_order_id', '=', bought.order.id).executeTakeFirstOrThrow();
    assert.equal(up.status, 'paid');
    assert.deepEqual((await commissionsOf(up.id)).map((c) => [c.affiliate_id, c.base_amount, c.amount, c.product_name]), [[a.id, 20000, 6000, 'Coaching']]);
    assert.equal((await s.api.get(`/api/affiliation/orders/${up.id}`)).body.affiliate.id, a.id);

    // an upsell of an order without affiliate has none either
    const direct = await buy(f, 'direct-upsell@mail.fr');
    await http(ctx, 'POST', `${f.offer}/upsell`, { form: { _block: 'up1' }, cookies: await click(f, b.code, direct.jar) });
    const up2 = await db.selectFrom('orders').selectAll().where('parent_order_id', '=', direct.order.id).executeTakeFirstOrThrow();
    assert.deepEqual(await commissionsOf(up2.id), []);
  });

  test('recurring: subscription payments (on / off / limited in time), installments always', async () => {
    const s = await seller();
    const sub = await product(s.api, { name: 'Club', prices: [{ type: 'subscription', amount: 3000, currency: 'eur', interval: 'month' }] });
    const f = await funnel(s.api, sub.prices[0].id);
    const a = await affiliate(s.api, 'hugo@partenaires.fr');
    const jar = await click(f, a.code);
    const { order } = await buy(f, 'abonne@mail.fr', jar);
    assert.deepEqual(summary(await commissionsOf(order.id)), [['sale', 900, 'pending']]);
    const subId = order.stripe_subscription_id!;
    const invoice = (n: number) => ({ id: `in_renew_${order.id}_${n}`, amount_paid: 3000, currency: 'eur', subscription: subId, payment_intent: `pi_renew_${order.id}_${n}`, billing_reason: 'subscription_cycle' });

    // the first invoice is the payment already commissioned; each renewal earns once, replays included
    const firstInvoice = stripe.subs.get(subId)!.latest_invoice as string;
    await webhook(s.webhookUrl, 'invoice.paid', { id: firstInvoice, amount_paid: 3000, currency: 'eur', subscription: subId, payment_intent: 'pi_first', billing_reason: 'subscription_create' });
    await webhook(s.webhookUrl, 'invoice.paid', invoice(1));
    await webhook(s.webhookUrl, 'invoice.paid', invoice(1));
    assert.deepEqual(summary(await commissionsOf(order.id)), [['sale', 900, 'pending'], ['recurring', 900, 'pending']]);

    // limited to N months after the order
    await s.api.put('/api/affiliation/settings', { recurring_months: 3 });
    await webhook(s.webhookUrl, 'invoice.paid', invoice(2));
    assert.equal((await commissionsOf(order.id)).length, 3);
    await db.updateTable('orders').set({ paid_at: new Date(Date.now() - 120 * DAY).toISOString() }).where('id', '=', order.id).execute();
    await webhook(s.webhookUrl, 'invoice.paid', invoice(3));
    assert.equal((await commissionsOf(order.id)).length, 3, 'beyond the recurring period');

    // recurring commissions off: only the first payment
    await s.api.put('/api/affiliation/settings', { recurring: false, recurring_months: null });
    await webhook(s.webhookUrl, 'invoice.paid', invoice(4));
    assert.equal((await commissionsOf(order.id)).length, 3);
    assert.equal((await orderById(order.id)).amount_paid, 3000 * 5);

    // affiliate suspended: renewals earn nothing either
    await s.api.put('/api/affiliation/settings', { recurring: true });
    await s.api.patch(`/api/affiliation/affiliates/${a.id}`, { status: 'suspended' });
    await webhook(s.webhookUrl, 'invoice.paid', invoice(5));
    assert.equal((await commissionsOf(order.id)).length, 3);
    await s.api.patch(`/api/affiliation/affiliates/${a.id}`, { status: 'approved' });

    // installments are one sale paid in several times: every payment earns, even with recurring commissions off
    await s.api.put('/api/affiliation/settings', { recurring: false });
    const plan = await product(s.api, { name: 'Formation x2', prices: [{ type: 'installments', amount: 10000, currency: 'eur', installments_min: 2, installments_max: 2 }] });
    const f2 = await funnel(s.api, plan.prices[0].id);
    const b2 = await buy(f2, 'x2@mail.fr', await click(f2, a.code));
    const sub2 = b2.order.stripe_subscription_id!;
    await webhook(s.webhookUrl, 'invoice.paid', { id: 'in_2nd_aff', amount_paid: 5000, currency: 'eur', subscription: sub2, payment_intent: 'pi_2nd_aff', billing_reason: 'subscription_cycle' });
    assert.deepEqual(summary(await commissionsOf(b2.order.id)), [['sale', 1500, 'pending'], ['recurring', 1500, 'pending']]);
  });
});

describe('validation, refunds, payouts', () => {
  test('pending → approved by the worker once the delay is over', async () => {
    const s = await seller();
    const p = await product(s.api, { name: 'Formation', prices: [ttc120] });
    const f = await funnel(s.api, p.prices[0].id);
    const a = await affiliate(s.api, 'ines@partenaires.fr');
    const o = (await buy(f, 'delai@mail.fr', await click(f, a.code))).order;
    await schedulers();
    assert.deepEqual(summary(await commissionsOf(o.id)), [['sale', 3000, 'pending']], 'still within the validation delay');
    assert.deepEqual(await balance(s.api, a.id), [{ currency: 'eur', pending: 3000, approved: 0, paid: 0 }]);
    await makeDue(o.id);
    await schedulers();
    const [row] = await commissionsOf(o.id);
    assert.deepEqual([row.status, !!row.approved_at], ['approved', true]);
    assert.deepEqual(await balance(s.api, a.id), [{ currency: 'eur', pending: 0, approved: 3000, paid: 0 }]);

    // validation delay of 0 day: payable at the next round
    await s.api.put('/api/affiliation/settings', { validation_days: 0 });
    const o2 = (await buy(f, 'delai0@mail.fr', await click(f, a.code))).order;
    await schedulers();
    assert.equal((await commissionsOf(o2.id))[0].status, 'approved');
  });

  test('refunds: full / partial before validation, after validation, after payout (negative balance carried over)', async () => {
    const s = await seller();
    const p = await product(s.api, { name: 'Formation', prices: [ttc120] });
    const f = await funnel(s.api, p.prices[0].id);
    const a = await affiliate(s.api, 'jade@partenaires.fr');
    const jar = await click(f, a.code);
    const sale = async (email: string) => (await buy(f, email, jar)).order;
    const refund = async (orderId: number, amount?: number) => {
      const r = await s.api.post(`/api/orders/${orderId}/refund`, amount ? { amount } : {});
      assert.equal(r.status, 200, r.text);
    };

    // before validation — partial (half): pro rata; then the rest: cancelled
    const o1 = await sale('r1@mail.fr');
    await refund(o1.id, 6000);
    assert.deepEqual(summary(await commissionsOf(o1.id)), [['sale', 1500, 'pending']]);
    await refund(o1.id);
    let [c1] = await commissionsOf(o1.id);
    assert.deepEqual([c1.status, c1.amount, c1.amount_initial, c1.cancel_reason], ['cancelled', 0, 3000, 'Commande remboursée']);
    // a cancelled commission is never validated
    await makeDue(o1.id);
    await schedulers();
    [c1] = await commissionsOf(o1.id);
    assert.equal(c1.status, 'cancelled');

    // full refund before validation, reported by Stripe (webhook), replayed
    const o2 = await sale('r2@mail.fr');
    const ev = { id: 'ch_aff_1', payment_intent: o2.stripe_payment_intent_id, amount: 12000, amount_refunded: 12000, refunded: true };
    await webhook(s.webhookUrl, 'charge.refunded', ev);
    await webhook(s.webhookUrl, 'charge.refunded', ev);
    assert.deepEqual(summary(await commissionsOf(o2.id)), [['sale', 0, 'cancelled']]);

    // after validation, not paid yet — partial (a quarter) then full
    const o3 = await sale('r3@mail.fr');
    await makeDue(o3.id);
    await schedulers();
    await refund(o3.id, 3000);
    assert.deepEqual(summary(await commissionsOf(o3.id)), [['sale', 2250, 'approved']]);
    assert.deepEqual(await balance(s.api, a.id), [{ currency: 'eur', pending: 0, approved: 2250, paid: 0 }]);
    await refund(o3.id);
    assert.deepEqual(summary(await commissionsOf(o3.id)), [['sale', 0, 'cancelled']]);
    assert.deepEqual(await balance(s.api, a.id), [{ currency: 'eur', pending: 0, approved: 0, paid: 0 }]);

    // after payout: the commission stays paid, a negative clawback is validated at once
    const o4 = await sale('r4@mail.fr');
    await makeDue(o4.id);
    await schedulers();
    const paid = await s.api.post('/api/affiliation/payouts', { affiliate_id: a.id, currency: 'eur', method: 'Virement', reference: 'VIR-1' });
    assert.equal(paid.status, 201, paid.text);
    assert.equal(paid.body.amount, 3000);
    await refund(o4.id, 4000); // a third
    assert.deepEqual(summary(await commissionsOf(o4.id)), [['sale', 3000, 'paid'], ['clawback', -1000, 'approved']]);
    await refund(o4.id); // the rest
    assert.deepEqual(summary(await commissionsOf(o4.id)), [['sale', 3000, 'paid'], ['clawback', -1000, 'approved'], ['clawback', -2000, 'approved']]);
    assert.deepEqual(await balance(s.api, a.id), [{ currency: 'eur', pending: 0, approved: -3000, paid: 3000 }]);
    // nothing to pay while the balance is negative; it is deducted from the next commissions
    assert.equal((await s.api.post('/api/affiliation/payouts', { affiliate_id: a.id, currency: 'eur' })).status, 409);
    const o5 = await sale('r5@mail.fr');
    await makeDue(o5.id);
    await schedulers();
    assert.deepEqual(await balance(s.api, a.id), [{ currency: 'eur', pending: 0, approved: 0, paid: 3000 }]);
    assert.equal((await s.api.post('/api/affiliation/payouts', { affiliate_id: a.id, currency: 'eur' })).status, 409);
    const o6 = await sale('r6@mail.fr');
    await makeDue(o6.id);
    await schedulers();
    const net = await s.api.post('/api/affiliation/payouts', { affiliate_id: a.id, currency: 'eur', method: 'PayPal' });
    assert.deepEqual([net.status, net.body.amount, net.body.commissions_count], [201, 3000, 4]);
    assert.deepEqual(await balance(s.api, a.id), [{ currency: 'eur', pending: 0, approved: 0, paid: 6000 }]);
    assert.ok((await commissionsOf(o4.id)).every((c) => c.status === 'paid'));
  });

  test('payout register: payable balances, minimum, batch, CSV, history, manual cancellation', async () => {
    const s = await seller({ validation_days: 0, min_payout: 5000 });
    const p = await product(s.api, { name: 'Formation', prices: [ttc120] });
    const f = await funnel(s.api, p.prices[0].id);
    const a = await affiliate(s.api, 'karl@partenaires.fr', { first_name: 'Karl' });
    const b = await affiliate(s.api, 'lea@partenaires.fr');
    const c = await affiliate(s.api, 'max@partenaires.fr');
    const ja = await click(f, a.code);
    const oa1 = (await buy(f, 'p1@mail.fr', ja)).order;
    await buy(f, 'p2@mail.fr', ja);
    await buy(f, 'p3@mail.fr', await click(f, b.code));
    const oc = (await buy(f, 'p4@mail.fr', await click(f, c.code))).order;
    await schedulers();

    // manual cancellation: reason required, not twice
    const [cc] = await commissionsOf(oc.id);
    assert.equal((await s.api.post(`/api/affiliation/commissions/${cc.id}/cancel`, {})).status, 400);
    const cancelled = await s.api.post(`/api/affiliation/commissions/${cc.id}/cancel`, { reason: 'Vente frauduleuse' });
    assert.deepEqual([cancelled.status, cancelled.body.status, cancelled.body.amount, cancelled.body.cancel_reason], [200, 'cancelled', 0, 'Vente frauduleuse']);
    assert.equal((await s.api.post(`/api/affiliation/commissions/${cc.id}/cancel`, { reason: 'Encore' })).status, 409);
    assert.equal((await s.api.get('/api/affiliation/commissions?status=cancelled')).body.total, 1);

    // balances: A 60 € (payable), B 30 € (below the 50 € minimum), C nothing
    const payables = (await s.api.get('/api/affiliation/payouts/balances')).body as any[];
    assert.deepEqual(payables.map((x) => [x.email, x.amount, x.commissions_count, x.payable]), [['karl@partenaires.fr', 6000, 2, true], ['lea@partenaires.fr', 3000, 1, false]]);
    assert.equal((await s.api.post('/api/affiliation/payouts', { affiliate_id: b.id, currency: 'eur' })).status, 409);
    assert.equal((await s.api.post('/api/affiliation/payouts', { affiliate_id: c.id, currency: 'eur' })).status, 409);
    assert.equal((await s.api.post('/api/affiliation/payouts', { affiliate_id: a.id, currency: 'usd' })).status, 409);

    // payout details typed by the affiliate appear in the export (administrators)
    const session = await login(s, 'karl@partenaires.fr');
    assert.equal((await http(ctx, 'POST', `${s.home}/paiement`, { form: { details: 'IBAN FR76 3000 4000 0312 3456 7890 143' }, cookies: session })).status, 303);
    const csv = await http(ctx, 'GET', '/api/affiliation/payouts/export', { token: s.token });
    assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
    const lines = csv.text.replace(/^﻿/, '').trim().split('\n');
    assert.deepEqual(lines, ['email;prenom;nom;code;devise;montant;commissions;coordonnees_de_paiement', 'karl@partenaires.fr;Karl;;karl;EUR;60.00;2;IBAN FR76 3000 4000 0312 3456 7890 143']);

    // batch: one payout per payable balance
    const batch = await s.api.post('/api/affiliation/payouts/batch', { method: 'Virement SEPA', reference: 'LOT-2026-09', note: 'Septembre' });
    assert.deepEqual([batch.status, batch.body.count], [201, 1]);
    assert.deepEqual([batch.body.payouts[0].affiliate_id, batch.body.payouts[0].amount, batch.body.payouts[0].method, batch.body.payouts[0].reference], [a.id, 6000, 'Virement SEPA', 'LOT-2026-09']);
    assert.equal((await s.api.post('/api/affiliation/payouts/batch', {})).body.count, 0, 'nothing is paid twice');
    const rowsA = await commissionsOf(oa1.id);
    assert.deepEqual([rowsA[0].status, rowsA[0].payout_id, !!rowsA[0].paid_at], ['paid', batch.body.payouts[0].id, true]);
    assert.deepEqual(await balance(s.api, a.id), [{ currency: 'eur', pending: 0, approved: 0, paid: 6000 }]);
    assert.equal((await s.api.get('/api/affiliation/payouts/balances')).body.length, 1);

    // history, per affiliate; a paid commission can no longer be cancelled
    const history = (await s.api.get('/api/affiliation/payouts')).body;
    assert.deepEqual([history.total, history.items[0].affiliate_email, history.items[0].commissions_count], [1, 'karl@partenaires.fr', 2]);
    assert.equal((await s.api.get(`/api/affiliation/payouts?affiliate_id=${b.id}`)).body.total, 0);
    assert.equal((await s.api.get(`/api/affiliation/affiliates/${a.id}`)).body.payouts.length, 1);
    assert.equal((await s.api.post(`/api/affiliation/commissions/${rowsA[0].id}/cancel`, { reason: 'Trop tard' })).status, 409);

    // summary card
    const sum = (await s.api.get('/api/affiliation/summary')).body;
    assert.deepEqual([sum.enabled, sum.affiliates, sum.clicks, sum.sales, sum.balances], [true, { total: 3, approved: 3, pending: 0 }, 3, 4, [{ currency: 'eur', pending: 0, approved: 3000, paid: 6000 }]]);
  });
});

describe('isolation between accounts', () => {
  test('affiliates, commissions, payouts and mentions of an account are invisible to another', async () => {
    const s = await seller({ validation_days: 0 });
    const p = await product(s.api, { name: 'Formation', prices: [ttc120] });
    const f = await funnel(s.api, p.prices[0].id);
    const a = await affiliate(s.api, 'nina@partenaires.fr');
    const o = (await buy(f, 'iso@mail.fr', await click(f, a.code))).order;
    await schedulers();
    const [c] = await commissionsOf(o.id);

    const other = await seller();
    assert.equal((await other.api.get('/api/affiliation/affiliates')).body.total, 0);
    assert.equal((await other.api.get(`/api/affiliation/affiliates/${a.id}`)).status, 404);
    assert.equal((await other.api.patch(`/api/affiliation/affiliates/${a.id}`, { status: 'suspended' })).status, 404);
    assert.equal((await other.api.get('/api/affiliation/commissions')).body.total, 0);
    assert.equal((await other.api.get(`/api/affiliation/commissions?affiliate_id=${a.id}`)).body.total, 0);
    assert.equal((await other.api.post(`/api/affiliation/commissions/${c.id}/cancel`, { reason: 'Pas à moi' })).status, 404);
    assert.equal((await other.api.post('/api/affiliation/payouts', { affiliate_id: a.id, currency: 'eur' })).status, 404);
    assert.deepEqual((await other.api.get('/api/affiliation/payouts/balances')).body, []);
    assert.equal((await other.api.post('/api/affiliation/payouts/batch', {})).body.count, 0);
    assert.equal((await other.api.get(`/api/affiliation/orders/${o.id}`)).status, 404);
    assert.equal((await other.api.get(`/api/affiliation/contacts/${a.contact_id}`)).status, 404);
    assert.equal((await other.api.post('/api/affiliation/affiliates', { contact_id: a.contact_id })).status, 404);
    assert.equal((await commissionsOf(o.id))[0].status, 'approved', 'untouched');

    // same email and same code in two accounts: two independent affiliates
    const twin = await affiliate(other.api, 'nina@partenaires.fr');
    assert.equal(twin.code, a.code);
    assert.notEqual(twin.id, a.id);
    assert.equal((await s.api.post('/api/affiliation/affiliates', { email: 'nina@partenaires.fr' })).status, 409);
    const dup = await affiliate(s.api, 'nina@autre-domaine.fr');
    assert.equal(dup.code, 'nina2', 'readable unique code');
    assert.equal((await s.api.patch(`/api/affiliation/affiliates/${dup.id}`, { code: a.code })).status, 409);
    assert.equal((await s.api.patch(`/api/affiliation/affiliates/${dup.id}`, { code: 'nina-pro' })).body.code, 'nina-pro');
  });
});

describe('affiliate area', () => {
  test('signup (manual approval): email ownership proven by the link, pending until approved, automation trigger', async () => {
    const s = await seller({ terms: 'Commission versée par virement.' });
    const auto = await s.api.post('/api/automations', { name: 'Bienvenue affilié', enabled: true, trigger: { type: 'affiliate_approved' }, actions: [] });
    assert.equal(auto.status, 201, auto.text);

    const landing = await http(ctx, 'GET', s.home);
    assert.equal(landing.status, 200);
    assert.match(landing.text, /Devenir affilié/);
    assert.match(landing.text, /30 % du montant hors taxes/);
    assert.match(landing.headers.get('content-security-policy') ?? '', /script-src 'nonce-/);
    assert.match((await http(ctx, 'GET', `${s.home}/conditions`)).text, /Commission versée par virement\./);
    assert.equal((await http(ctx, 'GET', '/a/programme-inconnu')).status, 404);

    // terms must be accepted; invalid email
    assert.match((await http(ctx, 'POST', `${s.home}/signup`, { form: { email: 'olga@mail.fr' } })).text, /accepter les conditions/);
    assert.match((await http(ctx, 'POST', `${s.home}/signup`, { form: { email: 'nope', terms: '1' } })).text, /Adresse email invalide/);

    let since = await lastSendId(s.userId);
    const done = await http(ctx, 'POST', `${s.home}/signup`, { form: { email: 'Olga@Mail.fr', first_name: 'Olga', terms: '1' } });
    assert.equal(done.status, 200);
    assert.match(done.text, /Vérifiez votre boîte mail/);
    const { token, send } = await lastLink(s.userId, since);
    assert.ok(token);
    assert.match(send!.subject, /^Confirmez votre inscription/);
    assert.ok(!send!.html!.includes('/t/c/'), 'the link is not rewritten by click tracking');
    // nobody is an affiliate before the link is used; the new contact is not subscribed to the account's emails
    assert.equal((await s.api.get('/api/affiliation/affiliates')).body.total, 0);
    const contact = await db.selectFrom('contacts').selectAll().where('user_id', '=', s.userId).where('email', '=', 'olga@mail.fr').executeTakeFirstOrThrow();
    assert.equal(contact.confirmed_at, null);

    // GET shows a button and consumes nothing (mail scanners); POST logs in and creates the pending affiliate
    assert.equal((await http(ctx, 'GET', `${s.home}/auth/${token}`)).status, 200);
    const auth = await http(ctx, 'POST', `${s.home}/auth/${token}`);
    assert.equal(auth.status, 303);
    assert.equal(auth.headers.get('location'), s.home);
    const session = { scalo_affiliate: auth.cookies.scalo_affiliate };
    assert.equal((await http(ctx, 'POST', `${s.home}/auth/${token}`)).status, 410, 'single use');
    const list = (await s.api.get('/api/affiliation/affiliates?status=pending')).body;
    assert.deepEqual([list.total, list.items[0].email, list.items[0].code, list.items[0].status], [1, 'olga@mail.fr', 'olga', 'pending']);
    const waiting = await http(ctx, 'GET', s.home, { cookies: session });
    assert.match(waiting.text, /Demande en cours d’examen/);
    assert.ok(!waiting.text.includes('?aff='), 'no link before approval');
    assert.equal((await db.selectFrom('automation_runs').select('id').where('automation_id', '=', auto.body.id).execute()).length, 0);

    // a pending affiliate earns nothing
    const p = await product(s.api, { name: 'Formation', prices: [ttc120] });
    const f = await funnel(s.api, p.prices[0].id);
    const early = (await buy(f, 'tot@mail.fr', await click(f, 'olga'))).order;
    assert.deepEqual(await commissionsOf(early.id), []);

    // approval: timeline event, automation queued once, dashboard with the links
    const id = list.items[0].id as number;
    assert.equal((await s.api.patch(`/api/affiliation/affiliates/${id}`, { status: 'approved' })).body.status, 'approved');
    await s.api.patch(`/api/affiliation/affiliates/${id}`, { status: 'suspended' });
    await s.api.patch(`/api/affiliation/affiliates/${id}`, { status: 'approved' });
    assert.equal((await db.selectFrom('contact_events').select('id').where('contact_id', '=', contact.id).where('type', '=', 'affiliate_joined').execute()).length, 1);
    assert.equal((await db.selectFrom('automation_runs').select('id').where('automation_id', '=', auto.body.id).where('contact_id', '=', contact.id).execute()).length, 1);
    const dash = await http(ctx, 'GET', s.home, { cookies: session });
    assert.match(dash.text, /Mes liens/);
    assert.ok(dash.text.includes(`${f.order}?aff=olga`));
    assert.match(dash.text, /Taux de conversion/);

    // refused request: no dashboard
    since = await lastSendId(s.userId);
    await http(ctx, 'POST', `${s.home}/signup`, { form: { email: 'refus@mail.fr', terms: '1' } });
    const t2 = (await lastLink(s.userId, since)).token;
    const refusedSession = { scalo_affiliate: (await http(ctx, 'POST', `${s.home}/auth/${t2}`)).cookies.scalo_affiliate };
    const pendingId = (await s.api.get('/api/affiliation/affiliates?status=pending')).body.items[0].id;
    await s.api.patch(`/api/affiliation/affiliates/${pendingId}`, { status: 'rejected' });
    assert.match((await http(ctx, 'GET', s.home, { cookies: refusedSession })).text, /Demande non retenue/);
    assert.equal((await s.api.patch(`/api/affiliation/affiliates/${pendingId}`, { status: 'suspended' })).status, 409);

    // program disabled: signups closed, nothing is sent
    await s.api.put('/api/affiliation/settings', { enabled: false });
    since = await lastSendId(s.userId);
    assert.match((await http(ctx, 'POST', `${s.home}/signup`, { form: { email: 'tard@mail.fr', terms: '1' } })).text, /inscriptions à ce programme sont fermées/);
    assert.equal((await lastLink(s.userId, since)).token, '');
  });

  test('open signup, login, dashboard limited to the affiliate, payout details encrypted', async () => {
    const s = await seller({ signup_mode: 'open', validation_days: 0 });
    const alpha = await product(s.api, { name: 'Produit Alpha', prices: [ttc120] });
    const beta = await product(s.api, { name: 'Produit Beta', prices: [{ type: 'one_time', amount: 5000, currency: 'eur' }] });
    const fa = await funnel(s.api, alpha.prices[0].id);
    const fb = await funnel(s.api, beta.prices[0].id);

    // open program: approved as soon as the address is confirmed
    const since = await lastSendId(s.userId);
    await http(ctx, 'POST', `${s.home}/signup`, { form: { email: 'paul@mail.fr', first_name: 'Paul' } });
    const { token } = await lastLink(s.userId, since);
    const paul = { scalo_affiliate: (await http(ctx, 'POST', `${s.home}/auth/${token}`)).cookies.scalo_affiliate };
    const me = (await s.api.get('/api/affiliation/affiliates?search=paul')).body.items[0];
    assert.deepEqual([me.status, me.code], ['approved', 'paul']);
    const rose = await affiliate(s.api, 'rose@mail.fr');

    await buy(fa, 'client-alpha@mail.fr', await click(fa, 'paul'));
    await buy(fb, 'client-beta@mail.fr', await click(fb, rose.code));
    await schedulers();
    await s.api.post('/api/affiliation/payouts', { affiliate_id: rose.id, currency: 'eur', method: 'PayPal', reference: 'PP-ROSE-1' });

    // each affiliate only sees his own figures: products, amounts, payouts
    const dashPaul = (await http(ctx, 'GET', s.home, { cookies: paul })).text;
    assert.ok(dashPaul.includes('Produit Alpha') && !dashPaul.includes('Produit Beta'));
    assert.ok(/30,00\s€/.test(dashPaul) && !dashPaul.includes('PP-ROSE-1'));
    assert.ok(!dashPaul.includes('client-alpha@mail.fr'), 'buyers are never shown');
    const roseSession = await login(s, 'rose@mail.fr');
    const dashRose = (await http(ctx, 'GET', s.home, { cookies: roseSession })).text;
    assert.ok(dashRose.includes('Produit Beta') && !dashRose.includes('Produit Alpha'));
    assert.ok(dashRose.includes('PP-ROSE-1') && /15,00\s€/.test(dashRose));

    // login: same answer for an unknown address or a contact who is not an affiliate, and no email
    await s.api.post('/api/contacts', { email: 'simple-contact@mail.fr' });
    for (const email of ['inconnu@mail.fr', 'simple-contact@mail.fr']) {
      const before = await lastSendId(s.userId);
      const r = await http(ctx, 'POST', `${s.home}/login`, { form: { email } });
      assert.match(r.text, /Vérifiez votre boîte mail/);
      assert.equal((await lastLink(s.userId, before)).token, '');
    }
    // not logged in: the program page, never a dashboard; forged session refused
    assert.match((await http(ctx, 'GET', s.home)).text, /Devenir affilié/);
    assert.match((await http(ctx, 'GET', s.home, { cookies: { scalo_affiliate: `${rose.contact_id}.zzzz.forged` } })).text, /Devenir affilié/);
    assert.equal((await http(ctx, 'POST', `${s.home}/paiement`, { form: { details: 'x' } })).headers.get('location'), `${s.home}/login`);
    // a request from another site is refused
    const csrf = await fetch(`${ctx.base}${s.home}/paiement`, { method: 'POST', redirect: 'manual', headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded', cookie: `scalo_affiliate=${paul.scalo_affiliate}` }, body: 'details=pirate' });
    assert.equal(csrf.status, 403);

    // a session / a link of one program is worthless on another account's program
    const other = await seller({ signup_mode: 'open' });
    assert.match((await http(ctx, 'GET', other.home, { cookies: paul })).text, /Devenir affilié/);
    const before = await lastSendId(s.userId);
    await http(ctx, 'POST', `${s.home}/login`, { form: { email: 'paul@mail.fr' } });
    const t = (await lastLink(s.userId, before)).token;
    assert.equal((await http(ctx, 'POST', `${other.home}/auth/${t}`)).status, 404);
    assert.equal((await http(ctx, 'GET', `${s.home}/auth/${t}`)).status, 200, 'still usable where it belongs');

    // payout details: encrypted at rest, shown back to the affiliate, readable by the account's administrators only
    const iban = 'FR76 1234 5678 9012 — Paul <b>Martin</b>';
    const saved = await http(ctx, 'POST', `${s.home}/paiement`, { form: { details: iban }, cookies: paul });
    assert.equal(saved.headers.get('location'), `${s.home}?ok=paiement`);
    const row = await db.selectFrom('affiliates').select('payout_details_enc').where('id', '=', me.id).executeTakeFirstOrThrow();
    assert.match(row.payout_details_enc!, /^v1\./);
    assert.ok(!row.payout_details_enc!.includes('FR76'));
    const again = (await http(ctx, 'GET', `${s.home}?ok=paiement`, { cookies: paul })).text;
    assert.ok(again.includes('FR76 1234 5678 9012 — Paul &lt;b&gt;Martin&lt;/b&gt;'), 'escaped');
    assert.match(again, /coordonnées de paiement ont été enregistrées/);
    assert.ok(!dashRose.includes('FR76') && !(await http(ctx, 'GET', s.home, { cookies: roseSession })).text.includes('FR76'));
    const admin = (await s.api.get(`/api/affiliation/affiliates/${me.id}`)).body;
    assert.deepEqual([admin.payout_details, admin.payout_details_visible], [iban, true]);
    assert.ok(!(await s.api.get('/api/affiliation/affiliates')).text.includes('FR76'), 'never in lists');

    // suspended: the dashboard says so and hides the links; logout
    await s.api.patch(`/api/affiliation/affiliates/${me.id}`, { status: 'suspended' });
    const susp = (await http(ctx, 'GET', s.home, { cookies: paul })).text;
    assert.ok(susp.includes('suspendu') && !susp.includes('?aff='));
    const out = await http(ctx, 'POST', `${s.home}/logout`, { cookies: paul });
    assert.equal(out.headers.get('location'), `${s.home}/login`);
  });
});
