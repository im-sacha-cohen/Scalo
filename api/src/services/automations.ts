// Automation engine: rules "trigger → conditions → actions".
//
// Triggering (`emitTrigger`): called from the existing hooks (logEvent of optin / created / tag_added / tag_removed /
// email_clicked / purchase / campaign_completed events, incoming webhooks) *inside the caller's transaction*: it only
// inserts `automation_runs` rows ('pending'), so a rolled back operation never leaves a run behind and the caller's
// transaction is never slowed down by the actions themselves.
//
// Execution (`runAutomationRuns`, called by the worker every tick): due runs are claimed atomically
// (`FOR UPDATE SKIP LOCKED`, pending/waiting → running). For each action, the action and the advance of `step` are done
// in the SAME transaction (checked against the claim), so a database action is executed exactly once even if the
// process crashes. "Attendre" stores `resume_at` ('waiting'). Outgoing webhooks are called outside any transaction:
// at-least-once, with a stable `X-Scalo-Delivery` id so the receiver can deduplicate. Runs left 'running' by a dead
// instance (no heartbeat in worker_instances) are put back to 'pending' at their current step.
//
// Loop protection: the actions of a run execute inside an AsyncLocalStorage context carrying the chain of automations
// that led to them. A run triggered from that context inherits the chain: an automation already in the chain (same
// contact) is not re-triggered, and chains deeper than MAX_DEPTH stop. Both cases are journaled as 'skipped'.
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import { sql } from 'kysely';
import type { AutomationAction, AutomationRunLogEntry, AutomationTrigger, AutomationTriggerType, SegmentFilter } from '@scalo/shared';
import { db, nowIso, type Db } from '../db';
import { PUBLIC_URL } from '../util';
import { addTag, enrollInCampaign, getContact, removeTag, stopSubscription } from './contacts';
import { unsubscribeContact } from './contact-actions';
import { applyFieldChanges, fieldDefMap, validateFields } from './fields';
import { contactMatches } from './segments';
import { postWebhook } from './webhook-http';

export const MAX_DEPTH = 5;
const CLAIM_BATCH = 50;
const INSTANCE_STALE_S = 30;

interface RunContext {
  /** Automations of the current chain (the run being executed included). */
  chain: number[];
  contactId: number;
}
const runContext = new AsyncLocalStorage<RunContext>();

export const newSecret = (prefix: string) => `${prefix}${crypto.randomBytes(24).toString('base64url')}`;
export const webhookUrl = (token: string) => `${PUBLIC_URL}/api/hooks/automations/${token}`;

// ---------- triggering ----------

/** What happened (from an event): matched against each enabled automation's trigger parameters. */
export interface TriggerEvent {
  type: AutomationTriggerType;
  data?: Record<string, unknown>;
  tag_id?: number | null;
  funnel_id?: number | null;
  step_id?: number | null;
  url?: string | null;
  broadcast_id?: number | null;
  campaign_id?: number | null;
  product?: string | null;
  course_id?: number | null;
}

export function triggerMatches(t: AutomationTrigger, ev: TriggerEvent): boolean {
  if (t.type !== ev.type) return false;
  switch (t.type) {
    case 'optin':
      return (!t.funnel_id || t.funnel_id === ev.funnel_id) && (!t.step_id || t.step_id === ev.step_id);
    case 'tag_added':
    case 'tag_removed':
      return !!ev.tag_id && t.tag_id === ev.tag_id;
    case 'link_clicked':
      return (
        (!t.url_contains || (ev.url ?? '').toLowerCase().includes(t.url_contains.toLowerCase())) &&
        (!t.broadcast_id || t.broadcast_id === ev.broadcast_id) &&
        (!t.campaign_id || t.campaign_id === ev.campaign_id)
      );
    case 'purchase':
      return !t.product || (ev.product ?? '').trim().toLowerCase() === t.product.trim().toLowerCase();
    case 'campaign_completed':
      return !t.campaign_id || t.campaign_id === ev.campaign_id;
    case 'course_completed':
      return !t.course_id || t.course_id === ev.course_id;
    case 'contact_created':
    case 'affiliate_approved':
      return true;
    case 'webhook':
      return false; // only through its own URL
  }
}

interface AutomationRef {
  id: number;
  run_once: boolean;
}

/**
 * Queues a run of `a` for the contact, applying the loop protection of the current run context. Returns the run id
 * (null when nothing was queued: run_once already done).
 */
export async function enqueueRun(ex: Db, userId: number, a: AutomationRef, contactId: number, data: Record<string, unknown>): Promise<number | null> {
  const ctx = runContext.getStore();
  const chain = ctx?.chain ?? [];
  let skip: string | null = null;
  if (ctx && ctx.contactId === contactId && chain.includes(a.id)) {
    skip = 'Boucle évitée : cette automatisation a déjà été exécutée pour ce contact dans la même chaîne';
  } else if (chain.length >= MAX_DEPTH) {
    skip = `Chaîne arrêtée : ${MAX_DEPTH} automatisations déclenchées en cascade au maximum`;
  } else if (a.run_once) {
    const done = await ex
      .selectFrom('automation_runs')
      .select('id')
      .where('automation_id', '=', a.id)
      .where('contact_id', '=', contactId)
      .where('status', '!=', 'skipped')
      .limit(1)
      .executeTakeFirst();
    if (done) return null;
  }
  const now = nowIso();
  const row = await ex
    .insertInto('automation_runs')
    .values({
      user_id: userId,
      automation_id: a.id,
      contact_id: contactId,
      status: skip ? 'skipped' : 'pending',
      error: skip,
      chain,
      depth: chain.length,
      trigger_data: JSON.stringify(data),
      resume_at: skip ? null : now,
      finished_at: skip ? now : null,
      created_at: now,
      updated_at: now,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return skip ? null : row.id;
}

/** Queues a run of every enabled automation of the account whose trigger matches. Returns how many were queued. */
export async function emitTrigger(ex: Db, userId: number, contactId: number, ev: TriggerEvent): Promise<number> {
  const autos = await ex
    .selectFrom('automations')
    .select(['id', 'trigger', 'run_once'])
    .where('user_id', '=', userId)
    .where('enabled', '=', true)
    .where('trigger_type', '=', ev.type)
    .execute();
  let n = 0;
  for (const a of autos) {
    if (!triggerMatches(a.trigger, ev)) continue;
    if (await enqueueRun(ex, userId, a, contactId, { type: ev.type, ...(ev.data ?? {}) })) n++;
  }
  return n;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null);

/**
 * Hook of `logEvent`: maps a contact event to a trigger. Double opt-in: the optin trigger fires on confirmation
 * (`optin_confirmed`), not on the unconfirmed submission.
 */
export async function onContactEvent(
  ex: Db,
  userId: number,
  contactId: number,
  type: string,
  data: Record<string, unknown>,
  extra: { funnel_id?: number | null; step_id?: number | null },
): Promise<void> {
  let ev: TriggerEvent | null = null;
  switch (type) {
    case 'created':
    case 'imported':
      ev = { type: 'contact_created', data: { source: type } };
      break;
    case 'optin':
      if (!data.double_optin) ev = { type: 'optin', funnel_id: extra.funnel_id ?? null, step_id: extra.step_id ?? null, data: { funnel: data.funnel, step: data.step } };
      break;
    case 'optin_confirmed':
      ev = { type: 'optin', funnel_id: extra.funnel_id ?? null, step_id: extra.step_id ?? null, data: { funnel: data.funnel, step: data.step, double_optin: true } };
      break;
    case 'tag_added':
    case 'tag_removed': {
      let tagId = num(data.tag_id);
      if (!tagId && typeof data.tag === 'string') {
        tagId = (await ex.selectFrom('tags').select('id').where('user_id', '=', userId).where(sql<string>`lower(name)`, '=', data.tag.toLowerCase()).executeTakeFirst())?.id ?? null;
      }
      ev = { type: type, tag_id: tagId, data: { tag: data.tag } };
      break;
    }
    case 'email_clicked':
      ev = {
        type: 'link_clicked',
        url: typeof data.url === 'string' ? data.url : null,
        broadcast_id: num(data.broadcast_id),
        campaign_id: num(data.campaign_id),
        data: { url: data.url },
      };
      break;
    case 'purchase':
      ev = {
        type: 'purchase',
        product: typeof data.product === 'string' ? data.product : null,
        data: { product: data.product, amount: data.amount, currency: data.currency },
      };
      break;
    case 'campaign_completed':
      ev = { type: 'campaign_completed', campaign_id: num(data.campaign_id), data: { campaign: data.campaign } };
      break;
    case 'course_completed':
      ev = { type: 'course_completed', course_id: num(data.course_id), data: { course: data.course } };
      break;
    // affiliation: the contact became an approved affiliate (services/affiliates.ts)
    case 'affiliate_joined':
      ev = { type: 'affiliate_approved', data: { code: data.code } };
      break;
  }
  if (ev) await emitTrigger(ex, userId, contactId, ev);
}

// ---------- execution ----------

class ActionError extends Error {}
class LostClaim extends Error {}

const WAIT_MS: Record<string, number> = { minutes: 60_000, hours: 3600_000, days: 86400_000 };

const entry = (step: number, action: AutomationAction['type'], ok: boolean, message: string): AutomationRunLogEntry => ({
  step,
  action,
  ok,
  message,
  at: nowIso(),
});
const appendLog = (e: AutomationRunLogEntry) => sql<string>`log || ${JSON.stringify([e])}::jsonb`;

/** Executes a database action inside the run's transaction. Returns the journal message; throws ActionError. */
async function executeAction(trx: Db, userId: number, contactId: number, act: AutomationAction): Promise<string> {
  switch (act.type) {
    case 'add_tag':
    case 'remove_tag': {
      const tag = await trx.selectFrom('tags').select(['id', 'name']).where('id', '=', act.tag_id).where('user_id', '=', userId).executeTakeFirst();
      if (!tag) throw new ActionError('Tag introuvable (supprimé ?)');
      if (act.type === 'add_tag') return (await addTag(userId, contactId, tag, undefined, trx)) ? `Tag « ${tag.name} » ajouté` : `Tag « ${tag.name} » déjà présent`;
      return (await removeTag(userId, contactId, tag.id, trx)) ? `Tag « ${tag.name} » retiré` : `Le contact n’avait pas le tag « ${tag.name} »`;
    }
    case 'enroll':
    case 'unenroll': {
      const c = await trx.selectFrom('campaigns').select(['id', 'name']).where('id', '=', act.campaign_id).where('user_id', '=', userId).executeTakeFirst();
      if (!c) throw new ActionError('Campagne introuvable (supprimée ?)');
      if (act.type === 'enroll') {
        return (await enrollInCampaign(userId, c.id, contactId, undefined, trx))
          ? `Inscrit à la campagne « ${c.name} »`
          : `Non inscrit à « ${c.name} » (déjà inscrit, double opt-in non confirmé ou tag d’arrêt)`;
      }
      return (await stopSubscription(userId, c.id, contactId, 'unsubscribed', 'Retiré par une automatisation', trx))
        ? `Retiré de la campagne « ${c.name} »`
        : `N’était pas inscrit à « ${c.name} »`;
    }
    case 'set_field': {
      const defs = await fieldDefMap(userId, trx);
      const def = defs.get(act.key);
      if (!def) throw new ActionError(`Champ « ${act.key} » introuvable (supprimé ?)`);
      let changes;
      try {
        changes = validateFields(defs, { [act.key]: act.value });
      } catch (e) {
        throw new ActionError((e as Error).message);
      }
      await applyFieldChanges(userId, contactId, changes, trx);
      return changes.unset.length ? `Champ « ${def.label} » vidé` : `Champ « ${def.label} » = ${String(changes.set[act.key])}`;
    }
    case 'unsubscribe':
      return (await unsubscribeContact(userId, contactId, 'automation', trx)) ? 'Contact désinscrit des emails' : 'Contact déjà désinscrit';
    default:
      throw new ActionError('Action inconnue');
  }
}

interface ClaimedRun {
  id: number;
  user_id: number;
  automation_id: number;
  contact_id: number | null;
  step: number;
  chain: number[];
  trigger_data: Record<string, unknown>;
}

async function finish(runId: number, instanceId: string, status: 'completed' | 'failed' | 'skipped', error: string | null, log?: AutomationRunLogEntry) {
  await db
    .updateTable('automation_runs')
    .set({
      status,
      error,
      finished_at: nowIso(),
      updated_at: nowIso(),
      resume_at: null,
      claimed_by: null,
      ...(log ? { log: appendLog(log) } : {}),
    })
    .where('id', '=', runId)
    .where('status', '=', 'running')
    .where('claimed_by', '=', instanceId)
    .execute();
}

async function processRun(run: ClaimedRun, instanceId: string): Promise<void> {
  const a = await db.selectFrom('automations').selectAll().where('id', '=', run.automation_id).executeTakeFirst();
  if (!a) return; // deleted meanwhile (its runs are deleted in cascade)
  if (!a.enabled) return finish(run.id, instanceId, 'skipped', 'Automatisation désactivée');
  const contact = run.contact_id ? await db.selectFrom('contacts').select(['id', 'user_id']).where('id', '=', run.contact_id).executeTakeFirst() : undefined;
  if (!contact || contact.user_id !== run.user_id) return finish(run.id, instanceId, 'failed', 'Contact supprimé');

  // conditions: evaluated when the run starts (nothing executed yet)
  if (run.step === 0 && !(await contactMatches(run.user_id, contact.id, a.conditions as SegmentFilter | null))) {
    return finish(run.id, instanceId, 'skipped', 'Conditions non remplies');
  }

  const actions = a.actions;
  const ctx: RunContext = { chain: [...run.chain, a.id], contactId: contact.id };
  for (let step = run.step; step < actions.length; step++) {
    const act = actions[step];
    if (act.type === 'wait') {
      const ms = Math.max(1, act.amount) * (WAIT_MS[act.unit] ?? WAIT_MS.minutes);
      const until = new Date(Date.now() + ms).toISOString();
      // no row updated = claim lost (recovered by another instance): nothing else to do
      await db
        .updateTable('automation_runs')
        .set({
          status: 'waiting',
          step: step + 1,
          resume_at: until,
          claimed_by: null,
          updated_at: nowIso(),
          log: appendLog(entry(step, 'wait', true, `Attente de ${act.amount} ${act.unit === 'days' ? 'jour(s)' : act.unit === 'hours' ? 'heure(s)' : 'minute(s)'}`)),
        })
        .where('id', '=', run.id)
        .where('status', '=', 'running')
        .where('claimed_by', '=', instanceId)
        .where('step', '=', step)
        .execute();
      return;
    }
    if (act.type === 'webhook') {
      const payload = {
        event: 'automation.webhook',
        delivery_id: `${run.id}.${step}`,
        automation: { id: a.id, name: a.name },
        trigger: { type: a.trigger_type, ...run.trigger_data },
        contact: await getContact(run.user_id, contact.id),
        sent_at: nowIso(),
      };
      const res = await postWebhook(act.url, payload, { secret: a.signing_secret, deliveryId: payload.delivery_id, event: payload.event });
      if (!res.ok) return finish(run.id, instanceId, 'failed', `Webhook : ${res.error}`, entry(step, 'webhook', false, res.error));
      const r = await db
        .updateTable('automation_runs')
        .set({ step: step + 1, updated_at: nowIso(), log: appendLog(entry(step, 'webhook', true, `Webhook appelé (HTTP ${res.status})`)) })
        .where('id', '=', run.id)
        .where('status', '=', 'running')
        .where('claimed_by', '=', instanceId)
        .where('step', '=', step)
        .executeTakeFirst();
      if (!Number(r.numUpdatedRows)) return; // claim lost (recovered by another instance)
      continue;
    }
    try {
      await db.transaction().execute(async (trx) => {
        const own = await trx
          .selectFrom('automation_runs')
          .select('id')
          .where('id', '=', run.id)
          .where('status', '=', 'running')
          .where('claimed_by', '=', instanceId)
          .where('step', '=', step)
          .forUpdate()
          .executeTakeFirst();
        if (!own) throw new LostClaim();
        const message = await runContext.run(ctx, () => executeAction(trx, run.user_id, contact.id, act));
        await trx
          .updateTable('automation_runs')
          .set({ step: step + 1, updated_at: nowIso(), log: appendLog(entry(step, act.type, true, message)) })
          .where('id', '=', run.id)
          .execute();
      });
    } catch (e) {
      if (e instanceof LostClaim) return;
      const msg = e instanceof ActionError ? e.message : `Erreur : ${e instanceof Error ? e.message : String(e)}`;
      return finish(run.id, instanceId, 'failed', msg, entry(step, act.type, false, msg));
    }
  }
  await finish(run.id, instanceId, 'completed', null);
}

/** Atomically claims up to `limit` due runs (pending, or waiting whose delay is over). */
export async function claimRuns(instanceId: string, limit = CLAIM_BATCH, ex: Db = db): Promise<ClaimedRun[]> {
  const { rows } = await sql<ClaimedRun>`
    UPDATE automation_runs SET status = 'running', claimed_by = ${instanceId}, claimed_at = now(), updated_at = now()
     WHERE id IN (
       SELECT id FROM automation_runs
        WHERE status IN ('pending', 'waiting') AND resume_at <= now()
        ORDER BY resume_at, id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
    RETURNING id, user_id, automation_id, contact_id, step, chain, trigger_data`.execute(ex);
  return rows.sort((a, b) => a.id - b.id);
}

let busy = false;

/** One round of the automation runner (worker tick). Never overlaps itself in a process. Returns runs processed. */
export async function runAutomationRuns(instanceId: string): Promise<number> {
  if (busy) return 0;
  busy = true;
  try {
    const runs = await claimRuns(instanceId);
    for (const run of runs) {
      try {
        await processRun(run, instanceId);
      } catch (e) {
        console.error('[automations]', e);
        await finish(run.id, instanceId, 'failed', `Erreur interne : ${e instanceof Error ? e.message : String(e)}`).catch(() => undefined);
      }
    }
    return runs.length;
  } finally {
    busy = false;
  }
}

/**
 * Runs left 'running' by an instance that is gone go back to 'pending' at their current step (the database actions
 * already done advanced `step` in their transaction, so they are not replayed; a webhook being called may be sent
 * again with the same delivery id).
 */
export async function recoverAutomationRuns(ex: Db = db): Promise<number> {
  const r = await ex
    .updateTable('automation_runs')
    .set({ status: 'pending', resume_at: sql`now()`, claimed_by: null, updated_at: nowIso() })
    .where('status', '=', 'running')
    .where(
      sql<boolean>`(automation_runs.claimed_by IS NULL OR NOT EXISTS (
        SELECT 1 FROM worker_instances w WHERE w.id = automation_runs.claimed_by
           AND w.heartbeat_at > now() - make_interval(secs => ${INSTANCE_STALE_S})))`,
    )
    .executeTakeFirst();
  const n = Number(r.numUpdatedRows);
  if (n) console.log(`[automations] ${n} exécution(s) interrompue(s) reprise(s)`);
  return n;
}

/** Due runs (drain loop of the tests / seed). */
export async function dueRunsCount(ex: Db = db): Promise<number> {
  const r = await ex
    .selectFrom('automation_runs')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('status', 'in', ['pending', 'waiting'])
    .where('resume_at', '<=', sql<string>`now()`)
    .executeTakeFirstOrThrow();
  return r.n;
}
