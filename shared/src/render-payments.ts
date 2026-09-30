// HTML of the payment blocks (« Paiement » order form with order bump, « Offre en un clic » upsell). Plain forms:
// they work without JavaScript and inside sandboxed pages; the payment itself happens on Stripe's hosted page.
// Offer names and prices come from `ctx.offers` (filled by the server from the database); in the editor the label
// remembered by the inspector is shown instead.
import type { CheckoutBlock, UpsellBlock } from './content';
import { css, esc, safeColor, themeOf, type RenderContext } from './render';

const text = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);
const radiusOf = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(40, Math.max(0, n)) : 8;
};

interface Shown { name: string; price: string; description?: string }

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
  const summary =
    b.showSummary === false
      ? ''
      : `<div style="${css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, padding: '14px 16px', margin: '0 0 14px', border: `1px solid ${th?.border ?? '#e2e8f0'}`, borderRadius: radius, background: th?.surface ?? '#f8fafc', color: th?.surfaceText ?? '#0f172a', fontSize: 16 })}"><span style="${css({ fontWeight: 600 })}">${esc(offer.name)}</span><span style="${css({ fontWeight: 800, whiteSpace: 'nowrap' })}">${esc(offer.price)}</span></div>`;
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
  return `<form method="post" action="${esc(ctx.checkoutAction ?? '#')}" style="${css({ margin: '0 auto', maxWidth: 440, textAlign: 'left' })}"${editor ? ' onsubmit="return false"' : ''}><input type="hidden" name="_block" value="${esc(b.id)}">${notice(ctx.payNotice)}${summary}${fields}${bumpHtml}<button type="submit" class="scalo-btn" style="${btn}"${dis}>${esc(text(b.submitLabel, 'Commander'))}</button>${note}</form>`;
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
  return `<form method="post" action="${esc(ctx.upsellAction ?? '#')}" style="${css({ margin: '0 auto', maxWidth: 480, textAlign: 'center' })}"${editor ? ' onsubmit="return false"' : ''}><input type="hidden" name="_block" value="${esc(b.id)}">${notice(ctx.payNotice)}<button type="submit" class="scalo-btn" style="${btn}"${dis}>${esc(text(b.acceptLabel, 'Oui, j’ajoute cette offre'))}<br><span style="${css({ fontSize: 14, fontWeight: 600, opacity: 0.9 })}">${esc(offer.name)} — ${esc(offer.price)}</span></button>${note}${decline}</form>`;
}

export function renderPaymentBlock(b: CheckoutBlock | UpsellBlock, ctx: RenderContext, accent: string): string {
  return b.type === 'checkout' ? checkoutHtml(b, ctx, accent) : upsellHtml(b, ctx, accent);
}
