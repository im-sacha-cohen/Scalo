// Custom domains of funnels: normalization, DNS verification, app host detection.
// The Host header is untrusted: it is only ever compared with the app hosts and with verified domains, never used to
// build absolute URLs.
import crypto from 'node:crypto';
import net from 'node:net';
import { domainToASCII } from 'node:url';
import type { CustomDomain, DnsInstruction } from '@scalo/shared';
import type { Selectable } from 'kysely';
import type { CustomDomainsTable } from '../db/schema';
import { env } from '../env';
import type { DnsResolver } from './dns';

export type CustomDomainRow = Selectable<CustomDomainsTable>;

const LABEL = '(?!-)[a-z0-9-]{1,63}(?<!-)';
const DOMAIN_RE = new RegExp(`^(?=.{3,253}$)(?:${LABEL}\\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$`);

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
};

/** Host names of the app itself (app + API): PUBLIC_URL, APP_HOSTS, loopback names. */
export function appHosts(): Set<string> {
  const set = new Set(['localhost', '127.0.0.1', '::1']);
  const pub = hostOf(env.PUBLIC_URL);
  if (pub) set.add(pub);
  for (const h of (env.APP_HOSTS ?? '').split(',')) {
    const t = h.trim().toLowerCase().replace(/\.$/, '');
    if (t) set.add(t);
  }
  return set;
}

/** True for the app's own hosts (and IP literals: health checks, direct access). Anything else is a custom domain or unknown. */
export function isAppHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return appHosts().has(h) || net.isIP(h) !== 0 || h.endsWith('.localhost');
}

/** CNAME target given to users (CUSTOM_DOMAIN_TARGET, default: host of PUBLIC_URL). */
export function cnameTarget(): string {
  return (env.CUSTOM_DOMAIN_TARGET?.trim().toLowerCase().replace(/\.$/, '') || hostOf(env.PUBLIC_URL) || 'localhost');
}

/**
 * Normalizes what a user typed (`https://Offre.Exemple.fr/`, `offre.exemple.fr.`, `café.fr`) to a lower-case ASCII
 * host name (IDN → punycode). Returns an error message (French) when it cannot be used.
 */
export function normalizeCustomDomain(raw: string): { domain: string } | { error: string } {
  let s = String(raw ?? '').trim().toLowerCase();
  if (!s) return { error: 'Saisissez un nom de domaine' };
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
    try {
      s = new URL(s).hostname;
    } catch {
      return { error: 'Nom de domaine invalide' };
    }
  } else s = s.split(/[/?#]/)[0];
  s = s.replace(/\.$/, '');
  if (/:\d+$/.test(s) && !s.includes(']')) s = s.replace(/:\d+$/, '');
  if (net.isIP(s.replace(/^\[|\]$/g, ''))) return { error: 'Une adresse IP ne peut pas être utilisée : saisissez un nom de domaine' };
  const ascii = domainToASCII(s);
  if (!ascii || !DOMAIN_RE.test(ascii)) return { error: 'Nom de domaine invalide (ex. offre.mondomaine.fr)' };
  const app = [...appHosts(), cnameTarget()];
  if (app.some((h) => ascii === h || ascii.endsWith(`.${h}`)) || ascii.endsWith('.localhost')) {
    return { error: 'Ce domaine est celui de l’application : utilisez votre propre domaine' };
  }
  return { domain: ascii };
}

export const newVerifyToken = () => crypto.randomBytes(16).toString('hex');
export const txtHost = (domain: string) => `_scalo.${domain}`;
export const txtValue = (token: string) => `scalo-verify=${token}`;

export function dnsInstructions(d: Pick<CustomDomainRow, 'domain' | 'verify_token'>): DnsInstruction[] {
  return [
    { type: 'CNAME', host: d.domain, value: cnameTarget(), purpose: 'Dirige le domaine vers vos pages (sous-domaine, ex. offre.mondomaine.fr)' },
    { type: 'TXT', host: txtHost(d.domain), value: txtValue(d.verify_token), purpose: 'Prouve que le domaine vous appartient (nécessaire pour un domaine racine ou derrière un proxy)' },
  ];
}

export function toCustomDomain(r: CustomDomainRow): CustomDomain {
  return {
    id: r.id,
    funnel_id: r.funnel_id,
    domain: r.domain,
    root_step_id: r.root_step_id,
    status: r.status,
    verified_at: r.verified_at,
    last_checked_at: r.last_checked_at,
    last_error: r.last_error,
    created_at: r.created_at,
    url: `https://${r.domain}/`,
    records: dnsInstructions(r),
  };
}

const LOOKUP_TIMEOUT_MS = 4000;

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; missing: boolean; code: string }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), LOOKUP_TIMEOUT_MS);
      }),
    ]);
    return { ok: true, value };
  } catch (e) {
    const code = (e as { code?: string }).code ?? 'ERROR';
    return { ok: false, missing: ['ENOTFOUND', 'ENODATA', 'NXDOMAIN'].includes(code), code };
  } finally {
    clearTimeout(timer);
  }
}

const clean = (h: string) => h.trim().toLowerCase().replace(/\.$/, '');

export interface VerifyResult {
  ok: boolean;
  method?: 'cname' | 'txt';
  /** DNS server error (timeout, SERVFAIL): the previous status is kept. */
  transient: boolean;
  error?: string;
}

/** Verified when the domain is a CNAME of the app host, or when `_scalo.<domain>` has the TXT token. */
export async function verifyCustomDomain(resolver: DnsResolver, d: Pick<CustomDomainRow, 'domain' | 'verify_token'>): Promise<VerifyResult> {
  const target = cnameTarget();
  const [cname, txt] = await Promise.all([
    resolver.resolveCname ? timed(() => resolver.resolveCname!(d.domain)) : Promise.resolve({ ok: false as const, missing: true, code: 'ENODATA' }),
    timed(() => resolver.resolveTxt(txtHost(d.domain))),
  ]);
  if (txt.ok && txt.value.map((c) => c.join('')).some((t) => t.trim() === txtValue(d.verify_token))) return { ok: true, method: 'txt', transient: false };
  if (cname.ok && cname.value.map(clean).includes(target)) return { ok: true, method: 'cname', transient: false };
  const transient = (!cname.ok && !cname.missing) || (!txt.ok && !txt.missing);
  const found = cname.ok && cname.value.length ? cname.value.map(clean) : [];
  let error: string;
  if (found.length) error = `Le CNAME de ${d.domain} pointe vers « ${found.join(', ')} » au lieu de « ${target} ».`;
  else if (txt.ok && txt.value.length) error = `L’enregistrement TXT ${txtHost(d.domain)} ne contient pas la valeur attendue.`;
  else if (transient) error = 'Le serveur DNS n’a pas répondu correctement. Réessayez dans un instant.';
  else error = `Aucun enregistrement trouvé : créez le CNAME vers « ${target} » ou le TXT « ${txtHost(d.domain)} ». La propagation DNS peut prendre jusqu’à 24 h.`;
  return { ok: false, transient, error };
}
