// Contact import jobs (migration from systeme.io / CSV exports of other tools).
//
// A job is a row of `import_jobs`, processed by the worker in batches:
// - claim: pending → running with `FOR UPDATE SKIP LOCKED` (several API processes never take the same job);
// - each batch runs in ONE transaction that writes the contacts, the counters, the journal AND the progress cursor,
//   guarded by the claim (`WHERE claimed_by = me AND status = 'running'`): a crash replays nothing and loses nothing,
//   a cancellation makes the batch in flight roll back;
// - a job left `running` by a dead instance goes back to `pending` (`recoverImportJobs`) and resumes at its cursor;
// - systeme.io API: one page per batch, the cursor is the id of the last contact; a 429 (or an exhausted quota) puts
//   the job to sleep until `Retry-After` / `X-RateLimit-Refill`;
// - by default nothing is triggered (no campaign, no automation): see services/import-context.ts.
//
// The CSV text and the (encrypted) API key live in the job row only while it is pending / running.
import crypto from 'node:crypto';
import { sql } from 'kysely';
import { isValidFieldValue, type ImportColumnMapping, type ImportJob, type ImportOptions, type ImportPreview, type ImportPreviewContact, type Tag } from '@scalo/shared';
import { db, nowIso, type Db, type ImportJobRow } from '../db';
import { env } from '../env';
import { addTag, flagBounce, getOrCreateTag, logEvent, upsertContact } from './contacts';
import { fieldDefMap, validateFields, type FieldDef } from './fields';
import { withTriggersSuspended } from './import-context';
import { csvRecords, normalizeRecord, parseCsv, sioRecord, type NormalizedContact, type SourceRecord } from './import-sources';
import { listSioContacts, SioError } from './systeme-io';

export const IMPORT_BATCH = 200;
export const SIO_PAGE = 100;
const INSTANCE_STALE_S = 30;
const SLICE_MS = 4000; // time a job keeps the worker before yielding (it is re-claimed at the next tick)
const MAX_JOURNAL = 5000;
const MAX_SOURCE_ATTEMPTS = 6;
export const MAX_ACTIVE_JOBS = 3;

// ---------- secret (API key of the source) ----------

const secretKey = () => crypto.createHash('sha256').update(`scalo-import-secret:${env.JWT_SECRET}`).digest();

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
}

export function decryptSecret(enc: string): string {
  const [iv, tag, ct] = enc.split('.').map((p) => Buffer.from(p, 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', secretKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

// ---------- API shape ----------

const JOB_COLUMNS = [
  'id', 'user_id', 'source', 'status', 'label', 'options', 'total', 'processed', 'created_count', 'updated_count', 'skipped_count',
  'error_count', 'warning_count', 'error', 'note', 'resume_at', 'created_at', 'finished_at',
] as const;
type JobPublicRow = Pick<ImportJobRow, (typeof JOB_COLUMNS)[number]>;

export function toImportJob(r: JobPublicRow): ImportJob {
  const active = r.status === 'pending' || r.status === 'running';
  return {
    id: r.id,
    source: r.source,
    status: r.status,
    label: r.label,
    options: r.options,
    total: r.total,
    processed: r.processed,
    created: r.created_count,
    updated: r.updated_count,
    skipped: r.skipped_count,
    errors: r.error_count,
    warnings: r.warning_count,
    error: r.error,
    note: active ? r.note : null,
    resume_at: active && new Date(r.resume_at).getTime() > Date.now() ? r.resume_at : null,
    created_at: r.created_at,
    finished_at: r.finished_at,
  };
}

export const jobQuery = (userId: number, ex: Db = db) => ex.selectFrom('import_jobs').select(JOB_COLUMNS).where('user_id', '=', userId);

// ---------- preview (dry run) ----------

export async function previewRecords(userId: number, records: SourceRecord[], mapping: ImportColumnMapping[], partial: boolean): Promise<ImportPreview> {
  const out: ImportPreview = {
    partial, total: records.length, valid: 0, invalid: 0, empty: 0, duplicates: 0, existing: 0, unsubscribed: 0, bounced: 0, pending: 0,
    tags: [], new_fields: mapping.filter((m) => m.target === 'field' && m.create).map((m) => m.create!.label), invalid_values: [], sample: [],
  };
  // values a custom field will reject (existing definition, or the field to create)
  const defs = await fieldDefMap(userId);
  for (const m of mapping) {
    if (m.target !== 'field') continue;
    const def = m.field_key ? defs.get(m.field_key) : m.create ? { label: m.create.label, type: m.create.type, options: m.create.options ?? [] } : undefined;
    if (!def || def.type === 'text') continue; // text: cut to 1000 characters, never rejected
    let count = 0;
    const examples: string[] = [];
    for (const rec of records) {
      const raw = rec.values[m.column];
      const v = (Array.isArray(raw) ? raw.join(', ') : raw ?? '').trim();
      if (!v || isValidFieldValue(def.type, v, def.options)) continue;
      count++;
      if (examples.length < 3 && !examples.includes(v.slice(0, 80))) examples.push(v.slice(0, 80));
    }
    if (count) out.invalid_values.push({ column: m.column, field: def.label, count, examples });
  }
  const seen = new Set<string>();
  const tags = new Map<string, string>();
  const valid: NormalizedContact[] = [];
  // fields to create are previewed under their future label
  const previewMapping = mapping.map((m) => (m.target === 'field' && !m.field_key && m.create ? { ...m, field_key: m.create.label } : m));
  for (const rec of records) {
    const n = normalizeRecord(rec, previewMapping);
    if (!n.ok) {
      if (n.reason === 'empty') out.empty++;
      else out.invalid++;
      continue;
    }
    if (seen.has(n.contact.email)) {
      out.duplicates++;
      continue;
    }
    seen.add(n.contact.email);
    out.valid++;
    if (n.contact.status === 'unsubscribed') out.unsubscribed++;
    else if (n.contact.status === 'bounced') out.bounced++;
    else if (n.contact.status === 'pending') out.pending++;
    for (const t of n.contact.tags) if (!tags.has(t.toLowerCase())) tags.set(t.toLowerCase(), t);
    valid.push(n.contact);
  }
  const emails = [...seen];
  const existing = new Set<string>();
  for (let i = 0; i < emails.length; i += 5000) {
    const rows = await db.selectFrom('contacts').select('email').where('user_id', '=', userId).where('email', 'in', emails.slice(i, i + 5000)).execute();
    for (const r of rows) existing.add(r.email);
  }
  out.existing = existing.size;
  out.tags = [...tags.values()].sort((a, b) => a.localeCompare(b, 'fr')).slice(0, 200);
  out.sample = valid.slice(0, 8).map((c): ImportPreviewContact => ({ ...c, exists: existing.has(c.email) }));
  return out;
}

// ---------- processing ----------

interface Counters {
  processed: number;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  warnings: number;
  journal: { line: number; email: string; level: 'error' | 'warning'; message: string }[];
}
const newCounters = (): Counters => ({ processed: 0, created: 0, updated: 0, skipped: 0, errors: 0, warnings: 0, journal: [] });

class ClaimLost extends Error {}

interface RunState {
  job: ImportJobRow;
  instanceId: string;
  defs: Map<string, FieldDef>;
  tagCache: Map<string, Tag>;
  /** Emails already handled by this run (duplicates inside the same batch are cheap to detect; others are plain updates). */
}

async function importOne(st: RunState, c: NormalizedContact, line: number, counters: Counters, trx: Db) {
  const { job } = st;
  const userId = job.user_id;
  const changes = Object.keys(c.fields).length ? validateFields(st.defs, c.fields, true) : null;
  if (changes?.ignored.length) {
    counters.warnings += changes.ignored.length;
    for (const key of changes.ignored) {
      counters.journal.push({ line, email: c.email, level: 'warning', message: `Valeur ignorée pour le champ « ${st.defs.get(key)?.label ?? key} » : « ${c.fields[key].slice(0, 80)} »` });
    }
  }
  const { contact, created } = await upsertContact(
    userId,
    { email: c.email, first_name: c.first_name, last_name: c.last_name, phone: c.phone, fields: changes },
    {
      overwrite: !job.options.keep_existing,
      eventType: 'imported',
      ...(c.created_at ? { created_at: c.created_at } : {}),
      // waiting for a double opt-in in the source: stays unconfirmed here too
      ...(c.status === 'pending' ? { optin: 'pending' as const } : {}),
    },
    trx,
  );
  if (created) counters.created++;
  else counters.updated++;
  // unsubscribed / bounced in the source: they stay so (and an existing contact is never re-subscribed by an import)
  if (c.status === 'unsubscribed' && !contact.unsubscribed) {
    await trx.updateTable('contacts').set({ unsubscribed: true }).where('id', '=', contact.id).execute();
    await logEvent(userId, contact.id, 'unsubscribed', { by: 'import' }, {}, trx);
    if (!created) {
      await trx
        .updateTable('campaign_subscriptions')
        .set({ status: 'unsubscribed', stopped_at: nowIso(), stopped_reason: 'Désinscrit des emails' })
        .where('contact_id', '=', contact.id)
        .where('status', 'in', ['active', 'completed'])
        .execute();
    }
  }
  if (c.status === 'bounced' && !contact.bounced) await flagBounce(userId, contact.id, 'Adresse signalée invalide dans la source importée', trx);
  const names = job.options.tag ? [job.options.tag, ...c.tags] : c.tags;
  for (const name of names) {
    const k = name.trim().toLowerCase();
    if (!k) continue;
    let tag = st.tagCache.get(k);
    if (!tag) {
      tag = await getOrCreateTag(userId, name, trx);
      st.tagCache.set(k, tag);
    }
    await addTag(userId, contact.id, tag, undefined, trx);
  }
}

type Cursor = ImportJobRow['cursor'];

/** Commits the counters, the journal and the cursor of a batch — only if this instance still owns the running job. */
async function commitProgress(st: RunState, counters: Counters, cursor: Cursor, trx: Db) {
  const r = await trx
    .updateTable('import_jobs')
    .set({
      cursor: JSON.stringify(cursor),
      processed: sql`processed + ${counters.processed}`,
      created_count: sql`created_count + ${counters.created}`,
      updated_count: sql`updated_count + ${counters.updated}`,
      skipped_count: sql`skipped_count + ${counters.skipped}`,
      error_count: sql`error_count + ${counters.errors}`,
      warning_count: sql`warning_count + ${counters.warnings}`,
      attempts: 0,
      note: null,
      updated_at: nowIso(),
    })
    .where('id', '=', st.job.id)
    .where('status', '=', 'running')
    .where('claimed_by', '=', st.instanceId)
    .executeTakeFirst();
  if (!Number(r.numUpdatedRows)) throw new ClaimLost();
  if (counters.journal.length) {
    const { n } = await trx.selectFrom('import_job_errors').select((eb) => eb.fn.countAll<number>().as('n')).where('job_id', '=', st.job.id).executeTakeFirstOrThrow();
    const room = Math.max(0, MAX_JOURNAL - n);
    const rows = counters.journal.slice(0, room).map((j) => ({ job_id: st.job.id, ...j, message: j.message.slice(0, 500) }));
    if (rows.length) await trx.insertInto('import_job_errors').values(rows).execute();
  }
}

/**
 * Imports `records` and moves the cursor, atomically. If the batch fails on a database error, it is replayed one
 * record at a time so that a single bad line is journaled instead of blocking the whole import.
 */
async function importBatch(st: RunState, records: SourceRecord[], cursorFor: (index: number) => Cursor): Promise<void> {
  if (!records.length) return;
  const run = (slice: SourceRecord[], cursor: Cursor) =>
    withTriggersSuspended(!st.job.options.trigger, () =>
      db.transaction().execute(async (trx) => {
        const counters = newCounters();
        const inBatch = new Set<string>();
        for (const rec of slice) {
          counters.processed++;
          const n = normalizeRecord(rec, st.job.mapping);
          if (!n.ok) {
            if (n.reason === 'empty') counters.skipped++;
            else {
              counters.errors++;
              counters.journal.push({ line: rec.line, email: n.email, level: 'error', message: n.message });
            }
            continue;
          }
          if (inBatch.has(n.contact.email)) {
            counters.skipped++;
            counters.journal.push({ line: rec.line, email: n.contact.email, level: 'warning', message: 'Doublon dans la source : ligne ignorée' });
            counters.warnings++;
            continue;
          }
          inBatch.add(n.contact.email);
          await importOne(st, n.contact, rec.line, counters, trx);
        }
        await commitProgress(st, counters, cursor, trx);
      }),
    );
  try {
    await run(records, cursorFor(records.length - 1));
  } catch (e) {
    if (e instanceof ClaimLost) throw e;
    st.tagCache.clear(); // tags created by the rolled back transaction no longer exist
    if (records.length === 1) {
      const rec = records[0];
      const n = normalizeRecord(rec, st.job.mapping);
      console.error(`[imports] tâche ${st.job.id}, ligne ${rec.line} :`, e instanceof Error ? e.message : e);
      const counters = newCounters();
      counters.processed = 1;
      counters.errors = 1;
      counters.journal.push({ line: rec.line, email: n.ok ? n.contact.email : n.email, level: 'error', message: 'Ligne rejetée : données refusées par la base' });
      await db.transaction().execute((trx) => commitProgress(st, counters, cursorFor(0), trx));
      return;
    }
    for (let i = 0; i < records.length; i++) await importBatch({ ...st }, [records[i]], () => cursorFor(i));
  }
}

async function finish(job: ImportJobRow, instanceId: string, status: 'completed' | 'failed', error: string | null = null) {
  await db
    .updateTable('import_jobs')
    .set({ status, error, note: null, payload: null, secret_enc: null, claimed_by: null, finished_at: nowIso(), updated_at: nowIso() })
    .where('id', '=', job.id)
    .where('status', '=', 'running')
    .where('claimed_by', '=', instanceId)
    .execute();
}

/** Gives the job back to the queue (time slice used up, or waiting for the source). */
async function release(job: ImportJobRow, instanceId: string, opts: { waitMs?: number; note?: string | null; attempts?: number } = {}) {
  await db
    .updateTable('import_jobs')
    .set({
      status: 'pending',
      claimed_by: null,
      resume_at: new Date(Date.now() + (opts.waitMs ?? 0)).toISOString(),
      note: opts.note ?? null,
      ...(opts.attempts !== undefined ? { attempts: opts.attempts } : {}),
      updated_at: nowIso(),
    })
    .where('id', '=', job.id)
    .where('status', '=', 'running')
    .where('claimed_by', '=', instanceId)
    .execute();
}

const waitNote = (ms: number) => `Limite de débit de systeme.io atteinte : reprise automatique dans ${ms >= 90_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`}`;

export interface ProcessOptions {
  /** Stop (leaving the job `running`) after this many batches: simulates a crash in tests. */
  maxBatches?: number;
  sliceMs?: number;
}

/** Runs a claimed job until it ends, its time slice is used up, or the source asks to wait. */
export async function processImportJob(job: ImportJobRow, instanceId: string, opts: ProcessOptions = {}): Promise<void> {
  const st: RunState = { job, instanceId, defs: await fieldDefMap(job.user_id), tagCache: new Map() };
  const deadline = Date.now() + (opts.sliceMs ?? SLICE_MS);
  let batches = 0;
  const more = () => {
    if (opts.maxBatches !== undefined && batches >= opts.maxBatches) return 'stop' as const;
    return Date.now() < deadline ? ('go' as const) : ('yield' as const);
  };
  try {
    if (job.source === 'csv') {
      if (job.payload === null) return finish(job, instanceId, 'failed', 'Fichier de l’import introuvable');
      const csv = parseCsv(job.payload);
      let row = job.cursor.row ?? 0;
      while (row < csv.rows.length) {
        const m = more();
        if (m === 'stop') return;
        if (m === 'yield') return release(job, instanceId);
        const start = row;
        const records = csvRecords(csv, start, start + IMPORT_BATCH);
        await importBatch(st, records, (i) => ({ row: start + i + 1 }));
        row = start + records.length;
        batches++;
      }
      return finish(job, instanceId, 'completed');
    }

    // systeme.io API
    if (!job.secret_enc) return finish(job, instanceId, 'failed', 'Clé API de la source introuvable');
    const apiKey = decryptSecret(job.secret_enc);
    let after = job.cursor.after ?? null;
    let n = job.cursor.n ?? 0;
    for (;;) {
      const m = more();
      if (m === 'stop') return;
      if (m === 'yield') return release(job, instanceId);
      const page = await listSioContacts(apiKey, { startingAfter: after, limit: SIO_PAGE });
      if (page.items.length) {
        if (!page.lastId || page.lastId === after) return finish(job, instanceId, 'failed', 'Pagination de systeme.io incohérente : import arrêté pour éviter une boucle');
        const base = n;
        const ids = page.items.map((c) => c.id);
        await importBatch(
          st,
          page.items.map((c, i) => sioRecord(c, base + i + 1)),
          (i) => ({ after: ids[i] || page.lastId, n: base + i + 1 }),
        );
        after = page.lastId;
        n += page.items.length;
      }
      batches++;
      if (!page.hasMore || !page.items.length) return finish(job, instanceId, 'completed');
      if (page.waitMs) return release(job, instanceId, { waitMs: page.waitMs, note: waitNote(page.waitMs) });
    }
  } catch (e) {
    if (e instanceof ClaimLost) return; // cancelled, or taken over after a recovery
    if (e instanceof SioError) {
      if (e.kind === 'rate_limit') return release(job, instanceId, { waitMs: e.retryAfterMs ?? 10_000, note: waitNote(e.retryAfterMs ?? 10_000) });
      if (e.kind === 'auth') return finish(job, instanceId, 'failed', e.message);
      // network error / 5xx / unreadable answer: retried with a growing delay, then the job fails (progress is kept)
      const attempts = job.attempts + 1;
      if ((e.kind === 'http' && e.status !== null && e.status < 500) || attempts >= MAX_SOURCE_ATTEMPTS) return finish(job, instanceId, 'failed', e.message);
      return release(job, instanceId, { waitMs: e.retryAfterMs ?? Math.min(300_000, 5000 * 2 ** (attempts - 1)), note: `${e.message} — nouvel essai automatique`, attempts });
    }
    console.error(`[imports] tâche ${job.id} :`, e instanceof Error ? e.message : e);
    return finish(job, instanceId, 'failed', 'Erreur inattendue pendant l’import');
  }
}

/** Atomically claims due jobs. */
export async function claimImportJobs(instanceId: string, limit = 2, ex: Db = db): Promise<ImportJobRow[]> {
  return ex
    .updateTable('import_jobs')
    .set({ status: 'running', claimed_by: instanceId, claimed_at: nowIso(), updated_at: nowIso() })
    .where(
      'id',
      'in',
      ex
        .selectFrom('import_jobs')
        .select('id')
        .where('status', '=', 'pending')
        .where('resume_at', '<=', sql<string>`now()`)
        .orderBy('resume_at')
        .orderBy('id')
        .limit(limit)
        .forUpdate()
        .skipLocked(),
    )
    .returningAll()
    .execute();
}

let busy = false;
/** Worker tick: processes the due import jobs (one slice each). */
export async function runImportJobs(instanceId: string): Promise<number> {
  if (busy) return 0;
  busy = true;
  try {
    const jobs = await claimImportJobs(instanceId);
    await Promise.all(jobs.map((j) => processImportJob(j, instanceId)));
    return jobs.length;
  } finally {
    busy = false;
  }
}

/** Jobs left `running` by an instance that is gone resume at their cursor (nothing is replayed). */
export async function recoverImportJobs(ex: Db = db): Promise<number> {
  const r = await ex
    .updateTable('import_jobs')
    .set({ status: 'pending', claimed_by: null, resume_at: sql`now()`, updated_at: nowIso() })
    .where('status', '=', 'running')
    .where(
      sql<boolean>`(import_jobs.claimed_by IS NULL OR NOT EXISTS (
        SELECT 1 FROM worker_instances w WHERE w.id = import_jobs.claimed_by
           AND w.heartbeat_at > now() - make_interval(secs => ${INSTANCE_STALE_S})))`,
    )
    .executeTakeFirst();
  const n = Number(r.numUpdatedRows);
  if (n) console.log(`[imports] ${n} import(s) interrompu(s) repris`);
  return n;
}

/** Cancels a pending / running job: the batch in flight rolls back, what was already imported stays. */
export async function cancelImportJob(userId: number, id: number): Promise<boolean> {
  const r = await db
    .updateTable('import_jobs')
    .set({ status: 'cancelled', payload: null, secret_enc: null, claimed_by: null, note: null, finished_at: nowIso(), updated_at: nowIso() })
    .where('id', '=', id)
    .where('user_id', '=', userId)
    .where('status', 'in', ['pending', 'running'])
    .executeTakeFirst();
  return Number(r.numUpdatedRows) > 0;
}

export interface NewImportJob {
  source: ImportJobRow['source'];
  label: string;
  options: ImportOptions;
  mapping: ImportColumnMapping[];
  payload?: string | null;
  apiKey?: string | null;
  total: number | null;
}

export async function createImportJob(userId: number, j: NewImportJob, ex: Db = db): Promise<ImportJobRow> {
  return ex
    .insertInto('import_jobs')
    .values({
      user_id: userId,
      source: j.source,
      label: j.label.slice(0, 200),
      options: JSON.stringify(j.options),
      mapping: JSON.stringify(j.mapping),
      payload: j.payload ?? null,
      secret_enc: j.apiKey ? encryptSecret(j.apiKey) : null,
      total: j.total,
      resume_at: nowIso(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}
