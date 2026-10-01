// Custom field values: parsing / validation shared by the API (strict and lenient validation, CSV import, forms) and
// the web app (import mapping step, contact page). No dependency: time zones go through Intl.
//
// Stored values: text / select → string, number → number, date → 'YYYY-MM-DD', datetime → ISO 8601 UTC
// ('2026-10-01T12:30:00.000Z'), checkbox → boolean.
//
// Date and time without a time zone ('2026-10-01T14:30', '01/10/2026 14:30') are read in an explicit time zone:
// DEFAULT_FIELD_TIMEZONE (Europe/Paris) on the server — CSV import, funnel forms, API without offset —, the browser's
// time zone in the app (the app always sends ISO strings with an offset).
import type { CustomFieldType } from './crm';

/** Time zone of a date and time written without offset (server side). */
export const DEFAULT_FIELD_TIMEZONE = 'Europe/Paris';

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

// ---------- time zones ----------

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function zoneFormat(tz: string) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    dtfCache.set(tz, f);
  }
  return f;
}

/** Is `tz` an IANA time zone known by this runtime? */
export function isTimeZone(tz: string): boolean {
  try {
    zoneFormat(tz);
    return true;
  } catch {
    return false;
  }
}

interface WallClock { y: number; mo: number; d: number; h: number; mi: number; s: number }

/** Wall clock time of an instant in a time zone. */
export function wallClock(ms: number, tz: string): WallClock {
  const parts: Record<string, string> = {};
  for (const p of zoneFormat(tz).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return { y: Number(parts.year), mo: Number(parts.month), d: Number(parts.day), h: Number(parts.hour) % 24, mi: Number(parts.minute), s: Number(parts.second) };
}

/** Offset of the time zone at this instant (ms, positive east of UTC). */
function zoneOffset(ms: number, tz: string) {
  const w = wallClock(ms, tz);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

/**
 * Instant of a wall clock time in a time zone. Around a DST change, an ambiguous time (autumn) is read in standard time
 * (its second occurrence) and a time that does not exist (spring forward) is moved forward by the gap.
 */
export function zonedToUtc(w: WallClock, tz: string, ms = 0): number {
  const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s, ms);
  const off1 = zoneOffset(guess, tz);
  const t1 = guess - off1;
  const off2 = zoneOffset(t1, tz);
  return off2 === off1 ? t1 : guess - off2;
}

// ---------- parsing ----------

const validDay = (y: number, mo: number, d: number) => {
  if (y < 1000 || y > 9999 || mo < 1 || mo > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
};
const validTime = (h: number, mi: number, s: number) => h >= 0 && h <= 23 && mi >= 0 && mi <= 59 && s >= 0 && s <= 59;

/** 'YYYY-MM-DD', 'DD/MM/YYYY' (or with '-' / '.') or an ISO datetime → 'YYYY-MM-DD'; null when invalid. */
export function parseFieldDate(v: string): string | null {
  const t = v.trim();
  let y: number, m: number, d: number;
  let r = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(t);
  if (r) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t))) [d, m, y] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else return null;
  if (!validDay(y, m, d)) return null;
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;
const FR_RE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:\s*(?:à|a|T|,)\s*|\s+)(\d{1,2})\s*[:h]\s*(\d{2})(?::(\d{2}))?$/i;

interface ReadDateTime { w: WallClock; frac: number; offsetMs: number | null }

/** Syntax and calendar check of a date and time; offset in ms when the value has one. */
function readDateTime(v: string): ReadDateTime | null {
  const t = v.trim();
  let w: WallClock;
  let frac = 0;
  let zone: string | undefined;
  let m = ISO_RE.exec(t);
  if (m) {
    w = { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] ?? 0) };
    frac = m[7] ? Math.floor(Number(`0.${m[7]}`) * 1000) : 0;
    zone = m[8];
  } else if ((m = FR_RE.exec(t))) {
    w = { y: +m[3], mo: +m[2], d: +m[1], h: +m[4], mi: +m[5], s: +(m[6] ?? 0) };
  } else return null;
  if (!validDay(w.y, w.mo, w.d) || !validTime(w.h, w.mi, w.s)) return null;
  if (!zone) return { w, frac, offsetMs: null };
  if (zone.toUpperCase() === 'Z') return { w, frac, offsetMs: 0 };
  const z = /^([+-])(\d{2}):?(\d{2})?$/.exec(zone)!;
  const oh = +z[2];
  const om = +(z[3] ?? 0);
  if (oh > 14 || om > 59) return null;
  return { w, frac, offsetMs: (z[1] === '-' ? -1 : 1) * (oh * 60 + om) * 60_000 };
}

/**
 * Date and time → ISO 8601 UTC, or null when invalid. Accepted: ISO 8601 with offset (`2026-10-01T14:30:00+02:00`,
 * `…Z`), ISO without offset (`2026-10-01T14:30`, `2026-10-01 14:30[:ss]`) and `DD/MM/YYYY HH:mm[:ss]` (also
 * `14h30`), the last two read in `tz`. A date without time is refused.
 */
export function parseFieldDateTime(v: string, tz: string = DEFAULT_FIELD_TIMEZONE): string | null {
  const r = readDateTime(v);
  if (!r) return null;
  const { w, frac } = r;
  let ms: number;
  if (r.offsetMs !== null) ms = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s, frac) - r.offsetMs;
  else {
    if (!isTimeZone(tz)) return null;
    ms = zonedToUtc(w, tz, frac);
  }
  if (!Number.isFinite(ms)) return null;
  const out = new Date(ms);
  if (out.getUTCFullYear() < 1000 || out.getUTCFullYear() > 9999) return null;
  return out.toISOString();
}

/** '1 234,5', '12.5', '-3' → number; null when not a finite number. */
export function parseFieldNumber(v: string | number): number | null {
  const n = typeof v === 'number' ? v : Number(v.trim().replace(/[\s  ]/g, '').replace(',', '.'));
  return typeof v === 'string' && !v.trim() ? null : Number.isFinite(n) ? n : null;
}

export const CHECKBOX_TRUE = ['true', '1', 'oui', 'yes', 'on', 'vrai', 'x'];
export const CHECKBOX_FALSE = ['false', '0', 'non', 'no', 'off', 'faux'];

export function parseFieldCheckbox(v: string | number | boolean): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === 0) return v === 1;
  const s = String(v).trim().toLowerCase();
  if (CHECKBOX_TRUE.includes(s)) return true;
  if (CHECKBOX_FALSE.includes(s)) return false;
  return null;
}

/** Would this (non-empty) raw value be accepted for a field of this type? */
export function isValidFieldValue(type: CustomFieldType, raw: string, options: string[] = []): boolean {
  const v = raw.trim();
  if (!v) return true;
  switch (type) {
    case 'text':
      return v.length <= 1000;
    case 'number':
      return parseFieldNumber(v) !== null;
    case 'date':
      return parseFieldDate(v) !== null;
    case 'datetime':
      return readDateTime(v) !== null; // syntax and calendar: no time zone lookup (called on every cell of a file)
    case 'checkbox':
      return parseFieldCheckbox(v) !== null;
    case 'select':
      return options.some((o) => o.toLowerCase() === v.toLowerCase());
  }
}

// ---------- display ----------

/** '2026-10-01' → '01/10/2026'. */
export function formatFieldDate(v: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : v;
}

/** ISO instant → 'DD/MM/YYYY HH:mm' in `tz` (readable, and accepted back by the CSV import). */
export function formatFieldDateTime(iso: string, tz: string = DEFAULT_FIELD_TIMEZONE): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || !isTimeZone(tz)) return iso;
  const w = wallClock(ms, tz);
  return `${pad(w.d)}/${pad(w.mo)}/${pad(w.y, 4)} ${pad(w.h)}:${pad(w.mi)}`;
}

// ---------- type suggestion (import mapping step) ----------

const PLAIN_NUMBER_RE = /^-?(?:0|[1-9]\d{0,2}(?:[   ]?\d{3})*|[1-9]\d*)(?:[.,]\d+)?$/;

/**
 * Field type that fits every value of a column: case à cocher (oui / non…), nombre (no leading zero: phone numbers and
 * postcodes stay text), date et heure, date, liste (few distinct values that repeat), else texte.
 */
export function suggestFieldType(values: string[]): CustomFieldType {
  const vals = values.map((v) => v.trim()).filter(Boolean);
  if (!vals.length) return 'text';
  const distinct = new Map<string, string>();
  for (const v of vals) if (!distinct.has(v.toLowerCase())) distinct.set(v.toLowerCase(), v);
  const keys = [...distinct.keys()];
  if (keys.length <= 2 && keys.every((k) => parseFieldCheckbox(k) !== null) && keys.some((k) => !/^\d$/.test(k) || keys.length === 2)) return 'checkbox';
  if (vals.every((v) => PLAIN_NUMBER_RE.test(v))) return 'number';
  if (vals.every((v) => readDateTime(v) !== null)) return 'datetime';
  if (vals.every((v) => parseFieldDate(v) !== null && !/[T ]\d/.test(v))) return 'date';
  if (keys.length <= 12 && vals.length >= keys.length * 2 && [...distinct.values()].every((v) => v.length <= 60)) return 'select';
  return 'text';
}
