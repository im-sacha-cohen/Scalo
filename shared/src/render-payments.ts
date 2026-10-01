// HTML of the payment blocks (« Paiement » order form with order bump, « Offre en un clic » upsell). Plain forms,
// enhanced on public pages by the server's payment script: with `ctx.stripeKey` the order form collects the payment
// right there with Stripe Elements (container `[data-scalo-pe]`); otherwise it is posted and the buyer pays on Scalo's
// payment page. Installments offers let the buyer choose the number of payments (radio `installments`).
// Offer names and prices come from `ctx.offers` (filled by the server from the database); in the editor the label
// remembered by the inspector is shown instead.
import type { CheckoutBlock, UpsellBlock } from './content';
import { css, esc, safeColor, themeOf, type PayOption, type RenderContext } from './render';

const text = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);
const radiusOf = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(40, Math.max(0, n)) : 8;
};

interface Shown { name: string; price: string; description?: string; options?: PayOption[] }

/** Offer as displayed: from the database on public pages, from the inspector's label in the editor. */
function shownOffer(ctx: RenderContext, id: unknown, label: unknown): Shown | null {
  const o = typeof id === 'number' ? ctx.offers?.[id] : undefined;
  if (o) return o;
  if (ctx.mode !== 'editor' || typeof id !== 'number') return null;
  const [name, price] = text(label).split(' · ');
  return { name: name || `Offre #${id}`, price: price ?? '' };
}

const notice = (msg: string | undefined) =>
  msg
    ? `<div role="alert" style="${css({ background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a', borderRadius: 8, padding: '10px 14px', margin: '0 0 14px', fontSize: 14, textAlign: 'center' })}">${esc(msg)}</div>`
    : '';

/** Radio list « En une fois / En 3 fois… » of an installments offer (nothing when there is a single way to pay). */
function planChoice(options: PayOption[] | undefined, ctx: RenderContext, accent: string, radius: number, dis: string): string {
  if (!options || options.length < 2) return '';
  const th = themeOf(ctx);
  const rows = options
    .map(
      (o, i) =>
        `<label style="${css({ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '12px 14px', margin: '0 0 8px', border: `1px solid ${th?.border ?? '#cbd5e1'}`, borderRadius: radius, background: th?.surface ?? '#fff', color: th?.surfaceText ?? '#0f172a', cursor: 'pointer', fontSize: 15, lineHeight: 1.4 })}"><input type="radio" name="installments" value="${o.count}" data-price="${esc(o.price)}"${i === 0 ? ' checked' : ''}${dis} style="${css({ width: 18, height: 18, marginTop: 1, flex: '0 0 auto', accentColor: accent })}"><span><strong>${esc(o.label)}</strong> <span style="${css({ whiteSpace: 'nowrap' })}">— ${esc(o.price)}</span>${o.detail ? `<br><span style="${css({ fontSize: 13, ...(th ? { opacity: 0.75 } : { color: '#64748b' }) })}">${esc(o.detail)}</span>` : ''}</span></label>`,
    )
    .join('');
  return `<fieldset style="${css({ border: 0, padding: 0, margin: '0 0 10px', minWidth: 0 })}"><legend style="${css({ fontWeight: 600, fontSize: 15, margin: '0 0 8px', padding: 0 })}">Comment souhaitez-vous payer ?</legend>${rows}</fieldset>`;
}

const hint = (msg: string, ctx: RenderContext) => {
  const th = themeOf(ctx);
  return `<div style="${css({ border: `1px dashed ${th?.border ?? '#cbd5e1'}`, borderRadius: th?.radius !== undefined ? Math.min(40, th.radius) : 8, padding: '18px 16px', color: th?.surfaceText ?? '#64748b', fontSize: 14, textAlign: 'center', background: th?.surface ?? '#f8fafc' })}">${esc(msg)}</div>`;
};

function checkoutHtml(b: CheckoutBlock, ctx: RenderContext, accent: string): string {
  const editor = ctx.mode === 'editor';
  const offer = shownOffer(ctx, b.offerId, b.offerLabel);
  if (!offer) return hint(editor ? 'Paiement — choisissez l’offre à vendre dans le panneau de droite' : 'Cette offre n’est pas disponible pour le moment.', ctx);
  const dis = editor ? ' disabled' : '';
  // design tokens of the page (kits): fields and summary follow the theme; without a theme nothing changes
  const th = themeOf(ctx);
  const radius = b.inputRadius === undefined && th?.radius !== undefined ? Math.min(40, th.radius) : radiusOf(b.inputRadius);
  const line = th?.border ?? '#cbd5e1';
  const input = css({
    display: 'block', width: '100%', boxSizing: 'border-box', padding: '14px 16px', margin: '0 0 12px',
    border: `1px solid ${line}`, borderRadius: radius, fontSize: 16, fontFamily: 'inherit', background: th?.surface ?? '#fff', color: th?.surfaceText ?? '#0f172a',
  });
  const plans = offer.options && offer.options.length > 1 ? offer.options : undefined;
  const summary =
    b.showSummary === false
      ? ''
      : `<div style="${css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, padding: '14px 16px', margin: '0 0 14px', border: `1px solid ${th?.border ?? '#e2e8f0'}`, borderRadius: radius, background: th?.surface ?? '#f8fafc', color: th?.surfaceText ?? '#0f172a', fontSize: 16 })}"><span style="${css({ fontWeight: 600 })}">${esc(offer.name)}</span><span data-scalo-price style="${css({ fontWeight: 800, whiteSpace: 'nowrap' })}">${esc(plans ? plans[0].price : offer.price)}</span></div>`;
  const fields = [
    b.askName === false ? '' : `<input type="text" name="first_name" autocomplete="given-name" placeholder="Votre prénom" aria-label="Votre prénom"${dis} style="${input}">`,
    b.askLastName ? `<input type="text" name="last_name" autocomplete="family-name" placeholder="Votre nom" aria-label="Votre nom"${dis} style="${input}">` : '',
    `<input type="email" name="email" autocomplete="email" placeholder="Votre email" aria-label="Votre email" required${dis} style="${input}">`,
  ].join('');
  const bump = shownOffer(ctx, b.bumpOfferId, b.bumpOfferLabel);
  const bumpHtml = bump
    ? `<label style="${css({ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '14px 16px', margin: '2px 0 14px', border: `2px dashed ${accent}`, borderRadius: radius, background: th?.surface ?? '#fffbeb', color: th?.surfaceText ?? '#0f172a', fontSize: 15, lineHeight: 1.45, cursor: 'pointer' })}"><input type="checkbox" name="bump" value="1"${dis} style="${css({ width: 18, height: 18, marginTop: 2, flex: '0 0 auto' })}"><span><strong>${esc(text(b.bumpTitle) || `Oui, j’ajoute « ${bump.name} »`)}</strong> <span style="${css({ whiteSpace: 'nowrap', fontWeight: 700 })}">(+ ${esc(bump.price)})</span>${text(b.bumpText) ? `<br><span style="${css(th ? { opacity: 0.75 } : { color: '#475569' })}">${esc(text(b.bumpText))}</span>` : ''}</span></label>`
    : '';
  const btn = css({
    display: 'block', width: '100%', padding: '16px', border: 0, borderRadius: b.inputRadius === undefined && th?.buttonRadius !== undefined ? Math.min(40, th.buttonRadius) : radius, cursor: 'pointer',
    background: safeColor(b.buttonBg) ?? accent, color: safeColor(b.buttonColor) ?? th?.accentText ?? '#fff', fontWeight: th?.buttonWeight ?? 700, fontSize: th?.buttonCase ? 15 : 18, fontFamily: 'inherit',
    textTransform: th?.buttonCase, letterSpacing: th?.buttonSpacing,
  });
  const note = text(b.secureNote) ? `<p style="${css({ margin: '10px 0 0', fontSize: 13, ...(th ? { opacity: 0.7 } : { color: '#64748b' }), textAlign: 'center' })}">🔒 ${esc(text(b.secureNote))}</p>` : '';
  // payment on the page (Stripe Elements, mounted by the payment script once the details are sent)
  const onPage = !editor && !!ctx.stripeKey;
  const payAttrs = onPage
    ? ` data-scalo-pay="${esc(ctx.stripeKey)}" data-scalo-appearance="${esc(JSON.stringify({ theme: 'stripe', variables: { colorPrimary: accent, borderRadius: `${Math.min(24, radius)}px` } }))}"`
    : '';
  const payBox = onPage
    ? `<div data-scalo-pe style="${css({ display: 'none', margin: '2px 0 14px' })}"><p style="${css({ margin: '0 0 8px', fontSize: 14, textAlign: 'right' })}"><a href="#" data-scalo-edit style="${css({ display: 'none', color: 'inherit', opacity: 0.75 })}">Modifier mes informations</a></p><div data-mount></div></div><div data-scalo-err role="alert" style="${css({ display: 'none', background: '#fee2e2', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: radius, padding: '10px 14px', margin: '0 0 14px', fontSize: 14 })}"></div>`
    : '';
  return `<form method="post" action="${esc(ctx.checkoutAction ?? '#')}"${payAttrs} style="${css({ margin: '0 auto', maxWidth: 440, textAlign: 'left' })}"${editor ? ' onsubmit="return false"' : ''}><input type="hidden" name="_block" value="${esc(b.id)}">${notice(ctx.payNotice)}${summary}${planChoice(plans, ctx, accent, radius, dis)}${fields}${bumpHtml}${payBox}<button type="submit" class="scalo-btn" style="${btn}"${dis}>${esc(text(b.submitLabel, 'Commander'))}</button>${note}</form>`;
}

function upsellHtml(b: UpsellBlock, ctx: RenderContext, accent: string): string {
  const editor = ctx.mode === 'editor';
  const offer = shownOffer(ctx, b.offerId, b.offerLabel);
  if (!offer) return hint(editor ? 'Offre en un clic — choisissez l’offre à proposer dans le panneau de droite' : 'Cette offre n’est plus disponible.', ctx);
  const dis = editor ? ' disabled' : '';
  const th = themeOf(ctx);
  const btn = css({
    display: 'block', width: '100%', padding: '18px 16px', border: 0, borderRadius: th?.buttonRadius !== undefined ? Math.min(40, th.buttonRadius) : 10, cursor: 'pointer',
    background: safeColor(b.buttonBg) ?? accent, color: safeColor(b.buttonColor) ?? th?.accentText ?? '#fff', fontWeight: th?.buttonWeight ?? 800, fontSize: 19, fontFamily: 'inherit', lineHeight: 1.3,
  });
  const decline = text(b.declineLabel)
    ? `<p style="${css({ margin: '14px 0 0', fontSize: 14, textAlign: 'center' })}"><a href="${esc(editor ? '#' : ctx.nextUrl ?? '#')}" style="${css(th ? { color: 'inherit', opacity: 0.7, textDecoration: 'underline' } : { color: '#64748b', textDecoration: 'underline' })}">${esc(text(b.declineLabel))}</a></p>`
    : '';
  const note = text(b.note) ? `<p style="${css({ margin: '10px 0 0', fontSize: 13, ...(th ? { opacity: 0.7 } : { color: '#64748b' }), textAlign: 'center' })}">${esc(text(b.note))}</p>` : '';
  const plans = offer.options && offer.options.length > 1 ? offer.options : undefined;
  const choice = plans ? `<div style="${css({ textAlign: 'left' })}">${planChoice(plans, ctx, accent, th?.radius !== undefined ? Math.min(40, th.radius) : 8, dis)}</div>` : '';
  return `<form method="post" action="${esc(ctx.upsellAction ?? '#')}" style="${css({ margin: '0 auto', maxWidth: 480, textAlign: 'center' })}"${editor ? ' onsubmit="return false"' : ''}><input type="hidden" name="_block" value="${esc(b.id)}">${notice(ctx.payNotice)}${choice}<button type="submit" class="scalo-btn" style="${btn}"${dis}>${esc(text(b.acceptLabel, 'Oui, j’ajoute cette offre'))}<br><span style="${css({ fontSize: 14, fontWeight: 600, opacity: 0.9 })}">${esc(offer.name)}${plans ? '' : ` — ${esc(offer.price)}`}</span></button>${note}${decline}</form>`;
}

export function renderPaymentBlock(b: CheckoutBlock | UpsellBlock, ctx: RenderContext, accent: string): string {
  return b.type === 'checkout' ? checkoutHtml(b, ctx, accent) : upsellHtml(b, ctx, accent);
}
