import { sql, type Kysely } from 'kysely';

// Enterprise edition (team & roles, audit log, white label, license key).
// The tables live in the core migrations (one schema for every edition); the code that uses them is in `ee/`
// (commercial license). In the community edition they simply stay empty.
//
// 1. Team: a member is a regular `users` row (own email / password) attached to ONE account (`account_members`);
//    he acts on behalf of that account with a role. Invitations carry a hashed one-time token.
// 2. Audit log: who did what (actor, action, resource, IP, date) on the API mutations of an account.
// 3. Per-account Enterprise settings: white label (mention of public pages / emails, admin name & logo), audit retention.
// 4. Instance license key entered from the interface (single row; SCALO_LICENSE_KEY wins when set).

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
-- ---------- team ----------
CREATE TABLE account_members (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CONSTRAINT account_members_role_check CHECK (role IN ('admin', 'editor', 'viewer')),
  invited_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_members_user_key UNIQUE (user_id),
  CONSTRAINT account_members_not_self_check CHECK (account_id <> user_id)
);
CREATE INDEX account_members_account_idx ON account_members (account_id, id);

CREATE TABLE account_invitations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email text NOT NULL CONSTRAINT account_invitations_email_check CHECK (email = lower(email)),
  role text NOT NULL CONSTRAINT account_invitations_role_check CHECK (role IN ('admin', 'editor', 'viewer')),
  token_hash text NOT NULL CONSTRAINT account_invitations_token_hash_key UNIQUE,
  invited_by bigint REFERENCES users(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- one pending invitation per (account, email)
CREATE UNIQUE INDEX account_invitations_pending_key ON account_invitations (account_id, email) WHERE accepted_at IS NULL;
CREATE INDEX account_invitations_account_idx ON account_invitations (account_id, id DESC);

-- ---------- audit log ----------
CREATE TABLE audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id bigint REFERENCES users(id) ON DELETE SET NULL,
  actor_email text NOT NULL DEFAULT '',
  actor_role text NOT NULL DEFAULT 'owner',
  action text NOT NULL,
  method text NOT NULL,
  path text NOT NULL,
  resource_type text NOT NULL DEFAULT '',
  resource_id text,
  status integer NOT NULL,
  ip text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_account_idx ON audit_logs (account_id, id DESC);
CREATE INDEX audit_logs_retention_idx ON audit_logs (created_at);

-- ---------- per-account Enterprise settings ----------
CREATE TABLE account_ee_settings (
  account_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  hide_powered_by boolean NOT NULL DEFAULT false,
  powered_by_text text NOT NULL DEFAULT '' CONSTRAINT account_ee_settings_powered_by_text_check CHECK (char_length(powered_by_text) <= 80),
  powered_by_url text NOT NULL DEFAULT '' CONSTRAINT account_ee_settings_powered_by_url_check CHECK (powered_by_url = '' OR powered_by_url ~ '^https?://'),
  app_name text NOT NULL DEFAULT '' CONSTRAINT account_ee_settings_app_name_check CHECK (char_length(app_name) <= 40),
  logo_url text NOT NULL DEFAULT '' CONSTRAINT account_ee_settings_logo_url_check CHECK (logo_url = '' OR logo_url ~ '^(https://|/uploads/)'),
  audit_retention_days integer NOT NULL DEFAULT 365 CONSTRAINT account_ee_settings_retention_check CHECK (audit_retention_days BETWEEN 1 AND 3650),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- instance license (single row) ----------
CREATE TABLE instance_license (
  id boolean PRIMARY KEY DEFAULT true CONSTRAINT instance_license_single_row_check CHECK (id),
  license_key text NOT NULL,
  updated_by bigint REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`.execute(db);
}

// Team members stay in `users` as ordinary (empty) accounts: their login keeps working, on their own account.
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
DROP TABLE IF EXISTS instance_license;
DROP TABLE IF EXISTS account_ee_settings;
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS account_invitations;
DROP TABLE IF EXISTS account_members;
`.execute(db);
}
