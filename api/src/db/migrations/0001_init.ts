import { sql, type Kysely } from 'kysely';

// Initial schema. Rules of thumb:
// - every tenant table carries user_id (directly or through its parent) with ON DELETE CASCADE;
// - enums are CHECK constraints; emails are stored lower-cased (enforced);
// - every hot query has an index (see comments).

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
CREATE TABLE users (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL,
  password_hash text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_key UNIQUE (email),
  CONSTRAINT users_email_lower CHECK (email = lower(email))
);

CREATE TABLE settings (
  user_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  sender_name text NOT NULL DEFAULT '',
  sender_email text NOT NULL DEFAULT '',
  company_address text NOT NULL DEFAULT '',
  smtp_host text NOT NULL DEFAULT '',
  smtp_port integer NOT NULL DEFAULT 587 CHECK (smtp_port BETWEEN 1 AND 65535),
  smtp_user text NOT NULL DEFAULT '',
  smtp_pass text NOT NULL DEFAULT '',
  smtp_secure boolean NOT NULL DEFAULT false,
  rate_per_minute integer NOT NULL DEFAULT 60 CHECK (rate_per_minute >= 1),
  daily_limit integer NOT NULL DEFAULT 0 CHECK (daily_limit >= 0),
  sending_paused boolean NOT NULL DEFAULT false,
  paused_reason text NOT NULL DEFAULT ''
);

CREATE TABLE contacts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email text NOT NULL,
  first_name text,
  last_name text,
  phone text,
  unsubscribed boolean NOT NULL DEFAULT false,
  bounced boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contacts_user_email_key UNIQUE (user_id, email),
  CONSTRAINT contacts_email_lower CHECK (email = lower(email))
);
-- contact list (ORDER BY created_at DESC, id DESC), dashboard counts
CREATE INDEX contacts_user_created_idx ON contacts (user_id, created_at DESC, id DESC);

CREATE TABLE tags (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (btrim(name) <> ''),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- tag names are unique per account, case-insensitively
CREATE UNIQUE INDEX tags_user_name_key ON tags (user_id, lower(name));

CREATE TABLE contact_tags (
  contact_id bigint NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id bigint NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, tag_id)
);
CREATE INDEX contact_tags_tag_idx ON contact_tags (tag_id);

CREATE TABLE funnels (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL CHECK (slug <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT funnels_slug_key UNIQUE (slug)
);
CREATE INDEX funnels_user_idx ON funnels (user_id, created_at DESC);

CREATE TABLE steps (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  funnel_id bigint NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL CHECK (slug <> ''),
  type text NOT NULL CHECK (type IN ('optin', 'sales', 'thankyou', 'custom')),
  position integer NOT NULL DEFAULT 0,
  content jsonb NOT NULL,
  access jsonb NOT NULL DEFAULT '{"mode":"public"}'::jsonb
    CHECK (access->>'mode' IN ('public', 'funnel', 'tag', 'password')),
  password_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT steps_funnel_slug_key UNIQUE (funnel_id, slug)
);
CREATE INDEX steps_funnel_position_idx ON steps (funnel_id, position, id);

CREATE TABLE contact_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id bigint NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('created', 'imported', 'optin', 'tag_added', 'tag_removed', 'campaign_enrolled',
    'email_sent', 'email_opened', 'email_clicked', 'unsubscribed', 'bounced')),
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  funnel_id bigint REFERENCES funnels(id) ON DELETE SET NULL,
  step_id bigint REFERENCES steps(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- contact timeline, "has this contact opted in through funnel X" (step access)
CREATE INDEX contact_events_contact_idx ON contact_events (contact_id, created_at DESC, id DESC);
-- dashboard (optins per day)
CREATE INDEX contact_events_user_type_idx ON contact_events (user_id, type, created_at);
-- per-step / per-funnel optin counts
CREATE INDEX contact_events_step_idx ON contact_events (step_id, type);
CREATE INDEX contact_events_funnel_idx ON contact_events (funnel_id, type);

CREATE TABLE page_views (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  funnel_id bigint NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  step_id bigint NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  visitor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- one view per visitor and step (INSERT … ON CONFLICT DO NOTHING)
  CONSTRAINT page_views_step_visitor_key UNIQUE (step_id, visitor_id)
);
CREATE INDEX page_views_funnel_idx ON page_views (funnel_id);
CREATE INDEX page_views_user_created_idx ON page_views (user_id, created_at);

CREATE TABLE broadcasts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject text NOT NULL,
  content jsonb NOT NULL,
  tag_id bigint REFERENCES tags(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent')),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT broadcasts_sent_at_check CHECK (status = 'draft' OR sent_at IS NOT NULL)
);
CREATE INDEX broadcasts_user_idx ON broadcasts (user_id, created_at DESC);
CREATE INDEX broadcasts_tag_idx ON broadcasts (tag_id);

CREATE TABLE campaigns (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  trigger_tag_id bigint REFERENCES tags(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX campaigns_user_idx ON campaigns (user_id, created_at DESC);
CREATE INDEX campaigns_trigger_idx ON campaigns (trigger_tag_id);

CREATE TABLE campaign_emails (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campaign_id bigint NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  subject text NOT NULL,
  content jsonb NOT NULL,
  delay_days integer NOT NULL DEFAULT 0 CHECK (delay_days >= 0),
  position integer NOT NULL DEFAULT 0
);
CREATE INDEX campaign_emails_campaign_idx ON campaign_emails (campaign_id, position, id);

CREATE TABLE campaign_subscriptions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campaign_id bigint NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id bigint NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaign_subscriptions_key UNIQUE (campaign_id, contact_id)
);
CREATE INDEX campaign_subscriptions_contact_idx ON campaign_subscriptions (contact_id);

CREATE TABLE email_sends (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id bigint REFERENCES contacts(id) ON DELETE CASCADE,
  broadcast_id bigint REFERENCES broadcasts(id) ON DELETE SET NULL,
  campaign_id bigint REFERENCES campaigns(id) ON DELETE SET NULL,
  campaign_email_id bigint REFERENCES campaign_emails(id) ON DELETE SET NULL,
  is_test boolean NOT NULL DEFAULT false,
  to_email text NOT NULL,
  subject text NOT NULL,
  html text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  send_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,
  last_attempt_at timestamptz,
  claimed_by text, -- worker instance that holds a 'sending' row
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- worker: accounts with due sends
CREATE INDEX email_sends_due_idx ON email_sends (status, send_at);
-- worker: claim due sends of one account (FOR UPDATE SKIP LOCKED); queue status
CREATE INDEX email_sends_user_status_idx ON email_sends (user_id, status, send_at);
-- outbox (ORDER BY id DESC)
CREATE INDEX email_sends_user_id_idx ON email_sends (user_id, id DESC);
-- daily limit, dashboard, "sent in the last minute"
CREATE INDEX email_sends_user_sent_idx ON email_sends (user_id, sent_at) WHERE status = 'sent' AND NOT is_test;
CREATE INDEX email_sends_broadcast_idx ON email_sends (broadcast_id);
CREATE INDEX email_sends_campaign_idx ON email_sends (campaign_id);
CREATE INDEX email_sends_campaign_email_idx ON email_sends (campaign_email_id);
CREATE INDEX email_sends_contact_idx ON email_sends (contact_id, status);

CREATE TABLE worker_instances (
  id text PRIMARY KEY,
  hostname text NOT NULL,
  pid integer NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);
`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
DROP TABLE IF EXISTS worker_instances, email_sends, campaign_subscriptions, campaign_emails, campaigns, broadcasts,
  page_views, contact_events, steps, funnels, contact_tags, tags, contacts, settings, users CASCADE;
`.execute(db);
}
