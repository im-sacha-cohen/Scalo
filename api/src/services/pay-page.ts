// Buyer-side payment UI: the script that turns the « Paiement » blocks of a funnel page into a Stripe Elements form
// (card, Apple Pay / Google Pay, SEPA Direct Debit; 3-D Secure in Stripe's modal — the buyer never leaves the page), and
// Scalo's own payment page, used when the funnel page cannot run it (page sandboxed because of custom code, buyer
// without JavaScript on the order form, one-click offer the bank wants confirmed).
//
// Stripe.js comes from js.stripe.com (PCI requirement); card data only ever goes to Stripe's iframes.
import { css, esc, formatMoney, safeColor } from '@scalo/shared';

export const STRIPE_JS = '<script src="https://js.stripe.com/v3/"></script>';

/**
 * Enhances `form[data-scalo-pay]` (value: publishable key). First submit: the form is sent as JSON to its action,
 * which creates the order and answers `{ clientSecret, returnUrl, payLabel }` → the Payment Element is mounted in
 * `[data-scalo-pe]` and the details are locked (« Modifier » unlocks them: the next order replaces this one). Second
 * submit: `stripe.confirmPayment` (no redirect for these methods), then the browser goes to `returnUrl`, which records
 * the payment and moves on to the next step. `data-scalo-order`: the order exists already (payment page).
 * Without Stripe.js the forms are posted normally and the server sends the buyer to the payment page.
 */
export const PAY_SCRIPT = `<script>(function(){
Array.prototype.forEach.call(document.querySelectorAll('form input[name=installments]'),function(r){r.addEventListener('change',function(){var p=r.form&&r.form.querySelector('[data-scalo-price]');if(p&&r.checked)p.textContent=r.getAttribute('data-price')})});
var forms=document.querySelectorAll('form[data-scalo-pay]');
if(!forms.length||typeof Stripe!=='function')return;
var NET='Connexion impossible. Vérifiez votre réseau et réessayez.';
Array.prototype.forEach.call(forms,function(f){
var stripe=Stripe(f.getAttribute('data-scalo-pay'),{locale:'fr'});
var box=f.querySelector('[data-scalo-pe]'),err=f.querySelector('[data-scalo-err]'),btn=f.querySelector('button[type=submit]'),edit=f.querySelector('[data-scalo-edit]');
var label=btn?btn.innerHTML:'',st=null,replaces='',appearance={};
try{appearance=JSON.parse(f.getAttribute('data-scalo-appearance')||'{}')}catch(e){}
function show(m){if(!err)return;err.textContent=m||'';err.style.display=m?'block':'none'}
function busy(b){if(!btn)return;btn.disabled=b;btn.style.opacity=b?'0.7':''}
function lock(b){Array.prototype.forEach.call(f.querySelectorAll('input,select,textarea'),function(i){if(i.type!=='hidden'&&!box.contains(i))i.disabled=b})}
function mount(r){st=r;st.elements=stripe.elements({clientSecret:r.clientSecret,appearance:appearance,locale:'fr'});
st.pe=st.elements.create('payment',{defaultValues:{billingDetails:{email:r.email||'',name:r.name||''}}});
box.style.display='block';st.pe.mount(box.querySelector('[data-mount]')||box);
if(btn&&r.payLabel)btn.textContent=r.payLabel;lock(true);if(edit)edit.style.display=r.locked?'none':'inline'}
function reset(){if(st&&st.pe)st.pe.destroy();replaces=st?st.o:'';st=null;box.style.display='none';if(btn)btn.innerHTML=label;lock(false);if(edit)edit.style.display='none';show('')}
if(edit)edit.addEventListener('click',function(e){e.preventDefault();reset()});
function post(body){return fetch(f.getAttribute('data-scalo-endpoint')||f.getAttribute('action'),{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json().catch(function(){return{error:'Erreur inattendue. Merci de réessayer.'}})})}
function handle(r){if(r.next){location.href=r.next;return}busy(false);if(r.error){show(r.error);return}if(r.clientSecret)mount(r)}
f.addEventListener('submit',function(e){e.preventDefault();show('');busy(true);
if(!st){var data={};new FormData(f).forEach(function(v,k){data[k]=String(v)});if(replaces)data.replaces=replaces;post(data).then(handle,function(){busy(false);show(NET)});return}
stripe.confirmPayment({elements:st.elements,confirmParams:{return_url:st.returnUrl},redirect:'if_required'}).then(function(res){
if(res.error){busy(false);show(res.error.message||'Le paiement a été refusé.');return}location.href=st.returnUrl},function(){busy(false);show(NET)})});
var o=f.getAttribute('data-scalo-order');if(o){busy(true);post({o:o}).then(handle,function(){busy(false);show(NET)})}
});})();</script>`;

/** Stripe Elements look, from the page's colours. */
export function elementsAppearance(accent: string, radius = 8, font?: string) {
  return {
    theme: 'stripe',
    variables: { colorPrimary: accent, borderRadius: `${Math.min(24, Math.max(0, radius))}px`, ...(font ? { fontFamily: font } : {}) },
  };
}

export interface PayPageLine {
  label: string;
  /** « 3 × 100,00 € / mois », « 97,00 € » */
  price: string;
  detail?: string;
}

/** Scalo's own payment page for an existing order. */
export function renderPayPage(p: {
  title: string;
  stripeKey: string;
  orderToken: string;
  endpoint: string;
  lines: PayPageLine[];
  due: number;
  currency: string;
  accent?: string;
  background?: string;
  font?: string;
  backUrl?: string | null;
  notice?: string;
}) {
  const accent = safeColor(p.accent) ?? '#2563eb';
  // inside <style>: entities are not decoded there, so the font list is filtered rather than escaped
  const font = (p.font || '').replace(/[^\w\s,'"-]/g, '') || "Inter,'Helvetica Neue',Arial,sans-serif";
  const lines = p.lines
    .map(
      (l) =>
        `<div style="${css({ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderBottom: '1px solid #e2e8f0' })}"><div><div style="${css({ fontWeight: 600 })}">${esc(l.label)}</div>${l.detail ? `<div style="${css({ fontSize: 13, color: '#64748b', marginTop: 2 })}">${esc(l.detail)}</div>` : ''}</div><div style="${css({ fontWeight: 700, whiteSpace: 'nowrap' })}">${esc(l.price)}</div></div>`,
    )
    .join('');
  const appearance = esc(JSON.stringify(elementsAppearance(accent, 8, p.font)));
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(p.title)}</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;background:${safeColor(p.background) ?? '#f1f5f9'};font-family:${font};color:#0f172a}</style>
</head><body>
<main style="${css({ maxWidth: 520, margin: '0 auto', padding: '40px 16px' })}">
<div style="${css({ background: '#fff', borderRadius: 16, boxShadow: '0 10px 30px rgba(15,23,42,.08)', padding: '28px 24px' })}">
<h1 style="${css({ fontSize: 22, margin: '0 0 4px' })}">Paiement sécurisé</h1>
<p style="${css({ margin: '0 0 16px', color: '#64748b', fontSize: 14 })}">${esc(p.title)}</p>
${p.notice ? `<div role="alert" style="${css({ background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a', borderRadius: 8, padding: '10px 14px', margin: '0 0 14px', fontSize: 14 })}">${esc(p.notice)}</div>` : ''}
${lines}
<div style="${css({ display: 'flex', justifyContent: 'space-between', padding: '14px 0 18px', fontSize: 17 })}"><strong>À payer aujourd’hui</strong><strong>${esc(formatMoney(p.due, p.currency))}</strong></div>
<form method="post" action="${esc(p.endpoint)}" data-scalo-pay="${esc(p.stripeKey)}" data-scalo-order="${esc(p.orderToken)}" data-scalo-appearance="${appearance}">
<div data-scalo-pe style="${css({ display: 'none', margin: '0 0 16px' })}"><div data-mount></div></div>
<div data-scalo-err role="alert" style="${css({ display: 'none', background: '#fee2e2', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 14px', margin: '0 0 14px', fontSize: 14 })}"></div>
<noscript><p style="${css({ color: '#b91c1c', fontSize: 14 })}">Activez JavaScript pour payer : le formulaire de paiement sécurisé en a besoin.</p></noscript>
<button type="submit" style="${css({ display: 'block', width: '100%', padding: 16, border: 0, borderRadius: 10, background: accent, color: '#fff', fontWeight: 700, fontSize: 17, cursor: 'pointer', fontFamily: 'inherit' })}">Payer ${esc(formatMoney(p.due, p.currency))}</button>
</form>
<p style="${css({ margin: '14px 0 0', fontSize: 12, color: '#64748b', textAlign: 'center' })}">🔒 Paiement chiffré, traité par Stripe. Vos données bancaires ne sont jamais stockées par le vendeur.</p>
${p.backUrl ? `<p style="${css({ margin: '10px 0 0', fontSize: 13, textAlign: 'center' })}"><a href="${esc(p.backUrl)}" style="${css({ color: '#64748b' })}">← Retour</a></p>` : ''}
</div></main>
${STRIPE_JS}${PAY_SCRIPT}
</body></html>`;
}
