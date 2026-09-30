// "Importer une page par URL": fetches the public HTML of a page the user owns and turns its *structure and texts*
// (headings, paragraphs, lists, buttons, images by URL, opt-in form) into editable Scalo blocks.
//
// Deliberately simple: no script is kept, no third-party CSS, no markup is copied — only text, image URLs and link
// targets are read, and the result is a flat list of native blocks using the default Scalo styles. Layout (columns,
// colours, fonts) is NOT reproduced, and pages rendered only by JavaScript yield nothing.
//
// Fetch: same SSRF rules as the outgoing webhooks (https only, every resolved address must be public, connection pinned
// to the validated address), GET only, 3 redirects at most (each one re-validated), 2 MB and 8 s at most, HTML only.
import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import { DEFAULT_SETTINGS, decodeEntities, esc, normalizeRich, sanitizeRich, uid, type Block, type FormBlock, type ListBlock, type PageContent, type PageImportResult } from '@scalo/shared';
import { HttpError } from '../util';
import { isPrivateAddress, type ResolvedAddress } from './webhook-http';

export const PAGE_MAX_BYTES = 2 * 1024 * 1024;
export const PAGE_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;
const MAX_BLOCKS = 300;

export interface PageResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: Buffer;
  /** The body was cut at PAGE_MAX_BYTES. */
  truncated: boolean;
}
export interface PageFetchDeps {
  lookup: (hostname: string) => Promise<ResolvedAddress[]>;
  /** GET `url`, connected to the validated `address` (TLS name = url.hostname). */
  get: (url: URL, address: ResolvedAddress) => Promise<PageResponse>;
}

const defaultDeps: PageFetchDeps = {
  lookup: async (hostname) => (await dns.lookup(hostname, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 })),
  get: (url, address) =>
    new Promise((resolve, reject) => {
      const req = https.request(
        {
          protocol: 'https:',
          hostname: url.hostname.replace(/^\[|\]$/g, ''),
          port: url.port || 443,
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          headers: { 'User-Agent': 'Scalo-PageImport/1.0', Accept: 'text/html,application/xhtml+xml', 'Accept-Encoding': 'identity' },
          servername: net.isIP(url.hostname) ? undefined : url.hostname,
          // pinned to the validated address: a second DNS answer cannot redirect the connection
          lookup: ((_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
            if (opts?.all) cb(null, [{ address: address.address, family: address.family }]);
            else cb(null, address.address, address.family);
          }) as never,
          timeout: PAGE_TIMEOUT_MS,
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          let done = false;
          const end = (truncated: boolean) => {
            if (done) return;
            done = true;
            resolve({ status: res.statusCode ?? 0, headers: { 'content-type': res.headers['content-type'], location: res.headers.location }, body: Buffer.concat(chunks), truncated });
          };
          res.on('data', (chunk: Buffer) => {
            const room = PAGE_MAX_BYTES - size;
            if (chunk.length >= room) {
              chunks.push(chunk.subarray(0, room));
              size = PAGE_MAX_BYTES;
              end(true);
              res.destroy();
            } else {
              chunks.push(chunk);
              size += chunk.length;
            }
          });
          res.on('end', () => end(false));
          res.on('close', () => end(false));
          res.on('error', () => end(false));
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    }),
};

let deps: PageFetchDeps = defaultDeps;
/** Tests: fake DNS / transport. `null` restores the real ones. */
export function setPageFetchDeps(d: Partial<PageFetchDeps> | null) {
  deps = d ? { ...defaultDeps, ...d } : defaultDeps;
}

/** Static checks of a page URL. Returns a French error or null. */
export function pageUrlError(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'URL invalide';
  }
  if (u.protocol !== 'https:') return 'L’adresse de la page doit commencer par https://';
  if (u.username || u.password) return 'L’adresse ne doit pas contenir d’identifiants';
  if (u.port && u.port !== '443') return 'Port non autorisé';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) return 'URL invalide';
  if (net.isIP(host) && isPrivateAddress(host)) return 'Adresse IP privée ou réservée refusée';
  if (/^(localhost|localhost\.localdomain)$/i.test(host) || /\.(localhost|local|internal)$/i.test(host)) return 'Adresse locale refusée';
  return null;
}

/** Fetches the HTML of a public page. Throws an HttpError with a French message. */
export async function fetchPublicPage(rawUrl: string): Promise<{ url: string; html: string; truncated: boolean }> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const err = pageUrlError(current);
    if (err) throw new HttpError(400, err);
    const url = new URL(current);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let addresses: ResolvedAddress[];
    try {
      addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) === 6 ? 6 : 4 }] : await deps.lookup(host);
    } catch {
      throw new HttpError(400, 'Nom de domaine introuvable');
    }
    if (!addresses.length) throw new HttpError(400, 'Nom de domaine introuvable');
    // every answer must be public: otherwise the connection could be steered to an internal address
    const bad = addresses.find((a) => isPrivateAddress(a.address));
    if (bad) throw new HttpError(400, 'Adresse refusée : cette page pointe vers un réseau privé, local ou réservé');
    let res: PageResponse;
    try {
      res = await Promise.race([
        deps.get(url, addresses[0]),
        new Promise<never>((_r, reject) => setTimeout(() => reject(new Error('timeout')), PAGE_TIMEOUT_MS + 500).unref()),
      ]);
    } catch (e) {
      throw new HttpError(502, (e as Error)?.message === 'timeout' ? `La page n’a pas répondu en ${PAGE_TIMEOUT_MS / 1000} s` : 'Impossible de charger la page');
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.location;
      if (!loc) throw new HttpError(502, 'Redirection sans destination');
      try {
        current = new URL(loc, url).toString();
      } catch {
        throw new HttpError(502, 'Redirection invalide');
      }
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new HttpError(502, `La page a répondu avec une erreur (HTTP ${res.status})`);
    const type = (res.headers['content-type'] ?? '').toLowerCase();
    if (type && !/text\/html|application\/xhtml\+xml/.test(type)) throw new HttpError(415, 'Cette adresse ne renvoie pas une page HTML');
    const charset = /charset=["']?([\w-]+)/.exec(type)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(res.body.subarray(0, 2048).toString('latin1'))?.[1] ?? 'utf-8';
    let html: string;
    try {
      html = new TextDecoder(charset).decode(res.body);
    } catch {
      html = res.body.toString('utf8');
    }
    return { url: url.toString(), html, truncated: res.truncated };
  }
  throw new HttpError(502, 'Trop de redirections');
}

// ---------- HTML → blocks ----------

const RAW_ELEMENTS = 'script|style|noscript|template|svg|iframe|object|canvas|video|audio|textarea|select|head|math';
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const BLOCK_LEVEL = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'html', 'label', 'legend', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);
const HEADING_BREAKERS = new Set(['p', 'ul', 'ol', 'form', 'section', 'article', 'table', 'header', 'footer', 'main', 'nav', 'blockquote']);
const INLINE_KEEP: Record<string, string> = { b: 'b', strong: 'strong', i: 'i', em: 'em', u: 'u' };

const attr = (attrs: string, name: string): string | null => {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '').trim() : null;
};
const hasAttr = (attrs: string, name: string) => new RegExp(`(?:^|\\s)${name}(?:\\s|=|$)`, 'i').test(attrs);

function absUrl(raw: string | null, base: string): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw, base);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString().slice(0, 2000) : null;
  } catch {
    return null;
  }
}

type FormField = FormBlock['fields'][number];
function inputField(attrs: string): FormField | 'submit' | null {
  const type = (attr(attrs, 'type') ?? 'text').toLowerCase();
  if (type === 'submit') return 'submit';
  if (['hidden', 'checkbox', 'radio', 'file', 'password', 'button', 'image', 'reset'].includes(type)) return null;
  const hint = `${attr(attrs, 'name') ?? ''} ${attr(attrs, 'id') ?? ''} ${attr(attrs, 'placeholder') ?? ''} ${attr(attrs, 'autocomplete') ?? ''}`.toLowerCase();
  const label = (attr(attrs, 'placeholder') ?? '').slice(0, 80);
  if (type === 'email' || /e-?mail|courriel/.test(hint)) return { name: 'email', label: label || 'Votre email', required: true };
  if (type === 'tel' || /phone|tel|mobile/.test(hint)) return { name: 'phone', label: label || 'Votre téléphone' };
  if (/first|prenom|prénom|given/.test(hint)) return { name: 'first_name', label: label || 'Votre prénom' };
  if (/last|surname|family|\bnom\b/.test(hint)) return { name: 'last_name', label: label || 'Votre nom' };
  if (/name/.test(hint)) return { name: 'first_name', label: label || 'Votre prénom' };
  return null;
}

/**
 * Converts an HTML document into a flat list of Scalo blocks. Pure function (no network): scripts, styles, iframes,
 * event handlers and every attribute other than href / src / alt / placeholder are dropped by construction, since only
 * text and those URLs are ever copied into the blocks.
 */
export function htmlToBlocks(html: string, baseUrl: string): Omit<PageImportResult, 'url'> {
  const warnings: string[] = [];
  const title = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ')).trim().slice(0, 120);
  const baseHref = absUrl(attr(/<base\b([^>]*)>/i.exec(html)?.[1] ?? '', 'href'), baseUrl) ?? baseUrl;
  let src = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ')
    .replace(/<[!?][^>]*>/g, ' ') // doctype, processing instructions
    .replace(new RegExp(`<(${RAW_ELEMENTS})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi'), ' ');
  // unclosed script / style (truncated document): drop everything after it, its content is code, not text
  src = src.replace(/<(script|style)\b[\s\S]*$/i, ' ');

  const blocks: Block[] = [];
  const stats = { headings: 0, texts: 0, lists: 0, images: 0, buttons: 0, forms: 0 };
  let buf = '';
  let heading: 0 | 1 | 2 | 3 = 0;
  let list: ListBlock | null = null;
  let inLi = false;
  let form: { fields: FormField[]; submitLabel: string; explicit: boolean; at: number } | null = null;
  let button: { url: string | null; inForm: boolean; tag: string; text: string } | null = null;
  let skip: { tag: string; depth: number } | null = null;
  const openInline: string[] = [];

  const push = (b: Block) => {
    if (blocks.length < MAX_BLOCKS) blocks.push(b);
  };
  const closeImplicitForm = () => {
    if (form && !form.explicit) endForm();
  };
  function endForm() {
    if (!form) return;
    const f = form;
    form = null;
    const fields = f.fields.filter((x, i, a) => a.findIndex((y) => y.name === x.name) === i);
    if (!fields.some((x) => x.name === 'email')) return;
    fields.sort((a, b) => Number(a.name === 'email') - Number(b.name === 'email'));
    const block: FormBlock = { id: uid(), type: 'form', fields, submitLabel: f.submitLabel || "Je m'inscris" };
    if (blocks.length < MAX_BLOCKS) blocks.splice(Math.min(f.at, blocks.length), 0, block);
    stats.forms++;
  }
  const flush = () => {
    const closing = [...openInline].reverse().map((t) => `</${t}>`).join('');
    const rich = sanitizeRich(`${buf}${closing}`).replace(/^(?:\s|<br>)+|(?:\s|<br>)+$/g, '').replace(/\s+/g, ' ');
    buf = openInline.map((t) => `<${t}>`).join('');
    if (!rich || !rich.replace(/<[^>]+>/g, '').trim()) return;
    const textOnly = normalizeRich(rich.slice(0, 5000));
    if (heading) {
      closeImplicitForm();
      push({ id: uid(), type: 'heading', text: textOnly, level: heading, style: { align: 'center' } });
      stats.headings++;
    } else if (inLi && list) {
      if (list.items.length < 50) list.items.push(textOnly);
    } else {
      // text between the inputs of a form without <form> (labels) is not page content
      if (form && !form.explicit && textOnly.length < 40) return;
      closeImplicitForm();
      push({ id: uid(), type: 'text', text: textOnly });
      stats.texts++;
    }
  };

  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>|([^<]+)|</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m[4] !== undefined || m[0] === '<') {
      if (skip) continue;
      const t = decodeEntities(m[4] ?? '<').replace(/\s+/g, ' ');
      if (button) button.text += t;
      else buf += esc(t);
      continue;
    }
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrs = m[3] ?? '';
    if (skip) {
      if (tag === skip.tag && !VOID.has(tag)) {
        if (closing) {
          if (--skip.depth === 0) skip = null;
        } else if (!/\/\s*$/.test(attrs)) skip.depth++;
      }
      continue;
    }
    if (!closing && !VOID.has(tag) && (hasAttr(attrs, 'hidden') || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(attr(attrs, 'style') ?? '') || attr(attrs, 'aria-hidden') === 'true')) {
      if (!/\/\s*$/.test(attrs)) skip = { tag, depth: 1 };
      continue;
    }

    if (button) {
      // inside a button / call-to-action link: only its text matters
      if (closing && tag === button.tag) {
        const b = button;
        button = null;
        const label = b.text.replace(/\s+/g, ' ').trim().slice(0, 120);
        if (!label) continue;
        if (form && (b.inForm || !form.explicit)) {
          if (!form.submitLabel) form.submitLabel = label;
          if (!form.explicit) endForm();
        } else {
          push({ id: uid(), type: 'button', label: normalizeRich(esc(label)), action: b.url ? 'url' : 'next', ...(b.url ? { url: b.url } : {}), style: { align: 'center' } });
          stats.buttons++;
        }
      }
      continue;
    }

    if (INLINE_KEEP[tag]) {
      const t = INLINE_KEEP[tag];
      if (closing) {
        const i = openInline.lastIndexOf(t);
        if (i >= 0) {
          buf += [...openInline.slice(i)].reverse().map((x) => `</${x}>`).join('');
          openInline.splice(i);
        }
      } else if (openInline.length < 4) {
        openInline.push(t);
        buf += `<${t}>`;
      }
      continue;
    }
    if (tag === 'br') {
      if (buf.replace(/<[^>]+>/g, '').trim()) buf += '<br>';
      continue;
    }
    if (tag === 'a') {
      if (closing) continue;
      const cls = `${attr(attrs, 'class') ?? ''} ${attr(attrs, 'role') ?? ''}`;
      if (/\b(btn|button|cta)\b|btn-|button-|-btn|-button/i.test(cls) && !heading && !inLi) {
        flush();
        button = { url: absUrl(attr(attrs, 'href'), baseHref), inForm: false, tag: 'a', text: '' };
      }
      continue; // plain links: the text is kept, the link is not
    }
    if (tag === 'button') {
      if (closing) continue;
      flush();
      button = { url: null, inForm: !!form?.explicit, tag: 'button', text: '' };
      continue;
    }
    if (tag === 'img') {
      const w = Number(attr(attrs, 'width'));
      const h = Number(attr(attrs, 'height'));
      if ((w && w <= 2) || (h && h <= 2)) continue; // tracking pixel
      const url = absUrl(attr(attrs, 'src') ?? attr(attrs, 'data-src') ?? attr(attrs, 'data-lazy-src'), baseHref);
      if (!url) continue;
      flush();
      closeImplicitForm();
      push({ id: uid(), type: 'image', src: url, alt: (attr(attrs, 'alt') ?? '').slice(0, 200), width: 100, style: { align: 'center' } });
      stats.images++;
      continue;
    }
    if (tag === 'input') {
      const f = inputField(attrs);
      if (!f) continue;
      flush();
      if (!form) form = { fields: [], submitLabel: '', explicit: false, at: blocks.length };
      if (f === 'submit') {
        form.submitLabel ||= (attr(attrs, 'value') ?? '').slice(0, 120);
        if (!form.explicit) endForm();
      } else form.fields.push(f);
      continue;
    }
    if (tag === 'hr') {
      flush();
      push({ id: uid(), type: 'divider' });
      continue;
    }
    if (!BLOCK_LEVEL.has(tag)) continue; // span, font, small… : transparent

    flush();
    // an unclosed heading must not turn the rest of the page into headings
    if (heading && !closing && HEADING_BREAKERS.has(tag)) heading = 0;
    if (/^h[1-6]$/.test(tag)) {
      heading = closing ? 0 : (Math.min(3, Number(tag[1])) as 1 | 2 | 3);
    } else if (tag === 'ul' || tag === 'ol') {
      if (!closing && !list) list = { id: uid(), type: 'list', items: [], icon: tag === 'ol' ? 'number' : 'check' };
      else if (closing && list) {
        if (list.items.length) {
          closeImplicitForm();
          push(list);
          stats.lists++;
        }
        list = null;
        inLi = false;
      }
    } else if (tag === 'li') {
      inLi = !closing && !!list;
    } else if (tag === 'form') {
      if (!closing) {
        closeImplicitForm();
        form = { fields: [], submitLabel: '', explicit: true, at: blocks.length };
      } else if (form?.explicit) endForm();
    }
  }
  flush();
  if (list?.items.length) push(list);
  endForm();

  // navigation menus, cookie banners… often repeat the same short text: drop exact consecutive duplicates
  const out = blocks.filter((b, i) => i === 0 || JSON.stringify({ ...b, id: '' }) !== JSON.stringify({ ...blocks[i - 1], id: '' }));
  if (blocks.length >= MAX_BLOCKS) warnings.push(`Page très longue : seuls les ${MAX_BLOCKS} premiers éléments ont été importés.`);
  if (stats.images) warnings.push('Les images restent chargées depuis leur adresse d’origine : réimportez-les dans votre médiathèque pour ne plus dépendre de l’ancien site.');
  warnings.push('Seuls la structure et les textes sont repris : la mise en page, les couleurs, les vidéos et les scripts ne sont pas importés.');
  const content: PageContent = { settings: { ...DEFAULT_SETTINGS }, blocks: out };
  return { title, content, stats, warnings };
}
