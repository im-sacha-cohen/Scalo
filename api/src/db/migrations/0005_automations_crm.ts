import { sql, type Kysely } from 'kysely';

// Automations & CRM:
// 1. Custom fields: per-account definitions (`custom_fields`: stable key, label, type, select options) and values on the
//    contact (`contacts.fields jsonb`, validated by the API according to the definition).
// 2. Segments: saved multi-criteria filters (`segments.filter jsonb`, compiled to a parameterized query) and newsletters
//    targeted by segment (`broadcasts.segment_id`, recipients computed when the send starts).
// 3. Automations: rules trigger → conditions (a segment filter) → actions (`automations`), executed asynchronously by the
//    worker (`automation_runs`: one row per execution, next action index, delayed actions, loop protection chain).
// 4. New contact event types: `purchase` (recorded through the API / incoming webhook), `campaign_completed`.
// 5. OAuth scope `purchases:write`.
//
// The contact_events type CHECK and the OAuth scopes CHECK are rebuilt from their *current* values (plus / minus ours)
// so that migrations developed in parallel (applied in any order) never drop each other's values.

const EVENT_TYPES = ['purchase', 'campaign_completed'];
const SCOPES = ['purchases:write'];

// DO blocks cannot take bind parameters: inline the (constant, trusted) arrays as literals.
const lit = (arr: string[]) => sql.raw(`ARRAY[${arr.map((v) => `'${v.replace(/'/g, "''")}'`).join(',')}]::text[]`);
const rebuildEvents = (add: string[], remove: string[]) =>
  sql`
DO $$
DECLARE vals text[];
BEGIN
  SELECT array_agg(DISTINCT v ORDER BY v) INTO vals FROM (
    SELECT (regexp_matches(pg_get_constraintdef(oid), '''([a-z_:]+)''::text', 'g'))[1] AS v
      FROM pg_constraint WHERE conname = 'contact_events_type_check' AND conrelid = 'contact_events'::regclass
    UNION SELECT unnest(${lit(add)})) s
  WHERE v <> ALL (${lit(remove)});
  ALTER TABLE contact_events DROP CONSTRAINT IF EXISTS contact_events_type_check;
  -- ARRAY['a'::text, …] form (like the original constraint) so that the next rebuild can parse it again
  EXECUTE 'ALTER TABLE contact_events ADD CONSTRAINT contact_events_type_check CHECK (type = ANY (ARRAY['
    || (SELECT string_agg(quote_literal(x), ',') FROM unnest(vals) x) || ']::text[]))';
END $$`;
const rebuildOAuthScopes = (add: string[], remove: string[]) =>
  sql`
DO $$
DECLARE vals text[];
BEGIN
  SELECT array_agg(DISTINCT v ORDER BY v) INTO vals FROM (
    SELECT (regexp_matches(pg_get_constraintdef(oid), '''([a-z_:]+)''::text', 'g'))[1] AS v
      FROM pg_constraint WHERE conname = 'oauth_clients_scopes_check' AND conrelid = 'oauth_clients'::regclass
    UNION SELECT unnest(${lit(add)})) s
  WHERE v <> ALL (${lit(remove)});
  ALTER TABLE oauth_clients DROP CONSTRAINT IF EXISTS oauth_clients_scopes_check;
  EXECUTE 'ALTER TABLE oauth_clients ADD CONSTRAINT oauth_clients_scopes_check CHECK (cardinality(scopes) >= 1 AND scopes <@ ARRAY['
    || (SELECT string_agg(quote_literal(x), ',') FROM unnest(vals) x) || ']::text[])';
END $$`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
-- ---------- custom fields ----------
CREATE TABLE custom_fields (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  type text NOT NULL CHECK (type IN ('text', 'number', 'date', 'select', 'checkbox')),
  options text[] NOT NULL DEFAULT '{}' CHECK (cardinality(options) <= 100),
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT custom_fields_user_key UNIQUE (user_id, key)
);

ALTER TABLE contacts ADD COLUMN fields jsonb NOT NULL DEFAULT '{}'::jsonb
  CONSTRAINT contacts_fields_object_check CHECK (jsonb_typeof(fields) = 'object');

-- ---------- segments ----------
CREATE TABLE segments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  filter jsonb NOT NULL CHECK (jsonb_typeof(filter) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX segments_user_name_key ON segments (user_id, lower(name));

ALTER TABLE broadcasts ADD COLUMN segment_id bigint REFERENCES segments(id) ON DELETE SET NULL;
CREATE INDEX broadcasts_segment_idx ON broadcasts (segment_id) WHERE segment_id IS NOT NULL;

-- segment conditions: purchases / optins by funnel, email activity by contact
CREATE INDEX contact_events_contact_type_idx ON contact_events (contact_id, type, created_at DESC);
CREATE INDEX email_sends_contact_activity_idx ON email_sends (contact_id, opened_at, clicked_at) WHERE contact_id IS NOT NULL AND NOT is_test;

-- ---------- automations ----------
CREATE TABLE automations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  enabled boolean NOT NULL DEFAULT false,
  trigger_type text NOT NULL CHECK (trigger_type IN ('optin', 'contact_created', 'tag_added', 'tag_removed', 'link_clicked',
    'purchase', 'campaign_completed', 'webhook')),
  trigger jsonb NOT NULL CHECK (jsonb_typeof(trigger) = 'object' AND trigger->>'type' = trigger_type),
  conditions jsonb CHECK (conditions IS NULL OR jsonb_typeof(conditions) = 'object'),
  actions jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(actions) = 'array' AND jsonb_array_length(actions) <= 20),
  run_once boolean NOT NULL DEFAULT false,
  -- secret part of the incoming webhook URL (trigger 'webhook')
  webhook_token text CONSTRAINT automations_webhook_token_key UNIQUE,
  -- HMAC-SHA256 key of the outgoing webhooks (sent in X-Scalo-Signature)
  signing_secret text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- trigger lookup: enabled rules of an account for one trigger type
CREATE INDEX automations_trigger_idx ON automations (user_id, trigger_type) WHERE enabled;

CREATE TABLE automation_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  automation_id bigint NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  contact_id bigint REFERENCES contacts(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'waiting', 'completed', 'failed', 'skipped')),
  -- index of the next action to execute (advanced in the same transaction as the action: exactly once)
  step integer NOT NULL DEFAULT 0 CHECK (step >= 0),
  -- automations that led to this run (loop protection: an automation never re-triggers itself in its own chain)
  chain bigint[] NOT NULL DEFAULT '{}',
  depth integer NOT NULL DEFAULT 0 CHECK (depth >= 0),
  trigger_data jsonb NOT NULL DEFAULT '{}',
  log jsonb NOT NULL DEFAULT '[]',
  error text,
  resume_at timestamptz,
  claimed_by text,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT automation_runs_resume_check CHECK (status NOT IN ('pending', 'waiting') OR resume_at IS NOT NULL)
);
-- worker: due runs; journal: per automation / per account; run_once: per (automation, contact)
CREATE INDEX automation_runs_due_idx ON automation_runs (resume_at, id) WHERE status IN ('pending', 'waiting');
CREATE INDEX automation_runs_running_idx ON automation_runs (claimed_by) WHERE status = 'running';
CREATE INDEX automation_runs_automation_idx ON automation_runs (automation_id, created_at DESC, id DESC);
CREATE INDEX automation_runs_user_idx ON automation_runs (user_id, created_at DESC, id DESC);
CREATE INDEX automation_runs_contact_idx ON automation_runs (automation_id, contact_id);
`.execute(db);
  await rebuildEvents(EVENT_TYPES, []).execute(db);
  await rebuildOAuthScopes(SCOPES, []).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
DROP TABLE IF EXISTS automation_runs;
DROP TABLE IF EXISTS automations;
DROP INDEX IF EXISTS email_sends_contact_activity_idx, contact_events_contact_type_idx;
ALTER TABLE broadcasts DROP COLUMN IF EXISTS segment_id;
DROP TABLE IF EXISTS segments;
ALTER TABLE contacts DROP COLUMN IF EXISTS fields;
DROP TABLE IF EXISTS custom_fields;
DELETE FROM contact_events WHERE type IN ('purchase', 'campaign_completed');
-- scope removed: applications / grants holding only this scope disappear, the others lose it
DELETE FROM oauth_clients WHERE scopes = ARRAY['purchases:write'];
UPDATE oauth_clients SET scopes = array_remove(scopes, 'purchases:write') WHERE 'purchases:write' = ANY (scopes);
DELETE FROM oauth_tokens WHERE scopes = ARRAY['purchases:write'];
UPDATE oauth_tokens SET scopes = array_remove(scopes, 'purchases:write') WHERE 'purchases:write' = ANY (scopes);
DELETE FROM oauth_codes WHERE scopes = ARRAY['purchases:write'];
UPDATE oauth_codes SET scopes = array_remove(scopes, 'purchases:write') WHERE 'purchases:write' = ANY (scopes);
DELETE FROM oauth_consents WHERE scopes = ARRAY['purchases:write'];
UPDATE oauth_consents SET scopes = array_remove(scopes, 'purchases:write') WHERE 'purchases:write' = ANY (scopes);
`.execute(db);
  await rebuildEvents([], EVENT_TYPES).execute(db);
  await rebuildOAuthScopes([], SCOPES).execute(db);
}
