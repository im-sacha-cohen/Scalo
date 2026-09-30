// Custom contact fields: per-account definitions (custom_fields) and validated values (contacts.fields jsonb).
//
// Stored values: text / select → string, number → finite number, date → 'YYYY-MM-DD', checkbox → boolean.
// An empty value (null, '', undefined) removes the key. Keys and types are immutable once created (existing values
// never need a conversion); labels and select options can change.
import { sql } from 'kysely';
import { z } from 'zod';
import type { ContactFields, CustomField, CustomFieldType, CustomFieldValue } from '@scalo/shared';
import { db, type Db } from '../db';
import { HttpError } from '../util';

export const MAX_CUSTOM_FIELDS = 50;
const MAX_TEXT = 1000;

/** API payload `{key: value}` (values checked against the definitions by `validateFields`). */
export const fieldsInputSchema = z
  .record(z.string().max(60), z.union([z.string().max(MAX_TEXT), z.number(), z.boolean(), z.null()]))
  .refine((o) => Object.keys(o).length <= MAX_CUSTOM_FIELDS, { message: `${MAX_CUSTOM_FIELDS} champs maximum` });

export type FieldDef = Pick<CustomField, 'key' | 'label' | 'type' | 'options'>;

export function listFieldDefs(userId: number, ex: Db = db): Promise<CustomField[]> {
  return ex
    .selectFrom('custom_fields')
    .select(['id', 'key', 'label', 'type', 'options', 'position', 'created_at'])
    .where('user_id', '=', userId)
    .orderBy('position')
    .orderBy('id')
    .execute();
}

export async function fieldDefMap(userId: number, ex: Db = db): Promise<Map<string, FieldDef>> {
  return new Map((await listFieldDefs(userId, ex)).map((d) => [d.key, d]));
}

const TRUE = new Set(['true', '1', 'oui', 'yes', 'on', 'vrai', 'x']);
const FALSE = new Set(['false', '0', 'non', 'no', 'off', 'faux']);

/** 'YYYY-MM-DD', 'DD/MM/YYYY' (or with '-' / '.') or an ISO datetime → 'YYYY-MM-DD'; null when invalid. */
export function parseDate(v: string): string | null {
  const t = v.trim();
  let y: number, m: number, d: number;
  let r = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(t);
  if (r) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t))) [d, m, y] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/**
 * Normalizes one value for a field definition. Returns `null` for an empty value (= remove the key) and throws a
 * French message when the value is invalid.
 */
export function coerceFieldValue(def: FieldDef, raw: unknown): CustomFieldValue | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const bad = (what: string) => new HttpError(400, `Champ « ${def.label} » : ${what}`);
  switch (def.type) {
    case 'text': {
      if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') throw bad('texte attendu');
      const s = String(raw).trim();
      if (s.length > MAX_TEXT) throw bad(`${MAX_TEXT} caractères maximum`);
      return s;
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim().replace(/\s/g, '').replace(',', '.')) : NaN;
      if (!Number.isFinite(n)) throw bad('nombre attendu');
      return n;
    }
    case 'date': {
      const d = typeof raw === 'string' ? parseDate(raw) : null;
      if (!d) throw bad('date attendue (AAAA-MM-JJ ou JJ/MM/AAAA)');
      return d;
    }
    case 'select': {
      const s = String(raw).trim();
      const opt = def.options.find((o) => o.toLowerCase() === s.toLowerCase());
      if (!opt) throw bad(`valeur « ${s.slice(0, 60)} » absente de la liste (${def.options.join(', ') || 'aucune option'})`);
      return opt;
    }
    case 'checkbox': {
      if (typeof raw === 'boolean') return raw;
      if (raw === 1 || raw === 0) return raw === 1;
      const s = String(raw).trim().toLowerCase();
      if (TRUE.has(s)) return true;
      if (FALSE.has(s)) return false;
      throw bad('oui / non attendu');
    }
  }
}

export interface FieldChanges {
  /** Values to set (normalized). */
  set: ContactFields;
  /** Keys to remove. */
  unset: string[];
  /** Lenient mode: keys ignored because unknown or invalid. */
  ignored: string[];
}

/**
 * Validates a `{key: value}` payload against the account's definitions. Strict (API): unknown key / invalid value →
 * 400. Lenient (forms, CSV import, incoming webhooks): the offending keys are ignored.
 */
export function validateFields(defs: Map<string, FieldDef>, input: Record<string, unknown>, lenient = false): FieldChanges {
  const out: FieldChanges = { set: {}, unset: [], ignored: [] };
  for (const [key, raw] of Object.entries(input)) {
    const def = defs.get(key);
    if (!def) {
      if (lenient) out.ignored.push(key);
      else throw new HttpError(400, `Champ personnalisé inconnu : « ${key.slice(0, 60)} »`);
      continue;
    }
    try {
      const v = coerceFieldValue(def, raw);
      if (v === null) out.unset.push(key);
      else out.set[key] = v;
    } catch (e) {
      if (!lenient) throw e;
      out.ignored.push(key);
    }
  }
  return out;
}

export const hasChanges = (c: FieldChanges | null | undefined) => !!c && (Object.keys(c.set).length > 0 || c.unset.length > 0);

/** SQL expression applying the changes to `contacts.fields` (atomic, other keys kept). */
export function fieldsUpdateExpr(c: FieldChanges) {
  return sql<string>`(contacts.fields - ${c.unset}::text[]) || ${JSON.stringify(c.set)}::jsonb`;
}

/** Applies changes to one contact. Returns false when the contact does not exist. */
export async function applyFieldChanges(userId: number, contactId: number, c: FieldChanges, ex: Db = db): Promise<boolean> {
  if (!hasChanges(c)) return true;
  const r = await ex
    .updateTable('contacts')
    .set({ fields: fieldsUpdateExpr(c) })
    .where('id', '=', contactId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return Number(r.numUpdatedRows) > 0;
}

/**
 * Custom field inputs of a funnel form submission (`field.<key>` in the urlencoded body): only the fields present in
 * the form block are accepted, invalid values are ignored. Empty inputs do not erase an existing value.
 */
export async function formFieldChanges(
  userId: number,
  body: unknown,
  block: { fields?: { name: string }[] } | undefined,
): Promise<FieldChanges | null> {
  if (!body || typeof body !== 'object' || !block?.fields) return null;
  const allowed = new Set(block.fields.map((f) => f.name).filter((n) => n.startsWith('field.')).map((n) => n.slice(6)));
  if (!allowed.size) return null;
  const input: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (!k.startsWith('field.') || !allowed.has(k.slice(6))) continue;
    const val = Array.isArray(v) ? v[v.length - 1] : v;
    if (typeof val === 'string' && val.length <= MAX_TEXT && val.trim()) input[k.slice(6)] = val;
  }
  if (!Object.keys(input).length) return null;
  const c = validateFields(await fieldDefMap(userId), input, true);
  return hasChanges(c) ? c : null;
}

/** Text shown for a value (email merge tags, CSV export). */
export function formatFieldValue(type: CustomFieldType | undefined, v: CustomFieldValue | undefined): string {
  if (v === undefined || v === null) return '';
  if (type === 'checkbox' || typeof v === 'boolean') return v ? 'Oui' : 'Non';
  if (type === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split('-');
    return `${d}/${m}/${y}`;
  }
  return String(v);
}

/** `{{field.key}}` merge tags of a contact (every defined field, '' when empty). */
export function fieldVars(defs: Iterable<FieldDef>, values: ContactFields | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of defs) out[`field.${d.key}`] = formatFieldValue(d.type, values?.[d.key]);
  return out;
}
