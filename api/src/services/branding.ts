// « Propulsé par Scalo »: the discreet mention at the bottom of public pages and emails.
// It is part of the core and always shown; only the Enterprise edition (white label, see api/src/ee.ts) can remove
// or replace it for an account.
import { esc } from '@scalo/shared';
import { ee, loadEe, type PoweredBy } from '../ee';

export const POWERED_BY_TEXT = 'Propulsé par Scalo';
export const POWERED_BY_URL = 'https://scalo.fr';

const safeHttpUrl = (u: string | undefined) => (u && /^https?:\/\//i.test(u) ? u : '');

function mention(p: PoweredBy | null): { text: string; url: string } | null {
  if (!p) return { text: POWERED_BY_TEXT, url: POWERED_BY_URL };
  if (p.text?.trim()) return { text: p.text.trim(), url: safeHttpUrl(p.url) };
  return p.hidden ? null : { text: POWERED_BY_TEXT, url: POWERED_BY_URL };
}

/** Footer of a public page (appended before </body>). */
export async function poweredByPageHtml(accountId: number): Promise<string> {
  const m = mention((await loadEe())?.poweredBy(accountId) ?? null);
  if (!m) return '';
  const label = m.url
    ? `<a href="${esc(m.url)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none">${esc(m.text)}</a>`
    : esc(m.text);
  return `<div data-scalo-powered style="text-align:center;padding:14px 16px 18px;font:12px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#94a3b8">${label}</div>`;
}

/**
 * Last line of the email footer. Plain text on purpose (no link): nothing for the click tracker to rewrite, and no
 * third-party link added to the owner's emails.
 */
export function poweredByEmailHtml(accountId: number): string {
  const m = mention(ee()?.poweredBy(accountId) ?? null);
  return m ? `<br><br><span style="font-size:11px;color:#cbd5e1">${esc(m.text)}</span>` : '';
}
