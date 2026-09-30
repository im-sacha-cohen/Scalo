import { sql, type Kysely } from 'kysely';

// 1. Removes "Sign in with Google/GitHub" (0002): user_identities, auth_login_codes, auth_link_tickets are dropped and
//    users.password_hash is NOT NULL again. auth_attempts (brute-force counters) is kept.
//    Refuses to run while accounts without a password exist (they could no longer log in).
// 2. The app becomes an OAuth 2.0 authorization server (RFC 6749 authorization code + refresh token, PKCE S256):
//    - oauth_clients: third-party apps registered by a user (secret stored as SHA-256, redirect URIs exact-match list)
//    - oauth_authorization_requests: validated /oauth/authorize requests waiting for the consent screen (10 min)
//    - oauth_codes: single-use authorization codes (SHA-256, 60 s), bound to client + redirect_uri + PKCE + user + scopes
//    - oauth_tokens: opaque access / refresh tokens (SHA-256), one family per authorization (rotation, reuse detection)
//    - oauth_consents: remembered consent per (user, client) = the "connected applications" of a user
// Secrets (client secrets, request ids, codes, tokens) are never stored in clear.

const SCOPES = `ARRAY['profile','contacts:read','contacts:write','tags:write','funnels:read','emails:read','campaigns:write','offline_access']::text[]`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
DO $$
DECLARE n integer;
BEGIN
  SELECT COUNT(*) INTO n FROM users WHERE password_hash IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION USING MESSAGE = format(
      '0004_oauth_provider : %s compte(s) sans mot de passe (créés via la connexion Google/GitHub, supprimée). '
      'Supprimez-les (DELETE FROM users WHERE password_hash IS NULL;) ou recréez la base puis relancez npm run seed.', n);
  END IF;
END $$;

DROP TABLE IF EXISTS auth_link_tickets, auth_login_codes, user_identities;
ALTER TABLE users ALTER COLUMN password_hash SET NOT NULL;

CREATE TABLE oauth_clients (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id text NOT NULL CONSTRAINT oauth_clients_client_id_key UNIQUE,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  website text CHECK (website ~ '^https?://'),
  logo_url text CHECK (logo_url ~ '^https://'),
  type text NOT NULL CHECK (type IN ('confidential', 'public')),
  secret_hash text,
  secret_hint text,
  secret_rotated_at timestamptz,
  redirect_uris text[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 10),
  scopes text[] NOT NULL CHECK (cardinality(scopes) >= 1 AND scopes <@ ${sql.raw(SCOPES)}),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- confidential clients have a secret, public clients (SPA, mobile, CLI) never do
  CONSTRAINT oauth_clients_secret_check CHECK ((type = 'confidential') = (secret_hash IS NOT NULL))
);
CREATE INDEX oauth_clients_user_idx ON oauth_clients (user_id, created_at DESC);

CREATE TABLE oauth_authorization_requests (
  id_hash text PRIMARY KEY,
  client_id bigint NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  scopes text[] NOT NULL CHECK (cardinality(scopes) >= 1),
  state text,
  code_challenge text,
  code_challenge_method text CHECK (code_challenge_method = 'S256'),
  prompt_consent boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((code_challenge IS NULL) = (code_challenge_method IS NULL))
);
CREATE INDEX oauth_authorization_requests_expires_idx ON oauth_authorization_requests (expires_at);
CREATE INDEX oauth_authorization_requests_client_idx ON oauth_authorization_requests (client_id);

CREATE TABLE oauth_codes (
  code_hash text PRIMARY KEY,
  client_id bigint NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  scopes text[] NOT NULL CHECK (cardinality(scopes) >= 1),
  code_challenge text,
  -- tokens issued from this code share this family: replaying the code revokes them
  family_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_codes_expires_idx ON oauth_codes (expires_at);
CREATE INDEX oauth_codes_grant_idx ON oauth_codes (user_id, client_id);
CREATE INDEX oauth_codes_client_idx ON oauth_codes (client_id);

CREATE TABLE oauth_tokens (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash text NOT NULL CONSTRAINT oauth_tokens_hash_key UNIQUE,
  type text NOT NULL CHECK (type IN ('access', 'refresh')),
  family_id uuid NOT NULL,
  -- refresh token this token was issued from (rotation chain)
  parent_id bigint REFERENCES oauth_tokens(id) ON DELETE SET NULL,
  client_id bigint NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes text[] NOT NULL CHECK (cardinality(scopes) >= 1),
  expires_at timestamptz NOT NULL,
  -- refresh tokens: set when exchanged (rotation); presenting it again = reuse → the whole family is revoked
  rotated_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (type = 'refresh' OR rotated_at IS NULL)
);
CREATE INDEX oauth_tokens_family_idx ON oauth_tokens (family_id);
CREATE INDEX oauth_tokens_grant_idx ON oauth_tokens (user_id, client_id);
CREATE INDEX oauth_tokens_client_idx ON oauth_tokens (client_id);
CREATE INDEX oauth_tokens_parent_idx ON oauth_tokens (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX oauth_tokens_expires_idx ON oauth_tokens (expires_at);

CREATE TABLE oauth_consents (
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id bigint NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  scopes text[] NOT NULL CHECK (cardinality(scopes) >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  PRIMARY KEY (user_id, client_id)
);
CREATE INDEX oauth_consents_client_idx ON oauth_consents (client_id);
`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Back to the 0003 state: no authorization server, social-login tables recreated (empty).
  await sql`
DROP TABLE IF EXISTS oauth_consents, oauth_tokens, oauth_codes, oauth_authorization_requests, oauth_clients;

ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

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
`.execute(db);
}
