// Public side of the payments: order form of a funnel step (« Paiement » block → Stripe Checkout), return from Stripe,
// one-click upsell (« Offre en un clic » block), and the Stripe webhook of each account.
//
// No card data goes through Scalo: the buyer pays on Stripe's hosted page (SCA / 3-D Secure handled by Stripe) and the
// card is saved there for the one-click offers of the next steps (`off_session` charge, with a fallback to the hosted
// page when the bank asks for authentication or refuses the card). Amounts always come from the offers in the database.
import { Router, type Request, type Response } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { blocksOfType } from '@scalo/shared';
import { db, nowIso } from '../db';
import { submitArm } from '../services/ab';
import { submitAttribution } from '../services/attribution';
import { VISITOR_COOKIE_RE } from '../services/order-hooks';
import {
  applySession,
  createOrder,
  getPaymentSettingsRow,
  handleStripeEvent,
  itemLabel,
  loadSellables,
  markOrderPaid,
  markOrderUnpaid,
  paidInfoOfIntent,
  stripeOfRow,
  toOffer,
  webhookSecretOfRow,
  type OrderRow,
  type Sellable,
} from '../services/payments';
import { hit, type Limit } from '../services/ratelimit';
import { StripeError, verifyStripeEvent, type CheckoutLineItem, type StripeClient } from '../services/stripe';
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
/** The return URL (it carries the Stripe session id) identifies the buyer only shortly after the payment. */
const RETURN_WINDOW_MS = 3600_000;

const funnelBase = (f: FunnelRow) => f.base ?? `/p/${encodeURIComponent(f.slug)}`;
const stepPath = (f: FunnelRow, s: { slug: string }) => `${funnelBase(f)}/${encodeURIComponent(s.slug)}`;
/** Absolute origin of the funnel's pages: the custom domain when the step is served on one, PUBLIC_URL otherwise. */
const originOf = (req: Request, f: FunnelRow) => (f.base === '' ? `${req.protocol}://${req.get('host')}` : PUBLIC_URL);
const previewQs = (req: Request) => (typeof req.query.preview === 'string' && req.query.preview ? `preview=${encodeURIComponent(req.query.preview)}` : '');

/** Step after this one (`skip`: the one after), legal pages skipped — same rule as the « étape suivante » links. */
function forwardUrl(r: Resolved, skip = false): string {
  const legal = new Set(r.funnel.settings.legal?.step_ids ?? []);
  const after = r.steps.slice(r.idx + 1).filter((s) => !legal.has(s.id));
  const target = after[skip ? 1 : 0] ?? after[0] ?? r.step;
  return stepPath(r.funnel, target);
}

const lineItem = (s: Sellable): CheckoutLineItem => {
  const o = toOffer(s);
  return {
    name: itemLabel(s),
    description: s.description || undefined,
    image: s.image_url && /^https:\/\//i.test(s.image_url) ? s.image_url : undefined,
    unit_amount: o.amount_total,
    currency: s.currency,
    recurring: s.type === 'one_time' ? undefined : { interval: s.interval ?? 'month' },
  };
};

function visitorContext(req: Request) {
  const cookies: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.cookies ?? {})) {
    if (VISITOR_COOKIE_RE.test(k) && typeof v === 'string' && v.length <= 300 && Object.keys(cookies).length < 10) cookies[k] = v;
  }
  const vid = req.cookies?.scalo_vid;
  return { visitor_id: typeof vid === 'string' && /^[\w-]{8,64}$/.test(vid) ? vid : null, cookies };
}

async function clientOf(userId: number): Promise<{ client: StripeClient; livemode: boolean } | null> {
  try {
    const row = await getPaymentSettingsRow(userId);
    const client = stripeOfRow(row);
    return client ? { client, livemode: row.mode === 'live' } : null;
  } catch {
    return null; // unreadable key: the offer is simply unavailable for visitors
  }
}

const checkoutSchema = z.object({
  email: z.string().trim().max(254).optional().default(''),
  first_name: z.string().max(200).optional(),
  last_name: z.string().max(200).optional(),
  _block: z.string().max(100).optional(),
  bump: z.string().max(10).optional(),
});
const emailCheck = z.email();

/** Order form of a step: creates the pending order, then sends the buyer to Stripe Checkout. */
export async function checkoutStep(req: Request, res: Response, r: Resolved) {
  const { funnel, step } = r;
  const here = stepPath(funnel, step);
  const pq = previewQs(req);
  const back = (code: string) => res.redirect(303, `${here}?pay=${code}${pq ? `&${pq}` : ''}`);
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
  // order bump: only when ticked, and only in the currency of the main offer
  const bump = bumpId && bumpId !== offerId ? sellables.find((s) => s.price_id === bumpId && s.currency === main.currency) : undefined;
  const stripe = await clientOf(funnel.user_id);
  if (!stripe) return back('unavailable');

  const lines = [{ sellable: main, kind: 'main' as const }, ...(bump ? [{ sellable: bump, kind: 'bump' as const }] : [])];
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
  const origin = originOf(req, funnel);
  try {
    const session = await stripe.client.createCheckoutSession(
      {
        mode: lines.some((l) => l.sellable.type !== 'one_time') ? 'subscription' : 'payment',
        line_items: lines.map((l) => lineItem(l.sellable)),
        customer_email: email,
        success_url: `${origin}${here}/paid?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}${here}?pay=cancel`,
        metadata: { order_id: String(order.id), scalo_user: String(funnel.user_id) },
        save_payment_method: true,
      },
      `scalo-order-${order.id}`,
    );
    if (!session.url) throw new Error('session sans URL');
    await db.updateTable('orders').set({ stripe_session_id: session.id, updated_at: nowIso() }).where('id', '=', order.id).execute();
    res.redirect(303, session.url);
  } catch (e) {
    console.error(`[stripe] création de la session (commande ${order.id}) :`, (e as Error).message);
    await markOrderUnpaid(funnel.user_id, order.id, 'failed', 'Session de paiement impossible à créer');
    back('error');
  }
}

function setBuyerCookies(res: Response, funnel: FunnelRow, order: OrderRow) {
  if (order.contact_id) res.cookie('scalo_cid', signId('cid', order.contact_id), { httpOnly: true, sameSite: 'lax', maxAge: YEAR_MS, path: '/' });
  // lets the next steps charge a one-click offer on the card saved by this order
  res.cookie(ORDER_COOKIE, signId('order', order.parent_order_id ?? order.id), { httpOnly: true, sameSite: 'lax', maxAge: UPSELL_WINDOW_MS, path: funnelBase(funnel) || '/' });
}

/** Return from Stripe Checkout (`?session_id=`): confirms the payment with Stripe (no need to wait for the webhook), then moves on. */
export async function paidStep(req: Request, res: Response, r: Resolved) {
  const { funnel, step } = r;
  const here = stepPath(funnel, step);
  const sid = typeof req.query.session_id === 'string' && /^cs_[A-Za-z0-9_]{8,250}$/.test(req.query.session_id) ? req.query.session_id : null;
  let order = sid ? await db.selectFrom('orders').selectAll().where('user_id', '=', funnel.user_id).where('stripe_session_id', '=', sid).executeTakeFirst() : undefined;
  if (!sid || !order) return res.redirect(303, here);
  let open = false;
  if (order.status !== 'paid' && order.status !== 'refunded') {
    const stripe = await clientOf(funnel.user_id);
    try {
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
  // paid — or still being processed by the bank (the webhook will confirm): the buyer moves on either way
  if (order.status === 'paid' && order.paid_at && Date.now() - new Date(order.paid_at).getTime() < RETURN_WINDOW_MS) setBuyerCookies(res, funnel, order);
  res.setHeader('Cache-Control', 'no-store');
  res.redirect(303, forwardUrl(r, req.query.skip === '1'));
}

const upsellSchema = z.object({ _block: z.string().max(100).optional() });

/**
 * One-click offer: charges the card saved by the order the visitor just paid (signed cookie), without asking for it
 * again. Subscription offers, banks asking for authentication and refused cards fall back to Stripe Checkout.
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
  const forward = forwardUrl(r, !!block.skipNextOnAccept);
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
        lines: [{ sellable, kind: 'upsell' }],
        attribution: root.attribution,
        visitor: root.visitor,
        customerId: root.stripe_customer_id,
      },
      trx,
    );
    return { order: created.order, reused: false };
  });
  if (order.status === 'paid' || order.status === 'refunded') return res.redirect(303, forward);

  const metadata = { order_id: String(order.id), scalo_user: String(funnel.user_id), parent_order_id: String(root.id) };
  // an order that already failed goes straight to the hosted page (the same off-session request would fail the same way)
  const oneClick = sellable.type === 'one_time' && !!root.stripe_customer_id && !!root.stripe_payment_method_id && !(reused && order.status !== 'pending');
  if (oneClick) {
    try {
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
      // requires_action / requires_payment_method: the buyer has to be there → hosted page
    } catch (e) {
      const cardIssue = e instanceof StripeError && (e.type === 'card_error' || e.code === 'authentication_required' || e.status === 402);
      if (!cardIssue) {
        console.error(`[stripe] offre en un clic (commande ${order.id}) :`, (e as Error).message);
        await markOrderUnpaid(funnel.user_id, order.id, 'failed', 'Paiement en un clic impossible');
        return back('error');
      }
      // authentication required / card refused: Stripe Checkout lets the buyer authenticate or use another card
    }
  }
  try {
    const origin = originOf(req, funnel);
    const session = await stripe.client.createCheckoutSession(
      {
        mode: sellable.type === 'one_time' ? 'payment' : 'subscription',
        line_items: [lineItem(sellable)],
        ...(root.stripe_customer_id ? { customer: root.stripe_customer_id } : { customer_email: root.email }),
        success_url: `${origin}${here}/paid?session_id={CHECKOUT_SESSION_ID}${block.skipNextOnAccept ? '&skip=1' : ''}`,
        cancel_url: `${origin}${here}?pay=cancel`,
        metadata,
      },
      `scalo-upsell-session-${order.id}-${Date.now()}`,
    );
    if (!session.url) throw new Error('session sans URL');
    await db.updateTable('orders').set({ stripe_session_id: session.id, updated_at: nowIso() }).where('id', '=', order.id).execute();
    res.redirect(303, session.url);
  } catch (e) {
    console.error(`[stripe] session de l’offre en un clic (commande ${order.id}) :`, (e as Error).message);
    await markOrderUnpaid(funnel.user_id, order.id, 'failed', 'Session de paiement impossible à créer');
    back('error');
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
