import { sql, type Kysely } from 'kysely';

// Contact imports (migration from systeme.io and other tools):
// 1. import_jobs: one row per import, processed in batches by the worker (claim with FOR UPDATE SKIP LOCKED, progress
//    and cursor committed with each batch → resumable after a crash, cancellable). `payload` holds the CSV text and
//    `secret_enc` the encrypted API key of the source; both are erased as soon as the job ends.
// 2. import_job_errors: downloadable journal (rejected lines, ignored values).

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
CREATE TABLE import_jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('csv', 'systeme_io')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  label text NOT NULL DEFAULT '' CHECK (char_length(label) <= 200),
  options jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(options) = 'object'),
  mapping jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(mapping) = 'array'),
  -- CSV text (source 'csv'); erased when the job ends
  payload text,
  -- AES-256-GCM encrypted API key (source 'systeme_io'); erased when the job ends
  secret_enc text,
  -- progress marker committed with each batch: {"row": n} (csv) or {"after": id, "n": count} (API)
  cursor jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(cursor) = 'object'),
  total integer CHECK (total IS NULL OR total >= 0),
  processed integer NOT NULL DEFAULT 0,
  created_count integer NOT NULL DEFAULT 0,
  updated_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  warning_count integer NOT NULL DEFAULT 0,
  -- consecutive failed calls to the source (network, 5xx); reset by a successful page
  attempts integer NOT NULL DEFAULT 0,
  error text,
  -- human-readable note while waiting (rate limit of the source…)
  note text,
  resume_at timestamptz NOT NULL DEFAULT now(),
  claimed_by text,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT import_jobs_secrets_erased_check CHECK (status IN ('pending', 'running') OR (payload IS NULL AND secret_enc IS NULL))
);
CREATE INDEX import_jobs_user_idx ON import_jobs (user_id, id DESC);
-- worker queue
CREATE INDEX import_jobs_queue_idx ON import_jobs (resume_at, id) WHERE status = 'pending';
CREATE INDEX import_jobs_running_idx ON import_jobs (claimed_by) WHERE status = 'running';

CREATE TABLE import_job_errors (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id bigint NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  line integer NOT NULL,
  email text NOT NULL DEFAULT '',
  level text NOT NULL DEFAULT 'error' CHECK (level IN ('error', 'warning')),
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX import_job_errors_job_idx ON import_job_errors (job_id, id);
`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
DROP TABLE IF EXISTS import_job_errors;
DROP TABLE IF EXISTS import_jobs;
`.execute(db);
}
