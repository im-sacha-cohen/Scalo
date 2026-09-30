import { sql } from 'kysely';
import type { Contact, Tag } from '@scalo/shared';
import { db, inTx, nowIso, type ContactRow, type Db } from '../db';
import { onContactEvent } from './automations';
import type { FieldChanges } from './fields';
import { triggersSuspended } from './import-context';

export type { ContactRow };

export interface ContactInput {
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  /** Validated custom field changes (services/fields.ts). */
  fields?: FieldChanges | null;
}

export const normEmail = (e: string) => e.trim().toLowerCase();
const clean = (v: string | null | undefined) => {
  if (v === undefined || v === null) return null;
  const t = v.trim();
  return t ? t : null;
};

export async function logEvent(
  userId: number,
  contactId: number,
  type: string,
  data: Record<string, unknown> = {},
  extra: { funnel_id?: number | null; step_id?: number | null; created_at?: string } = {},
  ex: Db = db,
) {
  await ex
    .insertInto('contact_events')
    .values({
      user_id: userId,
      contact_id: contactId,
      type,
      data: JSON.stringify(data),
      funnel_id: extra.funnel_id ?? null,
      step_id: extra.step_id ?? null,
      created_at: extra.created_at ?? nowIso(),
    })
    .execute();
  // automations: queue the runs triggered by this event, in the same transaction (see services/automations.ts)
  // (suspended during a contact import unless the user asked otherwise: see services/import-context.ts)
  if (!triggersSuspended()) await onContactEvent(ex, userId, contactId, type, data, extra);
}

export function getContactRow(userId: number, id: number, ex: Db = db): Promise<ContactRow | undefined> {
  return ex.selectFrom('contacts').selectAll().where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
}

export async function tagsForContacts(ids: number[], ex: Db = db): Promise<Map<number, Tag[]>> {
  const map = new Map<number, Tag[]>();
  if (!ids.length) return map;
  const rows = await ex
    .selectFrom('contact_tags as ct')
    .innerJoin('tags as t', 't.id', 'ct.tag_id')
    .select(['ct.contact_id', 't.id', 't.name'])
    .where('ct.contact_id', 'in', ids)
    .orderBy('t.name')
    .execute();
  for (const r of rows) {
    if (!map.has(r.contact_id)) map.set(r.contact_id, []);
    map.get(r.contact_id)!.push({ id: r.id, name: r.name });
  }
  return map;
}

/** API shape: booleans are exposed as 0 | 1 (contract kept from the original API). */
export function toContact(row: ContactRow, tags: Tag[] = []): Contact {
  return {
    id: row.id,
    email: row.email,
    first_name: row.first_name,
    last_name: row.last_name,
    phone: row.phone,
    unsubscribed: row.unsubscribed ? 1 : 0,
    bounced: row.bounced ? 1 : 0,
    complained: row.complained ? 1 : 0,
    status: row.confirmed_at ? 'active' : 'pending_confirmation',
    confirmed_at: row.confirmed_at,
    confirmation_sent_at: row.confirmation_sent_at,
    created_at: row.created_at,
    tags,
    fields: row.fields ?? {},
  };
}

export async function getContact(userId: number, id: number, ex: Db = db): Promise<Contact | undefined> {
  const row = await getContactRow(userId, id, ex);
  if (!row) return undefined;
  return toContact(row, (await tagsForContacts([row.id], ex)).get(row.id) ?? []);
}

/**
 * Creates the contact or fills in the provided non-empty fields of an existing one (single atomic upsert, safe
 * against concurrent submissions of the same email). `overwrite`: when false, existing non-null fields are kept.
 * `optin`: 'pending' creates the contact unconfirmed (double opt-in; an existing contact keeps its state),
 * 'confirmed' also confirms an existing unconfirmed contact (single opt-in form); default: new contacts are confirmed.
 */
export async function upsertContact(
  userId: number,
  input: ContactInput,
  opts: { overwrite?: boolean; created_at?: string; eventType?: string; optin?: 'pending' | 'confirmed' } = {},
  ex: Db = db,
): Promise<{ contact: ContactRow; created: boolean }> {
  const email = normEmail(input.email);
  const fields = { first_name: clean(input.first_name), last_name: clean(input.last_name), phone: clean(input.phone) };
  const overwrite = opts.overwrite ?? true;
  const createdAt = opts.created_at ?? nowIso();
  const custom = input.fields && (Object.keys(input.fields.set).length || input.fields.unset.length) ? input.fields : null;
  // new value wins when overwriting (if provided), otherwise the existing value wins (if set)
  const merge = (col: 'first_name' | 'last_name' | 'phone') =>
    overwrite ? sql<string | null>`COALESCE(excluded.${sql.ref(col)}, contacts.${sql.ref(col)})` : sql<string | null>`COALESCE(contacts.${sql.ref(col)}, excluded.${sql.ref(col)})`;
  const row = await ex
    .insertInto('contacts')
    .values({
      user_id: userId,
      email,
      ...fields,
      created_at: createdAt,
      confirmed_at: opts.optin === 'pending' ? null : createdAt,
      ...(custom ? { fields: JSON.stringify(custom.set) } : {}),
    })
    .onConflict((oc) =>
      oc.columns(['user_id', 'email']).doUpdateSet({
        first_name: merge('first_name'),
        last_name: merge('last_name'),
        phone: merge('phone'),
        // custom fields: same rule (overwrite: new values win and empty ones are removed; otherwise existing ones win)
        ...(custom
          ? {
              fields: overwrite
                ? sql<string>`(contacts.fields - ${custom.unset}::text[]) || ${JSON.stringify(custom.set)}::jsonb`
                : sql<string>`${JSON.stringify(custom.set)}::jsonb || contacts.fields`,
            }
          : {}),
        ...(opts.optin === 'confirmed' ? { confirmed_at: sql<string>`COALESCE(contacts.confirmed_at, now())` } : {}),
      }),
    )
    .returningAll()
    .returning(sql<boolean>`(xmax = 0)`.as('inserted'))
    .executeTakeFirstOrThrow();
  const { inserted, ...contact } = row;
  if (inserted) await logEvent(userId, contact.id, opts.eventType ?? 'created', {}, { created_at: createdAt }, ex);
  return { contact, created: inserted };
}

export async function findTag(userId: number, name: string, ex: Db = db): Promise<Tag | undefined> {
  return ex
    .selectFrom('tags')
    .select(['id', 'name'])
    .where('user_id', '=', userId)
    .where(sql<string>`lower(name)`, '=', name.trim().toLowerCase())
    .executeTakeFirst();
}

export async function getOrCreateTag(userId: number, name: string, ex: Db = db): Promise<Tag> {
  const n = name.trim();
  const found = await findTag(userId, n, ex);
  if (found) return found;
  const created = await ex
    .insertInto('tags')
    .values({ user_id: userId, name: n, created_at: nowIso() })
    .onConflict((oc) => oc.expression(sql`user_id, lower(name)`).doNothing())
    .returning(['id', 'name'])
    .executeTakeFirst();
  return created ?? (await findTag(userId, n, ex))!; // lost a race: someone else created it
}

/**
 * Adds a tag to a contact (idempotent). When newly added, enrolls the contact in every
 * campaign whose trigger is this tag. Returns true if the tag was newly added.
 */
export function addTag(userId: number, contactId: number, tag: Tag, at?: string, ex: Db = db): Promise<boolean> {
  return inTx(ex, async (trx) => {
    const when = at ?? nowIso();
    const added = await trx
      .insertInto('contact_tags')
      .values({ contact_id: contactId, tag_id: tag.id, created_at: when })
      .onConflict((oc) => oc.doNothing())
      .returning('tag_id')
      .executeTakeFirst();
    if (!added) return false;
    await logEvent(userId, contactId, 'tag_added', { tag: tag.name, tag_id: tag.id }, { created_at: when }, trx);
    // "stop when the contact gets tag X" (checked again at send time)
    const stops = await trx.selectFrom('campaigns').select(['id', 'name']).where('user_id', '=', userId).where('stop_tag_id', '=', tag.id).execute();
    for (const c of stops) await stopSubscription(userId, c.id, contactId, 'stopped', `Tag « ${tag.name} » reçu`, trx);
    // a contact import does not start campaigns (no surprise emails) unless the user asked for it
    if (triggersSuspended()) return true;
    const campaigns = await trx.selectFrom('campaigns').select('id').where('user_id', '=', userId).where('trigger_tag_id', '=', tag.id).execute();
    for (const c of campaigns) await enrollInCampaign(userId, c.id, contactId, when, trx);
    return true;
  });
}

/** Enrolls a contact in every campaign triggered by one of its tags (used when a double opt-in is confirmed). */
export async function enrollByTriggerTags(userId: number, contactId: number, ex: Db = db) {
  const campaigns = await ex
    .selectFrom('campaigns as c')
    .innerJoin('contact_tags as ct', 'ct.tag_id', 'c.trigger_tag_id')
    .select('c.id')
    .distinct()
    .where('c.user_id', '=', userId)
    .where('ct.contact_id', '=', contactId)
    .execute();
  for (const c of campaigns) await enrollInCampaign(userId, c.id, contactId, undefined, ex);
}

/**
 * Ends a contact's sequence in a campaign: 'stopped' (stop tag, condition) or 'unsubscribed' (removed from the
 * campaign). Its pending campaign emails are skipped. Returns false if the subscription was not active.
 */
export function stopSubscription(
  userId: number,
  campaignId: number,
  contactId: number,
  status: 'stopped' | 'unsubscribed',
  reason: string,
  ex: Db = db,
): Promise<boolean> {
  return inTx(ex, async (trx) => {
    const sub = await trx
      .updateTable('campaign_subscriptions')
      .set({ status, stopped_at: nowIso(), stopped_reason: reason })
      .where('campaign_id', '=', campaignId)
      .where('contact_id', '=', contactId)
      .where('status', 'in', ['active', 'completed'])
      .returning('id')
      .executeTakeFirst();
    if (!sub) return false;
    await trx
      .updateTable('email_sends')
      .set({ status: 'skipped', error: status === 'unsubscribed' ? 'Retiré de la campagne' : `Séquence arrêtée : ${reason}` })
      .where('campaign_id', '=', campaignId)
      .where('contact_id', '=', contactId)
      .where('status', '=', 'pending')
      .where('is_test', '=', false)
      .execute();
    const c = await trx.selectFrom('campaigns').select('name').where('id', '=', campaignId).executeTakeFirst();
    await logEvent(userId, contactId, 'campaign_left', { campaign: c?.name ?? '', reason, status }, {}, trx);
    return true;
  });
}

/** Hard bounce (SMTP 5xx on the recipient or provider webhook): excluded from every future send. */
export function flagBounce(userId: number, contactId: number, error: string, ex: Db = db): Promise<boolean> {
  return inTx(ex, async (trx) => {
    const flagged = await trx.updateTable('contacts').set({ bounced: true }).where('id', '=', contactId).where('bounced', '=', false).executeTakeFirst();
    if (!Number(flagged.numUpdatedRows)) return false;
    await trx
      .updateTable('email_sends')
      .set({ status: 'failed', error: 'Adresse invalide (bounce)' })
      .where('contact_id', '=', contactId)
      .where('status', '=', 'pending')
      .execute();
    await logEvent(userId, contactId, 'bounced', { error }, {}, trx);
    return true;
  });
}

/**
 * Spam complaint (feedback loop): unsubscribed + flagged `complained`, pending sends cancelled, campaigns stopped.
 * `sendId`: the email that was reported (counted in the complaint rate). Returns false if already recorded.
 */
export function flagComplaint(userId: number, contactId: number, sendId: number | null, source: string, ex: Db = db): Promise<boolean> {
  return inTx(ex, async (trx) => {
    if (sendId) {
      await trx.updateTable('email_sends').set({ complained_at: nowIso() }).where('id', '=', sendId).where('complained_at', 'is', null).execute();
    }
    const flagged = await trx
      .updateTable('contacts')
      .set({ complained: true, unsubscribed: true })
      .where('id', '=', contactId)
      .where('complained', '=', false)
      .executeTakeFirst();
    if (!Number(flagged.numUpdatedRows)) return false;
    await trx
      .updateTable('email_sends')
      .set({ status: 'failed', error: 'unsubscribed' })
      .where('contact_id', '=', contactId)
      .where('status', '=', 'pending')
      .execute();
    await trx
      .updateTable('campaign_subscriptions')
      .set({ status: 'unsubscribed', stopped_at: nowIso(), stopped_reason: 'Plainte pour spam' })
      .where('contact_id', '=', contactId)
      .where('status', 'in', ['active', 'completed'])
      .execute();
    await logEvent(userId, contactId, 'spam_complaint', { source }, {}, trx);
    return true;
  });
}

export function removeTag(userId: number, contactId: number, tagId: number, ex: Db = db): Promise<boolean> {
  return inTx(ex, async (trx) => {
    const tag = await trx.selectFrom('tags').select(['id', 'name']).where('id', '=', tagId).where('user_id', '=', userId).executeTakeFirst();
    if (!tag) return false;
    const res = await trx.deleteFrom('contact_tags').where('contact_id', '=', contactId).where('tag_id', '=', tagId).executeTakeFirst();
    const removed = Number(res.numDeletedRows) > 0;
    if (removed) await logEvent(userId, contactId, 'tag_removed', { tag: tag.name, tag_id: tag.id }, {}, trx);
    return removed;
  });
}

/**
 * Enrolls a contact in a campaign (once). One pending email_send per campaign email,
 * send_at = enrollment + cumulative delay_days (conditions, stop tag and subscription status are evaluated when each
 * email is due — see worker). Returns false if already enrolled, or if the contact has not confirmed its double
 * opt-in yet (it is enrolled on confirmation) or already has the campaign's stop tag.
 */
export function enrollInCampaign(userId: number, campaignId: number, contactId: number, at?: string, ex: Db = db): Promise<boolean> {
  return inTx(ex, async (trx) => {
    const campaign = await trx
      .selectFrom('campaigns')
      .select(['id', 'name', 'stop_tag_id'])
      .where('id', '=', campaignId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    const contact = await getContactRow(userId, contactId, trx);
    if (!campaign || !contact || !contact.confirmed_at) return false;
    if (
      campaign.stop_tag_id &&
      (await trx.selectFrom('contact_tags').select('tag_id').where('contact_id', '=', contactId).where('tag_id', '=', campaign.stop_tag_id).executeTakeFirst())
    ) {
      return false;
    }
    const when = at ?? nowIso();
    const sub = await trx
      .insertInto('campaign_subscriptions')
      .values({ campaign_id: campaignId, contact_id: contactId, created_at: when })
      .onConflict((oc) => oc.columns(['campaign_id', 'contact_id']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!sub) return false;
    const emails = await trx
      .selectFrom('campaign_emails')
      .select(['id', 'subject', 'delay_days'])
      .where('campaign_id', '=', campaignId)
      .orderBy('position')
      .orderBy('id')
      .execute();
    const base = new Date(when).getTime();
    let cumulative = 0;
    const rows = emails.map((e) => {
      cumulative += Math.max(0, e.delay_days);
      return {
        user_id: userId,
        contact_id: contactId,
        campaign_id: campaignId,
        campaign_email_id: e.id,
        kind: 'campaign' as const,
        to_email: contact.email,
        subject: e.subject,
        status: 'pending' as const,
        send_at: new Date(base + cumulative * 86400_000).toISOString(),
        created_at: when,
      };
    });
    if (rows.length) await trx.insertInto('email_sends').values(rows).execute();
    await logEvent(userId, contactId, 'campaign_enrolled', { campaign: campaign.name }, { created_at: when }, trx);
    return true;
  });
}
