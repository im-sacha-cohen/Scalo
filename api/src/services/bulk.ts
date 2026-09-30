// Bulk actions on contacts: explicit ids or "every contact matching the current list filters".
//
// The selection is resolved once (snapshot of the matching ids, ordered), then processed in batches of BATCH contacts,
// one transaction per batch. Each contact goes through the same services as a single action, so the side effects
// apply: campaigns triggered / stopped by tags, timeline events, automations (queued in the batch transaction).
import type { BulkAction, BulkResult, BulkSelection } from '@scalo/shared';
import { db, type Db } from '../db';
import { HttpError } from '../util';
import { addTag, enrollInCampaign, getOrCreateTag, removeTag, stopSubscription } from './contacts';
import { unsubscribeContact } from './contact-actions';
import { applyFieldChanges, fieldDefMap, validateFields } from './fields';
import { applyListFilters, listPredicate } from './segments';

export const BULK_BATCH = 200;
/** Safety cap of one bulk request. */
export const BULK_MAX = 100_000;

/** Ids of the selected contacts of the account (ordered). Ids of other accounts are silently ignored. */
export async function resolveSelection(userId: number, sel: BulkSelection, ex: Db = db): Promise<number[]> {
  if ('ids' in sel) {
    const ids = [...new Set(sel.ids)];
    if (!ids.length) return [];
    const rows = await ex.selectFrom('contacts').select('id').where('user_id', '=', userId).where('id', 'in', ids).orderBy('id').execute();
    return rows.map((r) => r.id);
  }
  const pred = await listPredicate(userId, sel, ex);
  const rows = await applyListFilters(ex.selectFrom('contacts as c').where('c.user_id', '=', userId), sel, pred)
    .select('c.id')
    .orderBy('c.id')
    .limit(BULK_MAX + 1)
    .execute();
  if (rows.length > BULK_MAX) throw new HttpError(400, `Trop de contacts sélectionnés (${BULK_MAX.toLocaleString('fr-FR')} maximum par action)`);
  return rows.map((r) => r.id);
}

/** Validates the action's references before touching anything (404 / 400 with a French message). */
async function prepare(userId: number, action: BulkAction) {
  switch (action.type) {
    case 'remove_tag': {
      const tag = await db.selectFrom('tags').select(['id', 'name']).where('id', '=', action.tag_id).where('user_id', '=', userId).executeTakeFirst();
      if (!tag) throw new HttpError(404, 'Tag introuvable');
      return { tag };
    }
    case 'enroll':
    case 'unenroll': {
      const c = await db.selectFrom('campaigns').select(['id', 'name']).where('id', '=', action.campaign_id).where('user_id', '=', userId).executeTakeFirst();
      if (!c) throw new HttpError(404, 'Campagne introuvable');
      return { campaign: c };
    }
    case 'set_field': {
      const changes = validateFields(await fieldDefMap(userId), { [action.key]: action.value });
      return { changes };
    }
    default:
      return {};
  }
}

export async function runBulk(userId: number, sel: BulkSelection, action: BulkAction): Promise<BulkResult> {
  const prep = await prepare(userId, action);
  const ids = await resolveSelection(userId, sel);
  let processed = 0;
  for (let i = 0; i < ids.length; i += BULK_BATCH) {
    const batch = ids.slice(i, i + BULK_BATCH);
    processed += await db.transaction().execute(async (trx) => {
      if (action.type === 'delete') {
        const r = await trx.deleteFrom('contacts').where('user_id', '=', userId).where('id', 'in', batch).executeTakeFirst();
        return Number(r.numDeletedRows);
      }
      let n = 0;
      const tag = action.type === 'add_tag' ? await getOrCreateTag(userId, action.tag_name, trx) : null;
      for (const id of batch) {
        let changed = false;
        switch (action.type) {
          case 'add_tag':
            changed = await addTag(userId, id, tag!, undefined, trx);
            break;
          case 'remove_tag':
            changed = await removeTag(userId, id, prep.tag!.id, trx);
            break;
          case 'enroll':
            changed = await enrollInCampaign(userId, prep.campaign!.id, id, undefined, trx);
            break;
          case 'unenroll':
            changed = await stopSubscription(userId, prep.campaign!.id, id, 'unsubscribed', 'Retiré (action groupée)', trx);
            break;
          case 'unsubscribe':
            changed = await unsubscribeContact(userId, id, 'bulk', trx);
            break;
          case 'set_field':
            changed = await applyFieldChanges(userId, id, prep.changes!, trx);
            break;
        }
        if (changed) n++;
      }
      return n;
    });
  }
  return { matched: ids.length, processed };
}
