import { sql, type Kysely } from 'kysely';

// OAuth sign-in (Google, GitHub…) + DB-backed brute-force protection.
// - users.password_hash becomes nullable: accounts created through a provider have no password.
// - user_identities: one row per (user, provider); a provider account belongs to at most one user.
// - auth_login_codes / auth_link_tickets: one-time secrets, stored as SHA-256 hashes, short TTL, single use.
// - auth_attempts: fixed-window counters shared by every API instance (login, register, code exchange, step passwords).
// To add a provider: extend the CHECK below in a new migration and register it in services/oauth.ts.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
-- marker left by down() for OAuth-only accounts
UPDATE users SET password_hash = NULL WHERE password_hash = '!oauth-only';

CREATE TABLE user_identities (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CONSTRAINT user_identities_provider_check CHECK (provider IN ('google', 'github')),
  provider_user_id text NOT NULL CHECK (provider_user_id <> ''),
  email text NOT NULL CHECK (email = lower(email)),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_identities_provider_uid_key UNIQUE (provider, provider_user_id),
  CONSTRAINT user_identities_user_provider_key UNIQUE (user_id, provider)
);

CREATE TABLE auth_login_codes (
  code_hash text PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  next text NOT NULL DEFAULT '/',
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_login_codes_expires_idx ON auth_login_codes (expires_at);

CREATE TABLE auth_link_tickets (
  ticket_hash text PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_link_tickets_expires_idx ON auth_link_tickets (expires_at);

-- key = '<bucket>:<subject>' (e.g. 'login:email:alice@x.fr', 'login:ip:1.2.3.4', 'step:12:1.2.3.4')
CREATE TABLE auth_attempts (
  key text PRIMARY KEY,
  count integer NOT NULL DEFAULT 0,
  window_start timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_attempts_window_idx ON auth_attempts (window_start);
`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
DROP TABLE IF EXISTS auth_attempts, auth_link_tickets, auth_login_codes, user_identities CASCADE;
-- accounts created through a provider have no password: they cannot log in without OAuth, give them an unusable hash
UPDATE users SET password_hash = '!oauth-only' WHERE password_hash IS NULL;
ALTER TABLE users ALTER COLUMN password_hash SET NOT NULL;
`.execute(db);
}
