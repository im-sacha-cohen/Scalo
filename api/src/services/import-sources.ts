// Contact import, source side: CSV parsing, column presets of the usual export files (systeme.io, Mailchimp, Brevo,
// ActiveCampaign, Kit), suggested mapping, and normalization of one source record into a contact to import.
import { z } from 'zod';
import { IMPORT_PRESET_LABELS, type ImportColumn, type ImportColumnMapping, type ImportTarget } from '@scalo/shared';
import type { FieldDef } from './fields';
import type { SioContact } from './systeme-io';

/** One source line: values by column (tags may already be a list). */
export interface SourceRecord {
  /** Line number in the file (CSV) or position in the account (API), for the error journal. */
  line: number;
  values: Record<string, string | string[]>;
  /** Waiting for a double opt-in confirmation in the source: imported unconfirmed. */
  pending?: boolean;
}

// ---------- CSV ----------

export interface ParsedCsv {
  headers: string[];
  /** Column ids: the header, made unique (`Tags`, `Tags (2)`…). */
  columns: string[];
  rows: { line: number; cells: string[] }[];
}

/** RFC 4180-style parser: `,` `;` or tab (detected on the header line), quotes, embedded new lines, BOM. */
export function parseCsv(text: string): ParsedCsv {
  const src = text.replace(/^﻿/, '').replace(/\u0000/g, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const count = (c: string) => firstLine.split(c).length - 1;
  const sep = count('\t') > Math.max(count(','), count(';')) ? '\t' : count(';') > count(',') ? ';' : ',';
  const rows: { line: number; cells: string[] }[] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  const endRow = () => {
    row.push(field);
    field = '';
    if (row.some((f) => f.trim() !== '')) rows.push({ line: rowLine, cells: row });
    row = [];
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === sep) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      endRow();
      line++;
      rowLine = line;
    } else field += ch;
  }
  endRow();
  const headers = (rows.shift()?.cells ?? []).map((h) => h.trim());
  const seen = new Map<string, number>();
  const columns = headers.map((h, i) => {
    const base = h || `Colonne ${i + 1}`;
    const n = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), n);
    return n === 1 ? base : `${base} (${n})`;
  });
  return { headers, columns, rows };
}

export function csvRecords(csv: ParsedCsv, from = 0, to = csv.rows.length): SourceRecord[] {
  return csv.rows.slice(from, to).map((r) => ({
    line: r.line,
    values: Object.fromEntries(csv.columns.map((c, i) => [c, r.cells[i] ?? ''])),
  }));
}

// ---------- presets ----------

export const normHeader = (h: string) =>
  h
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[’']/g, '_')
    .replace(/[\s./-]+/g, '_')
    .replace(/^_+|_+$/g, '');

type Rule = ImportTarget;

/** Headers understood in any file (French and English spellings). */
const GENERIC: Record<string, Rule> = {
  email: 'email', e_mail: 'email', mail: 'email', courriel: 'email', adresse_email: 'email', adresse_e_mail: 'email', email_address: 'email',
  first_name: 'first_name', firstname: 'first_name', prenom: 'first_name', given_name: 'first_name',
  last_name: 'last_name', lastname: 'last_name', nom: 'last_name', surname: 'last_name', nom_de_famille: 'last_name', family_name: 'last_name',
  phone: 'phone', telephone: 'phone', tel: 'phone', mobile: 'phone', phone_number: 'phone', numero_de_telephone: 'phone', sms: 'phone',
  tags: 'tags', tag: 'tags', etiquettes: 'tags', labels: 'tags',
  status: 'status', statut: 'status', state: 'status', subscription_status: 'status', email_status: 'status',
  unsubscribed: 'unsubscribed', desinscrit: 'unsubscribed', desabonne: 'unsubscribed', unsub_time: 'unsubscribed', unsubscribed_at: 'unsubscribed',
  opt_out: 'unsubscribed', optout: 'unsubscribed', blacklisted: 'unsubscribed', email_blacklisted: 'unsubscribed', blocklisted: 'unsubscribed', email_blocklisted: 'unsubscribed',
  bounced: 'bounced', bounce: 'bounced', clean_time: 'bounced', hard_bounce: 'bounced',
  created_at: 'created_at', date_created: 'created_at', date_d_inscription: 'created_at', date_inscription: 'created_at', inscrit_le: 'created_at',
  registered_at: 'created_at', date_of_registration: 'created_at', date_registered: 'created_at', registration_date: 'created_at', signup_date: 'created_at',
  subscribed_at: 'created_at', date_subscribed: 'created_at', date_added: 'created_at', added_time: 'created_at', optin_time: 'created_at', created: 'created_at',
};

interface Preset {
  id: string;
  /** Is this file an export of the tool? (normalized headers) */
  detect: (h: Set<string>) => boolean;
  /** Tool-specific headers (win over the generic ones). */
  map: Record<string, Rule>;
}

const has = (h: Set<string>, ...keys: string[]) => keys.some((k) => h.has(k));
const TECH: Rule = 'ignore';

export const CSV_PRESETS: Preset[] = [
  {
    // Audience export: "Email Address","First Name","Last Name",…,MEMBER_RATING,OPTIN_TIME,…,LEID,EUID,NOTES,TAGS
    // (+ UNSUB_TIME in the "unsubscribed" file, CLEAN_TIME in the "cleaned" file)
    id: 'mailchimp',
    detect: (h) => h.has('email_address') && has(h, 'member_rating', 'optin_time', 'leid', 'euid', 'confirm_time'),
    map: {
      member_rating: TECH, optin_ip: TECH, confirm_time: TECH, confirm_ip: TECH, latitude: TECH, longitude: TECH, gmtoff: TECH, dstoff: TECH,
      timezone: TECH, cc: TECH, region: TECH, last_changed: TECH, leid: TECH, euid: TECH, notes: TECH, unsub_campaign_title: TECH,
      unsub_campaign_id: TECH, unsub_reason: TECH, unsub_reason_other: TECH, clean_campaign_title: TECH, clean_campaign_id: TECH,
      optin_time: 'created_at', unsub_time: 'unsubscribed', clean_time: 'bounced', tags: 'tags',
    },
  },
  {
    // Contacts export: EMAIL, LASTNAME, FIRSTNAME, SMS, …, EMAIL_BLACKLISTED / BLACKLISTED, ADDED_TIME, MODIFIED_TIME
    id: 'brevo',
    detect: (h) => h.has('email') && has(h, 'lastname', 'firstname') && has(h, 'sms', 'added_time', 'modified_time', 'email_blacklisted', 'blacklisted', 'contact_id', 'double_opt_in'),
    map: {
      lastname: 'last_name', firstname: 'first_name', sms: 'phone', added_time: 'created_at', modified_time: TECH, contact_id: TECH,
      email_blacklisted: 'unsubscribed', blacklisted: 'unsubscribed', sms_blacklisted: TECH, whatsapp: TECH, landline_number: TECH, double_opt_in: TECH, opt_in: TECH, ext_id: TECH,
    },
  },
  {
    // Contacts export: Email, First name, Surname, Phone number, Country, …, Tags, Date registered (FR and EN headers)
    id: 'systeme_io',
    detect: (h) => has(h, 'email', 'e_mail') && (has(h, 'surname', 'nom_de_famille') || has(h, 'date_registered', 'date_of_registration')) && has(h, 'tags', 'phone_number', 'numero_de_telephone', 'street_address', 'postcode', 'tax_number', 'date_registered', 'date_of_registration', 'date_d_inscription'),
    map: {
      surname: 'last_name', nom_de_famille: 'last_name', first_name: 'first_name', prenom: 'first_name', phone_number: 'phone', numero_de_telephone: 'phone',
      tags: 'tags', date_registered: 'created_at', date_of_registration: 'created_at', date_d_inscription: 'created_at', id: TECH, contact_id: TECH, locale: TECH, source_url: TECH, ip: TECH,
    },
  },
  {
    // Subscribers export: first_name, email, created_at, status (+ custom fields, tags)
    id: 'kit',
    detect: (h) => has(h, 'email', 'email_address') && h.has('created_at') && has(h, 'status', 'state') && !has(h, 'last_name', 'lastname'),
    map: { created_at: 'created_at', status: 'status', state: 'status', id: TECH, subscriber_id: TECH },
  },
  {
    // Contacts export: Email, First Name, Last Name, Phone, Tags, Date Created, IP, Status, Organization…
    id: 'activecampaign',
    detect: (h) => has(h, 'email') && has(h, 'date_created', 'date_subscribed') && has(h, 'first_name', 'last_name', 'tags', 'status'),
    map: { date_created: 'created_at', date_subscribed: TECH, status: 'status', tags: 'tags', ip: TECH, id: TECH, contact_id: TECH, date_updated: TECH, score: TECH },
  },
];

export function detectPreset(headers: string[]): string {
  const h = new Set(headers.map(normHeader));
  return CSV_PRESETS.find((p) => p.detect(h))?.id ?? 'generic';
}

/** Targets that can be fed by one column only. */
const SINGLE: ImportTarget[] = ['email', 'first_name', 'last_name', 'phone', 'created_at', 'status'];

const matchField = (defs: FieldDef[], name: string) => {
  const n = normHeader(name).replace(/^field_/, '');
  return defs.find((d) => d.key === n || normHeader(d.label) === n);
};

/** Suggested mapping of a CSV file: preset headers, then generic ones, then existing custom fields; the rest is ignored. */
export function suggestCsvMapping(columns: string[], headers: string[], defs: FieldDef[]): { preset: string; mapping: ImportColumnMapping[] } {
  const preset = detectPreset(headers);
  const rules = CSV_PRESETS.find((p) => p.id === preset)?.map ?? {};
  const used = new Set<string>();
  const mapping = columns.map((column, i): ImportColumnMapping => {
    const n = normHeader(headers[i] ?? '');
    let target: ImportTarget | undefined = rules[n] ?? GENERIC[n];
    if (target && SINGLE.includes(target) && used.has(target)) target = undefined;
    if (target && target !== 'ignore') {
      used.add(target);
      return { column, target };
    }
    if (target === 'ignore') return { column, target };
    const def = matchField(defs, headers[i] ?? '');
    if (def && !used.has(`field:${def.key}`)) {
      used.add(`field:${def.key}`);
      return { column, target: 'field', field_key: def.key };
    }
    return { column, target: 'ignore' };
  });
  return { preset, mapping };
}

export function csvColumns(csv: ParsedCsv, samples = 3): ImportColumn[] {
  return csv.columns.map((column, i) => {
    const values: string[] = [];
    for (const r of csv.rows) {
      const v = (r.cells[i] ?? '').trim();
      if (v && !values.includes(v)) values.push(v.slice(0, 80));
      if (values.length >= samples) break;
    }
    return { column, label: column, samples: values };
  });
}

// ---------- systeme.io API ----------

const SIO_BASE_COLUMNS: { column: string; label: string; target: ImportTarget }[] = [
  { column: 'email', label: 'Email', target: 'email' },
  { column: 'registeredAt', label: 'Date d’inscription', target: 'created_at' },
  { column: 'unsubscribed', label: 'Désinscrit', target: 'unsubscribed' },
  { column: 'bounced', label: 'Adresse invalide (bounce)', target: 'bounced' },
  { column: 'tags', label: 'Tags', target: 'tags' },
];
const SIO_FIELD_TARGETS: Record<string, ImportTarget> = { first_name: 'first_name', surname: 'last_name', last_name: 'last_name', phone_number: 'phone', phone: 'phone' };
const SIO_FIELD_LABELS: Record<string, string> = {
  first_name: 'Prénom', surname: 'Nom', phone_number: 'Téléphone', country: 'Pays', city: 'Ville', street_address: 'Adresse',
  postcode: 'Code postal', state: 'Région', company_name: 'Société', tax_number: 'Numéro de TVA',
};

export function sioRecord(c: SioContact, line: number): SourceRecord {
  const values: Record<string, string | string[]> = {
    email: c.email,
    registeredAt: c.registeredAt ?? '',
    unsubscribed: c.unsubscribed ? 'true' : '',
    bounced: c.bounced ? 'true' : '',
    tags: c.tags,
  };
  for (const [slug, v] of Object.entries(c.fields)) values[`field:${slug}`] = v;
  return { line, values, pending: c.needsConfirmation && !c.unsubscribed };
}

/** Columns and suggested mapping from the field definitions of the account and a first page of contacts. */
export function sioAnalysis(contacts: SioContact[], fieldLabels: Record<string, string>, defs: FieldDef[]): { columns: ImportColumn[]; mapping: ImportColumnMapping[] } {
  const labels: Record<string, string> = { ...fieldLabels };
  for (const c of contacts) {
    for (const slug of Object.keys(c.fields)) labels[slug] ??= c.fieldLabels[slug] ?? slug;
    for (const [slug, l] of Object.entries(c.fieldLabels)) labels[slug] ??= l;
  }
  const records = contacts.map((c, i) => sioRecord(c, i + 1));
  const sample = (column: string) => {
    const out: string[] = [];
    for (const r of records) {
      const raw = r.values[column];
      const v = (Array.isArray(raw) ? raw.join(', ') : raw ?? '').trim();
      if (v && !out.includes(v)) out.push(v.slice(0, 80));
      if (out.length >= 3) break;
    }
    return out;
  };
  const columns: ImportColumn[] = SIO_BASE_COLUMNS.map((c) => ({ column: c.column, label: c.label, samples: sample(c.column) }));
  const mapping: ImportColumnMapping[] = SIO_BASE_COLUMNS.map((c) => ({ column: c.column, target: c.target }));
  const used = new Set<string>();
  for (const [slug, label] of Object.entries(labels)) {
    const column = `field:${slug}`;
    columns.push({ column, label: SIO_FIELD_LABELS[slug] && label === slug ? SIO_FIELD_LABELS[slug] : label || slug, samples: sample(column) });
    const builtin = SIO_FIELD_TARGETS[slug];
    if (builtin && !used.has(builtin)) {
      used.add(builtin);
      mapping.push({ column, target: builtin });
      continue;
    }
    const def = matchField(defs, slug) ?? matchField(defs, label);
    if (def && !used.has(`field:${def.key}`)) {
      used.add(`field:${def.key}`);
      mapping.push({ column, target: 'field', field_key: def.key });
    } else mapping.push({ column, target: 'ignore' });
  }
  return { columns, mapping };
}

export const presetLabel = (id: string) => IMPORT_PRESET_LABELS[id] ?? IMPORT_PRESET_LABELS.generic;

// ---------- normalization of one record ----------

export interface NormalizedContact {
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  tags: string[];
  status: 'subscribed' | 'unsubscribed' | 'bounced' | 'pending';
  /** Original sign-up date (ISO), when the source has a valid one in the past. */
  created_at: string | null;
  /** Raw custom field values by key (validated leniently against the definitions by the importer). */
  fields: Record<string, string>;
}

export type Normalized = { ok: true; contact: NormalizedContact } | { ok: false; reason: 'empty' | 'invalid'; email: string; message: string };

const emailCheck = z.email().max(254);
const NEGATIVE = new Set(['', '0', 'false', 'no', 'non', 'n', 'faux', 'off', 'null', 'none', 'subscribed', 'active', 'actif', 'abonne', 'inscrit', 'confirmed']);
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

/** Flag column ("Désinscrit", UNSUB_TIME, EMAIL_BLACKLISTED…): anything non-empty that is not a "no". */
export const flagValue = (v: string) => !NEGATIVE.has(fold(v));

/** Status column (ActiveCampaign "Status", Kit "status"…) → subscription state. */
export function statusValue(v: string): NormalizedContact['status'] {
  const s = fold(v);
  if (/unsub|desinscri|desabonn|cancel|blacklist|blocklist|complain|spam|opt.?out|^(2|no|non)$/.test(s)) return 'unsubscribed';
  if (/bounc|clean|invalid|undeliver|^3$/.test(s)) return 'bounced';
  if (/unconfirm|pending|en attente|non confirme|^0$/.test(s)) return 'pending';
  return 'subscribed';
}

/** Tag cell: `a, b`, `a;b`, `a|b`, or Mailchimp's `"a","b"`. */
export function splitTags(v: string | string[]): string[] {
  const parts = Array.isArray(v) ? v : v.split(/[,;|]/);
  const out: string[] = [];
  for (const p of parts) {
    const t = p.trim().replace(/^["']+|["']+$/g, '').trim().slice(0, 60);
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

/** ISO, `YYYY-MM-DD[ HH:MM[:SS]]`, `DD/MM/YYYY[ HH:MM]` (or `MM/DD/YYYY` when the day cannot be first), unix seconds. */
export function parseDateTime(v: string, now = Date.now()): string | null {
  const t = v.trim();
  if (!t) return null;
  let ms: number;
  let m: RegExpExecArray | null;
  if (/^\d{10}$/.test(t)) ms = Number(t) * 1000;
  else if ((m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t))) ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[T ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t))) {
    let d = +m[1];
    let mo = +m[2];
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    ms = Date.UTC(+m[3], mo - 1, d, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  } else ms = Date.parse(t);
  if (!Number.isFinite(ms) || ms > now || ms < Date.UTC(1990, 0, 1)) return null;
  return new Date(ms).toISOString();
}

const text = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(', ') : v ?? '').replace(/\u0000/g, '').trim();
const short = (v: string) => (v ? v.slice(0, 200) : null);

export function normalizeRecord(rec: SourceRecord, mapping: ImportColumnMapping[]): Normalized {
  const c: NormalizedContact = { email: '', first_name: null, last_name: null, phone: null, tags: [], status: rec.pending ? 'pending' : 'subscribed', created_at: null, fields: {} };
  let unsubscribed = false;
  let bounced = false;
  for (const m of mapping) {
    if (m.target === 'ignore') continue;
    const raw = rec.values[m.column];
    const v = text(raw);
    switch (m.target) {
      case 'email': c.email = v.toLowerCase(); break;
      case 'first_name': c.first_name = short(v); break;
      case 'last_name': c.last_name = short(v); break;
      case 'phone': c.phone = short(v); break;
      case 'tags':
        for (const t of splitTags(raw ?? '')) if (c.tags.length < 50 && !c.tags.some((o) => o.toLowerCase() === t.toLowerCase())) c.tags.push(t);
        break;
      case 'status':
        if (v) {
          const s = statusValue(v);
          if (s === 'unsubscribed') unsubscribed = true;
          else if (s === 'bounced') bounced = true;
          else if (s === 'pending') c.status = 'pending';
        }
        break;
      case 'unsubscribed': if (flagValue(v)) unsubscribed = true; break;
      case 'bounced': if (flagValue(v)) bounced = true; break;
      case 'created_at': c.created_at = parseDateTime(v); break;
      case 'field': if (m.field_key && v) c.fields[m.field_key] = v.slice(0, 1000); break;
    }
  }
  if (bounced) c.status = 'bounced';
  else if (unsubscribed) c.status = 'unsubscribed';
  if (!c.email) return { ok: false, reason: 'empty', email: '', message: 'Email manquant' };
  if (!emailCheck.safeParse(c.email).success) return { ok: false, reason: 'invalid', email: c.email.slice(0, 254), message: 'Adresse email invalide' };
  return { ok: true, contact: c };
}
