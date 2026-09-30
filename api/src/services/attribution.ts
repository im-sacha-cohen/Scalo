// First-touch attribution of funnel visitors: UTM parameters + external referrer host, kept in a cookie scoped to
// the funnel (`scalo_src`), stored on every page view and copied to the optin event and to the contact.
import type { Request, Response } from 'express';

export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;
export type UtmKey = (typeof UTM_KEYS)[number];
export type Attribution = Partial<Record<UtmKey | 'referrer', string>>;

const COOKIE = 'scalo_src';
const MAX_AGE = 30 * 86400_000;

/** Keeps printable text only, 100 chars max (values end up in stats tables, never in HTML without escaping). */
function cleanValue(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100);
  return s || undefined;
}

function cleanHost(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const h = v.trim().toLowerCase().replace(/^www\./, '');
  return /^[a-z0-9.-]{1,253}$/.test(h) && h.includes('.') ? h : h === 'localhost' ? h : undefined;
}

export function parseAttribution(raw: unknown): Attribution | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const out: Attribution = {};
  for (const k of UTM_KEYS) {
    const v = cleanValue(o[k]);
    if (v) out[k] = v;
  }
  const r = cleanHost(o.referrer);
  if (r) out.referrer = r;
  return out;
}

function readCookie(req: Request): Attribution | null {
  const raw = req.cookies?.[COOKIE];
  if (typeof raw !== 'string' || raw.length > 1500) return null;
  try {
    return parseAttribution(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch {
    return null;
  }
}

/** Attribution of the current request: from the URL (utm_*) and the Referer header (external hosts only). */
function fromRequest(req: Request): Attribution {
  const out: Attribution = {};
  for (const k of UTM_KEYS) {
    const v = cleanValue(req.query[k]);
    if (v) out[k] = v;
  }
  const ref = req.get('referer');
  if (ref) {
    try {
      const host = new URL(ref).hostname.toLowerCase();
      const self = (req.hostname ?? '').toLowerCase();
      if (host && host !== self) {
        const h = cleanHost(host);
        if (h) out.referrer = h;
      }
    } catch {
      /* invalid referer */
    }
  }
  return out;
}

/**
 * First-touch attribution of the visitor for this funnel: the cookie when present, otherwise the current request
 * (then remembered, even when empty = direct visit, so a later visit never overwrites the first touch).
 */
export function visitAttribution(req: Request, res: Response, cookiePath: string): Attribution {
  const known = readCookie(req);
  if (known) return known;
  const a = fromRequest(req);
  res.cookie(COOKIE, Buffer.from(JSON.stringify(a)).toString('base64url'), { httpOnly: true, sameSite: 'lax', maxAge: MAX_AGE, path: cookiePath });
  return a;
}

/** Attribution remembered for the visitor (form submissions); empty when the cookie is missing. */
export function submitAttribution(req: Request): Attribution {
  return readCookie(req) ?? {};
}

export const isEmptyAttribution = (a: Attribution) => Object.keys(a).length === 0;
