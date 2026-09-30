// Campaign sequences.
//
// Model: at enrollment one pending email_send is created per campaign email, due at
// `enrollment + cumulative delay_days` (in sequence order). Everything that depends on the contact's state is
// evaluated when an email is due (worker → `checkCampaignSend`): subscription status, campaign stop tag, the
// email's condition (skip / stop), ordering (an email waits while an earlier one of the sequence is still pending).
// Edits keep the pre-created rows consistent:
// - adding an email backfills existing active subscribers (`backfillEmail`, `apply_to_existing`);
// - changing a delay or reordering recomputes the due date of pending rows (`rescheduleCampaign`);
// - a contact never gets the same campaign email twice (partial unique index on (campaign_email_id, contact_id)).
import { sql } from 'kysely';
import type { CampaignCondition } from '@scalo/shared';
import { db, type Db } from '../db';
import { logEvent, stopSubscription } from './contacts';

/**
 * Due date of every email for every subscription, from the current order and delays:
 * `sub.created_at + SUM(delay_days) OVER (ORDER BY position, id)`.
 */
const dueDates = (campaignId: number) => sql`
  SELECT e.id AS email_id, e.subject, SUM(e.delay_days) OVER (ORDER BY e.position, e.id) AS cum
    FROM campaign_emails e WHERE e.campaign_id = ${campaignId}`;

/**
 * Grace period before a backfilled email that is already due goes out: the email is created with the default
 * template and edited right after ("Ajouter et éditer"), so it must not leave with placeholder content.
 */
export const BACKFILL_GRACE_S = 10 * 60;

/**
 * New email in a campaign: queue it for the existing active subscribers. Its due date is computed from their
 * enrollment + cumulative delays; when that date is already past it is sent now — after BACKFILL_GRACE_S —
 * (`applyToExisting`) or skipped for them (`applyToExisting = false`). Subscribers who have not reached it yet get it
 * normally in both cases. Returns the number of sends created.
 */
export async function backfillEmail(campaignId: number, emailId: number, applyToExisting: boolean, ex: Db = db): Promise<number> {
  const r = await sql`
    WITH d AS (${dueDates(campaignId)})
    INSERT INTO email_sends (user_id, contact_id, campaign_id, campaign_email_id, kind, to_email, subject, status, send_at, created_at)
    SELECT c.user_id, s.contact_id, s.campaign_id, d.email_id, 'campaign', ct.email, d.subject, 'pending',
           GREATEST(s.created_at + make_interval(secs => d.cum::int * 86400), now() + make_interval(secs => ${BACKFILL_GRACE_S})), now()
      FROM campaign_subscriptions s
      JOIN campaigns c ON c.id = s.campaign_id
      JOIN contacts ct ON ct.id = s.contact_id
      JOIN d ON d.email_id = ${emailId}
     WHERE s.campaign_id = ${campaignId} AND s.status IN ('active', 'completed')
       AND NOT ct.unsubscribed AND NOT ct.bounced AND ct.confirmed_at IS NOT NULL
       AND (${applyToExisting} OR s.created_at + make_interval(secs => d.cum::int * 86400) > now())
    ON CONFLICT (campaign_email_id, contact_id) WHERE NOT is_test AND campaign_email_id IS NOT NULL AND contact_id IS NOT NULL
    DO NOTHING`.execute(ex);
  const n = Number(r.numAffectedRows ?? 0);
  if (n) await refreshCompleted(campaignId, ex);
  return n;
}

/**
 * After a delay change or a reorder: pending, never-attempted rows get their new due date (retries keep theirs).
 * A date now in the past means "send as soon as possible".
 */
export async function rescheduleCampaign(campaignId: number, ex: Db = db): Promise<number> {
  const r = await sql`
    WITH d AS (${dueDates(campaignId)})
    UPDATE email_sends es SET send_at = s.created_at + make_interval(secs => d.cum::int * 86400)
      FROM d, campaign_subscriptions s
     WHERE es.campaign_email_id = d.email_id AND s.campaign_id = ${campaignId} AND s.contact_id = es.contact_id
       AND es.campaign_id = ${campaignId} AND es.status = 'pending' AND es.attempts = 0 AND NOT es.is_test
       AND es.send_at IS DISTINCT FROM s.created_at + make_interval(secs => d.cum::int * 86400)`.execute(ex);
  return Number(r.numAffectedRows ?? 0);
}

/** 'completed' ⇄ 'active' from the remaining pending sends of each subscription. */
export async function refreshCompleted(campaignId: number, ex: Db = db) {
  // only the subscriptions whose status changes (a newly completed one fires the "campagne terminée" event)
  const { rows } = await sql<{ contact_id: number; status: string }>`
    UPDATE campaign_subscriptions s SET status = x.next
      FROM (SELECT s2.id, CASE WHEN EXISTS (
              SELECT 1 FROM email_sends es WHERE es.campaign_id = s2.campaign_id AND es.contact_id = s2.contact_id
                 AND es.status IN ('pending', 'sending') AND NOT es.is_test) THEN 'active' ELSE 'completed' END AS next
              FROM campaign_subscriptions s2 WHERE s2.campaign_id = ${campaignId} AND s2.status IN ('active', 'completed')) x
     WHERE s.id = x.id AND s.status <> x.next
    RETURNING s.contact_id, s.status`.execute(ex);
  await logCompleted(campaignId, rows.filter((r) => r.status === 'completed').map((r) => r.contact_id), ex);
}

/** Marks one subscription completed when its last pending email has been processed. */
export async function completeIfDone(campaignId: number, contactId: number, ex: Db = db) {
  const { rows } = await sql<{ contact_id: number }>`
    UPDATE campaign_subscriptions s SET status = 'completed'
     WHERE s.campaign_id = ${campaignId} AND s.contact_id = ${contactId} AND s.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM email_sends es WHERE es.campaign_id = s.campaign_id AND es.contact_id = s.contact_id
                        AND es.status IN ('pending', 'sending') AND NOT es.is_test)
    RETURNING s.contact_id`.execute(ex);
  await logCompleted(campaignId, rows.map((r) => r.contact_id), ex);
}

/** Event `campaign_completed` (timeline + "Campagne terminée" automations). */
async function logCompleted(campaignId: number, contactIds: number[], ex: Db) {
  if (!contactIds.length) return;
  const c = await ex.selectFrom('campaigns').select(['user_id', 'name']).where('id', '=', campaignId).executeTakeFirst();
  if (!c) return;
  for (const id of contactIds) await logEvent(c.user_id, id, 'campaign_completed', { campaign: c.name, campaign_id: campaignId }, {}, ex);
}

export const CONDITION_LABELS: Record<CampaignCondition['type'], string> = {
  has_tag: 'a le tag',
  not_has_tag: 'n’a pas le tag',
  opened_previous: 'a ouvert l’email précédent',
  clicked_previous: 'a cliqué dans l’email précédent',
  not_opened_previous: 'n’a pas ouvert l’email précédent',
};

export type CampaignCheck =
  | { action: 'send' }
  | { action: 'wait'; until: string } // an earlier email of the sequence is still pending
  | { action: 'skip'; reason: string }
  | { action: 'stopped'; reason: string }; // subscription ended (this send and the remaining ones are skipped)

/**
 * Decides, when a campaign email is due, whether it goes out. Called by the worker on a claimed send.
 * Stops the subscription itself when the stop tag or a `stop` condition applies.
 */
export async function checkCampaignSend(
  s: { id: number; user_id: number; contact_id: number; campaign_email_id: number },
  ex: Db = db,
): Promise<CampaignCheck> {
  const email = await ex
    .selectFrom('campaign_emails as e')
    .innerJoin('campaigns as c', 'c.id', 'e.campaign_id')
    .select(['e.id', 'e.campaign_id', 'e.position', 'e.condition', 'c.stop_tag_id', 'c.name'])
    .where('e.id', '=', s.campaign_email_id)
    .executeTakeFirst();
  if (!email) return { action: 'skip', reason: 'Email source supprimé' };
  const sub = await ex
    .selectFrom('campaign_subscriptions')
    .select(['status', 'stopped_reason'])
    .where('campaign_id', '=', email.campaign_id)
    .where('contact_id', '=', s.contact_id)
    .executeTakeFirst();
  if (!sub) return { action: 'skip', reason: 'Retiré de la campagne' };
  if (sub.status === 'stopped' || sub.status === 'unsubscribed') {
    return { action: 'skip', reason: sub.status === 'unsubscribed' ? 'Retiré de la campagne' : `Séquence arrêtée : ${sub.stopped_reason ?? ''}`.trim() };
  }
  const hasTag = async (tagId: number) =>
    !!(await ex.selectFrom('contact_tags').select('tag_id').where('contact_id', '=', s.contact_id).where('tag_id', '=', tagId).executeTakeFirst());

  if (email.stop_tag_id && (await hasTag(email.stop_tag_id))) {
    const tag = await ex.selectFrom('tags').select('name').where('id', '=', email.stop_tag_id).executeTakeFirst();
    const reason = `Tag « ${tag?.name ?? email.stop_tag_id} » reçu`;
    await stopSubscription(s.user_id, email.campaign_id, s.contact_id, 'stopped', reason, ex);
    return { action: 'stopped', reason };
  }

  // sequence order: wait while an earlier email of this campaign is still pending / being sent for this contact
  const earlier = await ex
    .selectFrom('email_sends as es')
    .innerJoin('campaign_emails as e', 'e.id', 'es.campaign_email_id')
    .select(['es.send_at'])
    .where('es.campaign_id', '=', email.campaign_id)
    .where('es.contact_id', '=', s.contact_id)
    .where('es.id', '!=', s.id)
    .where('es.is_test', '=', false)
    .where('es.status', 'in', ['pending', 'sending'])
    .where((eb) => eb.or([eb('e.position', '<', email.position), eb.and([eb('e.position', '=', email.position), eb('e.id', '<', email.id)])]))
    .orderBy('es.send_at')
    .limit(1)
    .executeTakeFirst();
  if (earlier) {
    const until = new Date(Math.max(Date.now() + 60_000, new Date(earlier.send_at).getTime() + 1000)).toISOString();
    return { action: 'wait', until };
  }

  const cond = email.condition;
  if (!cond) return { action: 'send' };
  let ok: boolean;
  switch (cond.type) {
    case 'has_tag':
    case 'not_has_tag': {
      const has = cond.tag_id ? await hasTag(cond.tag_id) : false;
      ok = cond.type === 'has_tag' ? has : !has;
      break;
    }
    default: {
      // "previous" = the last email of this campaign actually delivered to the contact
      const prev = await ex
        .selectFrom('email_sends')
        .select(['opened_at', 'clicked_at'])
        .where('campaign_id', '=', email.campaign_id)
        .where('contact_id', '=', s.contact_id)
        .where('status', '=', 'sent')
        .where('is_test', '=', false)
        .where('id', '!=', s.id)
        .orderBy('sent_at', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst();
      const opened = !!prev?.opened_at || !!prev?.clicked_at;
      ok = cond.type === 'opened_previous' ? opened : cond.type === 'clicked_previous' ? !!prev?.clicked_at : !opened;
    }
  }
  if (ok) return { action: 'send' };
  let label = CONDITION_LABELS[cond.type];
  if (cond.tag_id && (cond.type === 'has_tag' || cond.type === 'not_has_tag')) {
    const tag = await ex.selectFrom('tags').select('name').where('id', '=', cond.tag_id).executeTakeFirst();
    label += ` « ${tag?.name ?? cond.tag_id} »`;
  }
  const reason = `Condition non remplie (${label})`;
  if (cond.action === 'stop') {
    await stopSubscription(s.user_id, email.campaign_id, s.contact_id, 'stopped', reason, ex);
    return { action: 'stopped', reason };
  }
  return { action: 'skip', reason };
}
