// HTML of the affiliate area (`/a/<slug>`, server-rendered like the members area): program page and signup, magic-link
// login, dashboard (statistics, links, commissions, payouts, payout details), program terms.
// Everything interpolated here goes through `esc`. The only script is the « Copier » helper, allowed by a CSP nonce.
import { AFFILIATE_STATUS_LABELS, COMMISSION_STATUS_LABELS, commissionLabel, esc, formatMoney, type AffiliateBalance, type AffiliateStats, type CommissionRate } from '@scalo/shared';
import { programPath, type AffiliateRow, type CommissionRow, type ProgramRow } from './affiliates';

export interface AffChrome {
  program: ProgramRow;
  /** Logged-in contact (null: visitor). */
  email: string | null;
  /** CSP nonce of the inline script. */
  nonce: string;
}

export interface Page {
  status: number;
  html: string;
}

const dateFmt = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeZone: 'Europe/Paris' });
const fmtDay = (iso: string) => dateFmt.format(new Date(iso));

const CSS = `*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:#f6f7fb;color:#0f172a;font-family:Inter,'Helvetica Neue',Arial,sans-serif;line-height:1.5}
a{color:#4338ca}
.top{background:#fff;border-bottom:1px solid #e2e8f0}
.top-in{max-width:1040px;margin:0 auto;padding:14px 20px;display:flex;align-items:center;gap:16px;justify-content:space-between}
.brand{font-weight:800;font-size:18px;text-decoration:none;letter-spacing:-.02em;color:#0f172a;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nav{display:flex;align-items:center;gap:14px;font-size:14px;color:#475569}
.nav a{text-decoration:none;font-weight:600;color:#0f172a;white-space:nowrap}
.who{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.linkbtn{background:none;border:0;padding:0;font:inherit;color:inherit;cursor:pointer;text-decoration:underline}
.wrap{max-width:1040px;margin:0 auto;padding:28px 20px 64px}
.narrow{max-width:500px}
h1{font-size:27px;line-height:1.2;margin:0 0 8px;letter-spacing:-.02em}
h2{font-size:18px;margin:0 0 14px;letter-spacing:-.01em}
.muted{color:#64748b}.small{font-size:13px}.center{text-align:center}
.btn{display:inline-block;background:#5B4BFF;color:#fff;border:0;border-radius:10px;padding:11px 20px;font:inherit;font-weight:700;font-size:15px;text-decoration:none;cursor:pointer;text-align:center}
.btn.sec{background:#fff;color:#0f172a;border:1px solid #cbd5e1}
.btn.sm{padding:8px 14px;font-size:14px}
.btn:hover{filter:brightness(1.06)}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:24px;margin-top:20px}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin-top:20px}
.stat{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:16px 18px}
.stat b{display:block;font-size:24px;letter-spacing:-.02em}
.stat span{font-size:13px;color:#64748b}
.field{display:block;width:100%;padding:11px 14px;border:1px solid #cbd5e1;border-radius:10px;font:inherit;font-size:15px;margin:6px 0 14px;background:#fff}
.field:focus{outline:2px solid #5B4BFF;outline-offset:1px}
textarea.field{min-height:110px;resize:vertical}
label{font-size:14px;font-weight:600}
.alert{background:#fee2e2;color:#991b1b;border-radius:10px;padding:10px 14px;font-size:14px;margin:0 0 14px}
.notice{background:#ecfdf5;color:#065f46;border-radius:10px;padding:10px 14px;font-size:14px;margin:0 0 16px}
.warn{background:#fef3c7;color:#92400e;border-radius:10px;padding:12px 16px;font-size:14px;margin-top:20px}
.badge{display:inline-block;font-size:12px;font-weight:600;padding:2px 8px;border-radius:99px;background:#eef2ff;color:#3730a3;white-space:nowrap}
.badge.gray{background:#f1f5f9;color:#475569}.badge.green{background:#dcfce7;color:#166534}.badge.amber{background:#fef3c7;color:#92400e}.badge.red{background:#fee2e2;color:#991b1b}
table{width:100%;border-collapse:collapse;font-size:14px}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#64748b;text-align:left;font-weight:700;padding:8px 10px;border-bottom:1px solid #e2e8f0}
td{padding:10px;border-bottom:1px solid #f1f5f9;vertical-align:top}
td.num,th.num{text-align:right;white-space:nowrap}
.scroll{overflow-x:auto}
.row{display:flex;gap:8px;align-items:center}
.row .field{margin:0;flex:1;min-width:0}
.terms{white-space:pre-line;color:#334155}
.check{display:flex;gap:8px;align-items:flex-start;font-weight:400;margin:0 0 14px}
@media (max-width:560px){.who{display:none}.wrap{padding:20px 14px 48px}h1{font-size:23px}.card{padding:18px}}`;

const COPY_JS = `document.addEventListener('click',function(e){var b=e.target.closest('[data-copy]');if(!b)return;var i=document.getElementById(b.getAttribute('data-copy'));if(!i)return;i.select();
(navigator.clipboard?navigator.clipboard.writeText(i.value):Promise.reject()).catch(function(){document.execCommand('copy')}).then(function(){var t=b.textContent;b.textContent='Copié !';setTimeout(function(){b.textContent=t},1500)})});
var s=document.getElementById('link-page'),o=document.getElementById('link-out');if(s&&o){s.addEventListener('change',function(){o.value=s.value})}`;

function doc(c: AffChrome, title: string, body: string, script = false): string {
  const home = programPath(c.program);
  const nav = c.email
    ? `<span class="who" title="${esc(c.email)}">${esc(c.email)}</span>
       <form method="post" action="${esc(home)}/logout" style="margin:0"><button class="linkbtn" type="submit">Se déconnecter</button></form>`
    : `<a href="${esc(home)}/login">Se connecter</a>`;
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — ${esc(c.program.name)}</title>
<meta name="robots" content="noindex">
<style>${CSS}</style>
</head><body>
<header class="top"><div class="top-in">
<a class="brand" href="${esc(home)}">${esc(c.program.name)}</a>
<nav class="nav">${nav}</nav>
</div></header>
${body}
${script ? `<script nonce="${esc(c.nonce)}">${COPY_JS}</script>` : ''}
</body></html>`;
}

const narrow = (inner: string) => `<main class="wrap narrow"><div class="card">${inner}</div></main>`;

export const unknownProgramHtml = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page introuvable</title>
<meta name="robots" content="noindex"><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f1f5f9;font-family:Inter,Arial,sans-serif;color:#0f172a}
.card{background:#fff;max-width:460px;margin:24px;padding:40px 36px;border-radius:16px;text-align:center}h1{font-size:24px;margin:0 0 12px}p{color:#475569;margin:0}</style></head>
<body><div class="card"><h1>Page introuvable</h1><p>Ce programme d’affiliation n’existe pas ou a été supprimé.</p></div></body></html>`;

export const messagePage = (c: AffChrome, title: string, text: string, status = 200): Page => ({
  status,
  html: doc(c, title, narrow(`<h1>${esc(title)}</h1><p class="muted">${esc(text)}</p><p style="margin-top:20px"><a href="${esc(programPath(c.program))}">Retour</a></p>`)),
});

export const notFoundAffPage = (c: AffChrome) => messagePage(c, 'Page introuvable', 'Cette page n’existe pas.', 404);

/** What the affiliate earns, in one sentence. */
export function commissionSentence(program: ProgramRow, own: CommissionRate | null): string {
  const rate = own ?? { type: program.commission_type, value: Number(program.commission_value) };
  const base = rate.type === 'percent' ? `${commissionLabel(rate)} du montant hors taxes de chaque vente` : `${commissionLabel(rate)} par produit vendu`;
  const rec = program.recurring
    ? program.recurring_months
      ? `, y compris sur les paiements d’abonnement pendant ${program.recurring_months} mois`
      : ', y compris sur chaque paiement d’abonnement'
    : '';
  return `Commission : ${base}${rec}. Une commission devient payable ${program.validation_days} jour${program.validation_days > 1 ? 's' : ''} après la vente ; le lien reste actif ${program.cookie_days} jour${program.cookie_days > 1 ? 's' : ''} après le clic.`;
}

export function landingPage(c: AffChrome, o: { error?: string; email?: string; firstName?: string } = {}): Page {
  const home = programPath(c.program);
  const p = c.program;
  const signup = p.enabled
    ? `<h2 style="margin-top:24px">Devenir affilié</h2>
       ${o.error ? `<div class="alert" role="alert">${esc(o.error)}</div>` : ''}
       <form method="post" action="${esc(home)}/signup">
         <label for="fn">Prénom</label><input class="field" id="fn" name="first_name" maxlength="200" autocomplete="given-name" value="${esc(o.firstName ?? '')}">
         <label for="em">Adresse email</label><input class="field" id="em" type="email" name="email" required maxlength="254" autocomplete="email" value="${esc(o.email ?? '')}">
         ${p.terms.trim() ? `<label class="check"><input type="checkbox" name="terms" value="1" required> <span>J’accepte les <a href="${esc(home)}/conditions">conditions du programme</a>.</span></label>` : ''}
         <button class="btn" type="submit" style="width:100%">${p.signup_mode === 'open' ? 'Rejoindre le programme' : 'Envoyer ma demande'}</button>
       </form>
       <p class="muted small" style="margin:14px 0 0">${p.signup_mode === 'open' ? 'Vous recevrez un email pour confirmer votre adresse et accéder à votre espace.' : 'Vous recevrez un email pour confirmer votre adresse ; votre demande sera ensuite examinée.'}</p>`
    : `<div class="warn">Les inscriptions à ce programme sont fermées pour le moment.</div>`;
  return {
    status: 200,
    html: doc(
      c,
      'Programme d’affiliation',
      narrow(`<h1>${esc(p.name)}</h1>
        <p class="muted">Recommandez nos offres avec votre lien personnel et touchez une commission sur chaque vente.</p>
        ${p.enabled ? `<p>${esc(commissionSentence(p, null))}</p>` : ''}
        ${signup}
        <p class="small" style="margin:18px 0 0">Déjà affilié ? <a href="${esc(home)}/login">Se connecter</a>${p.terms.trim() ? ` · <a href="${esc(home)}/conditions">Conditions du programme</a>` : ''}</p>`),
    ),
  };
}

export function loginPage(c: AffChrome, o: { error?: string; email?: string } = {}): Page {
  const home = programPath(c.program);
  return {
    status: o.error ? 400 : 200,
    html: doc(
      c,
      'Connexion',
      narrow(`<h1>Connexion</h1>
        <p class="muted">Saisissez l’adresse email de votre compte affilié : nous vous envoyons un lien de connexion.</p>
        ${o.error ? `<div class="alert" role="alert">${esc(o.error)}</div>` : ''}
        <form method="post" action="${esc(home)}/login" style="margin-top:16px">
          <label for="em">Adresse email</label><input class="field" id="em" type="email" name="email" required maxlength="254" autocomplete="email" autofocus value="${esc(o.email ?? '')}">
          <button class="btn" type="submit" style="width:100%">Recevoir mon lien de connexion</button>
        </form>
        <p class="small" style="margin:18px 0 0">Pas encore affilié ? <a href="${esc(home)}">Découvrir le programme</a></p>`),
    ),
  };
}

export const linkSentPage = (c: AffChrome): Page => ({
  status: 200,
  html: doc(
    c,
    'Vérifiez votre boîte mail',
    narrow(`<h1>Vérifiez votre boîte mail</h1>
      <p class="muted">Si cette adresse peut accéder au programme, un email contenant un lien vient de lui être envoyé. Le lien est valable 20 minutes et ne peut être utilisé qu’une seule fois.</p>
      <p style="margin-top:20px"><a href="${esc(programPath(c.program))}/login">Utiliser une autre adresse</a></p>`),
  ),
});

export const confirmLoginPage = (c: AffChrome, action: string): Page => ({
  status: 200,
  html: doc(
    c,
    'Connexion',
    narrow(`<h1>Accéder à mon espace affilié</h1><p class="muted">Cliquez sur le bouton ci-dessous pour continuer.</p>
      <form method="post" action="${esc(action)}" style="margin-top:20px"><button class="btn" type="submit" style="width:100%">Continuer</button></form>`),
  ),
});

export function badLinkPage(c: AffChrome, state: 'invalid' | 'expired' | 'used'): Page {
  const text = state === 'expired' ? 'Ce lien de connexion a expiré (il est valable 20 minutes).' : state === 'used' ? 'Ce lien de connexion a déjà été utilisé.' : 'Ce lien de connexion est invalide.';
  return {
    status: state === 'invalid' ? 404 : 410,
    html: doc(c, 'Lien invalide', narrow(`<h1>Lien invalide</h1><p class="muted">${text}</p><p style="margin-top:20px"><a class="btn" href="${esc(programPath(c.program))}/login">Demander un nouveau lien</a></p>`)),
  };
}

export const termsPage = (c: AffChrome): Page => ({
  status: 200,
  html: doc(
    c,
    'Conditions du programme',
    `<main class="wrap" style="max-width:760px"><div class="card"><h1>Conditions du programme</h1>
      <p>${esc(commissionSentence(c.program, null))}</p>
      ${c.program.terms.trim() ? `<div class="terms">${esc(c.program.terms)}</div>` : '<p class="muted">Aucune condition particulière n’a été publiée pour ce programme.</p>'}
      <p style="margin-top:20px"><a href="${esc(programPath(c.program))}">Retour</a></p></div></main>`,
  ),
});

/** Logged-in contact who is not an affiliate (yet), or whose request is pending / refused. */
export function statusPage(c: AffChrome, affiliate: AffiliateRow | null): Page {
  const home = programPath(c.program);
  const inner = !affiliate
    ? `<h1>Vous n’êtes pas encore affilié</h1><p class="muted">Cette adresse n’est pas inscrite au programme.</p>
       ${c.program.enabled ? `<form method="post" action="${esc(home)}/join" style="margin-top:20px"><button class="btn" type="submit">${c.program.signup_mode === 'open' ? 'Rejoindre le programme' : 'Envoyer ma demande'}</button></form>` : '<div class="warn">Les inscriptions à ce programme sont fermées pour le moment.</div>'}`
    : affiliate.status === 'pending'
      ? `<h1>Demande en cours d’examen</h1><p class="muted">Votre adresse est confirmée. Votre demande d’inscription au programme doit encore être validée : vous pourrez accéder à vos liens dès qu’elle sera acceptée.</p>`
      : `<h1>Demande non retenue</h1><p class="muted">Votre demande d’inscription à ce programme n’a pas été acceptée.</p>`;
  return { status: 200, html: doc(c, 'Espace affilié', narrow(inner)) };
}

export interface DashboardData {
  affiliate: AffiliateRow;
  stats: AffiliateStats;
  balances: AffiliateBalance[];
  links: { funnel: string; pages: { name: string; url: string }[] }[];
  commissions: CommissionRow[];
  payouts: { id: number; currency: string; amount: number; method: string; reference: string; created_at: string }[];
  payoutDetails: string;
  notice?: string;
}

const statusBadge = (s: CommissionRow['status']) => `<span class="badge ${s === 'paid' ? 'green' : s === 'approved' ? '' : s === 'pending' ? 'amber' : 'gray'}">${esc(COMMISSION_STATUS_LABELS[s])}</span>`;

export function dashboardPage(c: AffChrome, d: DashboardData): Page {
  const home = programPath(c.program);
  const a = d.affiliate;
  const own: CommissionRate | null = a.commission_type && a.commission_value !== null ? { type: a.commission_type, value: Number(a.commission_value) } : null;
  const suspended = a.status === 'suspended';
  const money = (pick: (b: AffiliateBalance) => number) => (d.balances.length ? d.balances.map((b) => esc(formatMoney(pick(b), b.currency))).join('<br>') : esc(formatMoney(0, 'eur')));
  const allPages = d.links.flatMap((f) => f.pages.map((p) => ({ label: `${f.funnel} — ${p.name}`, url: p.url })));
  const links = suspended
    ? ''
    : `<section class="card"><h2>Mes liens</h2>
      <p class="muted small" style="margin:0 0 14px">Votre code : <strong>${esc(a.code)}</strong>. Ajoutez <code>?aff=${esc(a.code)}</code> à l’adresse de n’importe quelle page pour qu’elle vous soit attribuée.</p>
      ${
        allPages.length
          ? `<label for="link-page">Page à recommander</label>
             <select class="field" id="link-page">${allPages.map((p) => `<option value="${esc(p.url)}">${esc(p.label)}</option>`).join('')}</select>
             <div class="row"><input class="field" id="link-out" readonly value="${esc(allPages[0].url)}" aria-label="Votre lien"><button class="btn sm" type="button" data-copy="link-out">Copier</button></div>`
          : '<p class="muted">Aucune page publique n’est disponible pour le moment.</p>'
      }</section>`;
  const commissions = d.commissions.length
    ? `<div class="scroll"><table><thead><tr><th>Date</th><th>Produit</th><th>Statut</th><th class="num">Commission</th></tr></thead><tbody>${d.commissions
        .map(
          (m) =>
            `<tr><td>${esc(fmtDay(m.created_at))}</td><td>${esc(m.product_name)}${m.kind === 'clawback' ? ' <span class="badge red">Reprise après remboursement</span>' : m.kind === 'recurring' ? ' <span class="badge gray">Récurrent</span>' : ''}</td><td>${statusBadge(m.status)}</td><td class="num">${esc(formatMoney(m.amount, m.currency))}</td></tr>`,
        )
        .join('')}</tbody></table></div>`
    : '<p class="muted">Aucune commission pour le moment.</p>';
  const payouts = d.payouts.length
    ? `<div class="scroll"><table><thead><tr><th>Date</th><th>Moyen</th><th>Référence</th><th class="num">Montant</th></tr></thead><tbody>${d.payouts
        .map((p) => `<tr><td>${esc(fmtDay(p.created_at))}</td><td>${esc(p.method || '—')}</td><td>${esc(p.reference || '—')}</td><td class="num">${esc(formatMoney(p.amount, p.currency))}</td></tr>`)
        .join('')}</tbody></table></div>`
    : '<p class="muted">Aucun paiement reçu pour le moment.</p>';
  const body = `<main class="wrap">
    <h1>Espace affilié</h1>
    <p class="muted" style="margin:0">Statut : <span class="badge ${a.status === 'approved' ? 'green' : 'amber'}">${esc(AFFILIATE_STATUS_LABELS[a.status])}</span></p>
    ${d.notice ? `<div class="notice" style="margin-top:16px" role="status">${esc(d.notice)}</div>` : ''}
    ${suspended ? '<div class="warn">Votre compte affilié est suspendu : vos liens ne génèrent plus de commission. Contactez le responsable du programme pour en savoir plus.</div>' : ''}
    <div class="grid">
      <div class="stat"><b>${d.stats.clicks}</b><span>Clics</span></div>
      <div class="stat"><b>${d.stats.leads}</b><span>Leads</span></div>
      <div class="stat"><b>${d.stats.sales}</b><span>Ventes</span></div>
      <div class="stat"><b>${esc((d.stats.conversion * 100).toFixed(1).replace('.', ','))} %</b><span>Taux de conversion</span></div>
    </div>
    <div class="grid">
      <div class="stat"><b>${money((b) => b.pending)}</b><span>Commissions en attente</span></div>
      <div class="stat"><b>${money((b) => b.approved)}</b><span>Commissions validées (à payer)</span></div>
      <div class="stat"><b>${money((b) => b.paid)}</b><span>Commissions payées</span></div>
    </div>
    ${links}
    <section class="card"><h2>Mes commissions</h2>${commissions}</section>
    <section class="card"><h2>Paiements reçus</h2>${payouts}</section>
    <section class="card"><h2>Coordonnées de paiement</h2>
      <p class="muted small" style="margin:0 0 12px">IBAN, adresse PayPal… Ces informations sont chiffrées et ne sont visibles que de vous et du responsable du programme.</p>
      <form method="post" action="${esc(home)}/paiement">
        <textarea class="field" name="details" maxlength="1000" aria-label="Coordonnées de paiement">${esc(d.payoutDetails)}</textarea>
        <button class="btn sm" type="submit">Enregistrer</button>
      </form>
    </section>
    <section class="card"><h2>Conditions du programme</h2><p style="margin:0">${esc(commissionSentence(c.program, own))}</p>
      ${c.program.min_payout > 0 ? `<p class="muted small">Seuil minimum de paiement : ${esc(formatMoney(c.program.min_payout, d.balances[0]?.currency ?? 'eur'))}.</p>` : ''}
      <p style="margin:12px 0 0"><a href="${esc(home)}/conditions">Lire les conditions complètes</a></p></section>
  </main>`;
  return { status: 200, html: doc(c, 'Espace affilié', body, true) };
}
