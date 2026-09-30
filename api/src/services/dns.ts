// Sender domain authentication check (SPF, DKIM, DMARC, MX) with real DNS lookups.
// Only DNS queries are made (no HTTP, no SMTP): the domain is validated first, every lookup has a timeout.
// The resolver is injectable (tests use a fake one).
import { Resolver } from 'node:dns/promises';
import type { DnsCheckResult, DnsRecordCheck } from '@scalo/shared';

export interface DnsResolver {
  resolveTxt(host: string): Promise<string[][]>;
  resolveMx(host: string): Promise<{ exchange: string; priority: number }[]>;
  /** Custom domains verification (optional so older fakes keep compiling). */
  resolveCname?(host: string): Promise<string[]>;
}

const LOOKUP_TIMEOUT_MS = 4000;

export function systemResolver(): DnsResolver {
  const r = new Resolver({ timeout: 2000, tries: 2 });
  return { resolveTxt: (h) => r.resolveTxt(h), resolveMx: (h) => r.resolveMx(h), resolveCname: (h) => r.resolveCname(h) };
}

export const DEFAULT_DKIM_SELECTORS = ['default', 'google', 'k1', 'k2', 's1', 's2', 'selector1', 'selector2', 'mail', 'dkim', 'mailjet', 'pm', 'mg', 'smtp'];

const DOMAIN_RE = /^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SELECTOR_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62})$/i;

/** Lower-cased registrable-looking domain, or null (IP literals, single labels, junk are refused). */
export function normalizeDomain(raw: string): string | null {
  const d = raw.trim().toLowerCase().replace(/\.$/, '');
  return DOMAIN_RE.test(d) ? d : null;
}

export function parseSelectors(raw: string | string[] | undefined | null): string[] {
  const list = Array.isArray(raw) ? raw : (raw ?? '').split(/[\s,;]+/);
  return [...new Set(list.map((s) => s.trim().toLowerCase()).filter((s) => SELECTOR_RE.test(s)))].slice(0, 20);
}

type Lookup<T> = { ok: true; value: T } | { ok: false; missing: boolean; error: string };

async function lookup<T>(fn: () => Promise<T>): Promise<Lookup<T>> {
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
    const code = (e as { code?: string }).code ?? '';
    return { ok: false, missing: code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN', error: code || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

const txt = (records: string[][]) => records.map((chunks) => chunks.join(''));
const lookupFailed = (error: string) =>
  error === 'ETIMEOUT' ? 'Le serveur DNS n’a pas répondu à temps. Réessayez dans un instant.' : `Erreur DNS (${error}). Réessayez dans un instant.`;

type Provider = NonNullable<DnsCheckResult['provider']>;

/** SPF include and DKIM hints by provider. */
export const PROVIDER_SPF: Record<Exclude<Provider, 'other'>, string> = {
  brevo: 'include:spf.brevo.com',
  mailgun: 'include:mailgun.org',
  ses: 'include:amazonses.com',
  google: 'include:_spf.google.com',
  ovh: 'include:mx.ovh.com',
  postmark: 'include:spf.mtasv.net',
};

export function guessProvider(smtpHost: string, spf: string | null, mx: string[]): Provider | null {
  const h = `${smtpHost} ${spf ?? ''} ${mx.join(' ')}`.toLowerCase();
  if (/brevo|sendinblue/.test(h)) return 'brevo';
  if (/mailgun/.test(h)) return 'mailgun';
  if (/amazonses|amazonaws/.test(h)) return 'ses';
  if (/postmark|mtasv/.test(h)) return 'postmark';
  if (/google|gmail/.test(h)) return 'google';
  if (/ovh/.test(h)) return 'ovh';
  return smtpHost.trim() ? 'other' : null; // SMTP host of another provider, or unknown
}

function checkSpf(domain: string, r: Lookup<string[][]>, provider: Provider | null): DnsRecordCheck {
  const host = domain;
  const include = provider && provider !== 'other' ? PROVIDER_SPF[provider] : null;
  const recommended = { type: 'TXT' as const, host: '@', value: `v=spf1 ${include ?? 'include:<votre-fournisseur>'} ~all` };
  if (!r.ok && !r.missing) return { kind: 'spf', status: 'warning', host, found: [], message: lookupFailed(r.error), recommended };
  const records = r.ok ? txt(r.value).filter((t) => /^v=spf1(\s|$)/i.test(t.trim())) : [];
  if (!records.length) {
    return {
      kind: 'spf',
      status: 'missing',
      host,
      found: [],
      message: 'Aucun enregistrement SPF : les serveurs de réception ne savent pas quels serveurs ont le droit d’envoyer pour votre domaine.',
      recommended,
    };
  }
  if (records.length > 1) {
    return {
      kind: 'spf',
      status: 'warning',
      host,
      found: records,
      message: 'Plusieurs enregistrements SPF : c’est invalide (erreur « permerror »). Fusionnez-les en un seul enregistrement TXT.',
      recommended: { type: 'TXT', host: '@', value: mergeSpf(records) },
    };
  }
  const spf = records[0];
  if (/(^|\s)\+?all(\s|$)/i.test(spf) && !/[-~?]all/i.test(spf)) {
    return {
      kind: 'spf',
      status: 'warning',
      host,
      found: records,
      message: '« +all » autorise n’importe quel serveur à envoyer pour votre domaine : remplacez-le par « ~all » (ou « -all »).',
      recommended: { type: 'TXT', host: '@', value: spf.replace(/\+?all\b/i, '~all') },
    };
  }
  if (/\?all/i.test(spf)) {
    return { kind: 'spf', status: 'warning', host, found: records, message: '« ?all » (neutre) ne protège pas votre domaine : préférez « ~all ».', recommended: { type: 'TXT', host: '@', value: spf.replace(/\?all/i, '~all') } };
  }
  if (!/[-~]all/i.test(spf) && !/redirect=/i.test(spf)) {
    return { kind: 'spf', status: 'warning', host, found: records, message: 'Votre SPF ne se termine pas par « ~all » ou « -all ».', recommended: { type: 'TXT', host: '@', value: `${spf} ~all` } };
  }
  if (include && !spf.toLowerCase().includes(include.split(':')[1])) {
    return {
      kind: 'spf',
      status: 'warning',
      host,
      found: records,
      message: `Votre SPF n’autorise pas encore votre fournisseur d’envoi : ajoutez « ${include} ».`,
      recommended: { type: 'TXT', host: '@', value: spf.replace(/^v=spf1/i, `v=spf1 ${include}`) },
    };
  }
  return { kind: 'spf', status: 'ok', host, found: records, message: 'SPF configuré.', recommended: null };
}

function mergeSpf(records: string[]) {
  const parts = new Set<string>();
  let all = '~all';
  for (const r of records) {
    for (const p of r.split(/\s+/).slice(1)) {
      if (/^[-~?+]?all$/i.test(p)) {
        if (p.startsWith('-')) all = '-all';
      } else if (p) parts.add(p);
    }
  }
  return `v=spf1 ${[...parts].join(' ')} ${all}`.replace(/\s+/g, ' ');
}

function checkDmarc(domain: string, r: Lookup<string[][]>): DnsRecordCheck {
  const host = `_dmarc.${domain}`;
  const recommended = { type: 'TXT' as const, host: '_dmarc', value: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${domain}; adkim=r; aspf=r` };
  if (!r.ok && !r.missing) return { kind: 'dmarc', status: 'warning', host, found: [], message: lookupFailed(r.error), recommended };
  const records = r.ok ? txt(r.value).filter((t) => /^v=DMARC1/i.test(t.trim())) : [];
  if (!records.length) {
    return {
      kind: 'dmarc',
      status: 'missing',
      host,
      found: [],
      message: 'Aucune politique DMARC : Gmail et Yahoo l’exigent pour les expéditeurs de volume. Commencez par « p=none » pour observer, puis passez à « p=quarantine ».',
      recommended: { ...recommended, value: `v=DMARC1; p=none; rua=mailto:dmarc@${domain}` },
    };
  }
  if (records.length > 1) return { kind: 'dmarc', status: 'warning', host, found: records, message: 'Plusieurs enregistrements DMARC : gardez-en un seul.', recommended };
  const p = /;\s*p\s*=\s*(\w+)/i.exec(`;${records[0].replace(/^v=DMARC1/i, '')}`)?.[1]?.toLowerCase();
  if (!p) return { kind: 'dmarc', status: 'warning', host, found: records, message: 'Enregistrement DMARC sans politique « p= » : il est ignoré.', recommended };
  if (p === 'none') {
    return {
      kind: 'dmarc',
      status: 'warning',
      host,
      found: records,
      message: 'DMARC en mode observation (« p=none ») : suffisant pour Gmail/Yahoo, mais votre domaine n’est pas protégé contre l’usurpation. Passez à « p=quarantine » une fois SPF et DKIM validés.',
      recommended,
    };
  }
  return { kind: 'dmarc', status: 'ok', host, found: records, message: `Politique DMARC active (p=${p}).`, recommended: null };
}

function checkMx(domain: string, r: Lookup<{ exchange: string; priority: number }[]>): DnsRecordCheck {
  if (!r.ok && !r.missing) return { kind: 'mx', status: 'warning', host: domain, found: [], message: lookupFailed(r.error) };
  const mx = r.ok ? [...r.value].sort((a, b) => a.priority - b.priority).map((m) => `${m.priority} ${m.exchange}`) : [];
  if (!mx.length) {
    return {
      kind: 'mx',
      status: 'warning',
      host: domain,
      found: [],
      message: 'Aucun serveur MX : votre domaine ne peut pas recevoir d’emails (réponses, rebonds). Certains filtres anti-spam pénalisent les domaines sans MX.',
    };
  }
  return { kind: 'mx', status: 'ok', host: domain, found: mx, message: 'Le domaine reçoit des emails.' };
}

export async function checkDomain(
  resolver: DnsResolver,
  domain: string,
  opts: { selectors?: string[]; smtpHost?: string } = {},
): Promise<DnsCheckResult> {
  const selectors = opts.selectors?.length ? opts.selectors : DEFAULT_DKIM_SELECTORS;
  const [spfR, dmarcR, mxR, ...dkimR] = await Promise.all([
    lookup(() => resolver.resolveTxt(domain)),
    lookup(() => resolver.resolveTxt(`_dmarc.${domain}`)),
    lookup(() => resolver.resolveMx(domain)),
    ...selectors.map((s) => lookup(() => resolver.resolveTxt(`${s}._domainkey.${domain}`))),
  ]);
  const spfTxt = spfR.ok ? txt(spfR.value as string[][]).find((t) => /^v=spf1/i.test(t)) ?? null : null;
  const mxList = mxR.ok ? (mxR.value as { exchange: string }[]).map((m) => m.exchange) : [];
  // The SMTP host tells which provider sends (its SPF include is then required); SPF/MX only pick the guide to show.
  const sending = opts.smtpHost?.trim() ? guessProvider(opts.smtpHost, null, []) : null;
  const provider = sending ?? guessProvider('', spfTxt, mxList);

  const found: { selector: string; value: string }[] = [];
  let dkimError: string | null = null;
  dkimR.forEach((r, i) => {
    if (r.ok) {
      const v = txt(r.value as string[][]).find((t) => /(^|;)\s*(v=DKIM1|k=|p=)/i.test(t));
      if (v) found.push({ selector: selectors[i], value: v });
    } else if (!r.missing) dkimError = r.error;
  });
  let dkim: DnsRecordCheck;
  const dkimHost = `<sélecteur>._domainkey.${domain}`;
  if (found.length) {
    const revoked = found.every((f) => /(^|;)\s*p=\s*(;|$)/i.test(f.value));
    dkim = revoked
      ? { kind: 'dkim', status: 'warning', host: `${found[0].selector}._domainkey.${domain}`, found: found.map((f) => `${f.selector} : ${f.value}`), message: 'La clé DKIM trouvée est vide (révoquée) : publiez la clé fournie par votre fournisseur.', selector: found[0].selector }
      : {
          kind: 'dkim',
          status: 'ok',
          host: `${found[0].selector}._domainkey.${domain}`,
          found: found.map((f) => `${f.selector} : ${f.value.length > 90 ? `${f.value.slice(0, 90)}…` : f.value}`),
          message: `Signature DKIM publiée (sélecteur${found.length > 1 ? 's' : ''} ${found.map((f) => `« ${f.selector} »`).join(', ')}).`,
          selector: found[0].selector,
        };
  } else {
    dkim = {
      kind: 'dkim',
      status: dkimError ? 'warning' : 'missing',
      host: dkimHost,
      found: [],
      message: dkimError
        ? lookupFailed(dkimError)
        : `Aucune clé DKIM trouvée pour les sélecteurs testés (${selectors.join(', ')}). Activez DKIM chez votre fournisseur d’envoi et publiez l’enregistrement qu’il vous donne ; si votre fournisseur utilise un autre sélecteur, ajoutez-le ci-dessous.`,
      recommended: { type: provider === 'ses' || provider === 'brevo' ? 'CNAME' : 'TXT', host: `<sélecteur>._domainkey`, value: 'Valeur fournie par votre fournisseur d’envoi (clé publique « v=DKIM1; k=rsa; p=… »)' },
    };
  }

  const records = [checkSpf(domain, spfR as Lookup<string[][]>, sending), dkim, checkDmarc(domain, dmarcR as Lookup<string[][]>), checkMx(domain, mxR as Lookup<{ exchange: string; priority: number }[]>)];
  return {
    domain,
    checked_at: new Date().toISOString(),
    provider,
    selectors,
    records,
    ok: records[0].status === 'ok' && records[1].status === 'ok',
  };
}
