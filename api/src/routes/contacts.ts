import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import type { ContactEvent } from '@scalo/shared';
import { db, isUniqueViolation, type ContactRow } from '../db';
import { resendConfirmation } from '../services/optin';
import {
  addTag,
  getContact,
  getContactRow,
  getOrCreateTag,
  logEvent,
  normEmail,
  removeTag,
  tagsForContacts,
  toContact,
  upsertContact,
} from '../services/contacts';
import { HttpError, notFound, paramId, uid } from '../util';
import type { SegmentFilter } from '@scalo/shared';
import { applyListFilters, listPredicate } from '../services/segments';
import { applyFieldChanges, fieldDefMap, fieldsInputSchema, formatFieldValue, hasChanges, validateFields } from '../services/fields';

export const contactsRouter = Router();

const optStr = z.string().trim().max(200).nullable().optional();
export const createSchema = z.object({
  email: z.email().max(254),
  first_name: optStr,
  last_name: optStr,
  phone: optStr,
  tags: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
  /** custom fields `{key: value}` (validated against the definitions; null / '' = empty) */
  fields: fieldsInputSchema.optional(),
});
export const patchSchema = z.object({
  email: z.email().max(254).optional(),
  first_name: optStr,
  last_name: optStr,
  phone: optStr,
  unsubscribed: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional(),
  fields: fieldsInputSchema.optional(),
});
export const listSchema = z.object({
  search: z.string().trim().max(200).optional().default(''),
  tag_id: z.coerce.number().int().positive().optional().or(z.literal('').transform(() => undefined)),
  /** pending_confirmation | confirmed | unsubscribed | bounced */
  status: z.enum(['pending_confirmation', 'confirmed', 'unsubscribed', 'bounced']).optional().catch(undefined),
  /** saved segment (services/segments.ts) */
  segment_id: z.coerce.number().int().positive().optional().or(z.literal('').transform(() => undefined)),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(500).optional().default(50),
});

export const CONTACT_TAKEN = 'Un contact existe déjà avec cet email';

const ownedContact = async (userId: number, rawId: unknown) => {
  const row = await getContactRow(userId, paramId(rawId, 'Contact'));
  if (!row) throw notFound('Contact');
  return row;
};
const nullIfEmpty = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() ? v.trim() : null);

/** Paginated, filtered list (shared with the public API /api/v1/contacts). */
export async function listContacts(userId: number, q: z.infer<typeof listSchema>, filter: SegmentFilter | null = null) {
  // search, tag, status, segment and ad hoc filter (same query as the bulk actions "all matching contacts")
  const lf = { ...q, filter };
  const base = applyListFilters(db.selectFrom('contacts as c').where('c.user_id', '=', userId), lf, await listPredicate(userId, lf));
  const [{ n: total }, rows] = await Promise.all([
    base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
    base
      .selectAll('c')
      .orderBy('c.created_at', 'desc')
      .orderBy('c.id', 'desc')
      .limit(q.limit)
      .offset((q.page - 1) * q.limit)
      .execute(),
  ]);
  const tags = await tagsForContacts(rows.map((r) => r.id));
  return { items: rows.map((r) => toContact(r, tags.get(r.id) ?? [])), total };
}

contactsRouter.get('/contacts', async (req, res) => {
  res.json(await listContacts(uid(req), listSchema.parse(req.query)));
});

contactsRouter.post('/contacts', async (req, res) => {
  const userId = uid(req);
  const body = createSchema.parse(req.body);
  const email = normEmail(body.email);
  if (await db.selectFrom('contacts').select('id').where('user_id', '=', userId).where('email', '=', email).executeTakeFirst()) {
    throw new HttpError(409, CONTACT_TAKEN);
  }
  const fields = body.fields ? validateFields(await fieldDefMap(userId), body.fields) : null;
  const contact = await db.transaction().execute(async (trx) => {
    const { contact, created } = await upsertContact(userId, { ...body, email, fields }, {}, trx);
    if (!created) throw new HttpError(409, CONTACT_TAKEN); // created concurrently
    for (const name of body.tags ?? []) await addTag(userId, contact.id, await getOrCreateTag(userId, name, trx), undefined, trx);
    return (await getContact(userId, contact.id, trx))!;
  });
  res.status(201).json(contact);
});

// --- CSV import / export (declared before /contacts/:id) ---

function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === sep) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

const HEADER_MAP: Record<string, 'email' | 'first_name' | 'last_name' | 'phone'> = {
  email: 'email', 'e-mail': 'email', mail: 'email', courriel: 'email', adresse_email: 'email',
  first_name: 'first_name', firstname: 'first_name', prenom: 'first_name',
  last_name: 'last_name', lastname: 'last_name', nom: 'last_name',
  phone: 'phone', telephone: 'phone', tel: 'phone', mobile: 'phone',
};
const normHeader = (h: string) =>
  h.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/^e_mail$/, 'email');

const importSchema = z.object({ csv: z.string().min(1).max(5_000_000), tag: z.string().trim().max(60).optional() });
const emailCheck = z.email();

contactsRouter.post('/contacts/import', async (req, res) => {
  const userId = uid(req);
  const body = importSchema.parse(req.body);
  const rows = parseCsv(body.csv);
  if (!rows.length) throw new HttpError(400, 'Le fichier CSV est vide');
  const header = rows[0].map((h) => HEADER_MAP[normHeader(h)]);
  const emailIdx = header.indexOf('email');
  if (emailIdx < 0) throw new HttpError(400, 'Colonne « email » introuvable dans l’en-tête du CSV');
  const idx = (k: string) => header.indexOf(k as never);
  // other columns → custom fields, matched by key (or `field.key`) or by label
  const defs = await fieldDefMap(userId);
  const customCols = new Map<number, string>();
  rows[0].forEach((h, i) => {
    if (header[i]) return;
    const n = normHeader(h).replace(/^field\./, '');
    const def = [...defs.values()].find((d) => d.key === n || normHeader(d.label) === n);
    if (def && ![...customCols.values()].includes(def.key)) customCols.set(i, def.key);
  });
  const result: { created: number; updated: number; skipped: number; fields?: string[]; invalid_values?: number } = { created: 0, updated: 0, skipped: 0 };
  // custom field columns found: which ones, and how many cells were ignored (invalid values)
  if (customCols.size) Object.assign(result, { fields: [...customCols.values()], invalid_values: 0 });
  // All-or-nothing: a failure rolls the whole import back.
  await db.transaction().execute(async (trx) => {
    const tag = body.tag ? await getOrCreateTag(userId, body.tag, trx) : null;
    for (const r of rows.slice(1)) {
      const email = (r[emailIdx] ?? '').trim().toLowerCase();
      if (!emailCheck.safeParse(email).success) { result.skipped++; continue; }
      const get = (k: string) => (idx(k) >= 0 ? r[idx(k)] ?? null : null);
      // empty cells never erase an existing value; invalid values are ignored (counted)
      const values: Record<string, string> = {};
      for (const [i, key] of customCols) if ((r[i] ?? '').trim()) values[key] = r[i];
      const fields = customCols.size ? validateFields(defs, values, true) : null;
      if (fields) result.invalid_values! += fields.ignored.length;
      const { contact, created } = await upsertContact(
        userId,
        { email, first_name: get('first_name'), last_name: get('last_name'), phone: get('phone'), fields },
        { eventType: 'imported' },
        trx,
      );
      if (created) result.created++;
      else result.updated++;
      if (tag) await addTag(userId, contact.id, tag, undefined, trx);
    }
  });
  res.json(result);
});

const csvCell = (v: unknown) => {
  const s = String(v ?? '');
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // avoid spreadsheet formula injection
  return /[",;\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

contactsRouter.get('/contacts/export', async (req, res) => {
  const userId = uid(req);
  const rows = await db.selectFrom('contacts').selectAll().where('user_id', '=', userId).orderBy('created_at', 'desc').orderBy('id', 'desc').execute();
  const tags = await tagsForContacts(rows.map((r) => r.id));
  // one column per custom field (header = key: re-importable as is)
  const defs = [...(await fieldDefMap(userId)).values()];
  const lines = [['email', 'first_name', 'last_name', 'phone', 'tags', 'unsubscribed', 'created_at', 'confirmed_at', ...defs.map((d) => d.key)].map(csvCell).join(',')];
  for (const r of rows) {
    const custom = defs.map((d) => {
      const v = r.fields?.[d.key];
      return v === undefined ? '' : d.type === 'checkbox' ? (v ? 'oui' : 'non') : d.type === 'date' ? String(v) : formatFieldValue(d.type, v);
    });
    lines.push(
      [r.email, r.first_name, r.last_name, r.phone, (tags.get(r.id) ?? []).map((t) => t.name).join('|'), r.unsubscribed ? 1 : 0, r.created_at, r.confirmed_at ?? '', ...custom]
        .map(csvCell)
        .join(','),
    );
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"');
  res.send('\ufeff' + lines.join('\n') + '\n');
});

contactsRouter.get('/contacts/:id', async (req, res) => {
  const userId = uid(req);
  const row = await ownedContact(userId, req.params.id);
  const events: ContactEvent[] = await db
    .selectFrom('contact_events')
    .select(['id', 'type', 'data', 'created_at'])
    .where('contact_id', '=', row.id)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(500)
    .execute();
  res.json({ ...(await getContact(userId, row.id))!, events });
});

/** Updates a contact (shared with the public API): 409 if the new email is taken, unsubscribing stops its campaigns. */
export async function patchContact(userId: number, row: ContactRow, body: z.infer<typeof patchSchema>, by = 'admin') {
  const email = body.email ? normEmail(body.email) : row.email;
  if (
    email !== row.email &&
    (await db.selectFrom('contacts').select('id').where('user_id', '=', userId).where('email', '=', email).where('id', '!=', row.id).executeTakeFirst())
  ) {
    throw new HttpError(409, CONTACT_TAKEN);
  }
  const next = {
    email,
    first_name: nullIfEmpty(body.first_name) === undefined ? row.first_name : nullIfEmpty(body.first_name)!,
    last_name: nullIfEmpty(body.last_name) === undefined ? row.last_name : nullIfEmpty(body.last_name)!,
    phone: nullIfEmpty(body.phone) === undefined ? row.phone : nullIfEmpty(body.phone)!,
    unsubscribed: body.unsubscribed === undefined ? row.unsubscribed : Boolean(body.unsubscribed),
  };
  // custom fields: only the keys sent are changed (null / '' empties a field)
  const fields = body.fields ? validateFields(await fieldDefMap(userId), body.fields) : null;
  try {
    await db.transaction().execute(async (trx) => {
      if (fields && hasChanges(fields)) await applyFieldChanges(userId, row.id, fields, trx);
      await trx
        .updateTable('contacts')
        .set({
          ...next,
          // A new address gets a fresh chance after a hard bounce.
          ...(next.email !== row.email ? { bounced: false } : {}),
        })
        .where('id', '=', row.id)
        .execute();
      if (next.unsubscribed && !row.unsubscribed) {
        await logEvent(userId, row.id, 'unsubscribed', { by }, {}, trx);
        await trx
          .updateTable('campaign_subscriptions')
          .set({ status: 'unsubscribed', stopped_at: new Date().toISOString(), stopped_reason: 'Désinscrit des emails' })
          .where('contact_id', '=', row.id)
          .where('status', 'in', ['active', 'completed'])
          .execute();
      }
    });
  } catch (e) {
    if (isUniqueViolation(e, 'contacts_user_email_key')) throw new HttpError(409, CONTACT_TAKEN);
    throw e;
  }
}

contactsRouter.patch('/contacts/:id', async (req, res) => {
  const userId = uid(req);
  const row = await ownedContact(userId, req.params.id);
  await patchContact(userId, row, patchSchema.parse(req.body));
  res.json(await getContact(userId, row.id));
});

contactsRouter.delete('/contacts/:id', async (req, res) => {
  const userId = uid(req);
  const row = await ownedContact(userId, req.params.id);
  await db.deleteFrom('contacts').where('id', '=', row.id).where('user_id', '=', userId).execute();
  res.json({ ok: true });
});

const tagNameSchema = z.object({ name: z.string().trim().min(1).max(60) });

contactsRouter.post('/contacts/:id/tags', async (req, res) => {
  const userId = uid(req);
  const row = await ownedContact(userId, req.params.id);
  const { name } = tagNameSchema.parse(req.body);
  await db.transaction().execute(async (trx) => addTag(userId, row.id, await getOrCreateTag(userId, name, trx), undefined, trx));
  res.json(await getContact(userId, row.id));
});

contactsRouter.delete('/contacts/:id/tags/:tagId', async (req, res) => {
  const userId = uid(req);
  const row = await ownedContact(userId, req.params.id);
  const tagId = paramId(req.params.tagId, 'Tag');
  if (!(await db.selectFrom('tags').select('id').where('id', '=', tagId).where('user_id', '=', userId).executeTakeFirst())) throw notFound('Tag');
  await removeTag(userId, row.id, tagId);
  res.json(await getContact(userId, row.id));
});

/** "Renvoyer l'email de confirmation" (double opt-in): new link, at most once every 5 min and 3 per hour. */
contactsRouter.post('/contacts/:id/resend-confirmation', async (req, res) => {
  const userId = uid(req);
  const row = await ownedContact(userId, req.params.id);
  const r = await resendConfirmation(userId, row);
  if (r === 'confirmed') throw new HttpError(409, 'Ce contact a déjà confirmé son inscription');
  if (r === 'undeliverable') throw new HttpError(409, 'Cette adresse ne peut plus recevoir d’emails (bounce ou plainte pour spam)');
  if (r === 'cooldown') {
    res.setHeader('Retry-After', '300');
    throw new HttpError(429, 'Un email de confirmation vient d’être envoyé : réessayez dans quelques minutes.');
  }
  if (r === 'limited') {
    res.setHeader('Retry-After', '3600');
    throw new HttpError(429, 'Trop d’emails de confirmation envoyés à ce contact. Réessayez dans une heure.');
  }
  res.json(await getContact(userId, row.id));
});
