import { sql, type Kysely } from 'kysely';

// Native AI (Claude API, "bring your own key"):
// 1. ai_settings: per-account Anthropic API key, encrypted at rest (AES-256-GCM, see services/secretbox.ts). Only the
//    last 4 characters are kept in clear (hint shown in the settings).
// 2. ai_generations: one row per AI call — state of the asynchronous generations (funnel, campaign, newsletter) polled
//    by the app, and usage log (tokens) shown in Settings → IA.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
CREATE TABLE ai_settings (
  user_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  api_key_enc text NOT NULL,
  key_hint text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_generations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CONSTRAINT ai_generations_kind_check CHECK (kind IN ('funnel', 'campaign', 'newsletter', 'rewrite', 'subjects')),
  status text NOT NULL DEFAULT 'running' CONSTRAINT ai_generations_status_check CHECK (status IN ('running', 'done', 'failed')),
  label text NOT NULL DEFAULT '',
  result jsonb,           -- what was created: { funnel_id } / { campaign_id } / { broadcast_id }
  error text,             -- readable message (French) when failed
  model text,
  key_source text NOT NULL DEFAULT 'account' CONSTRAINT ai_generations_key_source_check CHECK (key_source IN ('account', 'instance')),
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX ai_generations_user_idx ON ai_generations (user_id, created_at DESC, id DESC);
`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
DROP TABLE IF EXISTS ai_generations;
DROP TABLE IF EXISTS ai_settings;
`.execute(db);
}
