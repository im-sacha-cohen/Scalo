import { sql, type Kysely } from 'kysely';

// Funnels growth:
// 1. Custom domains (custom_domains): one verified domain serves one funnel on `https://domain/` (Host routing).
// 2. A/B tests of pages: step_variants + steps.ab_* ; the arm shown to a visitor is stored on page_views and on the
//    optin event (variant_id: 0 = original page, NULL = no test running).
// 3. Attribution: first-touch UTM + referrer host on page_views, copied to the optin event and to contacts.source.
// 4. Funnel settings (pixels, cookie banner, legal pages footer) in funnels.settings, share link (hashed token).

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
-- ---------- funnels: settings + share link ----------
ALTER TABLE funnels
  ADD COLUMN settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN share_token_hash text, -- SHA-256 of the random share token (never stored in clear)
  ADD COLUMN share_created_at timestamptz;
CREATE UNIQUE INDEX funnels_share_token_key ON funnels (share_token_hash) WHERE share_token_hash IS NOT NULL;

-- ---------- custom domains ----------
CREATE TABLE custom_domains (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  funnel_id bigint NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  domain text NOT NULL CONSTRAINT custom_domains_domain_check CHECK (domain = lower(domain) AND length(domain) BETWEEN 3 AND 253),
  root_step_id bigint REFERENCES steps(id) ON DELETE SET NULL, -- step served on "/" (NULL = first step)
  verify_token text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CONSTRAINT custom_domains_status_check CHECK (status IN ('pending', 'verified', 'error')),
  verified_at timestamptz,
  last_checked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT custom_domains_domain_key UNIQUE (domain)
);
CREATE INDEX custom_domains_user_idx ON custom_domains (user_id, created_at);
CREATE INDEX custom_domains_funnel_idx ON custom_domains (funnel_id);
CREATE INDEX custom_domains_root_step_idx ON custom_domains (root_step_id);

-- ---------- A/B tests of pages ----------
ALTER TABLE steps
  ADD COLUMN ab_status text NOT NULL DEFAULT 'off' CONSTRAINT steps_ab_status_check CHECK (ab_status IN ('off', 'running', 'paused')),
  ADD COLUMN ab_control_weight smallint NOT NULL DEFAULT 50 CONSTRAINT steps_ab_control_weight_check CHECK (ab_control_weight BETWEEN 0 AND 100),
  ADD COLUMN ab_started_at timestamptz;
CREATE TABLE step_variants (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  step_id bigint NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  name text NOT NULL CONSTRAINT step_variants_name_check CHECK (length(name) BETWEEN 1 AND 120),
  content jsonb NOT NULL,
  weight smallint NOT NULL DEFAULT 50 CONSTRAINT step_variants_weight_check CHECK (weight BETWEEN 0 AND 100),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX step_variants_step_idx ON step_variants (step_id, id);

-- ---------- attribution ----------
ALTER TABLE page_views
  ADD COLUMN variant_id bigint, -- A/B arm (0 = original page, NULL = no test); no FK: stats keep deleted variants apart
  ADD COLUMN utm_source text,
  ADD COLUMN utm_medium text,
  ADD COLUMN utm_campaign text,
  ADD COLUMN utm_content text,
  ADD COLUMN utm_term text,
  ADD COLUMN referrer_host text;
CREATE INDEX page_views_funnel_created_idx ON page_views (funnel_id, created_at);
CREATE INDEX page_views_step_variant_idx ON page_views (step_id, variant_id) WHERE variant_id IS NOT NULL;

ALTER TABLE contact_events
  ADD COLUMN variant_id bigint,
  ADD COLUMN attribution jsonb; -- first-touch {utm_source, utm_medium, utm_campaign, utm_content, utm_term, referrer}
CREATE INDEX contact_events_funnel_created_idx ON contact_events (funnel_id, created_at) WHERE type = 'optin';

ALTER TABLE contacts ADD COLUMN source jsonb; -- first-touch attribution of the first optin (never overwritten)
`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
ALTER TABLE contacts DROP COLUMN IF EXISTS source;
DROP INDEX IF EXISTS contact_events_funnel_created_idx;
ALTER TABLE contact_events DROP COLUMN IF EXISTS variant_id, DROP COLUMN IF EXISTS attribution;
DROP INDEX IF EXISTS page_views_funnel_created_idx, page_views_step_variant_idx;
ALTER TABLE page_views DROP COLUMN IF EXISTS variant_id, DROP COLUMN IF EXISTS utm_source, DROP COLUMN IF EXISTS utm_medium,
  DROP COLUMN IF EXISTS utm_campaign, DROP COLUMN IF EXISTS utm_content, DROP COLUMN IF EXISTS utm_term, DROP COLUMN IF EXISTS referrer_host;

DROP TABLE IF EXISTS step_variants;
ALTER TABLE steps DROP COLUMN IF EXISTS ab_status, DROP COLUMN IF EXISTS ab_control_weight, DROP COLUMN IF EXISTS ab_started_at;

DROP TABLE IF EXISTS custom_domains;

DROP INDEX IF EXISTS funnels_share_token_key;
ALTER TABLE funnels DROP COLUMN IF EXISTS settings, DROP COLUMN IF EXISTS share_token_hash, DROP COLUMN IF EXISTS share_created_at;
`.execute(db);
}
