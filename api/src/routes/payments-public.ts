// Public side of the payments: order form of a funnel step (« Paiement » block), Scalo's payment page, return after
// the payment, one-click upsell (« Offre en un clic » block), and the Stripe webhook of each account.
//
// The buyer pays on the funnel's own page with Stripe Elements (card, Apple Pay / Google Pay, SEPA Direct Debit;
// 3-D Secure in Stripe's modal): no card data goes through Scalo and the buyer never sees a Stripe page. When the
// funnel page cannot run Stripe.js (sandboxed custom code, no JavaScript) or a one-click offer needs the buyer, the
// buyer is sent to Scalo's payment page for the order (`/pay?o=`), which does the same. The payment method is saved
// for the one-click offers of the next steps (`off_session` charge). Amounts always come from the offers in the database.
import { Router, type Request, type Response } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { blocksOfType } from '@scalo/shared';
import { db, nowIso } from '../db';
import { submitArm } from '../services/ab';
import { submitAttribution } from '../services/attribution';
import { VISITOR_COOKIE_RE } from '../services/order-hooks';
import { formatMoney, planDetail, priceLabel, type InstallmentOption } from '@scalo/shared';
import { chargeSubscriptionOffSession, dueNow, orderOfPayToken, registerPaymentHost, payToken, preparePayment, syncPayment, type PayState } from '../services/checkout';
import { renderPayPage } from '../services/pay-page';
import {
  applySession,
  chosenInstallments,
  createOrder,
  getPaymentSettingsRow,
  handleStripeEvent,
  itemLabel,
  loadSellables,
  markOrderPaid,
  markOrderUnpaid,
  PAY_NOTICES,
  paidInfoOfIntent,
  stripeOfRow,
  webhookSecretOfRow,
  type OrderItemRow,
  type OrderRow,
} from '../services/payments';
import { hit, type Limit } from '../services/ratelimit';
import { StripeError, verifyStripeEvent, type StripeClient } from '../services/stripe';
import { readFunnelSettings } from '../services/tracking';
import { PUBLIC_URL, signId, verifySignedId } from '../util';
import { notFoundPage, resolveIn, sendSimple, type FunnelRow, type Resolved } from './public';

export const paymentsPublicRouter = Router();

// ---------- Stripe webhook ----------

/**
 * POST /api/payments/webhook/:token — `:token` identifies the account, the event is authenticated by its
 * `Stripe-Signature` (HMAC of the raw body with the account's signing secret). The body is a Buffer here: app.ts mounts
 * `express.raw()` on this path before the JSON parser.
 */
paymentsPublicRouter.post('/api/payments/webhook/:token', async (req, res) => {
  const token = String(req.params.token);
  const row = /^[\w-]{16,100}$/.test(token) ? await db.selectFrom('payment_settings').selectAll().where('webhook_token', '=', token).executeTakeFirst() : undefined;
  if (!row) return res.status(404).json({ error: 'Webhook inconnu' });
  const secret = webhookSecretOfRow(row);
  if (!secret) return res.status(400).json({ error: 'Secret de webhook non configuré' });
  const raw = Buffer.isBuffer(req.body) ? req.body : null;
  const event = raw ? verifyStripeEvent(raw, req.get('stripe-signature'), secret) : null;
  if (!event) return res.status(400).json({ error: 'Signature invalide' });
  const client = stripeOfRow(row);
  if (!client) return res.status(400).json({ error: 'Stripe non connecté' });
  try {
    const result = await handleStripeEvent(row.user_id, event, client);
    res.json({ received: true, result });
  } catch (e) {
    // 500 → Stripe retries the event later (nothing was recorded)
    console.error(`[stripe] webhook ${event.type} (${event.id}) :`, (e as Error).message);
    res.status(500).json({ error: 'Traitement impossible, réessayez' });
  }
});

// ---------- funnel pages ----------

const CHECKOUT_LIMIT: Limit = { max: 30, windowMs: 10 * 60_000 };
/** A one-click offer can be accepted for 24 h after the order it follows. */
const UPSELL_WINDOW_MS = 24 * 3600_000;
const ORDER_COOKIE = 'scalo_order';
const YEAR_MS = 365 * 86400_000;
/** The return URL (it carries the signed order id) identifies the buyer only shortly after the payment. */
const RETURN_WINDOW_MS = 3600_000;

const funnelBase = (f: FunnelRow) => f.base ?? `/p/${encodeURIComponent(f.slug)}`;
const stepPath = (f: FunnelRow, s: { slug: string }) => `${funnelBase(f)}/${encodeURIComponent(s.slug)}`;
/** Absolute origin of the funnel's pages: the custom domain when the step is served on one, PUBLIC_URL otherwise. */
const originOf = (req: Request, f: FunnelRow) => (f.base === '' ? `${req.protocol}://${req.get('host')}` : PUBLIC_URL);
const previewQs = (req: Request) => (typeof req.query.preview === 'string' && req.query.preview ? `preview=${encodeURIComponent(req.query.preview)}` : '');
/** Fetch from the page's script (JSON in, JSON out) rather than a plain form post. */
const wantsJson = (req: Request) => !!req.is('application/json');

/** Step after this one (`skip`: the one after), legal pages skipped — same rule as the « étape suivante » links. */
function forwardUrl(r: Resolved, skip = false): string {
  const legal = new Set(r.funnel.settings.legal?.step_ids ?? []);
  const after = r.steps.slice(r.idx + 1).filter((s) => !legal.has(s.id));
  const target = after[skip ? 1 : 0] ?? after[0] ?? r.step;
  return stepPath(r.funnel, target);
}

function visitorContext(req: Request) {
  const cookies: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.cookies ?? {})) {
    if (VISITOR_COOKIE_RE.test(k) && typeof v === 'string' && v.length <= 300 && Object.keys(cookies).length < 10) cookies[k] = v;
  }
  const vid = req.cookies?.scalo_vid;
  return { visitor_id: typeof vid === 'string' && /^[\w-]{8,64}$/.test(vid) ? vid : null, cookies };
}

/** Stripe of the seller, when buyers can pay (secret key, and the publishable key Stripe Elements needs). */
async function clientOf(userId: number): Promise<{ client: StripeClient; livemode: boolean; publishableKey: string } | null> {
  try {
    const row = await getPaymentSettingsRow(userId);
    const client = stripeOfRow(row);
    return client && row.stripe_publishable_key ? { client, livemode: row.mode === 'live', publishableKey: row.stripe_publishable_key } : null;
  } catch {
    return null; // unreadable key: the offer is simply unavailable for visitors
  }
}

const sparam = z.union([z.string(), z.number()]).transform(String).optional();
const checkoutSchema = z.object({
  email: z.string().trim().max(254).optional().default(''),
  first_name: z.string().max(200).optional(),
  last_name: z.string().max(200).optional(),
  _block: z.string().max(100).optional(),
  bump: sparam,
  /** Number of payments chosen for an installments offer. */
  installments: sparam,
  /** Order of a previous attempt on this form (details changed with « Modifier »): abandoned. */
  replaces: z.string().max(200).optional(),
});
const emailCheck = z.email();

const isRecurringLine = (l: { sellable: { type: string }; installments?: number | null }) => l.sellable.type === 'subscription' || (l.installments ?? 0) > 1;

/** URL the buyer comes back to once the payment is confirmed: records it, then the next step. */
const returnUrl = (req: Request, r: Resolved, order: { id: number }, skip: boolean) =>
  `${originOf(req, r.funnel)}${stepPath(r.funnel, r.step)}/paid?o=${encodeURIComponent(payToken(order.id))}${skip ? '&skip=1' : ''}`;
const payPageUrl = (r: Resolved, order: { id: number }, extra = '') => `${stepPath(r.funnel, r.step)}/pay?o=${encodeURIComponent(payToken(order.id))}${extra}`;

/** Answer of the JSON endpoints: what the page's script does next. */
async function respondPayment(req: Request, res: Response, r: Resolved, order: OrderRow, client: StripeClient, skip: boolean) {
  let st: PayState;
  try {
    st = await preparePayment(r.funnel.user_id, order, client);
  } catch (e) {
    console.error(`[stripe] préparation du paiement (commande ${order.id}) :`, (e as Error).message);
    await markOrderUnpaid(r.funnel.user_id, order.id, 'failed', 'Paiement impossible à préparer (Stripe injoignable)');
    return res.status(502).json({ error: PAY_NOTICES.error });
  }
  res.setHeader('Cache-Control', 'no-store');
  if (st.state === 'failed') return res.status(502).json({ error: PAY_NOTICES.error });
  if (st.state !== 'confirm') return res.json({ next: returnUrl(req, r, order, skip) });
  const name = [order.first_name, order.last_name].filter(Boolean).join(' ');
  res.json({
    o: payToken(order.id),
    clientSecret: st.clientSecret,
    returnUrl: returnUrl(req, r, order, skip),
    payLabel: `Payer ${formatMoney(st.amount, st.currency)}`,
    email: order.email,
    name,
  });
}

/**
 * Order form of a step. From the page's script (JSON): creates the pending order and answers what Stripe Elements
 * needs to collect the payment on the page. Plain form post (page that cannot run Stripe.js, no JavaScript): creates
 * the order and sends the buyer to Scalo's payment page for it.
 */
export async function checkoutStep(req: Request, res: Response, r: Resolved) {
  const { funnel, step } = r;
  const here = stepPath(funnel, step);
  const pq = previewQs(req);
  const json = wantsJson(req);
  const back = (code: string) =>
    json ? res.status(code === 'error' ? 502 : 400).json({ error: PAY_NOTICES[code] ?? PAY_NOTICES.error }) : res.redirect(303, `${here}?pay=${code}${pq ? `&${pq}` : ''}`);
  if (pq) return back('preview');
  if ((await hit(`checkout:${req.ip ?? ''}`, CHECKOUT_LIMIT)).blocked) return back('limit');

  const parsed = checkoutSchema.safeParse(req.body ?? {});
  const body = parsed.success ? parsed.data : checkoutSchema.parse({});
  const email = body.email.toLowerCase();
  if (!emailCheck.safeParse(email).success) return back('email');

  // A/B test: the order form is the one of the arm the visitor saw
  const arm = await submitArm(req, step);
  const forms = blocksOfType(arm.content?.blocks ?? [], 'checkout');
  const block = forms.find((b) => b.id === body._block) ?? forms[0];
  const offerId = Number(block?.offerId);
  const bumpId = body.bump && block?.bumpOfferId ? Number(block.bumpOfferId) : null;
  if (!block || !Number.isSafeInteger(offerId) || offerId <= 0) return back('unavailable');
  const sellables = await loadSellables(funnel.user_id, [offerId, ...(bumpId && Number.isSafeInteger(bumpId) && bumpId > 0 ? [bumpId] : [])]);
  const main = sellables.find((s) => s.price_id === offerId);
  if (!main) return back('unavailable');
  const mainLine = { sellable: main, kind: 'main' as const, installments: chosenInstallments(main, body.installments) };
  // order bump: only when ticked, in the currency of the main offer, and at most one recurring line per order
  const bumpOffer = bumpId && bumpId !== offerId ? sellables.find((s) => s.price_id === bumpId && s.currency === main.currency) : undefined;
  const bumpLine = bumpOffer ? { sellable: bumpOffer, kind: 'bump' as const, installments: chosenInstallments(bumpOffer, 1) } : null;
  const lines = [mainLine, ...(bumpLine && !(isRecurringLine(bumpLine) && isRecurringLine(mainLine)) ? [bumpLine] : [])];
  const stripe = await clientOf(funnel.user_id);
  if (!stripe) return back('unavailable');

  const { order } = await createOrder({
    userId: funnel.user_id,
    email,
    first_name: body.first_name,
    last_name: body.last_name,
    funnelId: funnel.id,
    stepId: step.id,
    variantId: arm.variantId,
    kind: 'checkout',
    livemode: stripe.livemode,
    lines,
    attribution: submitAttribution(req),
    visitor: visitorContext(req),
  });
  const replaced = orderOfPayToken(body.replaces);
  if (replaced && replaced !== order.id) await markOrderUnpaid(funnel.user_id, replaced, 'canceled', `Remplacée par la commande n° ${order.id}`);
  if (!json) return res.redirect(303, payPageUrl(r, order));
  await respondPayment(req, res, r, order, stripe.client, false);
}

/** Order of the buyer (signed id) placed on this step, if any. */
async function orderOfRequest(r: Resolved, token: unknown) {
  const id = orderOfPayToken(token);
  return id ? db.selectFrom('orders').selectAll().where('id', '=', id).where('user_id', '=', r.funnel.user_id).where('step_id', '=', r.step.id).executeTakeFirst() : undefined;
}

const payBodySchema = z.object({ o: z.string().max(200) });

/** POST …/pay (JSON, Scalo's payment page): what Stripe Elements needs to collect the payment of an existing order. */
export async function payStep(req: Request, res: Response, r: Resolved) {
  if ((await hit(`pay:${req.ip ?? ''}`, CHECKOUT_LIMIT)).blocked) return res.status(429).json({ error: PAY_NOTICES.limit });
  const parsed = payBodySchema.safeParse(req.body ?? {});
  const order = parsed.success ? await orderOfRequest(r, parsed.data.o) : undefined;
  if (!order || order.status === 'canceled') return res.status(404).json({ error: PAY_NOTICES.expired });
  const skip = req.query.skip === '1';
  if (order.status === 'paid' || order.status === 'refunded') return res.json({ next: returnUrl(req, r, order, skip) });
  const stripe = await clientOf(r.funnel.user_id);
  if (!stripe) return res.status(409).json({ error: PAY_NOTICES.unavailable });
  await respondPayment(req, res, r, order, stripe.client, skip);
}

/** « 3 × 100,00 € / mois » plan of an order line, for the payment page. */
function planOf(i: OrderItemRow): InstallmentOption | null {
  if (i.type !== 'installments' || !i.installments || i.installment_amount === null) return null;
  const first = i.amount_total - i.installment_amount * (i.installments - 1);
  return { count: i.installments, total: i.amount_total, subtotal: i.amount_subtotal, tax: i.amount_tax, first, each: i.installment_amount, fee: 0 };
}

const PAGE_NOTICES: Record<string, string> = {
  auth: 'Votre banque demande de confirmer ce paiement : choisissez votre moyen de paiement ci-dessous.',
  declined: 'Le paiement avec le moyen de paiement enregistré a été refusé : utilisez-en un autre ci-dessous.',
};

/** GET …/pay?o= — Scalo's payment page for an order of this step. */
export async function payPage(req: Request, res: Response, r: Resolved) {
  const here = stepPath(r.funnel, r.step);
  const order = await orderOfRequest(r, req.query.o);
  if (!order || order.status === 'canceled') return res.redirect(303, here);
  const skip = req.query.skip === '1';
  if (order.status === 'paid' || order.status === 'refunded') return res.redirect(303, returnUrl(req, r, order, skip));
  const stripe = await clientOf(r.funnel.user_id);
  if (!stripe) return res.redirect(303, `${here}?pay=unavailable`);
  registerPaymentHost(req, r.funnel.user_id);
  const items = await db.selectFrom('order_items').selectAll().where('order_id', '=', order.id).orderBy('id').execute();
  const settings = r.step.content?.settings ?? {};
  const code = typeof req.query.notice === 'string' ? req.query.notice : '';
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.type('html').send(
    renderPayPage({
      title: r.funnel.name,
      stripeKey: stripe.publishableKey,
      orderToken: payToken(order.id),
      endpoint: `${here}/pay${skip ? '?skip=1' : ''}`,
      lines: items.map((i) => {
        const plan = planOf(i);
        return { label: itemLabel(i), price: priceLabel({ ...i, interval: i.interval as 'week' | 'month' | 'year' | null, currency: order.currency }, i.amount_total), detail: plan ? planDetail(plan, order.currency, i.interval, i.interval_count) : undefined };
      }),
      due: dueNow(items),
      currency: order.currency,
      accent: settings.accent,
      background: settings.background,
      font: settings.fontFamily,
      backUrl: order.kind === 'checkout' ? here : forwardUrl(r, false),
      notice: PAGE_NOTICES[code] ?? PAY_NOTICES[code],
    }),
  );
}

function setBuyerCookies(res: Response, funnel: FunnelRow, order: OrderRow) {
  if (order.contact_id) res.cookie('scalo_cid', signId('cid', order.contact_id), { httpOnly: true, sameSite: 'lax', maxAge: YEAR_MS, path: '/' });
  // lets the next steps charge a one-click offer on the payment method saved by this order
  res.cookie(ORDER_COOKIE, signId('order', order.parent_order_id ?? order.id), { httpOnly: true, sameSite: 'lax', maxAge: UPSELL_WINDOW_MS, path: funnelBase(funnel) || '/' });
}

/**
 * Return after the payment (`?o=<signed order id>`): asks Stripe where the payment stands and records it (no need to
 * wait for the webhook), then moves on. Not paid yet → back to the payment page. `?session_id=`: orders paid on
 * Stripe Checkout before the payments moved to the funnel's pages.
 */
export async function paidStep(req: Request, res: Response, r: Resolved) {
  const { funnel, step } = r;
  const here = stepPath(funnel, step);
  const skip = req.query.skip === '1';
  let order: OrderRow | undefined;
  const sid = typeof req.query.session_id === 'string' && /^cs_[A-Za-z0-9_]{8,250}$/.test(req.query.session_id) ? req.query.session_id : null;
  if (sid) {
    order = await db.selectFrom('orders').selectAll().where('user_id', '=', funnel.user_id).where('stripe_session_id', '=', sid).executeTakeFirst();
    if (!order) return res.redirect(303, here);
    let open = false;
    if (order.status !== 'paid' && order.status !== 'refunded') {
      try {
        const stripe = await clientOf(funnel.user_id);
        const session = await stripe?.client.retrieveCheckoutSession(sid);
        if (session) {
          open = session.status === 'open';
          order = (await applySession(funnel.user_id, session)) ?? order;
        }
      } catch (e) {
        console.error(`[stripe] retour de paiement (commande ${order.id}) :`, (e as Error).message);
      }
    }
    if (open) return res.redirect(303, `${here}?pay=cancel`);
  } else {
    order = await orderOfRequest(r, req.query.o);
    if (!order) return res.redirect(303, here);
    if (order.status !== 'paid' && order.status !== 'refunded') {
      let st: PayState | null = null;
      try {
        const stripe = await clientOf(funnel.user_id);
        st = stripe ? await syncPayment(funnel.user_id, order, stripe.client) : null;
      } catch (e) {
        console.error(`[stripe] retour de paiement (commande ${order.id}) :`, (e as Error).message);
      }
      // nothing confirmed (the buyer came back without paying): the payment page lets them do it
      if (!st || st.state === 'confirm' || st.state === 'failed') return res.redirect(303, payPageUrl(r, order, skip ? '&skip=1' : ''));
      order = (await db.selectFrom('orders').selectAll().where('id', '=', order.id).executeTakeFirst()) ?? order;
    }
  }
  // paid — or still being processed by the bank (SEPA: the webhook will confirm): the buyer moves on either way
  if (order.status === 'paid' && order.paid_at && Date.now() - new Date(order.paid_at).getTime() < RETURN_WINDOW_MS) setBuyerCookies(res, funnel, order);
  res.setHeader('Cache-Control', 'no-store');
  res.redirect(303, forwardUrl(r, skip));
}

const upsellSchema = z.object({ _block: z.string().max(100).optional(), installments: sparam });

/**
 * One-click offer: charges the payment method saved by the order the visitor just paid (signed cookie), without asking
 * for it again — a payment, or a subscription / installment plan whose first invoice is paid now. When the bank asks
 * for authentication or refuses the payment, the buyer confirms it on Scalo's payment page.
 */
export async function upsellStep(req: Request, res: Response, r: Resolved) {
  const { funnel, step } = r;
  const here = stepPath(funnel, step);
  const pq = previewQs(req);
  const back = (code: string) => res.redirect(303, `${here}?pay=${code}${pq ? `&${pq}` : ''}`);
  if (pq) return back('preview');
  if ((await hit(`checkout:${req.ip ?? ''}`, CHECKOUT_LIMIT)).blocked) return back('limit');

  const rootId = verifySignedId('order', req.cookies?.[ORDER_COOKIE]);
  const root = rootId
    ? await db.selectFrom('orders').selectAll().where('id', '=', rootId).where('user_id', '=', funnel.user_id).where('kind', '=', 'checkout').where('status', '=', 'paid').executeTakeFirst()
    : undefined;
  if (!root || !root.paid_at || Date.now() - new Date(root.paid_at).getTime() > UPSELL_WINDOW_MS) return back('expired');

  const parsed = upsellSchema.safeParse(req.body ?? {});
  const arm = await submitArm(req, step);
  const offers = blocksOfType(arm.content?.blocks ?? [], 'upsell');
  const block = offers.find((b) => b.id === (parsed.success ? parsed.data._block : undefined)) ?? offers[0];
  const offerId = Number(block?.offerId);
  const sellable = block && Number.isSafeInteger(offerId) && offerId > 0 ? (await loadSellables(funnel.user_id, [offerId]))[0] : undefined;
  if (!block || !sellable) return back('unavailable');
  const count = chosenInstallments(sellable, parsed.success ? parsed.data.installments : undefined);
  const skip = !!block.skipNextOnAccept;
  const forward = forwardUrl(r, skip);
  const stripe = await clientOf(funnel.user_id);
  if (!stripe) return back('unavailable');

  // one order per (paid order, offer): a double click or a page reload never charges twice
  const { order, reused } = await db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`upsell:${root.id}:${sellable.price_id}`}))`.execute(trx);
    const prev = await trx
      .selectFrom('orders as o')
      .selectAll('o')
      .where('o.parent_order_id', '=', root.id)
      .where('o.kind', '=', 'upsell')
      .where('o.status', '!=', 'canceled')
      .where((eb) => eb.exists(eb.selectFrom('order_items as i').select('i.id').whereRef('i.order_id', '=', 'o.id').where('i.price_id', '=', sellable.price_id)))
      .orderBy('o.id', 'desc')
      .executeTakeFirst();
    if (prev) return { order: prev, reused: true };
    const created = await createOrder(
      {
        userId: funnel.user_id,
        email: root.email,
        first_name: root.first_name,
        last_name: root.last_name,
        funnelId: funnel.id,
        stepId: step.id,
        variantId: arm.variantId,
        parentOrderId: root.id,
        kind: 'upsell',
        livemode: stripe.livemode,
        lines: [{ sellable, kind: 'upsell', installments: count }],
        attribution: root.attribution,
        visitor: root.visitor,
        customerId: root.stripe_customer_id,
      },
      trx,
    );
    return { order: created.order, reused: false };
  });
  if (order.status === 'paid' || order.status === 'refunded') return res.redirect(303, forward);
  const payPage = (notice?: string) => res.redirect(303, payPageUrl(r, order, `${skip ? '&skip=1' : ''}${notice ? `&notice=${notice}` : ''}`));

  // an order that already went through a one-click attempt goes straight to the payment page (it would fail the same way)
  const oneClick = !!root.stripe_customer_id && !!root.stripe_payment_method_id && !reused;
  if (!oneClick) return payPage();
  const recurring = sellable.type === 'subscription' || (count ?? 0) > 1;
  const metadata = { order_id: String(order.id), scalo_user: String(funnel.user_id), parent_order_id: String(root.id) };
  try {
    if (recurring) {
      const st = await chargeSubscriptionOffSession(funnel.user_id, order, stripe.client, root.stripe_customer_id!, root.stripe_payment_method_id!);
      if (st.state === 'paid' || st.state === 'processing') return res.redirect(303, forward);
      return payPage('auth'); // the first invoice waits for the buyer (authentication, refused payment)
    }
    const pi = await stripe.client.createOffSessionPayment(
      { amount: order.amount_total, currency: order.currency, customer: root.stripe_customer_id!, payment_method: root.stripe_payment_method_id!, description: itemLabel(sellable), metadata },
      `scalo-upsell-${order.id}`,
    );
    if (pi.status === 'succeeded') {
      await markOrderPaid(funnel.user_id, order.id, paidInfoOfIntent(pi));
      return res.redirect(303, forward);
    }
    if (pi.status === 'processing') {
      await db.updateTable('orders').set({ stripe_payment_intent_id: pi.id, updated_at: nowIso() }).where('id', '=', order.id).execute();
      return res.redirect(303, forward); // confirmed later by the webhook
    }
    return payPage('auth'); // requires_action / requires_payment_method: the buyer has to be there
  } catch (e) {
    const cardIssue = e instanceof StripeError && (e.type === 'card_error' || e.code === 'authentication_required' || e.status === 402);
    if (cardIssue) return payPage(e.code === 'authentication_required' ? 'auth' : 'declined');
    console.error(`[stripe] offre en un clic (commande ${order.id}) :`, (e as Error).message);
    await markOrderUnpaid(funnel.user_id, order.id, 'failed', 'Paiement en un clic impossible');
    return back('error');
  }
}

// ---------- routes on the app's own host (custom domains: routes/custom-domain.ts) ----------

async function resolve(req: Request): Promise<Resolved | null> {
  const f = await db.selectFrom('funnels').select(['id', 'user_id', 'name', 'slug', 'settings']).where('slug', '=', String(req.params.funnelSlug)).executeTakeFirst();
  return f ? resolveIn({ ...f, settings: readFunnelSettings(f.settings) }, String(req.params.stepSlug)) : null;
}

paymentsPublicRouter.post('/p/:funnelSlug/:stepSlug/checkout', async (req, res) => {
  const r = await resolve(req);
  if (!r) return sendSimple(res, notFoundPage());
  await checkoutStep(req, res, r);
});
paymentsPublicRouter.post('/p/:funnelSlug/:stepSlug/pay', async (req, res) => {
  const r = await resolve(req);
  if (!r) return res.status(404).json({ error: 'Page introuvable' });
  await payStep(req, res, r);
});
paymentsPublicRouter.get('/p/:funnelSlug/:stepSlug/pay', async (req, res) => {
  const r = await resolve(req);
  if (!r) return sendSimple(res, notFoundPage());
  await payPage(req, res, r);
});
paymentsPublicRouter.get('/p/:funnelSlug/:stepSlug/paid', async (req, res) => {
  const r = await resolve(req);
  if (!r) return sendSimple(res, notFoundPage());
  await paidStep(req, res, r);
});
paymentsPublicRouter.post('/p/:funnelSlug/:stepSlug/upsell', async (req, res) => {
  const r = await resolve(req);
  if (!r) return sendSimple(res, notFoundPage());
  await upsellStep(req, res, r);
});
