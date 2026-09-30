const nf = new Intl.NumberFormat('fr-FR');
export const fmtNumber = (n: number | undefined | null) => nf.format(n ?? 0);

export const fmtPercent = (ratio: number | undefined | null, digits = 1) =>
  `${((ratio ?? 0) * 100).toLocaleString('fr-FR', { maximumFractionDigits: digits, minimumFractionDigits: 0 })} %`;

/** Safe ratio a/b (0 when b is 0). */
export const ratio = (a: number | undefined, b: number | undefined) => (b ? (a ?? 0) / b : 0);

export const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

export const fmtDateTime = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '—';

export function fmtRelative(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60) return 'à l’instant';
  if (abs < 3600) return rtf.format(-Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(-Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(-Math.round(diff / 86400), 'day');
  return fmtDate(iso);
}

export const contactName = (c: { first_name: string | null; last_name: string | null; email: string }) =>
  [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || c.email;

export const initials = (s: string) =>
  s
    .replace(/@.*/, '')
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('') || '?';

export function slugify(s: string) {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export const STEP_TYPE_LABELS: Record<string, string> = {
  optin: 'Capture',
  sales: 'Vente',
  thankyou: 'Remerciement',
  custom: 'Personnalisée',
};

/** Human duration in French, rounded: "45 s", "3 min", "1 h 20", "2 j 3 h". */
export function fmtDuration(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h} h ${String(rm).padStart(2, '0')}` : `${h} h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d} j ${rh} h` : `${d} j`;
}

export const fmtTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '—';

/** "14:32" today, otherwise "3 oct. 14:32". */
export function fmtTimeOrDate(iso: string | null | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return fmtTime(iso);
  return d.toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Sending rate for humans: 60/min → "1 email/s", 30/min → "30 emails/min". */
export function fmtRate(perMinute: number) {
  if (perMinute >= 60) {
    const perSec = perMinute / 60;
    const txt = perSec.toLocaleString('fr-FR', { maximumFractionDigits: 1 });
    return `${txt} email${perSec >= 2 ? 's' : ''}/s`;
  }
  return `${fmtNumber(perMinute)} email${perMinute >= 2 ? 's' : ''}/min`;
}

/** "jeu. 3 oct. 09:00" (with the year when it is not the current one). */
export function fmtWeekdayDateTime(iso: string | null | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const day = d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
  return `${day} ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
}

/** Browser time zone, e.g. "Europe/Paris" (+ UTC offset). */
export function localTimeZone() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'heure locale';
  const off = -new Date().getTimezoneOffset();
  const sign = off >= 0 ? '+' : '−';
  const h = Math.floor(Math.abs(off) / 60);
  const m = Math.abs(off) % 60;
  return `${tz} (UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''})`;
}

/** Countdown for the future: "dans 2 j 3 h", "dans 12 min". */
export function fmtCountdown(iso: string, now = Date.now()) {
  const s = (new Date(iso).getTime() - now) / 1000;
  if (s <= 0) return 'imminent';
  if (s < 60) return `dans ${Math.ceil(s)} s`;
  return `dans ${fmtDuration(s)}`;
}
