import os from 'node:os';
import crypto from 'node:crypto';
import { sql } from 'kysely';
import { applyVars, type PageContent } from '@scalo/shared';
import { db, nowIso, type ContactRow, type Db } from './db';
import { flagBounce, logEvent } from './services/contacts';
import { checkCampaignSend, completeIfDone } from './services/campaigns';
import { decideAbTests, runBroadcastScheduler, variantSubject } from './services/broadcasts';
import { recoverAutomationRuns, runAutomationRuns } from './services/automations';
import { recoverImportJobs, runImportJobs } from './services/imports';
import { approveDueCommissions } from './services/affiliates';
import { fieldVars, listFieldDefs } from './services/fields';
import {
  addTracking,
  deliver,
  feedbackId,
  footerHtml,
  getSettingsRow,
  renderEmail,
  smtpConfigured,
  unsubscribeUrl,
  type DeliveryErrorKind,
  type SettingsRow,
} from './services/email';

/*
 * Sending engine
 * - Each account has a token bucket refilled at `rate_per_minute` (small burst allowed), plus an optional
 *   rolling 24h `daily_limit`.
 * - Due emails are claimed atomically (pending → sending) with `FOR UPDATE SKIP LOCKED`, so several API processes can
 *   run the worker against the same database and a send is never claimed twice.
 * - Priority: double opt-in confirmation emails first (someone is waiting for them), then campaign emails
 *   (sequences, time-sensitive), then newsletters.
 * - Each round also runs the schedulers (scheduled newsletters, A/B winners): conditional UPDATEs, so several
 *   instances never start the same newsletter twice.
 * - Campaign emails are checked when due (subscription, stop tag, condition, order): see services/campaigns.ts.
 * - Temporary failures are retried with backoff; hard bounces flag the contact; auth failures pause the queue;
 *   connection failures put the account in backoff for a minute.
 * - Each process registers itself in `worker_instances` (heartbeat). Rows left in 'sending' by an instance that is gone
 *   (crash, kill -9) are recovered by any live instance.
 * - Token bucket / backoff state is in memory, i.e. per process: with N processes an account may send up to N× its
 *   rate for short periods. The daily limit is computed from the database and therefore shared.
 */

export const MAX_ATTEMPTS = 4;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000]; // after attempt 1, 2, 3
const BACKOFF_MS = 60_000;
const TICK_MS = 1000;
const HEARTBEAT_MS = 10_000;
const INSTANCE_STALE_S = 30; // an instance without heartbeat for this long is considered dead
const RECOVERY_EVERY_MS = 30_000;
const UNTHROTTLED_BATCH = 500;

export interface ClaimedSend {
  id: number;
  user_id: number;
  contact_id: number | null;
  broadcast_id: number | null;
  campaign_id: number | null;
  campaign_email_id: number | null;
  kind: 'broadcast' | 'campaign' | 'test' | 'confirmation' | 'order';
  variant: number | null;
  attempts: number; // already incremented by the claim
  send_at: string;
  created_at: string;
}

/** 0 = confirmation, 1 = campaign / other, 2 = newsletter. */
const priority = (s: Pick<ClaimedSend, 'kind' | 'broadcast_id'>) => (s.kind === 'confirmation' ? 0 : s.broadcast_id === null ? 1 : 2);

interface Runtime {
  tokens: number;
  refilledAt: number;
  backoffUntil: number;
  inFlight: boolean;
}

// ---------- shared (database-backed) helpers ----------

export async function sentInLast24h(userId: number, ex: Db = db) {
  const r = await ex
    .selectFrom('email_sends')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('user_id', '=', userId)
    .where('is_test', '=', false)
    .where('status', '=', 'sent')
    .where('sent_at', '>=', sql<string>`now() - interval '24 hours'`)
    .executeTakeFirstOrThrow();
  return r.n;
}

/** When the oldest send of the 24h window leaves it, i.e. when quota frees up. */
export async function dailyLimitResumeAt(userId: number, limit: number, ex: Db = db) {
  const row = await ex
    .selectFrom('email_sends')
    .select('sent_at')
    .where('user_id', '=', userId)
    .where('is_test', '=', false)
    .where('status', '=', 'sent')
    .where('sent_at', '>=', sql<string>`now() - interval '24 hours'`)
    .orderBy('sent_at', 'desc')
    .limit(1)
    .offset(Math.max(0, limit - 1))
    .executeTakeFirst();
  return row?.sent_at ? new Date(new Date(row.sent_at).getTime() + 86_400_000).toISOString() : null;
}

/**
 * Atomically claims up to `limit` due sends of an account: confirmation emails, then campaign emails, then oldest first.
 * `FOR UPDATE SKIP LOCKED` makes concurrent claimers (other processes, other ticks) take disjoint rows.
 */
export async function claimSends(userId: number, limit: number, instanceId: string, ex: Db = db): Promise<ClaimedSend[]> {
  if (limit < 1) return [];
  const { rows } = await sql<ClaimedSend>`
    UPDATE email_sends
       SET status = 'sending', attempts = attempts + 1, last_attempt_at = now(), claimed_by = ${instanceId}
     WHERE id IN (
       SELECT id FROM email_sends
        WHERE user_id = ${userId} AND status = 'pending' AND send_at <= now()
        ORDER BY CASE WHEN kind = 'confirmation' THEN 0 WHEN broadcast_id IS NULL THEN 1 ELSE 2 END, send_at, id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
    RETURNING id, user_id, contact_id, broadcast_id, campaign_id, campaign_email_id, kind, variant, attempts, send_at, created_at`.execute(ex);
  // RETURNING has no guaranteed order: restore the priority order
  return rows.sort((a, b) => priority(a) - priority(b) || a.send_at.localeCompare(b.send_at) || a.id - b.id);
}

const markFailed = (id: number, error: string, ex: Db = db) =>
  ex.updateTable('email_sends').set({ status: 'failed', error, sent_at: null }).where('id', '=', id).execute();

const markSkipped = (id: number, error: string, ex: Db = db) =>
  ex.updateTable('email_sends').set({ status: 'skipped', error, sent_at: null }).where('id', '=', id).execute();

/** Puts a claimed send back for later without counting the attempt (campaign email waiting for an earlier one). */
const postpone = (id: number, until: string, ex: Db = db) =>
  ex
    .updateTable('email_sends')
    .set({ status: 'pending', send_at: until, attempts: sql`GREATEST(attempts - 1, 0)`, claimed_by: null })
    .where('id', '=', id)
    .where('status', '=', 'sending')
    .execute();

/** Gives a claimed send back to the queue without counting the attempt. */
const release = (id: number, ex: Db = db) =>
  ex
    .updateTable('email_sends')
    .set({ status: 'pending', attempts: sql`GREATEST(attempts - 1, 0)` })
    .where('id', '=', id)
    .where('status', '=', 'sending')
    .execute();

// ---------- worker ----------

export interface WorkerOptions {
  /** false: ignore rate_per_minute (seed / tests). The daily limit still applies. */
  throttle?: boolean;
  instanceId?: string;
}

export class EmailWorker {
  readonly instanceId: string;
  private readonly throttle: boolean;
  private runtimes = new Map<number, Runtime>();
  private ticking = false;
  private timer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private lastRecovery = 0;
  private inFlightJobs = new Set<Promise<void>>();

  constructor(opts: WorkerOptions = {}) {
    this.throttle = opts.throttle ?? true;
    this.instanceId = opts.instanceId ?? `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;
  }

  private runtime(userId: number) {
    let r = this.runtimes.get(userId);
    if (!r) this.runtimes.set(userId, (r = { tokens: 1, refilledAt: Date.now(), backoffUntil: 0, inFlight: false }));
    return r;
  }

  getBackoffUntil(userId: number) {
    const until = this.runtimes.get(userId)?.backoffUntil ?? 0;
    return until > Date.now() ? until : null;
  }

  clearBackoff(userId: number) {
    const r = this.runtimes.get(userId);
    if (r) r.backoffUntil = 0;
  }

  private refill(r: Runtime, ratePerMinute: number) {
    const now = Date.now();
    const perMs = ratePerMinute / 60_000;
    const capacity = Math.max(1, Math.ceil(ratePerMinute / 60) * 2); // ~2 s of burst
    r.tokens = Math.min(capacity, r.tokens + (now - r.refilledAt) * perMs);
    r.refilledAt = now;
  }

  private async handleFailure(s: ClaimedSend, settings: SettingsRow, contact: ContactRow, error: string, kind: DeliveryErrorKind, html: string, subject: string) {
    const attempt = s.attempts; // incremented when claimed
    await db.transaction().execute(async (trx) => {
      await trx.updateTable('email_sends').set({ html, subject }).where('id', '=', s.id).execute();
      switch (kind) {
        case 'auth':
          // Not the recipient's fault: give the attempt back and stop the queue until the user fixes the settings.
          await trx
            .updateTable('email_sends')
            .set({ status: 'pending', attempts: sql`GREATEST(attempts - 1, 0)`, error })
            .where('id', '=', s.id)
            .execute();
          await trx
            .updateTable('settings')
            .set({
              sending_paused: true,
              paused_reason: `Le serveur SMTP refuse l’authentification (${error}). Vérifiez vos identifiants dans Paramètres, puis reprenez l’envoi.`,
            })
            .where('user_id', '=', settings.user_id)
            .execute();
          return;
        case 'connection':
        case 'temporary': {
          if (kind === 'connection') this.runtime(settings.user_id).backoffUntil = Date.now() + BACKOFF_MS;
          if (attempt >= MAX_ATTEMPTS) return void (await markFailed(s.id, `${error} (abandon après ${MAX_ATTEMPTS} tentatives)`, trx));
          const retryAt = new Date(Date.now() + RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]).toISOString();
          await trx.updateTable('email_sends').set({ status: 'pending', send_at: retryAt, error }).where('id', '=', s.id).execute();
          return;
        }
        case 'recipient': {
          await markFailed(s.id, `Adresse rejetée : ${error}`, trx);
          await flagBounce(settings.user_id, contact.id, error, trx);
          return;
        }
        default:
          await markFailed(s.id, error, trx);
      }
    });
  }

  private async processSend(s: ClaimedSend, settings: SettingsRow) {
    const contact = s.contact_id ? await db.selectFrom('contacts').selectAll().where('id', '=', s.contact_id).executeTakeFirst() : undefined;
    if (!contact) return void (await markFailed(s.id, 'Contact introuvable'));
    if (contact.bounced) return void (await markFailed(s.id, 'Adresse invalide (bounce)'));
    // pre-rendered emails: double opt-in confirmation, order confirmation (payments)
    if (s.kind === 'confirmation' || s.kind === 'order') return this.processConfirmation(s, settings, contact);
    if (contact.unsubscribed) return void (await markFailed(s.id, 'unsubscribed'));
    if (!contact.confirmed_at) {
      await markSkipped(s.id, 'Contact non confirmé (double opt-in)');
      if (s.campaign_id) await completeIfDone(s.campaign_id, contact.id);
      return;
    }

    let source: { subject: string; content: PageContent } | undefined;
    if (s.broadcast_id) {
      const b = await db.selectFrom('broadcasts').select(['subject', 'content', 'ab_test']).where('id', '=', s.broadcast_id).executeTakeFirst();
      if (b) source = { subject: variantSubject(b, s.variant), content: b.content };
    } else if (s.campaign_email_id) {
      const check = await checkCampaignSend({ id: s.id, user_id: s.user_id, contact_id: contact.id, campaign_email_id: s.campaign_email_id });
      if (check.action === 'wait') return void (await postpone(s.id, check.until));
      if (check.action === 'skip' || check.action === 'stopped') {
        await markSkipped(s.id, check.reason);
        if (s.campaign_id) await completeIfDone(s.campaign_id, contact.id);
        return;
      }
      source = await db.selectFrom('campaign_emails').select(['subject', 'content']).where('id', '=', s.campaign_email_id).executeTakeFirst();
    }
    if (!source) return void (await markFailed(s.id, 'Email source supprimé'));

    const vars = {
      first_name: contact.first_name ?? '',
      last_name: contact.last_name ?? '',
      email: contact.email,
      phone: contact.phone ?? '',
      // {{field.key}}: custom fields of the contact
      ...fieldVars(await listFieldDefs(s.user_id), contact.fields),
    };
    const subject = applyVars(source.subject, vars);
    const content = source.content ?? ({ settings: {}, blocks: [] } as unknown as PageContent);
    const unsub = unsubscribeUrl(contact.id);
    const html = addTracking(renderEmail(content, subject, vars, footerHtml(settings, unsub)), s.id);

    const res = await deliver(settings, { to: contact.email, subject, html, unsubscribeUrl: unsub, sendId: s.id, feedbackId: feedbackId(s) });
    if (res.ok) {
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable('email_sends')
          .set({ status: 'sent', sent_at: nowIso(), html, subject, to_email: contact.email, error: null, message_id: res.messageId ?? null })
          .where('id', '=', s.id)
          .execute();
        await logEvent(s.user_id, contact.id, 'email_sent', { subject }, {}, trx);
        if (s.campaign_id) await completeIfDone(s.campaign_id, contact.id, trx);
      });
    } else {
      await this.handleFailure(s, settings, contact, res.error, res.kind, html, subject);
    }
  }

  /**
   * Double opt-in confirmation: pre-rendered at request time (it contains the one-time link), no tracking. Sent even
   * to a contact who had unsubscribed before asking to re-subscribe (explicit request), but not when the contact
   * unsubscribed or complained after the request, nor to a bounced address.
   */
  private async processConfirmation(s: ClaimedSend, settings: SettingsRow, contact: ContactRow) {
    // an order confirmation (kind 'order') is transactional: sent whatever the marketing subscription state
    if (s.kind !== 'order' && contact.complained) return void (await markFailed(s.id, 'unsubscribed'));
    if (s.kind !== 'order' && contact.unsubscribed) {
      const after = await db
        .selectFrom('contact_events')
        .select('id')
        .where('contact_id', '=', contact.id)
        .where('type', '=', 'unsubscribed')
        .where('created_at', '>', s.created_at)
        .limit(1)
        .executeTakeFirst();
      if (after) return void (await markFailed(s.id, 'unsubscribed'));
    }
    const row = await db.selectFrom('email_sends').select(['subject', 'html']).where('id', '=', s.id).executeTakeFirst();
    if (!row?.html) return void (await markFailed(s.id, 'Email de confirmation vide'));
    const unsub = unsubscribeUrl(contact.id);
    const res = await deliver(settings, { to: contact.email, subject: row.subject, html: row.html, unsubscribeUrl: unsub, sendId: s.id, feedbackId: feedbackId(s) });
    if (res.ok) {
      await db
        .updateTable('email_sends')
        .set({ status: 'sent', sent_at: nowIso(), to_email: contact.email, error: null, message_id: res.messageId ?? null })
        .where('id', '=', s.id)
        .execute();
    } else {
      await this.handleFailure(s, settings, contact, res.error, res.kind, row.html, row.subject);
    }
  }

  private async processUser(userId: number) {
    const r = this.runtime(userId);
    if (r.inFlight) return; // previous batch of this account still being delivered (by this process)
    r.inFlight = true;
    try {
      const settings = await getSettingsRow(userId);
      if (settings.sending_paused || r.backoffUntil > Date.now()) return;

      let budget: number;
      if (this.throttle) {
        this.refill(r, Math.max(1, settings.rate_per_minute));
        budget = Math.floor(r.tokens);
      } else budget = UNTHROTTLED_BATCH;
      if (budget < 1) return;
      if (settings.daily_limit > 0) budget = Math.min(budget, settings.daily_limit - (await sentInLast24h(userId)));
      if (budget < 1) return;

      const batch = await claimSends(userId, budget, this.instanceId);
      if (this.throttle) r.tokens -= batch.length;

      for (const s of batch) {
        // The queue may have been paused (auth error) or put in backoff by a previous send of this batch.
        const fresh = await getSettingsRow(userId);
        if (fresh.sending_paused || r.backoffUntil > Date.now()) {
          await release(s.id);
          continue;
        }
        try {
          await this.processSend(s, fresh);
        } catch (e) {
          await markFailed(s.id, e instanceof Error ? e.message : String(e)).catch((err) => console.error('[worker]', err));
        }
      }
    } finally {
      r.inFlight = false;
    }
  }

  /**
   * One scheduling round: starts a batch for every account with due sends. Accounts are independent (a slow SMTP
   * server on one account doesn't hold the others back). Resolves when the batches started by this round are done.
   */
  async runOnce(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const jobs: Promise<void>[] = [];
    try {
      if (Date.now() - this.lastRecovery > RECOVERY_EVERY_MS && this.heartbeat) {
        await this.recoverInterruptedSends();
        await recoverAutomationRuns();
        await recoverImportJobs();
      }
      await this.runSchedulers();
      // automation runs (triggers queued by the app, delayed actions): in parallel with the email batches
      const autoJob = runAutomationRuns(this.instanceId).then(
        () => undefined,
        (e) => console.error('[automations]', e),
      );
      this.inFlightJobs.add(autoJob);
      void autoJob.finally(() => this.inFlightJobs.delete(autoJob));
      jobs.push(autoJob);
      // contact imports (migration from another tool): one time slice per due job
      const importJob = runImportJobs(this.instanceId).then(
        () => undefined,
        (e) => console.error('[imports]', e),
      );
      this.inFlightJobs.add(importJob);
      void importJob.finally(() => this.inFlightJobs.delete(importJob));
      jobs.push(importJob);
      const users = await db
        .selectFrom('email_sends')
        .select('user_id')
        .distinct()
        .where('status', '=', 'pending')
        .where('send_at', '<=', sql<string>`now()`)
        .execute();
      for (const { user_id } of users) {
        const job = this.processUser(user_id).catch((e) => console.error('[worker]', e));
        this.inFlightJobs.add(job);
        void job.finally(() => this.inFlightJobs.delete(job));
        jobs.push(job);
      }
    } catch (e) {
      console.error('[worker]', e instanceof Error ? e.message : e);
    } finally {
      this.ticking = false;
    }
    await Promise.all(jobs);
  }

  /** Scheduled newsletters that are due, A/B tests whose winner can be picked. Errors never stop the sending. */
  async runSchedulers() {
    try {
      await runBroadcastScheduler();
      await decideAbTests();
      // affiliation: pending commissions whose validation delay is over become payable
      await approveDueCommissions();
    } catch (e) {
      console.error('[scheduler]', e instanceof Error ? e.message : e);
    }
  }

  /** Runs rounds until nothing is due (or `maxRounds`). Used by the seed and tests. */
  async drain(maxRounds = 100) {
    for (let i = 0; i < maxRounds; i++) {
      await this.runOnce();
      const { rows } = await sql<{ n: number }>`
        SELECT (SELECT COUNT(*) FROM email_sends WHERE status = 'pending' AND send_at <= now())
             + (SELECT COUNT(*) FROM broadcasts WHERE status = 'scheduled' AND scheduled_at <= now())
             + (SELECT COUNT(*) FROM broadcasts WHERE ab_phase = 'testing' AND ab_decide_at <= now())
             + (SELECT COUNT(*) FROM automation_runs WHERE status IN ('pending', 'waiting') AND resume_at <= now())
             + (SELECT COUNT(*) FROM import_jobs WHERE status = 'pending' AND resume_at <= now()) AS n`.execute(db);
      if (!rows[0].n) return;
      if (this.throttle) await new Promise((r) => setTimeout(r, 200));
    }
  }

  /**
   * Sends left in 'sending' by an instance that is gone have an unknown outcome. With a real SMTP server they may
   * already have been delivered, so they are not resent automatically (no duplicates): they are marked failed and can
   * be retried manually. In dev mode nothing was delivered, so they are simply requeued.
   */
  async recoverInterruptedSends() {
    this.lastRecovery = Date.now();
    const orphan = sql<boolean>`(email_sends.claimed_by IS NULL OR NOT EXISTS (
      SELECT 1 FROM worker_instances w WHERE w.id = email_sends.claimed_by
         AND w.heartbeat_at > now() - make_interval(secs => ${INSTANCE_STALE_S})))`;
    const users = await db
      .selectFrom('email_sends')
      .select('user_id')
      .distinct()
      .where('status', '=', 'sending')
      .where(orphan)
      .execute();
    let total = 0;
    for (const { user_id } of users) {
      const dev = !smtpConfigured(await getSettingsRow(user_id));
      const q = db.updateTable('email_sends').where('user_id', '=', user_id).where('status', '=', 'sending').where(orphan);
      const res = dev
        ? await q.set({ status: 'pending', attempts: sql`GREATEST(attempts - 1, 0)`, claimed_by: null }).executeTakeFirst()
        : await q
            .set({ status: 'failed', claimed_by: null, error: 'Envoi interrompu (redémarrage du serveur) : non renvoyé automatiquement pour éviter un doublon' })
            .executeTakeFirst();
      total += Number(res.numUpdatedRows);
    }
    if (total) console.log(`[worker] ${total} envoi(s) interrompu(s) récupéré(s)`);
    return total;
  }

  private async beat() {
    await db
      .insertInto('worker_instances')
      .values({ id: this.instanceId, hostname: os.hostname(), pid: process.pid })
      .onConflict((oc) => oc.column('id').doUpdateSet({ heartbeat_at: sql`now()` }))
      .execute();
  }

  async start() {
    await this.beat();
    // forget instances dead for more than a day
    await db.deleteFrom('worker_instances').where('heartbeat_at', '<', sql<string>`now() - interval '1 day'`).execute();
    this.heartbeat = setInterval(() => void this.beat().catch((e) => console.error('[worker] heartbeat:', e.message)), HEARTBEAT_MS);
    this.heartbeat.unref();
    await this.recoverInterruptedSends();
    await recoverAutomationRuns();
    await recoverImportJobs();
    this.timer = setInterval(() => void this.runOnce(), TICK_MS);
    this.timer.unref();
    void this.runOnce();
  }

  /** Stops scheduling, waits (up to `timeoutMs`) for deliveries in progress, then unregisters the instance. */
  async stop(timeoutMs = 20_000) {
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.timer = this.heartbeat = null;
    await Promise.race([Promise.all([...this.inFlightJobs]), new Promise((r) => setTimeout(r, timeoutMs).unref())]);
    await db.deleteFrom('worker_instances').where('id', '=', this.instanceId).execute().catch(() => undefined);
  }
}

// ---------- default (process-wide) worker ----------

export const worker = new EmailWorker();

export const runWorkerOnce = () => worker.runOnce();
export const getBackoffUntil = (userId: number) => worker.getBackoffUntil(userId);
export const clearBackoff = (userId: number) => worker.clearBackoff(userId);
