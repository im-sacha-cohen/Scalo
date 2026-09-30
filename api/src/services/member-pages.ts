// HTML of the members area (server-rendered like funnel pages): login, library, course page, lesson player.
// Everything interpolated here goes through `esc`; lesson content is rendered by the shared block renderer.
import {
  builderCss,
  DEFAULT_SETTINGS,
  esc,
  googleFontsUrl,
  renderBlock,
  renderBlocks,
  safeColor,
  safeSrc,
  safeUrl,
  type Block,
  type PageContent,
  type RenderContext,
} from '@scalo/shared';
import { areaPath, type AreaRow } from './courses';

export interface Chrome {
  area: AreaRow;
  /** Logged-in member (null: visitor). */
  member: { email: string } | null;
  /** Owner preview: banner + no progress tracking. */
  preview: boolean;
}

export interface Page {
  status: number;
  html: string;
}

const dateFmt = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: 'Europe/Paris' });
export const fmtDay = (iso: string) => dateFmt.format(new Date(iso));

/** Black or white text, whichever is readable on the brand colour. */
function onColor(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? '#0f172a' : '#ffffff';
}

const brandColor = (area: AreaRow) => (/^#[0-9a-fA-F]{6}$/.test(area.color) ? area.color : '#5B4BFF');

const CSS = `*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:#f6f7fb;color:#0f172a;font-family:Inter,'Helvetica Neue',Arial,sans-serif;line-height:1.5}
a{color:inherit}img{max-width:100%}
.top{background:#fff;border-bottom:1px solid #e2e8f0}
.top-in{max-width:1180px;margin:0 auto;padding:12px 20px;display:flex;align-items:center;gap:16px;justify-content:space-between}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:18px;text-decoration:none;letter-spacing:-.02em;min-width:0}
.brand img{max-height:36px;max-width:180px;display:block}
.nav{display:flex;align-items:center;gap:14px;font-size:14px;color:#475569;min-width:0}
.nav a{text-decoration:none;font-weight:600;white-space:nowrap}
.who{max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.linkbtn{background:none;border:0;padding:0;font:inherit;color:inherit;cursor:pointer;text-decoration:underline}
.preview{background:#0f172a;color:#fff;font-size:14px;padding:8px 20px;display:flex;gap:12px;justify-content:center;align-items:center;flex-wrap:wrap;text-align:center}
.wrap{max-width:1180px;margin:0 auto;padding:28px 20px 64px}
.narrow{max-width:480px}
h1{font-size:28px;line-height:1.2;margin:0 0 8px;letter-spacing:-.02em}
h2{font-size:19px;margin:36px 0 14px;letter-spacing:-.01em}
.muted{color:#64748b}.small{font-size:13px}
.btn{display:inline-block;background:var(--brand);color:var(--on-brand);border:0;border-radius:10px;padding:11px 20px;font:inherit;font-weight:700;font-size:15px;text-decoration:none;cursor:pointer;text-align:center}
.btn.sec{background:#fff;color:#0f172a;border:1px solid #cbd5e1}
.btn:hover{filter:brightness(1.06)}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:16px}
.pad{padding:28px}
.grid{display:grid;gap:20px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}
.course{display:flex;flex-direction:column;overflow:hidden;text-decoration:none;transition:box-shadow .15s ease}
.course:hover{box-shadow:0 8px 24px rgba(15,23,42,.08)}
.thumb{aspect-ratio:16/9;background:linear-gradient(135deg,var(--brand),#0f172a);overflow:hidden}
.thumb img{width:100%;height:100%;object-fit:cover;display:block}
.course .body{padding:16px;display:flex;flex-direction:column;gap:10px;flex:1}
.course h3{margin:0;font-size:17px;line-height:1.3}
.bar{height:8px;border-radius:99px;background:#e2e8f0;overflow:hidden}
.bar>span{display:block;height:100%;background:var(--brand);border-radius:99px}
.badge{display:inline-block;font-size:12px;font-weight:600;padding:2px 8px;border-radius:99px;background:#eef2ff;color:#3730a3;white-space:nowrap}
.badge.gray{background:#f1f5f9;color:#475569}.badge.green{background:#dcfce7;color:#166534}.badge.amber{background:#fef3c7;color:#92400e}
.field{display:block;width:100%;padding:12px 14px;border:1px solid #cbd5e1;border-radius:10px;font:inherit;font-size:16px;margin:6px 0 14px}
.field:focus{outline:2px solid var(--brand);outline-offset:1px}
.alert{background:#fee2e2;color:#991b1b;border-radius:10px;padding:10px 14px;font-size:14px;margin:0 0 14px}
.notice{background:#ecfdf5;color:#065f46;border-radius:10px;padding:10px 14px;font-size:14px;margin:0 0 16px}
.hero{display:grid;grid-template-columns:1.2fr 1fr;gap:28px;align-items:center}
.hero .thumb{border-radius:14px}
.desc{white-space:pre-line;color:#334155;margin:12px 0 0}
.outline{list-style:none;margin:0;padding:0}
.mod{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#64748b;padding:14px 16px 6px}
.les{display:flex;align-items:center;gap:10px;padding:9px 16px;text-decoration:none;font-size:15px;border-left:3px solid transparent}
a.les:hover{background:#f8fafc}
.les.cur{background:#f1f5f9;border-left-color:var(--brand);font-weight:600}
.les.off{color:#94a3b8}
.les .t{flex:1;min-width:0}
.ico{width:20px;height:20px;border-radius:50%;flex:none;display:inline-flex;align-items:center;justify-content:center;font-size:11px;border:1.5px solid #cbd5e1;color:#94a3b8}
.ico.done{background:var(--brand);border-color:var(--brand);color:var(--on-brand)}
.ico.lock{border-color:transparent}
.player{display:grid;grid-template-columns:320px minmax(0,1fr);gap:24px;align-items:start}
.side{position:sticky;top:16px;max-height:calc(100vh - 32px);overflow:auto;padding-bottom:10px}
.side .head{padding:16px 16px 12px;border-bottom:1px solid #e2e8f0}
.side .head a{text-decoration:none;font-weight:700}
.main{min-width:0}
.lesson-head{padding:24px 28px 0}
.video{padding:20px 28px 0}
.video video{width:100%;border-radius:10px;display:block;background:#000}
.lesson-content{overflow:hidden;padding:12px 4px}
.lesson-content .scalo-full{margin-left:0!important;margin-right:0!important}
.files{padding:0 28px 8px}
.file{display:flex;align-items:center;gap:10px;padding:10px 14px;border:1px solid #e2e8f0;border-radius:10px;text-decoration:none;margin-top:8px;font-size:15px}
.file:hover{background:#f8fafc}
.foot{display:flex;gap:12px;justify-content:space-between;align-items:center;flex-wrap:wrap;padding:20px 28px 24px;border-top:1px solid #e2e8f0;margin-top:12px}
.foot form{margin:0}
.center{text-align:center}
@media (max-width:900px){.player{grid-template-columns:1fr}.side{position:static;max-height:none;order:2}.hero{grid-template-columns:1fr}}
@media (max-width:560px){.who{display:none}.wrap{padding:20px 14px 48px}h1{font-size:23px}.lesson-head,.video,.files,.foot{padding-left:16px;padding-right:16px}.pad{padding:20px}}`;

function document_(c: Chrome, title: string, body: string, headExtra = '') {
  const { area } = c;
  const color = brandColor(area);
  const home = areaPath(area);
  const logo = safeSrc(area.logo_url);
  const nav = c.preview
    ? `<a href="${esc(home)}">Formations</a>`
    : c.member
      ? `<a href="${esc(home)}">Mes formations</a><span class="who" title="${esc(c.member.email)}">${esc(c.member.email)}</span>
         <form method="post" action="${esc(home)}/logout" style="margin:0"><button class="linkbtn" type="submit">Se déconnecter</button></form>`
      : `<a href="${esc(home)}/login">Se connecter</a>`;
  const banner = c.preview
    ? `<div class="preview"><span>Aperçu propriétaire : vous voyez l’espace comme un membre ayant accès à tout (brouillons compris). La progression n’est pas enregistrée.</span>
       <form method="post" action="${esc(home)}/preview/exit" style="margin:0"><button class="linkbtn" type="submit">Quitter l’aperçu</button></form></div>`
    : '';
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — ${esc(area.name)}</title>
<meta name="robots" content="noindex">
<style>:root{--brand:${color};--on-brand:${onColor(color)}}${CSS}</style>${headExtra}
</head><body>${banner}
<header class="top"><div class="top-in">
<a class="brand" href="${esc(home)}">${logo ? `<img src="${esc(logo)}" alt="${esc(area.name)}">` : esc(area.name)}</a>
<nav class="nav">${nav}</nav>
</div></header>
${body}
</body></html>`;
}

const page = (c: Chrome, title: string, body: string, status = 200, headExtra = ''): Page => ({ status, html: document_(c, title, body, headExtra) });

/** Small centered card (login, confirmations, errors). */
const cardPage = (c: Chrome, title: string, inner: string, status = 200) =>
  page(c, title, `<div class="wrap narrow"><div class="card pad">${inner}</div></div>`, status);

// ---------- login ----------

export function loginPage(c: Chrome, opts: { error?: string; next?: string | null; email?: string } = {}): Page {
  const home = areaPath(c.area);
  return cardPage(
    c,
    'Connexion',
    `<h1>Connexion</h1>
<p class="muted" style="margin:0 0 18px">Saisissez votre adresse email : nous vous envoyons un lien de connexion, sans mot de passe.</p>
${opts.error ? `<p class="alert" role="alert">${esc(opts.error)}</p>` : ''}
<form method="post" action="${esc(home)}/login">
  ${opts.next ? `<input type="hidden" name="next" value="${esc(opts.next)}">` : ''}
  <label for="email" style="font-weight:600;font-size:14px">Adresse email</label>
  <input class="field" id="email" type="email" name="email" required autofocus autocomplete="email" placeholder="vous@exemple.fr" value="${esc(opts.email ?? '')}">
  <button class="btn" type="submit" style="width:100%">Recevoir mon lien de connexion</button>
</form>`,
    opts.error ? 400 : 200,
  );
}

/** Same page whether or not the address belongs to a member (no account enumeration). */
export const linkSentPage = (c: Chrome): Page =>
  cardPage(
    c,
    'Vérifiez votre boîte mail',
    `<h1>Vérifiez votre boîte mail</h1>
<p class="muted">Si cette adresse correspond à un compte, un lien de connexion vient de lui être envoyé. Il est valable 20 minutes et ne peut être utilisé qu’une seule fois.</p>
<p class="muted small" style="margin-bottom:0">Rien reçu ? Vérifiez vos courriers indésirables, ou <a href="${esc(areaPath(c.area))}/login">demandez un nouveau lien</a>.</p>`,
  );

export const confirmLoginPage = (c: Chrome, action: string): Page =>
  cardPage(
    c,
    'Connexion',
    `<h1>Se connecter</h1>
<p class="muted" style="margin:0 0 18px">Cliquez sur le bouton ci-dessous pour ouvrir votre espace membres.</p>
<form method="post" action="${esc(action)}"><button class="btn" type="submit" style="width:100%">Accéder à mon espace</button></form>`,
  );

export const badLinkPage = (c: Chrome, state: 'invalid' | 'expired' | 'used'): Page => {
  const text = {
    invalid: ['Lien invalide', 'Ce lien de connexion est invalide.', 404],
    expired: ['Lien expiré', 'Ce lien de connexion a expiré (il est valable 20 minutes).', 410],
    used: ['Lien déjà utilisé', 'Ce lien de connexion a déjà été utilisé : chaque lien ne fonctionne qu’une seule fois.', 410],
  } as const;
  const [title, body, status] = text[state];
  return cardPage(c, title, `<h1>${title}</h1><p class="muted">${body}</p><p style="margin:18px 0 0"><a class="btn" href="${esc(areaPath(c.area))}/login">Recevoir un nouveau lien</a></p>`, status);
};

export const messagePage = (c: Chrome, title: string, text: string, status: number, action?: { href: string; label: string }): Page =>
  cardPage(c, title, `<h1>${esc(title)}</h1><p class="muted">${esc(text)}</p>${action ? `<p style="margin:18px 0 0"><a class="btn" href="${esc(action.href)}">${esc(action.label)}</a></p>` : ''}`, status);

export const notFoundMemberPage = (c: Chrome): Page =>
  messagePage(c, 'Page introuvable', 'Cette page n’existe pas ou n’est plus disponible.', 404, { href: areaPath(c.area), label: 'Retour aux formations' });

/** Shown when the members area itself is unknown (no branding available). */
export const unknownAreaHtml = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page introuvable</title><meta name="robots" content="noindex">
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f1f5f9;font-family:Inter,'Helvetica Neue',Arial,sans-serif;color:#0f172a}div{background:#fff;max-width:460px;margin:24px;padding:40px 36px;border-radius:16px;text-align:center}h1{font-size:24px;margin:0 0 12px}p{color:#475569;margin:0}</style></head>
<body><div><h1>Page introuvable</h1><p>Cet espace membres n’existe pas.</p></div></body></html>`;

// ---------- library ----------

export interface CourseCard {
  title: string;
  description: string;
  image_url: string | null;
  url: string;
  draft?: boolean;
  /** Set for courses the member has access to. */
  progress?: { done: number; total: number; percent: number };
  expired?: boolean;
}

function courseCard(k: CourseCard) {
  const img = safeSrc(k.image_url);
  const p = k.progress;
  return `<a class="card course" href="${esc(k.url)}">
<div class="thumb">${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : ''}</div>
<div class="body"><h3>${esc(k.title)}</h3>
${k.draft ? '<div><span class="badge amber">Brouillon</span></div>' : ''}
${k.expired ? '<div><span class="badge gray">Accès expiré</span></div>' : ''}
${p ? `<div style="margin-top:auto"><div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p.percent}"><span style="width:${p.percent}%"></span></div>
<div class="muted small" style="margin-top:6px">${p.percent === 100 && p.total ? 'Terminée' : `${p.percent} % — ${p.done} / ${p.total} leçon${p.total > 1 ? 's' : ''}`}</div></div>` : `<div class="muted small">${esc(k.description.slice(0, 140))}${k.description.length > 140 ? '…' : ''}</div>`}
</div></a>`;
}

export function libraryPage(c: Chrome, mine: CourseCard[], others: CourseCard[]): Page {
  const body = `<div class="wrap">
<h1>Mes formations</h1>
${
  mine.length
    ? `<div class="grid" style="margin-top:20px">${mine.map(courseCard).join('')}</div>`
    : `<div class="card pad center" style="margin-top:20px"><p class="muted" style="margin:0">Vous n’avez accès à aucune formation pour le moment.</p></div>`
}
${others.length ? `<h2>Autres formations</h2><div class="grid">${others.map(courseCard).join('')}</div>` : ''}
</div>`;
  return page(c, 'Mes formations', body);
}

// ---------- course & lesson ----------

export interface OutlineLesson {
  id: number;
  title: string;
  url: string;
  done: boolean;
  /** The viewer may open it now. */
  open: boolean;
  free_preview: boolean;
  draft: boolean;
  /** Drip: opens later for this member. */
  available_at?: string;
}
export interface OutlineModule {
  title: string;
  lessons: OutlineLesson[];
}

function outlineHtml(modules: OutlineModule[], currentId: number | null) {
  return `<ul class="outline">${modules
    .map(
      (m) =>
        `<li><div class="mod">${esc(m.title)}</div>${m.lessons
          .map((l) => {
            const icon = l.done ? '<span class="ico done" aria-label="Terminée">✓</span>' : l.open ? '<span class="ico" aria-hidden="true"></span>' : '<span class="ico lock" aria-label="Verrouillée">🔒</span>';
            const badges =
              (l.draft ? ' <span class="badge amber">Brouillon</span>' : '') +
              (l.free_preview && !l.done ? ' <span class="badge green">Aperçu gratuit</span>' : '') +
              (!l.open && l.available_at ? ` <span class="badge gray">Le ${esc(fmtDay(l.available_at))}</span>` : '');
            const inner = `${icon}<span class="t">${esc(l.title)}${badges}</span>`;
            const cls = `les${l.id === currentId ? ' cur' : ''}${l.open ? '' : ' off'}`;
            // drip-locked lessons stay links (the lesson page says when it opens); others are plain text
            return l.open || l.available_at ? `<a class="${cls}" href="${esc(l.url)}"${l.id === currentId ? ' aria-current="page"' : ''}>${inner}</a>` : `<div class="${cls}">${inner}</div>`;
          })
          .join('')}</li>`,
    )
    .join('')}</ul>`;
}

export interface CourseView {
  title: string;
  description: string;
  image_url: string | null;
  url: string;
  draft: boolean;
  modules: OutlineModule[];
}

export function coursePage(
  c: Chrome,
  course: CourseView,
  state:
    | { access: true; progress: { done: number; total: number; percent: number }; continueUrl: string | null; completed: boolean }
    | { access: false; expired: boolean; purchaseUrl: string | null; loginUrl: string | null },
): Page {
  const img = safeSrc(course.image_url);
  let cta: string;
  if (state.access) {
    const p = state.progress;
    cta = `<div style="margin-top:18px"><div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p.percent}"><span style="width:${p.percent}%"></span></div>
<p class="muted small" style="margin:6px 0 16px">${p.percent} % — ${p.done} / ${p.total} leçon${p.total > 1 ? 's' : ''} terminée${p.done > 1 ? 's' : ''}${state.completed ? ' · Formation terminée 🎉' : ''}</p>
${state.continueUrl ? `<a class="btn" href="${esc(state.continueUrl)}">${p.done ? 'Continuer' : 'Commencer'}</a>` : ''}</div>`;
  } else {
    const buy = state.purchaseUrl ? safeUrl(state.purchaseUrl) : null;
    cta = `<div style="margin-top:18px">
<p class="muted" style="margin:0 0 14px">${state.expired ? 'Votre accès à cette formation a expiré.' : 'Vous n’avez pas encore accès à cette formation.'}</p>
<div style="display:flex;gap:10px;flex-wrap:wrap">
${buy && buy !== '#' ? `<a class="btn" href="${esc(buy)}">${state.expired ? 'Renouveler mon accès' : 'Obtenir l’accès'}</a>` : ''}
${state.loginUrl ? `<a class="btn sec" href="${esc(state.loginUrl)}">Déjà inscrit ? Se connecter</a>` : ''}
</div></div>`;
  }
  const body = `<div class="wrap">
<div class="card pad hero">
<div><h1>${esc(course.title)}${course.draft ? ' <span class="badge amber">Brouillon</span>' : ''}</h1>
${course.description ? `<p class="desc">${esc(course.description)}</p>` : ''}${cta}</div>
<div class="thumb">${img ? `<img src="${esc(img)}" alt="">` : ''}</div>
</div>
<h2>Programme</h2>
<div class="card" style="padding:4px 0 10px">${course.modules.length ? outlineHtml(course.modules, null) : '<p class="muted" style="padding:14px 16px 4px;margin:0">Le programme sera bientôt disponible.</p>'}</div>
</div>`;
  return page(c, course.title, body);
}

const VIDEO_FILE_RE = /\.(mp4|m4v|webm|mov|ogv)(?:[?#]|$)/i;

function videoHtml(url: string | null, ctx: RenderContext) {
  if (!url || !/^https?:\/\//i.test(url)) return '';
  if (VIDEO_FILE_RE.test(url)) return `<div class="video"><video controls preload="metadata" playsinline src="${esc(url)}"></video></div>`;
  // YouTube / Vimeo → responsive embed; anything else → a link (shared renderer)
  return `<div class="video">${renderBlock({ id: 'lesson-video', type: 'video', url, style: { paddingX: 0, paddingY: 0 } } as Block, ctx)}</div>`;
}

export interface LessonView {
  title: string;
  content: PageContent;
  video_url: string | null;
  draft: boolean;
  free_preview: boolean;
  files: { name: string; url: string; size: number }[];
  done: boolean;
  /** POST target of the "terminée" button; null when progress is not tracked for this viewer. */
  completeAction: string | null;
  prevUrl: string | null;
  nextUrl: string | null;
  vars: Record<string, string>;
}

const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`);

export function lessonPage(c: Chrome, course: CourseView, lessonId: number, l: LessonView, notice?: string): Page {
  // accent: the lesson's own, else the brand colour of the area
  const settings: PageContent['settings'] = Object.assign({}, DEFAULT_SETTINGS, { accent: brandColor(c.area) }, l.content?.settings);
  const ctx: RenderContext = { mode: 'page', settings, vars: l.vars, nextUrl: l.nextUrl ?? course.url, depth: 0 };
  const fonts = googleFontsUrl(settings);
  const head = `<style>${builderCss('page')}</style>${fonts ? `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${esc(fonts)}">` : ''}`;
  const font = String(settings.fontFamily ?? '').replace(/[^\w\s,'"-]/g, '');
  const contentStyle = `${font ? `font-family:${esc(font)};` : ''}color:${safeColor(settings.textColor) ?? '#0f172a'}`;
  const files = l.files.length
    ? `<div class="files"><h2 style="margin-top:12px">Fichiers à télécharger</h2>${l.files
        .map((f) => `<a class="file" href="${esc(f.url)}"><span aria-hidden="true">⬇</span><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(f.name)}</span><span class="muted small">${fmtSize(f.size)}</span></a>`)
        .join('')}</div>`
    : '';
  const complete = l.completeAction
    ? l.done
      ? `<form method="post" action="${esc(l.completeAction)}"><input type="hidden" name="done" value="0"><span class="badge green" style="font-size:14px;padding:6px 12px">✓ Leçon terminée</span> <button class="linkbtn muted small" type="submit">Marquer comme non terminée</button></form>`
      : `<form method="post" action="${esc(l.completeAction)}"><input type="hidden" name="done" value="1"><button class="btn" type="submit">Marquer comme terminée${l.nextUrl ? ' et continuer' : ''}</button></form>`
    : '<span></span>';
  const body = `<div class="wrap"><div class="player">
<aside class="card side"><div class="head"><a href="${esc(course.url)}">← ${esc(course.title)}</a></div>${outlineHtml(course.modules, lessonId)}</aside>
<article class="card main">
${notice ? `<div style="padding:20px 28px 0"><p class="notice" role="status" style="margin:0">${esc(notice)}</p></div>` : ''}
<div class="lesson-head"><h1>${esc(l.title)}</h1>
${l.draft ? '<span class="badge amber">Brouillon</span> ' : ''}${l.free_preview ? '<span class="badge green">Aperçu gratuit</span>' : ''}</div>
${videoHtml(l.video_url, ctx)}
<div class="lesson-content" style="${contentStyle}">${renderBlocks(l.content?.blocks ?? [], ctx)}</div>
${files}
<div class="foot">${complete}
<div style="display:flex;gap:10px;flex-wrap:wrap">${l.prevUrl ? `<a class="btn sec" href="${esc(l.prevUrl)}">← Précédente</a>` : ''}${l.nextUrl ? `<a class="btn sec" href="${esc(l.nextUrl)}">Suivante →</a>` : ''}</div></div>
</article></div></div>`;
  return page(c, l.title, body, 200, head);
}

/** Lesson the member will get later (drip): same layout, no content. */
export function lockedLessonPage(c: Chrome, course: CourseView, lessonId: number, title: string, availableAt: string): Page {
  const body = `<div class="wrap"><div class="player">
<aside class="card side"><div class="head"><a href="${esc(course.url)}">← ${esc(course.title)}</a></div>${outlineHtml(course.modules, lessonId)}</aside>
<article class="card main pad center"><div style="font-size:40px" aria-hidden="true">🔒</div>
<h1>${esc(title)}</h1>
<p class="muted">Cette leçon sera disponible le <strong>${esc(fmtDay(availableAt))}</strong>.</p>
<p style="margin:18px 0 0"><a class="btn sec" href="${esc(course.url)}">Retour au programme</a></p></article>
</div></div>`;
  return page(c, title, body, 403);
}
