// Contact operations shared by the bulk actions, the automations, the public API and the incoming webhooks.
import { sql } from 'kysely';
import type { PurchaseInput } from '@scalo/shared';
import { db, inTx, nowIso, type Db } from '../db';
import { logEvent } from './contacts';

/**
 * Unsubscribes a contact from every email (same effects as the contact page toggle / the unsubscribe link): pending
 * sends cancelled, campaign subscriptions ended, event `unsubscribed {by}`. Returns false if already unsubscribed.
 */
export function unsubscribeContact(userId: number, contactId: number, by: string, ex: Db = db): Promise<boolean> {
  return inTx(ex, async (trx) => {
    const r = await trx
      .updateTable('contacts')
      .set({ unsubscribed: true })
      .where('id', '=', contactId)
      .where('user_id', '=', userId)
      .where('unsubscribed', '=', false)
      .executeTakeFirst();
    if (!Number(r.numUpdatedRows)) return false;
    await trx
      .updateTable('email_sends')
      .set({ status: 'failed', error: 'unsubscribed' })
      .where('contact_id', '=', contactId)
      .where('status', '=', 'pending')
      .where('kind', '!=', 'confirmation')
      .execute();
    await trx
      .updateTable('campaign_subscriptions')
      .set({ status: 'unsubscribed', stopped_at: nowIso(), stopped_reason: 'Désinscrit des emails' })
      .where('contact_id', '=', contactId)
      .where('status', 'in', ['active', 'completed'])
      .execute();
    await logEvent(userId, contactId, 'unsubscribed', { by }, {}, trx);
    return true;
  });
}

export interface RecordedPurchase {
  id: number;
  product: string;
  amount: number | null;
  currency: string | null;
  external_id: string | null;
  created_at: string;
  /** false: a purchase with the same external_id was already recorded for this contact (idempotent retry). */
  created: boolean;
}

/**
 * Records a purchase (there is no payment in the app: purchases come from the public API or an incoming webhook).
 * Logs a `purchase` event, which fires the "Achat" automations. Idempotent on `external_id` per contact.
 */
export function recordPurchase(userId: number, contactId: number, p: PurchaseInput, source: string, ex: Db = db): Promise<RecordedPurchase> {
  return inTx(ex, async (trx) => {
    const externalId = p.external_id?.trim() || null;
    if (externalId) {
      // serialize concurrent retries of the same purchase
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`purchase:${contactId}:${externalId}`}))`.execute(trx);
      const prev = await trx
        .selectFrom('contact_events')
        .select(['id', 'data', 'created_at'])
        .where('contact_id', '=', contactId)
        .where('type', '=', 'purchase')
        .where(sql<boolean>`data ->> 'external_id' = ${externalId}`)
        .executeTakeFirst();
      if (prev) {
        const d = prev.data as Record<string, unknown>;
        return {
          id: prev.id,
          product: String(d.product ?? ''),
          amount: typeof d.amount === 'number' ? d.amount : null,
          currency: typeof d.currency === 'string' ? d.currency : null,
          external_id: externalId,
          created_at: prev.created_at,
          created: false,
        };
      }
    }
    const data = {
      product: p.product.trim(),
      amount: p.amount ?? null,
      currency: p.currency ? p.currency.trim().toUpperCase() : null,
      external_id: externalId,
      source,
    };
    const at = nowIso();
    await logEvent(userId, contactId, 'purchase', data, { created_at: at }, trx);
    const ev = await trx
      .selectFrom('contact_events')
      .select('id')
      .where('contact_id', '=', contactId)
      .where('type', '=', 'purchase')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    return { id: ev.id, product: data.product, amount: data.amount, currency: data.currency, external_id: externalId, created_at: at, created: true };
  });
}
