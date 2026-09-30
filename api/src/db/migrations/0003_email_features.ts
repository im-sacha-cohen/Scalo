import { sql, type Kysely } from 'kysely';

// Email features:
// 1. Scheduled newsletters: broadcasts.status 'scheduled' + scheduled_at (recipients computed when the send starts).
// 2. Double opt-in: contacts.confirmed_at (NULL = waiting for confirmation; existing contacts count as confirmed),
//    pending_optins (hashed one-time token, 7 days, the actions to apply on confirmation), send kind 'confirmation'.
// 3. Advanced campaigns: per-email condition (jsonb), campaign stop tag, subscription status, 'skipped' sends,
//    "never the same campaign email twice" (partial unique index), A/B subject test on newsletters (variant per send).
// 4. Complaints & bounces from provider webhooks (per-account secret), complaint flag, message id, Feedback-ID;
//    user-configurable DKIM selectors for the DNS check.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
-- ---------- settings ----------
ALTER TABLE settings
  ADD COLUMN double_optin_default boolean NOT NULL DEFAULT false,
  ADD COLUMN webhook_secret text,
  ADD COLUMN dkim_selectors text NOT NULL DEFAULT '';
CREATE UNIQUE INDEX settings_webhook_secret_key ON settings (webhook_secret) WHERE webhook_secret IS NOT NULL;

-- ---------- contacts ----------
ALTER TABLE contacts
  ADD COLUMN confirmed_at timestamptz,
  ADD COLUMN confirmation_sent_at timestamptz,
  ADD COLUMN complained boolean NOT NULL DEFAULT false;
-- existing contacts are confirmed (single opt-in so far); new ones too, unless created by a double opt-in form
UPDATE contacts SET confirmed_at = created_at;
ALTER TABLE contacts ALTER COLUMN confirmed_at SET DEFAULT now();
CREATE INDEX contacts_pending_idx ON contacts (user_id, created_at DESC) WHERE confirmed_at IS NULL;

ALTER TABLE contact_events DROP CONSTRAINT contact_events_type_check;
ALTER TABLE contact_events ADD CONSTRAINT contact_events_type_check CHECK (type IN ('created', 'imported', 'optin', 'tag_added',
  'tag_removed', 'campaign_enrolled', 'email_sent', 'email_opened', 'email_clicked', 'unsubscribed', 'bounced',
  'optin_confirmed', 'confirmation_sent', 'spam_complaint', 'campaign_left'));

-- ---------- broadcasts: scheduling + A/B subject test ----------
ALTER TABLE broadcasts DROP CONSTRAINT broadcasts_status_check;
ALTER TABLE broadcasts DROP CONSTRAINT broadcasts_sent_at_check;
ALTER TABLE broadcasts
  ADD COLUMN scheduled_at timestamptz,
  ADD COLUMN ab_test jsonb,
  ADD COLUMN ab_phase text CONSTRAINT broadcasts_ab_phase_check CHECK (ab_phase IN ('testing', 'done')),
  ADD COLUMN ab_winner smallint,
  ADD COLUMN ab_decide_at timestamptz,
  ADD CONSTRAINT broadcasts_status_check CHECK (status IN ('draft', 'scheduled', 'sent')),
  ADD CONSTRAINT broadcasts_sent_at_check CHECK (status <> 'sent' OR sent_at IS NOT NULL),
  ADD CONSTRAINT broadcasts_scheduled_at_check CHECK (status <> 'scheduled' OR scheduled_at IS NOT NULL);
-- scheduler: due scheduled newsletters, A/B tests waiting for their winner
CREATE INDEX broadcasts_scheduled_idx ON broadcasts (scheduled_at) WHERE status = 'scheduled';
CREATE INDEX broadcasts_ab_idx ON broadcasts (ab_decide_at) WHERE ab_phase = 'testing';

-- ---------- campaigns ----------
ALTER TABLE campaigns ADD COLUMN stop_tag_id bigint REFERENCES tags(id) ON DELETE SET NULL;
CREATE INDEX campaigns_stop_tag_idx ON campaigns (stop_tag_id);
ALTER TABLE campaign_emails ADD COLUMN condition jsonb;
ALTER TABLE campaign_subscriptions
  ADD COLUMN status text NOT NULL DEFAULT 'active'
    CONSTRAINT campaign_subscriptions_status_check CHECK (status IN ('active', 'completed', 'stopped', 'unsubscribed')),
  ADD COLUMN stopped_at timestamptz,
  ADD COLUMN stopped_reason text;
CREATE INDEX campaign_subscriptions_list_idx ON campaign_subscriptions (campaign_id, created_at DESC, id DESC);

-- ---------- email_sends ----------
ALTER TABLE email_sends
  ADD COLUMN kind text NOT NULL DEFAULT 'broadcast'
    CONSTRAINT email_sends_kind_check CHECK (kind IN ('broadcast', 'campaign', 'test', 'confirmation')),
  ADD COLUMN variant smallint,
  ADD COLUMN message_id text,
  ADD COLUMN complained_at timestamptz;
UPDATE email_sends SET kind = CASE
  WHEN is_test THEN 'test'
  WHEN broadcast_id IS NULL AND (campaign_id IS NOT NULL OR campaign_email_id IS NOT NULL) THEN 'campaign'
  ELSE 'broadcast' END;
ALTER TABLE email_sends DROP CONSTRAINT email_sends_status_check;
ALTER TABLE email_sends ADD CONSTRAINT email_sends_status_check CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped'));
-- a contact never gets the same campaign email / newsletter twice (backfill, A/B final phase, concurrent schedulers)
CREATE UNIQUE INDEX email_sends_campaign_email_contact_key ON email_sends (campaign_email_id, contact_id)
  WHERE NOT is_test AND campaign_email_id IS NOT NULL AND contact_id IS NOT NULL;
CREATE UNIQUE INDEX email_sends_broadcast_contact_key ON email_sends (broadcast_id, contact_id)
  WHERE NOT is_test AND broadcast_id IS NOT NULL AND contact_id IS NOT NULL;
-- webhooks: find the send of a provider message id
CREATE INDEX email_sends_message_id_idx ON email_sends (message_id) WHERE message_id IS NOT NULL;
-- ordered campaign progress of a contact
CREATE INDEX email_sends_campaign_contact_idx ON email_sends (campaign_id, contact_id) WHERE campaign_id IS NOT NULL;

-- ---------- double opt-in ----------
CREATE TABLE pending_optins (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id bigint NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  token_hash text NOT NULL, -- SHA-256 of the random token sent by email (never stored in clear)
  tag_name text,
  campaign_id bigint REFERENCES campaigns(id) ON DELETE SET NULL,
  funnel_id bigint REFERENCES funnels(id) ON DELETE SET NULL,
  step_id bigint REFERENCES steps(id) ON DELETE SET NULL,
  redirect_url text,
  send_id bigint REFERENCES email_sends(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pending_optins_token_key UNIQUE (token_hash)
);
CREATE INDEX pending_optins_contact_idx ON pending_optins (contact_id, created_at DESC);
`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
DROP TABLE IF EXISTS pending_optins;

DROP INDEX IF EXISTS email_sends_campaign_contact_idx, email_sends_message_id_idx, email_sends_broadcast_contact_key,
  email_sends_campaign_email_contact_key;
UPDATE email_sends SET status = 'failed', error = COALESCE(error, 'Ignoré') WHERE status = 'skipped';
DELETE FROM email_sends WHERE kind = 'confirmation' AND status IN ('pending', 'sending');
ALTER TABLE email_sends DROP CONSTRAINT email_sends_status_check;
ALTER TABLE email_sends ADD CONSTRAINT email_sends_status_check CHECK (status IN ('pending', 'sending', 'sent', 'failed'));
ALTER TABLE email_sends DROP COLUMN kind, DROP COLUMN variant, DROP COLUMN message_id, DROP COLUMN complained_at;

DROP INDEX IF EXISTS campaign_subscriptions_list_idx;
-- stopped / unsubscribed subscriptions: their pending sends were already cancelled
ALTER TABLE campaign_subscriptions DROP COLUMN status, DROP COLUMN stopped_at, DROP COLUMN stopped_reason;
ALTER TABLE campaign_emails DROP COLUMN condition;
DROP INDEX IF EXISTS campaigns_stop_tag_idx;
ALTER TABLE campaigns DROP COLUMN stop_tag_id;

DROP INDEX IF EXISTS broadcasts_scheduled_idx, broadcasts_ab_idx;
UPDATE broadcasts SET status = 'draft' WHERE status = 'scheduled';
ALTER TABLE broadcasts DROP CONSTRAINT broadcasts_status_check, DROP CONSTRAINT broadcasts_sent_at_check,
  DROP CONSTRAINT broadcasts_scheduled_at_check;
ALTER TABLE broadcasts DROP COLUMN scheduled_at, DROP COLUMN ab_test, DROP COLUMN ab_phase, DROP COLUMN ab_winner, DROP COLUMN ab_decide_at;
ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_status_check CHECK (status IN ('draft', 'sent')),
  ADD CONSTRAINT broadcasts_sent_at_check CHECK (status = 'draft' OR sent_at IS NOT NULL);

DELETE FROM contact_events WHERE type IN ('optin_confirmed', 'confirmation_sent', 'spam_complaint', 'campaign_left');
ALTER TABLE contact_events DROP CONSTRAINT contact_events_type_check;
ALTER TABLE contact_events ADD CONSTRAINT contact_events_type_check CHECK (type IN ('created', 'imported', 'optin', 'tag_added',
  'tag_removed', 'campaign_enrolled', 'email_sent', 'email_opened', 'email_clicked', 'unsubscribed', 'bounced'));
DROP INDEX IF EXISTS contacts_pending_idx;
ALTER TABLE contacts DROP COLUMN confirmed_at, DROP COLUMN confirmation_sent_at, DROP COLUMN complained;

DROP INDEX IF EXISTS settings_webhook_secret_key;
ALTER TABLE settings DROP COLUMN double_optin_default, DROP COLUMN webhook_secret, DROP COLUMN dkim_selectors;
`.execute(db);
}
