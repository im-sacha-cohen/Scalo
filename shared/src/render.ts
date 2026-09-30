// Pure HTML renderer for blocks. Styles are inline so the output works identically in the
// editor canvas (inside the app DOM), on public funnel pages and in email clients. The few
// responsive rules (column stacking, hide on mobile/desktop, mobile font sizes) are class based
// and emitted by `builderCss()`: as media queries for pages/emails, as container queries in the editor.
import type {
  Block,
  BlockStyle,
  ColumnsBlock,
  PageContent,
  PageSettings,
  SectionBlock,
  SocialNetwork,
} from './content';
// render-payments.ts only uses helpers from this module inside functions, so the import cycle is safe.
import { renderPaymentBlock } from './render-payments';

export type RenderMode = 'page' | 'email' | 'editor';

export interface RenderContext {
  mode: RenderMode;
  settings: PageSettings;
  nextUrl?: string;     // target of "next step" buttons and form redirects
  formAction?: string;  // POST target of forms (page mode)
  /** Payment blocks (page mode): POST targets, offers by price id (current name / price), message after a redirect. */
  checkoutAction?: string;
  upsellAction?: string;
  offers?: Record<number, { name: string; price: string; description?: string }>;
  payNotice?: string;
  vars?: Record<string, string>; // merge tags: {{first_name}}, {{email}}...
  /** Absolute origin used to make root-relative image URLs absolute (emails). */
  baseUrl?: string;
  /** Email mode: the preview is rendered for the editor (no side effects, static countdowns). */
  now?: number;
  /** internal: nesting depth / whether we are inside a column. */
  depth?: number;
  inColumn?: boolean;
}

export const MOBILE_BREAKPOINT = 640;
const MAX_DEPTH = 6;

export const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const decodeEntities = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);?/gi, (_m, h) => safeFromCode(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_m, d) => safeFromCode(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, '\u00a0')
    .replace(/&amp;/g, '&');
const safeFromCode = (n: number) => (Number.isFinite(n) && n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : '');

const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback);
const num = (v: unknown, fallback: number, min = -Infinity, max = Infinity) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const optNum = (v: unknown, min = -Infinity, max = Infinity) => {
  const n = num(v, NaN, min, max);
  return Number.isFinite(n) ? n : undefined;
};
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** Only plain colors: hex, rgb(a)/hsl(a) with numeric args, named colors. */
export function safeColor(v: unknown): string | undefined {
  const s = str(v).trim();
  if (!s) return undefined;
  if (/^#[0-9a-f]{3,8}$/i.test(s)) return s;
  if (/^(rgb|hsl)a?\(\s*[\d.\s,%/]+\)$/i.test(s)) return s;
  if (/^[a-z]{3,20}$/i.test(s)) return s;
  return undefined;
}

/** Link targets: http(s), mailto, tel, root-relative, anchors. Anything with another scheme is dropped. */
export const safeUrl = (u?: string) => {
  const url = str(u).trim();
  if (!url) return '#';
  const probe = decodeEntities(url).replace(/[\u0000-\u0020\u007f-\u009f]/g, '');
  if (/^(https?:|mailto:|tel:)/i.test(probe)) return url;
  if (/^(\/(?!\/)|#|\?)/.test(probe)) return url;
  if (/^\/\//.test(probe)) return 'https:' + url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(probe)) return '#'; // blocks javascript:, data: ...
  return 'https://' + url;
};

/** Image sources: http(s) and root-relative only (made absolute in emails when a base URL is known). */
export function safeSrc(u: unknown, ctx?: Pick<RenderContext, 'baseUrl' | 'mode'>): string {
  const url = str(u).trim();
  if (!url) return '';
  const probe = url.replace(/[\u0000-\u0020]/g, '');
  if (/^https?:\/\//i.test(probe)) return url;
  if (/^\/(?!\/)/.test(probe)) return ctx?.baseUrl ? ctx.baseUrl.replace(/\/+$/, '') + url : url;
  if (/^\/\//.test(probe)) return 'https:' + url;
  // Inline SVG illustrations (kits): an <img> / CSS background never runs scripts. Not in emails (Gmail drops them).
  if (ctx?.mode !== 'email' && /^data:image\/svg\+xml[;,][\w%.,;=:/+*!~-]+$/i.test(probe) && probe.length <= 20000) return probe;
  return '';
}

const cssUrl = (u: string) => `url('${u.replace(/['"\\()\s<>]/g, (c) => encodeURIComponent(c))}')`;

export function applyVars(text: string, vars?: Record<string, string>) {
  if (!vars) return text;
  // `{{field.key}}`: custom fields of the contact
  return text.replace(/\{\{\s*(\w+(?:\.\w+)?)\s*\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

/** Legacy markdown subset: escapes then applies **bold**, *italic*, [label](url), newlines. */
export function inline(text: string, ctx: RenderContext) {
  let out = esc(applyVars(str(text), ctx.vars));
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<em>$2</em>');
  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_m, label, url) => `<a href="${esc(safeUrl(decodeEntities(url)))}" style="color:${esc(safeColor(ctx.settings.accent) ?? '#2563eb')};text-decoration:underline">${label}</a>`,
  );
  return out.replace(/\n/g, '<br>');
}

// ---------- rich text (sanitized HTML subset) ----------

const RICH_TAG_RE = /<\/?(b|strong|i|em|u|s|a|br|span|div|p|font)(\s[^>]*)?\/?>/i;
/** True when a rich-text field is stored as HTML (new format) rather than markdown-lite. */
export const isRichHtml = (s: unknown) => typeof s === 'string' && RICH_TAG_RE.test(s);

const INLINE_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'a', 'span']);
const BLOCK_TAGS = new Set(['div', 'p', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'section', 'article', 'header', 'footer', 'tr']);
const ATTR_RE = /([^\s"'>\/=]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function parseAttrs(s: string) {
  const out: Record<string, string> = {};
  let m: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(s))) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

const escText = (s: string) =>
  s.replace(/&(?!(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Strict allowlist sanitizer for rich text. Keeps b/strong/i/em/u/s/br, a[href http(s)/mailto/tel/relative]
 * and span[style=color]. Block tags become line breaks, everything else is dropped (text kept, escaped).
 * Output is always balanced. Runs without a DOM (Node and browser).
 */
export function sanitizeRich(input: unknown, opts: { linkStyle?: string } = {}): string {
  let s = str(input);
  s = s.replace(/<!--[\s\S]*?(-->|$)/g, '');
  s = s.replace(/<(script|style|iframe|object|embed|template|noscript|textarea|title|svg|math|select|head)\b[\s\S]*?(<\/\1\s*>|$)/gi, '');
  const out: string[] = [];
  const stack: { tag: string; emitted: boolean }[] = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const hasContent = () => out.some((x) => x !== '');
  while ((m = re.exec(s))) {
    out.push(escText(s.slice(last, m.index)));
    last = re.lastIndex;
    const closing = !!m[1];
    const raw = m[2].toLowerCase();
    const tag = raw === 'strike' ? 's' : raw;
    if (tag === 'br') {
      if (!closing) out.push('<br>');
      continue;
    }
    if (BLOCK_TAGS.has(tag)) {
      if (!closing && hasContent() && out[out.length - 1] !== '<br>') out.push('<br>');
      continue;
    }
    if (!INLINE_TAGS.has(tag) && tag !== 'font') continue;
    if (closing) {
      const name = tag === 'font' ? 'span' : tag;
      let i = stack.length - 1;
      while (i >= 0 && stack[i].tag !== name) i--;
      if (i < 0) continue;
      while (stack.length > i) {
        const t = stack.pop()!;
        if (t.emitted) out.push(`</${t.tag}>`);
      }
      continue;
    }
    const attrs = parseAttrs(m[3] ?? '');
    if (tag === 'a') {
      const href = attrs.href ? safeUrl(attrs.href) : '#';
      const nested = stack.some((t) => t.tag === 'a' && t.emitted);
      if (href === '#' || nested) {
        stack.push({ tag: 'a', emitted: false });
        continue;
      }
      const blank = attrs.target === '_blank';
      out.push(`<a href="${esc(href)}"${blank ? ' target="_blank" rel="noopener noreferrer"' : ''}${opts.linkStyle ? ` style="${esc(opts.linkStyle)}"` : ''}>`);
      stack.push({ tag: 'a', emitted: true });
      continue;
    }
    if (tag === 'span' || tag === 'font') {
      let color: string | undefined;
      if (tag === 'font') color = safeColor(attrs.color);
      const style = attrs.style ?? '';
      const cm = /(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(style);
      if (cm) color = safeColor(cm[1].trim()) ?? color;
      if (color) {
        out.push(`<span style="color:${esc(color)}">`);
        stack.push({ tag: 'span', emitted: true });
      } else stack.push({ tag: 'span', emitted: false });
      continue;
    }
    out.push(`<${tag}>`);
    stack.push({ tag, emitted: true });
  }
  out.push(escText(s.slice(last)));
  while (stack.length) {
    const t = stack.pop()!;
    if (t.emitted) out.push(`</${t.tag}>`);
  }
  let html = out.join('');
  html = html.replace(/(<br>)+$/, '');
  return html;
}

/** Rich text field → HTML. Accepts the legacy markdown-lite or the sanitized HTML subset. */
export function rich(text: unknown, ctx: RenderContext): string {
  const t = str(text);
  if (!isRichHtml(t)) return inline(t, ctx);
  const html = sanitizeRich(t, { linkStyle: `color:${safeColor(ctx.settings.accent) ?? '#2563eb'};text-decoration:underline` });
  if (!ctx.vars) return html;
  const vars = ctx.vars;
  return html.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in vars ? esc(vars[k]) : m));
}

/**
 * Normalizes HTML coming from a contentEditable editor into a stored rich-text value: sanitized HTML,
 * or plain text when there is no formatting (wrapped in a span when it would be misread as markdown-lite).
 */
export function normalizeRich(html: string): string {
  const s = sanitizeRich(str(html).replace(/&nbsp;|\u00a0/g, ' ')).trim();
  if (/<[a-z]/i.test(s)) return s;
  const text = decodeEntities(s);
  return /[*[\]<>&]/.test(text) ? `<span>${s}</span>` : text;
}

/** Rich-text value → HTML suitable for a contentEditable editor (legacy markdown converted, merge tags kept). */
export function richToEditable(text: unknown): string {
  const t = str(text);
  if (isRichHtml(t)) return sanitizeRich(t);
  let out = esc(t);
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) => `<a href="${esc(safeUrl(decodeEntities(url)))}">${label}</a>`);
  return out.replace(/\n/g, '<br>');
}

/** Plain text field (no formatting) → escaped HTML with merge tags applied. */
const plain = (text: unknown, ctx: RenderContext) => esc(applyVars(str(text), ctx.vars)).replace(/\n/g, '<br>');

/** Converts a rich text value to plain text (layers panel, summaries). */
export function richToPlain(text: unknown): string {
  const t = str(text);
  if (isRichHtml(t)) return decodeEntities(sanitizeRich(t).replace(/<br>/g, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
  return t.replace(/\*\*|\*|\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
}

// ---------- css helpers ----------

type CssValue = string | number | undefined | null | false;
const UNITLESS = /^(fontWeight|lineHeight|opacity|flex|flexGrow|flexShrink|zIndex|order)$/;
/** Builds an inline style string. Values are escaped for use inside a double-quoted attribute. */
export const css = (o: Record<string, CssValue>) =>
  esc(
    Object.entries(o)
      .filter(([, v]) => v !== undefined && v !== null && v !== false && v !== '' && !(typeof v === 'number' && !Number.isFinite(v)))
      .map(([k, v]) => {
        const prop = k.startsWith('--') ? k : k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
        const val = typeof v === 'number' && !UNITLESS.test(k) ? v + 'px' : String(v);
        return `${prop}:${val.replace(/[<>"]/g, '')}`;
      })
      .join(';'),
  );

export const SHADOWS: Record<string, string | undefined> = {
  none: undefined,
  sm: '0 1px 3px rgba(15,23,42,0.12)',
  md: '0 8px 20px -6px rgba(15,23,42,0.18)',
  lg: '0 18px 40px -12px rgba(15,23,42,0.28)',
  xl: '0 30px 60px -18px rgba(15,23,42,0.38)',
};

function visibilityClasses(s: BlockStyle) {
  const c: string[] = [];
  if (s.hideOnMobile) c.push('scalo-hide-m');
  if (s.hideOnDesktop) c.push('scalo-hide-d');
  return c;
}

const clsAttr = (c: string[]) => (c.length ? ` class="${c.join(' ')}"` : '');

/** Box styles shared by every block wrapper: spacing, background, border, shadow, radius. */
function boxStyle(s: BlockStyle, defaults: { py: number; px: number }) {
  const py = num(s.paddingY, defaults.py, 0, 400);
  const bw = optNum(s.borderWidth, 0, 40);
  return {
    paddingTop: num(s.paddingTop, py, 0, 400),
    paddingBottom: num(s.paddingBottom, py, 0, 400),
    paddingLeft: num(s.paddingX, defaults.px, 0, 200),
    paddingRight: num(s.paddingX, defaults.px, 0, 200),
    marginTop: optNum(s.marginTop, -200, 400),
    marginBottom: optNum(s.marginBottom, -200, 400),
    background: safeColor(s.background),
    border: bw ? `${bw}px solid ${safeColor(s.borderColor) ?? '#e2e8f0'}` : undefined,
    borderRadius: optNum(s.borderRadius, 0, 400),
    boxShadow: s.shadow ? SHADOWS[s.shadow] : undefined,
  };
}

function typo(s: BlockStyle, fallbackSize: number) {
  return {
    fontSize: num(s.fontSize, fallbackSize, 6, 200),
    fontWeight: optNum(s.fontWeight, 100, 900),
    lineHeight: optNum(s.lineHeight, 0.8, 3),
    letterSpacing: optNum(s.letterSpacing, -10, 30),
  };
}

/** class + custom property for the per-device (mobile) font size. */
function mobileFont(s: BlockStyle): { cls: string[]; vars: Record<string, CssValue> } {
  const m = optNum(s.mobileFontSize, 6, 200);
  return m ? { cls: ['scalo-mfs'], vars: { '--scalo-mfs': `${m}px` } } : { cls: [], vars: {} };
}

const editAttr = (ctx: RenderContext, field: string) => (ctx.mode === 'editor' ? ` data-edit="${esc(field)}"` : '');

const accentOf = (ctx: RenderContext) => safeColor(ctx.settings.accent) ?? '#2563eb';
const textColorOf = (ctx: RenderContext) => safeColor(ctx.settings.textColor) ?? '#0f172a';

// ---------- theme (design tokens of `settings.theme`, see PageTheme) ----------

export interface ResolvedTheme {
  surface?: string;
  surfaceText?: string;
  border?: string;
  accentText?: string;
  accent2?: string;
  radius?: number;
  buttonRadius?: number;
  borderWidth?: number;
  shadow?: 'none' | 'soft' | 'hard';
  headingWeight?: number;
  headingSpacing?: number;
  headingCase?: 'uppercase';
  buttonWeight?: number;
  buttonSpacing?: number;
  buttonCase?: 'uppercase';
}
const themeCache = new WeakMap<object, ResolvedTheme>();

/** Sanitized tokens of the page, or null when the content has no theme (then nothing changes in the output). */
export function themeOf(ctx: Pick<RenderContext, 'settings'>): ResolvedTheme | null {
  const raw = ctx.settings?.theme as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const hit = themeCache.get(raw);
  if (hit) return hit;
  const t = raw as Record<string, unknown>;
  const th: ResolvedTheme = {
    surface: safeColor(t.surface),
    surfaceText: safeColor(t.surfaceText),
    border: safeColor(t.border),
    accentText: safeColor(t.accentText),
    accent2: safeColor(t.accent2),
    radius: optNum(t.radius, 0, 60),
    buttonRadius: optNum(t.buttonRadius, 0, 100),
    borderWidth: optNum(t.borderWidth, 0, 6),
    shadow: t.shadow === 'none' || t.shadow === 'soft' || t.shadow === 'hard' ? t.shadow : undefined,
    headingWeight: optNum(t.headingWeight, 100, 900),
    headingSpacing: optNum(t.headingSpacing, -10, 30),
    headingCase: t.headingCase === 'upper' ? 'uppercase' : undefined,
    buttonWeight: optNum(t.buttonWeight, 100, 900),
    buttonSpacing: optNum(t.buttonSpacing, -10, 30),
    buttonCase: t.buttonCase === 'upper' ? 'uppercase' : undefined,
  };
  themeCache.set(raw, th);
  return th;
}

/** Border and shadow of a themed card (testimonial, pricing, colored column). */
function themedCard(th: ResolvedTheme, ctx: RenderContext, highlight?: string) {
  const hard = th.shadow === 'hard';
  const bw = hard ? Math.max(2, th.borderWidth ?? 2) : (th.borderWidth ?? 1);
  const line = hard ? textColorOf(ctx) : (th.border ?? '#e2e8f0');
  return {
    border: highlight ? `${Math.max(2, bw)}px solid ${highlight}` : bw ? `${bw}px solid ${line}` : undefined,
    boxShadow:
      ctx.mode === 'email' || th.shadow === 'none' ? undefined
      : hard ? `6px 6px 0 ${highlight ?? textColorOf(ctx)}`
      : th.shadow === 'soft' ? '0 18px 40px -24px rgba(15,23,42,0.35)'
      : undefined,
  };
}

function videoEmbed(url: string): string | null {
  const yt = url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/);
  if (yt) return `https://www.youtube.com/embed/${yt[1]}`;
  const vm = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (vm) return `https://player.vimeo.com/video/${vm[1]}`;
  return null;
}
const youtubeId = (url: string) => url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/)?.[1];

const HEADING_SIZES = { 1: 40, 2: 30, 3: 22 } as const;
const placeholder = (label: string) =>
  `<div style="${css({ border: '2px dashed #cbd5e1', borderRadius: 8, padding: 36, color: '#94a3b8', textAlign: 'center', fontSize: 14, fontFamily: 'Inter, Arial, sans-serif' })}">${esc(label)}</div>`;

// ---------- buttons ----------

function buttonHtml(
  opts: { label: string; href: string; bg?: string; color?: string; radius?: number; full?: boolean; size?: 'sm' | 'md' | 'lg'; outline?: boolean; fontSize?: number; fontWeight?: number; newTab?: boolean; edit?: string; align?: string },
  ctx: RenderContext,
) {
  const th = themeOf(ctx);
  const bg = safeColor(opts.bg) ?? accentOf(ctx);
  // the theme's "text on accent" only applies to buttons painted with the accent itself
  const fg = safeColor(opts.color) ?? (opts.outline ? bg : ((!safeColor(opts.bg) || safeColor(opts.bg) === accentOf(ctx)) && th?.accentText) || '#ffffff');
  const pad = opts.size === 'sm' ? '11px 22px' : opts.size === 'lg' ? '20px 40px' : '16px 32px';
  const upper = th?.buttonCase;
  const fs = opts.fontSize ?? Math.round((opts.size === 'sm' ? 15 : opts.size === 'lg' ? 20 : 18) * (upper ? 0.82 : 1));
  const radius = num(opts.radius, th?.buttonRadius ?? 8, 0, 100);
  const weight = opts.fontWeight ?? th?.buttonWeight ?? 700;
  const hard = th?.shadow === 'hard' && !opts.outline;
  const hardLine = hard ? `2px solid ${textColorOf(ctx)}` : undefined;
  const label = `<span${opts.edit ? editAttr(ctx, opts.edit) : ''}>${opts.label}</span>`;
  if (ctx.mode === 'email') {
    // bulletproof button: the table cell carries the background (Outlook), the link is padded for clicks.
    const align = opts.align === 'left' || opts.align === 'right' ? opts.align : 'center';
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"${opts.full ? ' width="100%"' : ''} align="${align}" style="${css({ margin: align === 'center' ? '0 auto' : undefined, borderCollapse: 'separate' })}"><tr><td align="center" bgcolor="${esc(opts.outline ? '' : bg)}" style="${css({ borderRadius: radius, background: opts.outline ? undefined : bg, border: opts.outline ? `2px solid ${bg}` : hardLine })}"><a href="${esc(opts.href)}" target="_blank" style="${css({ display: 'block', padding: pad, fontSize: fs, fontWeight: weight, color: fg, textDecoration: 'none', borderRadius: radius, fontFamily: 'inherit', lineHeight: 1.2, textTransform: upper, letterSpacing: th?.buttonSpacing })}">${label}</a></td></tr></table>`;
  }
  const style = css({
    display: opts.full ? 'block' : 'inline-block',
    background: opts.outline ? 'transparent' : bg,
    color: fg,
    border: opts.outline ? `2px solid ${bg}` : hardLine,
    padding: pad,
    borderRadius: radius,
    fontWeight: weight,
    fontSize: fs,
    lineHeight: 1.2,
    textDecoration: 'none',
    textAlign: 'center',
    fontFamily: 'inherit',
    textTransform: upper,
    letterSpacing: th?.buttonSpacing,
    boxShadow: hard ? `4px 4px 0 ${textColorOf(ctx)}` : undefined,
  });
  if (ctx.mode === 'editor') return `<span class="scalo-btn" style="${style}">${label}</span>`;
  return `<a class="scalo-btn" href="${esc(opts.href)}"${opts.newTab ? ' target="_blank" rel="noopener"' : ''} style="${style}">${label}</a>`;
}

// ---------- social ----------

const SOCIAL: Record<SocialNetwork, { label: string; color: string; glyph: string; svg: string }> = {
  facebook: { label: 'Facebook', color: '#1877f2', glyph: 'f', svg: '<path d="M13.5 21v-7h2.4l.4-2.9h-2.8V9.3c0-.8.3-1.4 1.4-1.4h1.5V5.3c-.3 0-1.2-.1-2.2-.1-2.2 0-3.6 1.3-3.6 3.7v2.2H8.2V14h2.4v7z" fill="currentColor"/>' },
  instagram: { label: 'Instagram', color: '#e4405f', glyph: 'IG', svg: '<rect x="5" y="5" width="14" height="14" rx="4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="16.3" cy="7.7" r="1.1" fill="currentColor"/>' },
  x: { label: 'X', color: '#0f172a', glyph: 'X', svg: '<path d="M6 5l12 14M18 5L6 19" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' },
  linkedin: { label: 'LinkedIn', color: '#0a66c2', glyph: 'in', svg: '<rect x="6" y="10" width="2.6" height="8" fill="currentColor"/><circle cx="7.3" cy="6.9" r="1.5" fill="currentColor"/><path d="M11 10h2.5v1.2c.5-.8 1.4-1.4 2.7-1.4 2 0 2.8 1.3 2.8 3.4V18h-2.6v-4.3c0-1-.3-1.7-1.3-1.7s-1.5.7-1.5 1.7V18H11z" fill="currentColor"/>' },
  youtube: { label: 'YouTube', color: '#ff0000', glyph: '▶', svg: '<rect x="4" y="7" width="16" height="10.5" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10.5 9.8v5l4.2-2.5z" fill="currentColor"/>' },
  tiktok: { label: 'TikTok', color: '#111111', glyph: '♪', svg: '<path d="M14 5c.4 2 1.8 3.4 4 3.6v2.5c-1.5 0-2.8-.4-4-1.2V15a4.5 4.5 0 1 1-4.5-4.5h.6v2.6h-.6a1.9 1.9 0 1 0 1.9 1.9V5z" fill="currentColor"/>' },
  website: { label: 'Site web', color: '#475569', glyph: 'www', svg: '<circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4.5 12h15M12 4.5c2.2 2.4 2.2 12.6 0 15M12 4.5c-2.2 2.4-2.2 12.6 0 15" fill="none" stroke="currentColor" stroke-width="1.6"/>' },
  email: { label: 'Email', color: '#475569', glyph: '@', svg: '<rect x="4.5" y="6.5" width="15" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5 7.5l7 5.5 7-5.5" fill="none" stroke="currentColor" stroke-width="1.8"/>' },
};
export const SOCIAL_NETWORKS = Object.fromEntries(Object.entries(SOCIAL).map(([k, v]) => [k, { label: v.label, color: v.color }])) as Record<SocialNetwork, { label: string; color: string }>;

function socialIcon(network: SocialNetwork, url: string, size: number, variant: string, ctx: RenderContext) {
  const n = SOCIAL[network] ?? SOCIAL.website;
  const base = variant === 'accent' ? accentOf(ctx) : variant === 'dark' ? '#0f172a' : n.color;
  const outline = variant === 'outline';
  const bg = outline ? 'transparent' : base;
  const fg = outline ? textColorOf(ctx) : '#ffffff';
  const href = network === 'email' && url && !/^mailto:/i.test(url) && url.includes('@') ? `mailto:${url}` : safeUrl(url);
  if (ctx.mode === 'email') {
    return `<td style="padding:0 4px"><a href="${esc(href)}" target="_blank" title="${esc(n.label)}" style="${css({ display: 'inline-block', width: size, height: size, lineHeight: `${size}px`, borderRadius: size, background: bg, border: outline ? `1px solid ${textColorOf(ctx)}` : undefined, color: fg, textAlign: 'center', textDecoration: 'none', fontFamily: 'Arial, sans-serif', fontWeight: 700, fontSize: Math.round(size * (n.glyph.length > 2 ? 0.28 : 0.42)) })}">${esc(n.glyph)}</a></td>`;
  }
  const inner = `<svg viewBox="0 0 24 24" width="${Math.round(size * 0.6)}" height="${Math.round(size * 0.6)}" aria-hidden="true" style="display:block">${n.svg}</svg>`;
  const style = css({
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, borderRadius: size,
    background: bg, color: fg, border: outline ? `1.5px solid ${textColorOf(ctx)}` : undefined, margin: '4px', textDecoration: 'none', verticalAlign: 'middle',
  });
  return ctx.mode === 'editor'
    ? `<span title="${esc(n.label)}" style="${style}">${inner}</span>`
    : `<a href="${esc(href)}" target="_blank" rel="noopener" title="${esc(n.label)}" aria-label="${esc(n.label)}" style="${style}">${inner}</a>`;
}

// ---------- countdown ----------

function countdownParts(ms: number) {
  const t = Math.max(0, Math.floor(ms / 1000));
  return { d: Math.floor(t / 86400), h: Math.floor((t % 86400) / 3600), m: Math.floor((t % 3600) / 60), s: t % 60 };
}
const pad2 = (n: number) => String(n).padStart(2, '0');

// ---------- layout parts (shared with the editor canvas for WYSIWYG) ----------

export interface SectionParts {
  cls: string[];
  outer: string;           // style of the outer element (background, padding...)
  overlay: string | null;  // style of the overlay layer (absolute)
  inner: string;           // style of the content wrapper
}

export function sectionParts(b: SectionBlock, ctx: RenderContext, topLevel: boolean): SectionParts {
  const s = b.style ?? {};
  const box = boxStyle(s, { py: 56, px: 24 });
  const grad = b.gradient && safeColor(b.gradient.from) && safeColor(b.gradient.to)
    ? `linear-gradient(${num(b.gradient.angle, 135, 0, 360)}deg, ${safeColor(b.gradient.from)}, ${safeColor(b.gradient.to)})`
    : undefined;
  const img = safeSrc(b.bgImage, ctx);
  const backgrounds = [img ? cssUrl(img) : undefined, grad].filter(Boolean).join(', ');
  const minH = optNum(b.minHeight, 0, 2000);
  const valign = b.valign ?? 'center';
  const overlayOpacity = num(b.overlayOpacity, 0, 0, 100);
  const overlayColor = safeColor(b.overlayColor);
  const cls = ['scalo-sec', ...visibilityClasses(s)];
  if (b.fullWidth && topLevel && ctx.mode !== 'email') cls.push('scalo-full');
  // themed pages: generous desktop paddings are tightened on phones (class + custom properties, see builderCss)
  const tight = themeOf(ctx) && ctx.mode !== 'email' && (box.paddingTop > 56 || box.paddingBottom > 56);
  if (tight) cls.push('scalo-mpy');
  const mpy = (v: number) => `${v > 56 ? Math.max(48, Math.round(v * 0.6)) : v}px`;
  const outer = css({
    position: 'relative',
    ...(tight ? { '--scalo-mpt': mpy(box.paddingTop), '--scalo-mpb': mpy(box.paddingBottom) } : {}),
    ...box,
    backgroundColor: box.background,
    background: undefined,
    backgroundImage: backgrounds || undefined,
    backgroundSize: img ? b.bgSize ?? 'cover' : undefined,
    backgroundPosition: img ? b.bgPosition ?? 'center' : undefined,
    backgroundRepeat: img ? 'no-repeat' : undefined,
    color: safeColor(s.color),
    textAlign: s.align,
    minHeight: minH,
    display: minH ? 'flex' : undefined,
    flexDirection: minH ? 'column' : undefined,
    justifyContent: minH ? (valign === 'top' ? 'flex-start' : valign === 'bottom' ? 'flex-end' : 'center') : undefined,
    overflow: box.borderRadius ? 'hidden' : undefined,
  });
  const overlay = overlayColor && overlayOpacity > 0
    ? css({ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: overlayColor, opacity: overlayOpacity / 100, pointerEvents: 'none' })
    : null;
  const inner = css({
    position: 'relative',
    maxWidth: optNum(b.contentWidth, 200, 2400),
    width: '100%',
    margin: '0 auto',
  });
  return { cls, outer, overlay, inner };
}

export interface ColumnsParts {
  cls: string[];
  outer: string;
  cols: { id: string; style: string }[];
}

export function columnsParts(b: ColumnsBlock, _ctx: RenderContext): ColumnsParts {
  const s = b.style ?? {};
  const th = themeOf(_ctx);
  const box = boxStyle(s, { py: 8, px: 24 });
  const gap = num(b.gap, 24, 0, 120);
  const valign = b.valign ?? 'top';
  const cls = ['scalo-cols', ...visibilityClasses(s)];
  if (b.stackOnMobile !== false) cls.push('scalo-stack');
  if (b.reverseOnMobile) cls.push('scalo-rev');
  const outer = css({
    ...box,
    display: 'flex',
    gap,
    alignItems: valign === 'center' ? 'center' : valign === 'bottom' ? 'flex-end' : 'stretch',
    color: safeColor(s.color),
    textAlign: s.align,
  });
  const cols = arr<ColumnsBlock['columns'][number]>(b.columns).map((c) => ({
    id: str(c?.id),
    style: css({
      flex: `${num(c?.width, 50, 1, 100)} 1 0%`,
      minWidth: 0,
      background: safeColor(c?.background),
      padding: optNum(c?.padding, 0, 200),
      // themed pages: roomy cards are tightened on phones (see builderCss)
      ...(th && (optNum(c?.padding, 0, 200) ?? 0) > 24 ? { '--scalo-mcp': '24px' } : {}),
      borderRadius: safeColor(c?.background) ? (th?.radius ?? 8) : undefined,
      // themed pages: a colored column is a card
      ...(th && safeColor(c?.background) ? themedCard(th, _ctx) : {}),
      display: valign !== 'top' ? 'flex' : undefined,
      flexDirection: valign !== 'top' ? 'column' : undefined,
      justifyContent: valign === 'center' ? 'center' : valign === 'bottom' ? 'flex-end' : undefined,
    }),
  }));
  return { cls, outer, cols };
}

// ---------- block renderer ----------

/** Wrapper for leaf blocks (div for pages/editor, table for emails). */
function wrapLeaf(b: Block, ctx: RenderContext, inner: string, extra: { align?: boolean } = {}) {
  const s = b.style ?? {};
  const box = boxStyle(s, { py: 12, px: ctx.inColumn ? 0 : 24 });
  const align = s.align ?? 'left';
  const color = safeColor(s.color) ?? (ctx.depth ? undefined : textColorOf(ctx));
  const cls = visibilityClasses(s);
  if (ctx.mode === 'email') {
    const hideD = s.hideOnDesktop ? { display: 'none', maxHeight: 0, overflow: 'hidden', msoHide: 'all' } : {};
    const tdStyle = css({
      padding: `${box.paddingTop}px ${box.paddingRight}px ${box.paddingBottom}px ${box.paddingLeft}px`,
      background: box.background,
      textAlign: extra.align === false ? undefined : align,
      color,
      border: box.border,
      borderRadius: box.borderRadius,
      boxShadow: box.boxShadow,
    });
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"${clsAttr(cls)} style="${css({ marginTop: box.marginTop, marginBottom: box.marginBottom, borderCollapse: 'separate', ...hideD })}"><tr><td${extra.align === false ? '' : ` align="${align}"`} style="${tdStyle}">${inner}</td></tr></table>`;
  }
  return `<div data-block-id="${esc(b.id)}"${clsAttr(cls)} style="${css({
    ...box,
    textAlign: extra.align === false ? undefined : align,
    color,
    boxSizing: 'border-box',
  })}">${inner}</div>`;
}

export function renderBlock(b: Block, ctx: RenderContext): string {
  if (!b || typeof b !== 'object') return '';
  const depth = ctx.depth ?? 0;
  if (depth > MAX_DEPTH) return '';
  const s: BlockStyle = b.style && typeof b.style === 'object' ? b.style : {};
  const { settings } = ctx;
  const accent = accentOf(ctx);
  const th = themeOf(ctx);
  const isEmail = ctx.mode === 'email';
  const wrap = (inner: string, extra?: { align?: boolean }) => wrapLeaf(b, ctx, inner, extra);

  switch (b.type) {
    case 'heading': {
      const level = ([1, 2, 3] as const).includes(b.level) ? b.level : 2;
      const t = typo(s, HEADING_SIZES[level]);
      const mf = mobileFont(s);
      return wrap(
        `<h${level}${clsAttr(mf.cls)}${editAttr(ctx, 'text')} style="${css({ margin: 0, fontSize: t.fontSize, lineHeight: t.lineHeight ?? 1.2, fontWeight: t.fontWeight ?? th?.headingWeight ?? 800, letterSpacing: t.letterSpacing ?? th?.headingSpacing, textTransform: th?.headingCase, color: 'inherit', fontFamily: settings.headingFont || 'inherit', ...mf.vars })}">${rich(b.text, ctx)}</h${level}>`,
      );
    }
    case 'text': {
      const t = typo(s, 17);
      const mf = mobileFont(s);
      return wrap(`<p${clsAttr(mf.cls)}${editAttr(ctx, 'text')} style="${css({ margin: 0, fontSize: t.fontSize, lineHeight: t.lineHeight ?? 1.6, fontWeight: t.fontWeight, letterSpacing: t.letterSpacing, ...mf.vars })}">${rich(b.text, ctx)}</p>`);
    }
    case 'list': {
      const t = typo(s, 17);
      const items = arr<string>(b.items);
      const marker = (i: number) => (b.icon === 'check' ? '✓' : b.icon === 'number' ? `${i + 1}.` : b.icon === 'arrow' ? '→' : b.icon === 'star' ? '★' : '•');
      const lis = items
        .map(
          (it, i) =>
            `<li style="${css({ margin: '0 0 8px', listStyle: 'none', display: 'block' })}"><span style="${css({ color: accent, fontWeight: 700, marginRight: 10 })}">${marker(i)}</span><span${editAttr(ctx, `items.${i}`)}>${rich(it, ctx)}</span></li>`,
        )
        .join('');
      const tag = b.icon === 'number' ? 'ol' : 'ul';
      return wrap(`<${tag} style="${css({ margin: 0, padding: 0, fontSize: t.fontSize, lineHeight: t.lineHeight ?? 1.5, fontWeight: t.fontWeight, display: 'inline-block', textAlign: 'left' })}">${lis}</${tag}>`);
    }
    case 'image': {
      const src = safeSrc(b.src, ctx);
      if (!src) return wrap(ctx.mode === 'editor' ? placeholder('Image — choisissez ou importez une image') : '');
      const w = num(b.width, 100, 5, 100);
      const img = `<img src="${esc(src)}" alt="${esc(b.alt)}"${isEmail ? ` width="${Math.round((num(settings.maxWidth, 600, 200, 1200) * w) / 100)}"` : ''} style="${css({ width: `${w}%`, maxWidth: '100%', height: 'auto', display: 'inline-block', border: 0, borderRadius: num(b.radius, 8, 0, 400), verticalAlign: 'middle' })}">`;
      return wrap(b.href && ctx.mode !== 'editor' ? `<a href="${esc(safeUrl(b.href))}"${isEmail ? ' target="_blank"' : ''}>${img}</a>` : img);
    }
    case 'button': {
      const href = b.action === 'next' && !isEmail ? ctx.nextUrl ?? '#' : safeUrl(b.url);
      return wrap(
        buttonHtml(
          { label: rich(b.label, ctx), href, bg: b.bg, color: b.textColor, radius: b.radius, full: b.fullWidth, size: b.size, outline: b.variant === 'outline', fontSize: optNum(s.fontSize, 8, 80), fontWeight: optNum(s.fontWeight, 100, 900), newTab: b.newTab, edit: 'label', align: s.align ?? 'left' },
          ctx,
        ),
      );
    }
    case 'form': {
      if (isEmail) return '';
      const radius = num(b.inputRadius, th?.radius ?? 8, 0, 40);
      const input = css({
        display: 'block', width: '100%', boxSizing: 'border-box', padding: '14px 16px', margin: '0 0 12px',
        border: th ? `${th.shadow === 'hard' ? 2 : Math.max(1, th.borderWidth ?? 1)}px solid ${th.shadow === 'hard' ? textColorOf(ctx) : (th.border ?? '#cbd5e1')}` : '1px solid #cbd5e1',
        borderRadius: radius, fontSize: 16, fontFamily: 'inherit', background: th?.surface ?? '#fff', color: th?.surfaceText ?? '#0f172a',
      });
      const fields = arr<FormFieldLike>(b.fields)
        .filter((f) => f && (['email', 'first_name', 'last_name', 'phone'].includes(f.name) || CUSTOM_INPUT_RE.test(str(f.name))))
        .map((f) => {
          if (f.name.startsWith('field.')) return customInput(f, input, ctx);
          const type = f.name === 'email' ? 'email' : f.name === 'phone' ? 'tel' : 'text';
          const auto = f.name === 'email' ? 'email' : f.name === 'first_name' ? 'given-name' : f.name === 'last_name' ? 'family-name' : 'tel';
          return `<input type="${type}" name="${f.name}" autocomplete="${auto}" placeholder="${esc(f.label)}" aria-label="${esc(f.label)}"${f.required || f.name === 'email' ? ' required' : ''}${ctx.mode === 'editor' ? ' disabled' : ''} style="${input}">`;
        })
        .join('');
      const btn = css({
        display: 'block', width: '100%', padding: '16px', border: th?.shadow === 'hard' ? `2px solid ${textColorOf(ctx)}` : 0, borderRadius: th?.buttonRadius !== undefined && b.inputRadius === undefined ? Math.min(th.buttonRadius, 40) : radius, cursor: 'pointer',
        background: safeColor(b.buttonBg) ?? accent, color: safeColor(b.buttonColor) ?? th?.accentText ?? '#fff', fontWeight: th?.buttonWeight ?? 700, fontSize: th?.buttonCase ? 15 : 18, fontFamily: 'inherit',
        textTransform: th?.buttonCase, letterSpacing: th?.buttonSpacing, boxShadow: th?.shadow === 'hard' ? `4px 4px 0 ${textColorOf(ctx)}` : undefined,
      });
      const hidden = `<input type="hidden" name="_block" value="${esc(b.id)}">`;
      return wrap(
        `<form method="post" action="${esc(ctx.formAction ?? '#')}" style="${css({ margin: '0 auto', maxWidth: 440, textAlign: 'left' })}"${ctx.mode === 'editor' ? ' onsubmit="return false"' : ''}>${hidden}${fields}<button type="submit" class="scalo-btn" style="${btn}"${ctx.mode === 'editor' ? ' disabled' : ''}>${esc(b.submitLabel)}</button></form>`,
      );
    }
    case 'video': {
      const url = str(b.url);
      const embed = videoEmbed(url);
      if (isEmail) {
        if (!url) return '';
        const yt = youtubeId(url);
        if (yt) {
          const thumb = `https://img.youtube.com/vi/${yt}/hqdefault.jpg`;
          return wrap(`<a href="${esc(safeUrl(url))}" target="_blank" style="display:block;text-decoration:none"><img src="${esc(thumb)}" alt="Regarder la vidéo" width="${num(settings.maxWidth, 600, 200, 1200) - 48}" style="${css({ width: '100%', maxWidth: '100%', height: 'auto', display: 'block', border: 0, borderRadius: 8 })}"></a><div style="padding-top:10px"><a href="${esc(safeUrl(url))}" target="_blank" style="${css({ color: accent, fontWeight: 700, textDecoration: 'none' })}">▶ Regarder la vidéo</a></div>`);
        }
        return wrap(`<a href="${esc(safeUrl(url))}" target="_blank" style="${css({ color: accent, fontWeight: 700 })}">▶ Regarder la vidéo</a>`);
      }
      if (!embed) {
        if (!url) return wrap(ctx.mode === 'editor' ? placeholder('Vidéo — collez une URL YouTube ou Vimeo') : '');
        return wrap(`<a href="${esc(safeUrl(url))}" style="${css({ color: accent, fontWeight: 700 })}">▶ Regarder la vidéo</a>`);
      }
      const yt = youtubeId(url);
      const frame = ctx.mode === 'editor'
        ? `<div style="${css({ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: yt ? `#0f172a ${cssUrl(`https://img.youtube.com/vi/${yt}/hqdefault.jpg`)} center/cover` : '#0f172a', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' })}"><span style="${css({ width: 68, height: 48, borderRadius: 12, background: 'rgba(15,23,42,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22 })}">▶</span></div>`
        : `<iframe src="${esc(embed)}" title="Vidéo" loading="lazy" style="${css({ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', border: 0 })}" allowfullscreen allow="autoplay; encrypted-media; picture-in-picture"></iframe>`;
      return wrap(`<div style="${css({ position: 'relative', paddingTop: '56.25%', borderRadius: 8, overflow: 'hidden' })}">${frame}</div>`);
    }
    case 'spacer': {
      const h = num(b.height, 32, 0, 800);
      const cls = visibilityClasses(s);
      if (isEmail) return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"${clsAttr(cls)}><tr><td height="${h}" style="${css({ height: h, lineHeight: `${h}px`, fontSize: 1, background: safeColor(s.background) })}">&nbsp;</td></tr></table>`;
      return `<div data-block-id="${esc(b.id)}"${clsAttr(cls)} style="${css({ height: h, background: safeColor(s.background) })}"></div>`;
    }
    case 'divider': {
      const w = num(b.width, 100, 5, 100);
      return wrap(`<hr style="${css({ border: 0, borderTop: `${num(b.thickness, 1, 1, 20)}px ${['dashed', 'dotted'].includes(str(b.lineStyle)) ? b.lineStyle : 'solid'} ${safeColor(b.color) ?? th?.border ?? '#e2e8f0'}`, margin: '0 auto', width: `${w}%` })}">`);
    }

    case 'section': {
      const children = arr<Block>(b.children);
      const parts = sectionParts(b, ctx, depth === 0);
      const inner = renderBlocks(children, { ...ctx, depth: depth + 1, inColumn: false });
      if (isEmail) {
        const bg = safeColor(s.background) ?? (b.gradient ? safeColor(b.gradient.from) : undefined);
        const img = safeSrc(b.bgImage, ctx);
        const box = boxStyle(s, { py: 40, px: 0 });
        const grad = b.gradient && safeColor(b.gradient.from) && safeColor(b.gradient.to) ? `linear-gradient(${num(b.gradient.angle, 135, 0, 360)}deg, ${safeColor(b.gradient.from)}, ${safeColor(b.gradient.to)})` : undefined;
        const tdStyle = css({
          padding: `${box.paddingTop}px ${box.paddingLeft}px ${box.paddingBottom}px ${box.paddingRight}px`,
          backgroundColor: bg,
          backgroundImage: [img ? cssUrl(img) : undefined, grad].filter(Boolean).join(', ') || undefined,
          backgroundSize: img ? 'cover' : undefined,
          backgroundPosition: img ? 'center' : undefined,
          color: safeColor(s.color),
          textAlign: s.align,
          borderRadius: box.borderRadius,
          border: box.border,
        });
        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"${clsAttr(visibilityClasses(s))} style="${css({ marginTop: box.marginTop, marginBottom: box.marginBottom })}"><tr><td${bg ? ` bgcolor="${esc(bg)}"` : ''}${img ? ` background="${esc(img)}"` : ''} style="${tdStyle}">${inner}</td></tr></table>`;
      }
      return `<section data-block-id="${esc(b.id)}" class="${parts.cls.join(' ')}" style="${parts.outer}">${parts.overlay ? `<div style="${parts.overlay}"></div>` : ''}<div style="${parts.inner}">${inner}</div></section>`;
    }
    case 'columns': {
      const cols = arr<ColumnsBlock['columns'][number]>(b.columns);
      const parts = columnsParts(b, ctx);
      const childCtx: RenderContext = { ...ctx, depth: depth + 1, inColumn: true };
      if (isEmail) {
        const total = cols.reduce((a, c) => a + num(c?.width, 50, 1, 100), 0) || 1;
        const gap = num(b.gap, 24, 0, 120);
        const valign = b.valign === 'center' ? 'middle' : b.valign === 'bottom' ? 'bottom' : 'top';
        const box = boxStyle(s, { py: 8, px: 24 });
        const tds = cols
          .map((c, i) => {
            const pct = Math.round((num(c?.width, 50, 1, 100) / total) * 1000) / 10;
            const padL = i === 0 ? 0 : gap / 2;
            const padR = i === cols.length - 1 ? 0 : gap / 2;
            return `<td class="scalo-col" width="${pct}%" valign="${valign}" style="${css({ width: `${pct}%`, verticalAlign: valign, padding: `0 ${padR}px 0 ${padL}px` })}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="${css({ background: safeColor(c?.background), padding: optNum(c?.padding, 0, 200), borderRadius: safeColor(c?.background) ? (th?.radius ?? 8) : undefined, border: th && safeColor(c?.background) ? themedCard(th, ctx).border : undefined })}">${renderBlocks(arr<Block>(c?.children), childCtx)}</td></tr></table></td>`;
          })
          .join('');
        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"${clsAttr(visibilityClasses(s))} style="${css({ marginTop: box.marginTop, marginBottom: box.marginBottom })}"><tr><td style="${css({ padding: `${box.paddingTop}px ${box.paddingRight}px ${box.paddingBottom}px ${box.paddingLeft}px`, background: box.background, borderRadius: box.borderRadius, border: box.border })}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="scalo-cols"><tr>${tds}</tr></table></td></tr></table>`;
      }
      const colsHtml = cols
        .map((c, i) => `<div class="scalo-col" style="${parts.cols[i]?.style ?? ''}">${renderBlocks(arr<Block>(c?.children), childCtx)}</div>`)
        .join('');
      return `<div data-block-id="${esc(b.id)}" class="${parts.cls.join(' ')}" style="${parts.outer}">${colsHtml}</div>`;
    }

    case 'countdown': {
      const now = ctx.now ?? Date.now();
      const evergreen = b.mode === 'evergreen';
      const minutes = num(b.minutes, 30, 1, 60 * 24 * 365);
      const end = evergreen ? now + minutes * 60_000 : Date.parse(str(b.date)) || now + 3 * 86400_000;
      const p = countdownParts(end - now);
      const boxBg = safeColor(b.boxBg) ?? (th ? textColorOf(ctx) : '#0f172a');
      const boxFg = safeColor(b.boxColor) ?? (th ? (safeColor(settings.contentBackground) ?? '#ffffff') : '#ffffff');
      const boxRadius = th?.radius !== undefined ? Math.min(th.radius, 12) : undefined;
      const labels = b.showLabels !== false;
      const t = typo(s, 34);
      const unit = (k: 'd' | 'h' | 'm' | 's', v: number, label: string) =>
        isEmail
          ? `<td style="padding:0 4px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="${esc(boxBg)}" style="${css({ background: boxBg, color: boxFg, borderRadius: boxRadius ?? 10, padding: '12px 14px', minWidth: 56, fontSize: t.fontSize, fontWeight: 800, fontFamily: 'inherit', lineHeight: 1 })}">${pad2(v)}${labels ? `<div style="${css({ fontSize: 11, fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', opacity: 0.75, paddingTop: 6 })}">${label}</div>` : ''}</td></tr></table></td>`
          : `<div style="${css({ display: 'inline-block', background: boxBg, color: boxFg, borderRadius: boxRadius ?? 12, padding: th ? '12px 6px 10px' : '14px 10px 12px', minWidth: th ? 60 : 76, margin: th ? '3px' : '4px', textAlign: 'center', verticalAlign: 'top' })}"><div data-u="${k}" style="${css({ fontSize: t.fontSize, fontWeight: th?.headingWeight ?? 800, lineHeight: 1, fontVariantNumeric: 'tabular-nums', fontFamily: th ? settings.headingFont : undefined })}">${pad2(v)}</div>${labels ? `<div style="${css({ fontSize: 11, fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', opacity: 0.75, marginTop: 6 })}">${label}</div>` : ''}</div>`;
      const units = unit('d', p.d, 'Jours') + unit('h', p.h, 'Heures') + unit('m', p.m, 'Min') + unit('s', p.s, 'Sec');
      if (isEmail) return wrap(`<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto"><tr>${units}</tr></table>`);
      const attrs = ctx.mode === 'page'
        ? ` data-scalo-countdown="" data-key="${esc(b.id)}"${evergreen ? ` data-minutes="${minutes}"` : ` data-end="${end}"`} data-expired="${esc(b.expiredText ?? '')}"`
        : '';
      return wrap(`<div${attrs}>${units}</div>`);
    }
    case 'testimonial': {
      const stars = Math.round(num(b.stars, 5, 0, 5));
      const photo = safeSrc(b.photo, ctx);
      const card = b.layout !== 'plain';
      const starsHtml = stars ? `<div style="${css({ color: th?.accent2 ?? '#f59e0b', fontSize: 18, letterSpacing: 2, marginBottom: 12 })}">${'★'.repeat(stars)}<span style="color:${esc(th?.border ?? '#e2e8f0')}">${'★'.repeat(5 - stars)}</span></div>` : '';
      const quote = `<div style="${css({ fontSize: num(s.fontSize, 18, 10, 60), lineHeight: 1.6, fontStyle: 'italic', marginBottom: 18 })}">“<span${editAttr(ctx, 'quote')}>${rich(b.quote, ctx)}</span>”</div>`;
      const who = `<div${editAttr(ctx, 'name')} style="${css({ fontWeight: 700, fontSize: 16 })}">${plain(b.name, ctx)}</div>${b.role ? `<div style="${css({ fontSize: 14, opacity: 0.65, marginTop: 2 })}">${plain(b.role, ctx)}</div>` : ''}`;
      const img = (sz: number) => (photo ? `<img src="${esc(photo)}" alt="${esc(b.name)}" width="${sz}" height="${sz}" style="${css({ width: sz, height: sz, borderRadius: sz, objectFit: 'cover', display: 'block', border: 0 })}">` : '');
      const align = s.align ?? 'left';
      const person = isEmail
        ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0"${align === 'center' ? ' align="center"' : ''}><tr>${photo ? `<td style="padding-right:12px" valign="middle">${img(48)}</td>` : ''}<td valign="middle" style="text-align:left">${who}</td></tr></table>`
        : `<div style="${css({ display: 'flex', alignItems: 'center', gap: 12, justifyContent: align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start', textAlign: 'left' })}">${img(48)}<div>${who}</div></div>`;
      const body = `${starsHtml}${quote}${person}`;
      const cardBg = safeColor(b.cardBg) ?? th?.surface ?? '#ffffff';
      const cardStyle = !card ? ''
        : th ? css({ background: cardBg, borderRadius: th.radius ?? 16, padding: 28, color: safeColor(b.cardBg) ? 'inherit' : (th.surfaceText ?? 'inherit'), ...themedCard(th, ctx) })
        : css({ background: cardBg, border: '1px solid #e2e8f0', borderRadius: 16, padding: 28, boxShadow: isEmail ? undefined : '0 10px 30px -18px rgba(15,23,42,0.25)', color: 'inherit' });
      return wrap(card ? (isEmail ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="${cardStyle}">${body}</td></tr></table>` : `<div style="${cardStyle}">${body}</div>`) : body);
    }
    case 'pricing': {
      const hl = !!b.highlighted;
      const ac = safeColor(b.accent) ?? accent;
      const features = arr<string>(b.features)
        .map((f, i) => `<li style="${css({ listStyle: 'none', padding: '7px 0', borderBottom: '1px solid rgba(148,163,184,0.18)', display: 'block' })}"><span style="${css({ color: ac, fontWeight: 800, marginRight: 10 })}">✓</span><span${editAttr(ctx, `features.${i}`)}>${rich(f, ctx)}</span></li>`)
        .join('');
      const href = b.action === 'next' && !isEmail ? ctx.nextUrl ?? '#' : safeUrl(b.url);
      const badge = hl && b.badge ? `<div style="${css({ display: 'inline-block', background: ac, color: (ac === accent && th?.accentText) || '#fff', fontSize: 12, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', padding: '5px 12px', borderRadius: 999, marginBottom: 14 })}">${plain(b.badge, ctx)}</div>` : '';
      const body = `${badge}<div${editAttr(ctx, 'title')} style="${css({ fontSize: 20, fontWeight: 700 })}">${plain(b.title, ctx)}</div>${b.description ? `<div${editAttr(ctx, 'description')} style="${css({ fontSize: 15, opacity: 0.7, marginTop: 6 })}">${rich(b.description, ctx)}</div>` : ''}<div style="${css({ margin: '18px 0 20px' })}"><span${editAttr(ctx, 'price')} style="${css({ fontSize: 48, fontWeight: th?.headingWeight ?? 800, lineHeight: 1, letterSpacing: -1, fontFamily: th ? settings.headingFont : undefined })}">${plain(b.price, ctx)}</span>${b.period ? `<span style="${css({ fontSize: 16, opacity: 0.6, marginLeft: 6 })}">${plain(b.period, ctx)}</span>` : ''}</div><ul style="${css({ margin: '0 0 24px', padding: 0, textAlign: 'left', fontSize: 16 })}">${features}</ul>${buttonHtml({ label: plain(b.buttonLabel, ctx), href, bg: ac, full: true, radius: th ? undefined : 10, size: 'md', outline: !hl, edit: 'buttonLabel' }, ctx)}`;
      const cardStyle = th
        ? css({
            background: safeColor(b.cardBg) ?? th.surface ?? '#ffffff', color: safeColor(b.cardBg) ? '#0f172a' : (th.surfaceText ?? '#0f172a'), borderRadius: th.radius ?? 18, padding: '32px 28px', textAlign: 'center',
            maxWidth: 420, margin: '0 auto', ...themedCard(th, ctx, hl ? ac : undefined),
          })
        : css({
        background: safeColor(b.cardBg) ?? '#ffffff', color: '#0f172a', border: hl ? `2px solid ${ac}` : '1px solid #e2e8f0', borderRadius: 18, padding: '32px 28px', textAlign: 'center',
        boxShadow: isEmail ? undefined : hl ? '0 24px 50px -20px rgba(15,23,42,0.35)' : '0 10px 30px -20px rgba(15,23,42,0.2)', maxWidth: 420, margin: '0 auto',
      });
      return wrap(isEmail ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:420px;margin:0 auto"><tr><td style="${cardStyle}">${body}</td></tr></table>` : `<div style="${cardStyle}">${body}</div>`);
    }
    case 'faq': {
      const items = arr<{ q: string; a: string }>(b.items).filter((it) => it && typeof it === 'object');
      const border = 'rgba(148,163,184,0.35)';
      if (isEmail) {
        return wrap(items.map((it) => `<div style="${css({ padding: '14px 0', borderBottom: `1px solid ${border}` })}"><div style="${css({ fontWeight: 700, fontSize: 17, marginBottom: 6 })}">${plain(it.q, ctx)}</div><div style="${css({ fontSize: 15, lineHeight: 1.6, opacity: 0.85 })}">${rich(it.a, ctx)}</div></div>`).join(''), { align: false });
      }
      const html = items
        .map(
          (it, i) =>
            `<details${(ctx.mode === 'editor' || (b.openFirst && i === 0)) ? ' open' : ''} style="${css({ borderBottom: `1px solid ${border}`, padding: '4px 0' })}"><summary style="${css({ cursor: 'pointer', listStyle: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, padding: '14px 0', fontWeight: 700, fontSize: num(s.fontSize, 18, 10, 40) })}"><span${editAttr(ctx, `items.${i}.q`)}>${plain(it.q, ctx)}</span><span class="scalo-chev" style="${css({ color: accent, fontSize: 22, fontWeight: 400, lineHeight: 1, transition: 'transform .2s' })}">+</span></summary><div${editAttr(ctx, `items.${i}.a`)} style="${css({ padding: '0 0 16px', fontSize: 16, lineHeight: 1.65, opacity: 0.85 })}">${rich(it.a, ctx)}</div></details>`,
        )
        .join('');
      return wrap(`<div class="scalo-faq" style="text-align:left">${html}</div>`, { align: false });
    }
    case 'feature': {
      const size = num(b.iconSize, 56, 24, 140);
      const iconBg = safeColor(b.iconBg) ?? (/^#[0-9a-f]{6}$/i.test(accent) ? `${accent}1a` : '#eef2ff');
      const left = b.layout === 'left';
      const align = s.align ?? (left ? 'left' : 'center');
      // themed pages: the icon can be a short label ("01", "A") drawn in the accent color with the heading font
      const glyph = str(b.icon, '✨').slice(0, 8);
      const label = !!th && /^[\w+#&.→↗✓·-]{1,3}$/.test(glyph);
      const icon = `<div style="${css({ width: size, height: size, lineHeight: `${size}px`, borderRadius: th?.radius !== undefined ? Math.min(th.radius, Math.round(size / 2)) : Math.round(size * 0.28), background: iconBg, fontSize: Math.round(size * (label ? 0.36 : 0.5)), textAlign: 'center', display: 'inline-block', flexShrink: 0, ...(label ? { color: accent, fontWeight: th.headingWeight ?? 700, fontFamily: settings.headingFont } : {}) })}">${esc(glyph)}</div>`;
      const title = `<div${editAttr(ctx, 'title')} style="${css({ fontWeight: th?.headingWeight ?? 700, fontFamily: th ? settings.headingFont : undefined, fontSize: num(s.fontSize, 19, 10, 60), margin: left ? '0 0 6px' : '16px 0 8px', lineHeight: 1.3 })}">${plain(b.title, ctx)}</div>`;
      const text = `<div${editAttr(ctx, 'text')} style="${css({ fontSize: 15.5, lineHeight: 1.6, opacity: 0.8 })}">${rich(b.text, ctx)}</div>`;
      if (left) {
        return wrap(
          isEmail
            ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td valign="top" style="padding-right:16px">${icon}</td><td valign="top" style="text-align:left">${title}${text}</td></tr></table>`
            : `<div style="${css({ display: 'flex', gap: 16, alignItems: 'flex-start', textAlign: 'left' })}">${icon}<div>${title}${text}</div></div>`,
          { align: false },
        );
      }
      return wrap(`<div style="text-align:${align}">${icon}${title}${text}</div>`);
    }
    case 'social': {
      const size = num(b.size, 40, 20, 80);
      const links = arr<{ network: SocialNetwork; url: string }>(b.links).filter((l) => l && SOCIAL[l.network]);
      if (!links.length) return wrap(ctx.mode === 'editor' ? placeholder('Réseaux sociaux — ajoutez des liens') : '');
      const icons = links.map((l) => socialIcon(l.network, str(l.url), size, str(b.variant, 'brand'), ctx)).join('');
      const align = s.align ?? 'center';
      return wrap(isEmail ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${align}"${align === 'center' ? ' style="margin:0 auto"' : ''}><tr>${icons}</tr></table>` : `<div>${icons}</div>`, isEmail ? {} : undefined);
    }
    case 'imageText': {
      const src = safeSrc(b.src, ctx);
      const iw = num(b.imageWidth, 45, 20, 70);
      const right = b.imagePosition === 'right';
      const radius = num(b.radius, th?.radius ?? 14, 0, 200);
      const img = src
        ? `<img src="${esc(src)}" alt="${esc(b.alt)}"${isEmail ? ` width="${Math.round(((num(settings.maxWidth, 600, 200, 1200) - 48) * iw) / 100)}"` : ''} style="${css({ width: '100%', height: 'auto', display: 'block', borderRadius: radius, border: 0 })}">`
        : ctx.mode === 'editor' ? placeholder('Image') : '';
      const href = b.buttonAction === 'next' && !isEmail ? ctx.nextUrl ?? '#' : safeUrl(b.buttonUrl);
      const text = `${b.title ? `<h3${editAttr(ctx, 'title')} style="${css({ margin: '0 0 12px', fontSize: 26, lineHeight: 1.25, fontWeight: th?.headingWeight ?? 800, letterSpacing: th?.headingSpacing, textTransform: th?.headingCase, fontFamily: settings.headingFont || 'inherit' })}">${plain(b.title, ctx)}</h3>` : ''}<div${editAttr(ctx, 'text')} style="${css({ fontSize: num(s.fontSize, 17, 10, 40), lineHeight: 1.65 })}">${rich(b.text, ctx)}</div>${b.buttonLabel ? `<div style="margin-top:20px">${buttonHtml({ label: plain(b.buttonLabel, ctx), href, size: 'md', radius: th ? undefined : 10, edit: 'buttonLabel', align: 'left' }, ctx)}</div>` : ''}`;
      if (isEmail) {
        const imgTd = `<td class="scalo-col" width="${iw}%" valign="middle" style="${css({ width: `${iw}%`, padding: right ? '0 0 0 12px' : '0 12px 0 0' })}">${img}</td>`;
        const txtTd = `<td class="scalo-col" width="${100 - iw}%" valign="middle" style="${css({ width: `${100 - iw}%`, padding: right ? '0 12px 0 0' : '0 0 0 12px', textAlign: 'left' })}">${text}</td>`;
        return wrap(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${right ? txtTd + imgTd : imgTd + txtTd}</tr></table>`, { align: false });
      }
      const imgDiv = `<div style="${css({ flex: `0 0 ${iw}%`, maxWidth: `${iw}%` })}">${img}</div>`;
      const txtDiv = `<div style="${css({ flex: '1 1 0%', minWidth: 0, textAlign: 'left' })}">${text}</div>`;
      return wrap(`<div class="scalo-it${right ? ' scalo-it-r' : ''}" style="${css({ display: 'flex', gap: 40, alignItems: 'center' })}">${right ? txtDiv + imgDiv : imgDiv + txtDiv}</div>`, { align: false });
    }
    case 'progress': {
      const v = num(b.value, 70, 0, 100);
      const h = num(b.height, 14, 4, 48);
      const bar = safeColor(b.barColor) ?? accent;
      const track = safeColor(b.trackColor) ?? th?.border ?? '#e2e8f0';
      const label = b.label ? `<div style="${css({ display: 'flex', justifyContent: 'space-between', fontSize: 15, fontWeight: 600, marginBottom: 8 })}"><span${editAttr(ctx, 'label')}>${plain(b.label, ctx)}</span><span>${v}%</span></div>` : '';
      if (isEmail) {
        return wrap(`${b.label ? `<div style="${css({ fontSize: 15, fontWeight: 600, marginBottom: 8 })}">${plain(b.label, ctx)} — ${v}%</div>` : ''}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${css({ background: track, borderRadius: h })}"><tr><td width="${v}%" height="${h}" bgcolor="${esc(bar)}" style="${css({ background: bar, height: h, borderRadius: h, fontSize: 1, lineHeight: `${h}px` })}">&nbsp;</td>${v < 100 ? `<td style="font-size:1px">&nbsp;</td>` : ''}</tr></table>`, { align: false });
      }
      const stripes = b.striped ? 'linear-gradient(45deg,rgba(255,255,255,.18) 25%,transparent 25%,transparent 50%,rgba(255,255,255,.18) 50%,rgba(255,255,255,.18) 75%,transparent 75%,transparent)' : undefined;
      return wrap(`${label}<div style="${css({ background: track, borderRadius: h, height: h, overflow: 'hidden' })}"><div style="${css({ width: `${v}%`, height: '100%', background: bar, backgroundImage: stripes, backgroundSize: stripes ? '20px 20px' : undefined, borderRadius: h })}"></div></div>`, { align: false });
    }
    case 'navbar': {
      const logoSrc = safeSrc(b.logoSrc, ctx);
      const logo = logoSrc
        ? `<img src="${esc(logoSrc)}" alt="${esc(b.logoText ?? 'Logo')}" width="${num(b.logoWidth, 140, 30, 400)}" style="${css({ width: num(b.logoWidth, 140, 30, 400), maxWidth: '100%', height: 'auto', display: 'block', border: 0 })}">`
        : `<span${editAttr(ctx, 'logoText')} style="${css({ fontWeight: th?.headingWeight ?? 800, fontSize: 22, letterSpacing: th?.headingSpacing ?? -0.3, textTransform: th?.headingCase, fontFamily: settings.headingFont || 'inherit' })}">${plain(b.logoText || 'Logo', ctx)}</span>`;
      const links = arr<{ label: string; url: string }>(b.links).filter(Boolean);
      const linkA = (l: { label: string; url: string }) =>
        ctx.mode === 'editor' ? `<span style="${css({ fontWeight: 500, fontSize: 15, opacity: 0.85 })}">${plain(l.label, ctx)}</span>` : `<a href="${esc(safeUrl(l.url))}" style="${css({ fontWeight: 500, fontSize: 15, textDecoration: 'none', color: 'inherit', opacity: 0.85 })}">${plain(l.label, ctx)}</a>`;
      if (isEmail) {
        const row = links.map(linkA).join('<span style="opacity:.35;padding:0 10px">|</span>');
        return wrap(`<div style="text-align:center">${logoSrc ? `<div style="display:inline-block">${logo}</div>` : logo}</div>${row ? `<div style="${css({ textAlign: 'center', paddingTop: 12, fontSize: 14 })}">${row}</div>` : ''}`, { align: false });
      }
      const cta = b.ctaLabel ? buttonHtml({ label: plain(b.ctaLabel, ctx), href: safeUrl(b.ctaUrl), size: 'sm', radius: th ? undefined : 8, edit: 'ctaLabel' }, ctx) : '';
      const nav = `<div style="${css({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24 })}"><div>${logo}</div><div style="${css({ display: 'flex', alignItems: 'center', gap: 28 })}"><nav class="scalo-nav-links" style="${css({ display: 'flex', gap: 28, alignItems: 'center' })}">${links.map(linkA).join('')}</nav>${th && cta ? `<span class="scalo-nav-links">${cta}</span>` : cta}</div></div>`;
      const out = wrap(nav, { align: false });
      return b.sticky && ctx.mode === 'page' ? out.replace('style="', 'style="position:sticky;top:0;z-index:50;') : out;
    }
    case 'footer': {
      const links = arr<{ label: string; url: string }>(b.links).filter(Boolean);
      const linkA = (l: { label: string; url: string }) =>
        ctx.mode === 'editor' ? `<span style="margin:0 10px;text-decoration:underline">${plain(l.label, ctx)}</span>` : `<a href="${esc(safeUrl(l.url))}"${isEmail ? ' target="_blank"' : ''} style="${css({ margin: '0 10px', color: 'inherit', textDecoration: 'underline' })}">${plain(l.label, ctx)}</a>`;
      const t = typo(s, 14);
      return wrap(
        `<div style="${css({ fontSize: t.fontSize, lineHeight: 1.6, opacity: 0.8 })}">${b.text ? `<div${editAttr(ctx, 'text')}>${rich(b.text, ctx)}</div>` : ''}${links.length ? `<div style="margin-top:10px">${links.map(linkA).join('')}</div>` : ''}${b.copyright ? `<div${editAttr(ctx, 'copyright')} style="margin-top:10px;opacity:.75">${plain(b.copyright, ctx)}</div>` : ''}</div>`,
      );
    }
    case 'html': {
      if (isEmail) return '';
      const code = str(b.html);
      if (ctx.mode === 'editor') {
        const preview = code.trim()
          ? `<iframe sandbox="" title="Aperçu HTML" srcdoc="${esc(`<!doctype html><meta charset=utf-8><body style="margin:0;font-family:${settings.fontFamily}">${code}`)}" style="${css({ width: '100%', height: 140, border: 0, display: 'block', background: '#fff', pointerEvents: 'none' })}"></iframe>`
          : `<div style="${css({ padding: 24, color: '#94a3b8', fontSize: 13, textAlign: 'center' })}">Collez votre code HTML dans le panneau de droite</div>`;
        return wrap(`<div style="${css({ border: '1px dashed #94a3b8', borderRadius: 8, overflow: 'hidden', textAlign: 'left', fontFamily: 'Inter, Arial, sans-serif' })}"><div style="${css({ background: '#0f172a', color: '#e2e8f0', fontSize: 11, fontWeight: 600, padding: '5px 10px', letterSpacing: 0.3 })}">&lt;/&gt; HTML personnalisé — exécuté uniquement sur la page publique</div>${preview}</div>`, { align: false });
      }
      // Page owner's own code, rendered as-is on their public page only (never in emails / editor).
      return wrap(code, { align: false });
    }
    case 'rating': {
      const max = Math.round(num(b.max, 5, 1, 10));
      const v = num(b.value, 5, 0, max);
      const full = Math.round(v);
      const size = num(b.size, 26, 10, 80);
      const color = safeColor(b.starColor) ?? th?.accent2 ?? '#f59e0b';
      return wrap(`<div style="${css({ fontSize: size, lineHeight: 1, letterSpacing: 2 })}"><span style="color:${esc(color)}">${'★'.repeat(full)}</span><span style="color:${esc(th?.border ?? '#e2e8f0')}">${'★'.repeat(Math.max(0, max - full))}</span></div>${b.caption ? `<div${editAttr(ctx, 'caption')} style="${css({ fontSize: 15, marginTop: 8, opacity: 0.75 })}">${plain(b.caption, ctx)}</div>` : ''}`);
    }
    case 'quote': {
      const bar = safeColor(b.barColor) ?? accent;
      const t = typo(s, 22);
      const body = `<div${editAttr(ctx, 'text')} style="${css({ fontSize: t.fontSize, lineHeight: t.lineHeight ?? 1.5, fontStyle: 'italic', fontWeight: t.fontWeight ?? 500, fontFamily: settings.headingFont || 'inherit' })}">${rich(b.text, ctx)}</div>${b.author ? `<div style="${css({ marginTop: 12, fontSize: 15, fontWeight: 600, opacity: 0.7 })}">— <span${editAttr(ctx, 'author')}>${plain(b.author, ctx)}</span></div>` : ''}`;
      return wrap(
        isEmail
          ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td width="4" bgcolor="${esc(bar)}" style="${css({ background: bar, width: 4 })}"></td><td style="padding:4px 0 4px 20px;text-align:left">${body}</td></tr></table>`
          : `<blockquote style="${css({ margin: 0, padding: '4px 0 4px 22px', borderLeft: `4px solid ${bar}`, textAlign: 'left' })}">${body}</blockquote>`,
        { align: false },
      );
    }
    case 'checkout':
    case 'upsell':
      return isEmail ? '' : wrap(renderPaymentBlock(b, ctx, accent));
    default:
      return '';
  }
}

interface FormFieldLike { name: string; label: string; required?: boolean; input?: string; options?: unknown }

const CUSTOM_INPUT_RE = /^field\.[a-z][a-z0-9_]{0,39}$/;

/** Input of a custom contact field (`field.<key>`) in a form block. */
function customInput(f: FormFieldLike, inputCss: string, ctx: RenderContext) {
  const dis = ctx.mode === 'editor' ? ' disabled' : '';
  const req = f.required ? ' required' : '';
  const name = esc(f.name);
  const label = esc(str(f.label));
  if (f.input === 'checkbox') {
    return `<label style="${css({ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 12px', fontSize: 15 })}"><input type="checkbox" name="${name}" value="true"${req}${dis}> ${label}</label>`;
  }
  if (f.input === 'select') {
    const opts = arr<unknown>(f.options).map((o) => str(o)).filter(Boolean);
    return `<select name="${name}" aria-label="${label}"${req}${dis} style="${inputCss}"><option value="">${label}</option>${opts.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}</select>`;
  }
  const type = f.input === 'number' ? 'number' : f.input === 'date' ? 'date' : 'text';
  return `<input type="${type}" name="${name}"${type === 'number' ? ' step="any"' : ''} placeholder="${label}" aria-label="${label}"${req}${dis} style="${inputCss}">`;
}

export function renderBlocks(blocks: Block[], ctx: RenderContext) {
  return arr<Block>(blocks).map((b) => renderBlock(b, ctx)).join('\n');
}

/** Depth-first iteration over every block of a tree (sections, columns...). */
export function flattenBlocks(blocks: Block[], out: Block[] = [], depth = 0): Block[] {
  if (depth > MAX_DEPTH + 1) return out;
  for (const b of arr<Block>(blocks)) {
    if (!b || typeof b !== 'object') continue;
    out.push(b);
    if (b.type === 'section') flattenBlocks(arr<Block>(b.children), out, depth + 1);
    else if (b.type === 'columns') for (const c of arr<{ children: Block[] }>(b.columns)) flattenBlocks(arr<Block>(c?.children), out, depth + 1);
  }
  return out;
}

/** True when a page contains owner-authored code (custom HTML blocks or head code). */
export function pageHasCustomCode(content: PageContent) {
  if (str(content?.settings?.headCode).trim()) return true;
  return flattenBlocks(arr<Block>(content?.blocks)).some((b) => b.type === 'html' && str(b.html).trim());
}

// ---------- responsive / shared css ----------

/**
 * Class-based rules used by the renderer. `page`/`email` use media queries, `editor` uses container
 * queries on the device frame (container name `scalo`) and dims hidden blocks instead of removing them.
 */
export function builderCss(target: 'page' | 'editor' | 'email'): string {
  const bp = MOBILE_BREAKPOINT;
  if (target === 'email') {
    return `@media only screen and (max-width:620px){.scalo-col{display:block!important;width:100%!important;max-width:100%!important;padding:0 0 16px 0!important}.scalo-hide-m{display:none!important;max-height:0!important;overflow:hidden!important}.scalo-hide-d{display:table!important;max-height:none!important}.scalo-mfs{font-size:var(--scalo-mfs)!important}.scalo-wrap{padding:12px 0!important}}`;
  }
  const common =
    `.scalo-cols{display:flex}.scalo-col{min-width:0}` +
    `.scalo-faq summary::-webkit-details-marker{display:none}.scalo-faq summary::marker{content:''}.scalo-faq details[open] .scalo-chev{transform:rotate(45deg)}`;
  const mobile = (hide: string) =>
    `.scalo-stack{flex-direction:column!important}.scalo-stack.scalo-rev{flex-direction:column-reverse!important}.scalo-stack>.scalo-col{flex:1 1 auto!important;width:100%!important}` +
    `.scalo-it{flex-direction:column!important;gap:24px!important}.scalo-it.scalo-it-r{flex-direction:column-reverse!important}.scalo-it>div{flex:1 1 auto!important;max-width:100%!important;width:100%!important}` +
    `.scalo-nav-links{display:none!important}.scalo-mfs{font-size:var(--scalo-mfs)!important}` +
    `.scalo-mpy{padding-top:var(--scalo-mpt)!important;padding-bottom:var(--scalo-mpb)!important}` +
    `.scalo-stack>.scalo-col[style*="--scalo-mcp"]{padding:var(--scalo-mcp)!important}${hide}`;
  if (target === 'page') {
    return `${common}.scalo-btn{transition:filter .15s ease,transform .15s ease}.scalo-btn:hover{filter:brightness(1.08);transform:translateY(-1px)}` +
      `.scalo-full{margin-left:calc(50% - 50vw)!important;margin-right:calc(50% - 50vw)!important}` +
      `@media (max-width:${bp}px){${mobile('.scalo-hide-m{display:none!important}')}}@media (min-width:${bp + 1}px){.scalo-hide-d{display:none!important}}`;
  }
  const dim = (c: string) => `${c}{opacity:.38;outline:1px dashed #94a3b8;outline-offset:-1px}`;
  return `${common}.scalo-full{margin-left:calc(50% - 50cqw)!important;margin-right:calc(50% - 50cqw)!important}` +
    `@container scalo (max-width:${bp}px){${mobile(dim('.scalo-hide-m'))}}@container scalo (min-width:${bp + 1}px){${dim('.scalo-hide-d')}}`;
}

// ---------- fonts ----------

export const GOOGLE_FONTS = [
  'Inter', 'Poppins', 'Montserrat', 'Roboto', 'Open Sans', 'Lato', 'Raleway', 'Nunito', 'DM Sans', 'Work Sans',
  'Outfit', 'Space Grotesk', 'Plus Jakarta Sans', 'Manrope', 'Playfair Display', 'Merriweather', 'Lora', 'Oswald', 'Bebas Neue', 'DM Serif Display',
  // used by the kits (kits/)
  'Fraunces', 'Newsreader', 'Cormorant Garamond', 'Sora', 'Bricolage Grotesque', 'Figtree',
];
/** Serif families also loaded in italic (headings of the kits use *italic* words). */
const ITALIC_FONTS = new Set(['Fraunces', 'Newsreader', 'Cormorant Garamond']);

/** Google Fonts stylesheet URL for the fonts used by the settings (null when only system fonts are used). */
export function googleFontsUrl(settings: Pick<PageSettings, 'fontFamily' | 'headingFont'>): string | null {
  const fams = new Set<string>();
  for (const stack of [settings.fontFamily, settings.headingFont]) {
    const first = str(stack).split(',')[0]?.trim().replace(/^['"]|['"]$/g, '');
    if (first && GOOGLE_FONTS.includes(first)) fams.add(first);
  }
  if (!fams.size) return null;
  const q = [...fams]
    .map((f) => `family=${f.replace(/ /g, '+')}:${ITALIC_FONTS.has(f) ? 'ital,wght@0,400;0,500;0,600;0,700;1,400;1,500;1,600' : 'wght@400;500;600;700;800'}`)
    .join('&');
  return `https://fonts.googleapis.com/css2?${q}&display=swap`;
}

// ---------- documents ----------

const COUNTDOWN_SCRIPT = `<script>(function(){function p(n){return(n<10?'0':'')+n}document.querySelectorAll('[data-scalo-countdown]').forEach(function(el){var end=Number(el.getAttribute('data-end'));var min=Number(el.getAttribute('data-minutes'));if(min){var k='scalo_cd_'+el.getAttribute('data-key'),s=null;try{s=Number(localStorage.getItem(k))||null;if(!s){s=Date.now();localStorage.setItem(k,String(s))}}catch(e){s=Date.now()}end=s+min*60000}function t(){var r=Math.max(0,Math.floor((end-Date.now())/1000));var v={d:Math.floor(r/86400),h:Math.floor(r%86400/3600),m:Math.floor(r%3600/60),s:r%60};for(var u in v){var n=el.querySelector('[data-u="'+u+'"]');if(n)n.textContent=p(v[u])}if(r<=0){clearInterval(i);var x=el.getAttribute('data-expired');if(x){el.textContent=x;el.style.fontSize='20px';el.style.fontWeight='700'}}}var i=setInterval(t,1000);t()})})();</script>`;

/** Full standalone HTML document for a public funnel page. */
/**
 * `headExtra` / `bodyEnd`: trusted HTML generated by the server (pixels, cookie banner, legal footer), appended at the
 * end of <head> / before </body>. Never user input.
 */
export function renderPageDocument(content: PageContent, ctx: Omit<RenderContext, 'mode' | 'settings'> & { title: string; headExtra?: string; bodyEnd?: string }) {
  const settings = { ...DEFAULT_SETTINGS, ...(content?.settings ?? {}) };
  const rctx: RenderContext = { ...ctx, mode: 'page', settings, depth: 0 };
  const blocks = arr<Block>(content?.blocks);
  const title = str(settings.seoTitle).trim() || ctx.title;
  const desc = str(settings.seoDescription).trim();
  const og = safeSrc(settings.ogImage);
  const favicon = safeSrc(settings.favicon);
  const fonts = googleFontsUrl(settings);
  const hasCountdown = flattenBlocks(blocks).some((b) => b.type === 'countdown');
  const head = [
    `<title>${esc(title)}</title>`,
    desc ? `<meta name="description" content="${esc(desc)}">` : '',
    `<meta property="og:title" content="${esc(title)}">`,
    desc ? `<meta property="og:description" content="${esc(desc)}">` : '',
    og ? `<meta property="og:image" content="${esc(og)}"><meta name="twitter:card" content="summary_large_image">` : '',
    favicon ? `<link rel="icon" href="${esc(favicon)}">` : '',
    fonts ? `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${esc(fonts)}">` : '',
    `<style>*{box-sizing:border-box}body{margin:0;overflow-x:hidden}img{max-width:100%}a{color:inherit}${builderCss('page')}</style>`,
    str(settings.headCode), // owner's tracking code (their own page)
    ctx.headExtra ?? '',
  ].filter(Boolean).join('\n');
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${head}
</head><body style="${css({ background: safeColor(settings.background), fontFamily: settings.fontFamily, color: textColorOf(rctx), margin: 0 })}">
<main style="${css({ maxWidth: num(settings.maxWidth, 880, 320, 2400), margin: '0 auto', background: safeColor(settings.contentBackground), padding: `${num(settings.contentPadding, 24, 0, 200)}px 0`, minHeight: '100vh' })}">
${renderBlocks(blocks, rctx)}
</main>${hasCountdown ? COUNTDOWN_SCRIPT : ''}${ctx.bodyEnd ?? ''}</body></html>`;
}

/** Email-safe HTML (tables, inline styles). `footer` is raw HTML appended below the content. */
export function renderEmailDocument(content: PageContent, opts: { subject: string; vars?: Record<string, string>; footer?: string; baseUrl?: string; now?: number }) {
  const settings = { ...DEFAULT_EMAIL_SETTINGS, ...(content?.settings ?? {}) };
  const ctx: RenderContext = { mode: 'email', settings, vars: opts.vars, baseUrl: opts.baseUrl, now: opts.now, depth: 0 };
  const bg = safeColor(settings.background) ?? '#f1f5f9';
  const cbg = safeColor(settings.contentBackground) ?? '#ffffff';
  const width = num(settings.maxWidth, 600, 320, 900);
  const pre = str(settings.preheader).trim();
  const preheader = pre
    ? `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">${esc(applyVars(pre, opts.vars))}${'&#847;&zwnj;&nbsp;'.repeat(40)}</div>`
    : '';
  const padY = num(settings.contentPadding, 16, 0, 120);
  return `<!doctype html><html lang="fr" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="X-UA-Compatible" content="IE=edge"><meta name="x-apple-disable-message-reformatting"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(opts.subject)}</title>
<style>body{margin:0;padding:0;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}table{border-collapse:collapse;mso-table-lspace:0;mso-table-rspace:0}img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic}a{color:inherit}${builderCss('email')}</style>
<!--[if mso]><style>body,table,td,a{font-family:Arial,Helvetica,sans-serif!important}</style><![endif]--></head>
<body style="margin:0;padding:0;background:${esc(bg)}">${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${esc(bg)}" style="background:${esc(bg)}"><tr><td align="center" class="scalo-wrap" style="padding:24px 12px">
<!--[if mso]><table role="presentation" width="${width}" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${esc(cbg)}" style="${css({ maxWidth: width, background: cbg, borderRadius: Math.min(themeOf(ctx)?.radius ?? 8, 16), fontFamily: settings.fontFamily, color: textColorOf(ctx) })}"><tr><td style="padding:${padY}px 0">
${renderBlocks(arr<Block>(content?.blocks), ctx)}
</td></tr></table>
<!--[if mso]></td></tr></table><![endif]-->
${opts.footer ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:${width}px"><tr><td style="padding:16px;font-family:Arial,sans-serif;font-size:12px;line-height:1.5;color:#94a3b8;text-align:center">${opts.footer}</td></tr></table>` : ''}
</td></tr></table></body></html>`;
}

export const DEFAULT_SETTINGS: PageSettings = {
  background: '#f1f5f9',
  contentBackground: '#ffffff',
  maxWidth: 880,
  fontFamily: "Inter, 'Helvetica Neue', Arial, sans-serif",
  textColor: '#0f172a',
  accent: '#2563eb',
};

export const DEFAULT_EMAIL_SETTINGS: PageSettings = {
  ...DEFAULT_SETTINGS,
  maxWidth: 600,
  fontFamily: 'Arial, Helvetica, sans-serif',
};
