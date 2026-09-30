import { sql, type Kysely } from 'kysely';

// Payments (Stripe, "bring your own account"):
// 1. payment_settings: the account's Stripe keys (secret key and webhook signing secret stored encrypted — AES-256-GCM,
//    see services/secretbox.ts — with a 4-character hint), and the secret token of its webhook URL.
// 2. products / product_prices: what is sold (one-time, subscription, installments), the tag / campaign given on purchase.
// 3. orders / order_items / order_transactions: one order per checkout (or one-click upsell), a snapshot of what was
//    bought, and every payment / refund collected for it (subscriptions: one payment per paid invoice).
// 4. stripe_events: processed webhook events (idempotency).
// 5. Send kind `order` (confirmation email of an order) and OAuth scope `sales:read`.
//
// CHECK constraints shared with other features (email_sends.kind, oauth_clients.scopes) are rebuilt from their *current*
// values (plus / minus ours) so that migrations developed in parallel apply in any order.

const SEND_KINDS = ['order'];
const SCOPES = ['sales:read'];

// DO blocks cannot take bind parameters: inline the (constant, trusted) arrays as literals.
const lit = (arr: string[]) => sql.raw(`ARRAY[${arr.map((v) => `'${v.replace(/'/g, "''")}'`).join(',')}]::text[]`);
const rebuildSendKinds = (add: string[], remove: string[]) =>
  sql`
DO $$
DECLARE vals text[];
BEGIN
  SELECT array_agg(DISTINCT v ORDER BY v) INTO vals FROM (
    SELECT (regexp_matches(pg_get_constraintdef(oid), '''([a-z_:]+)''::text', 'g'))[1] AS v
      FROM pg_constraint WHERE conname = 'email_sends_kind_check' AND conrelid = 'email_sends'::regclass
    UNION SELECT unnest(${lit(add)})) s
  WHERE v <> ALL (${lit(remove)});
  ALTER TABLE email_sends DROP CONSTRAINT IF EXISTS email_sends_kind_check;
  -- ARRAY['a'::text, …] form (like the original constraint) so that the next rebuild can parse it again
  EXECUTE 'ALTER TABLE email_sends ADD CONSTRAINT email_sends_kind_check CHECK (kind = ANY (ARRAY['
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
-- ---------- Stripe connection of the account ----------
CREATE TABLE payment_settings (
  user_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stripe_secret_key text,      -- encrypted (never returned by the API)
  stripe_secret_hint text,     -- last 4 characters
  stripe_publishable_key text,
  stripe_webhook_secret text,  -- encrypted
  stripe_webhook_hint text,
  mode text CONSTRAINT payment_settings_mode_check CHECK (mode IN ('test', 'live')),
  webhook_token text NOT NULL, -- secret part of the webhook URL (identifies the account; events are verified by signature)
  account_name text,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_settings_webhook_token_key UNIQUE (webhook_token)
);

-- ---------- products & offers ----------
CREATE TABLE products (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '',
  image_url text,
  tag_id bigint REFERENCES tags(id) ON DELETE SET NULL,           -- given to the buyer when the order is paid
  campaign_id bigint REFERENCES campaigns(id) ON DELETE SET NULL, -- buyer enrolled when the order is paid
  revoke_on_refund boolean NOT NULL DEFAULT true,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX products_user_idx ON products (user_id, created_at DESC, id DESC);
CREATE INDEX products_tag_idx ON products (tag_id);
CREATE INDEX products_campaign_idx ON products (campaign_id);

CREATE TABLE product_prices (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id bigint NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT '',
  type text NOT NULL CHECK (type IN ('one_time', 'subscription', 'installments')),
  amount integer NOT NULL CHECK (amount BETWEEN 50 AND 99999999), -- minor units (cents)
  currency text NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  "interval" text CHECK ("interval" IN ('month', 'year')),
  installments integer CHECK (installments BETWEEN 2 AND 36),
  tax_rate numeric(5,2) NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 100),
  tax_inclusive boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_prices_shape_check CHECK (
    (type = 'one_time' AND "interval" IS NULL AND installments IS NULL)
    OR (type = 'subscription' AND "interval" IS NOT NULL AND installments IS NULL)
    OR (type = 'installments' AND "interval" = 'month' AND installments IS NOT NULL))
);
CREATE INDEX product_prices_product_idx ON product_prices (product_id, id);
CREATE INDEX product_prices_user_idx ON product_prices (user_id);

-- ---------- orders ----------
CREATE TABLE orders (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id bigint REFERENCES contacts(id) ON DELETE SET NULL,
  email text NOT NULL CHECK (email = lower(email)),
  first_name text,
  last_name text,
  funnel_id bigint REFERENCES funnels(id) ON DELETE SET NULL,
  step_id bigint REFERENCES steps(id) ON DELETE SET NULL,
  variant_id integer,                                              -- A/B arm of the step (0 = original)
  parent_order_id bigint REFERENCES orders(id) ON DELETE SET NULL, -- one-click upsell: the order it follows
  kind text NOT NULL DEFAULT 'checkout' CHECK (kind IN ('checkout', 'upsell')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'refunded', 'canceled')),
  subscription_status text CHECK (subscription_status IN ('active', 'past_due', 'canceled', 'completed')),
  livemode boolean NOT NULL DEFAULT false,
  currency text NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  amount_subtotal integer NOT NULL CHECK (amount_subtotal >= 0),
  amount_tax integer NOT NULL DEFAULT 0 CHECK (amount_tax >= 0),
  amount_total integer NOT NULL CHECK (amount_total >= 0),
  amount_paid integer NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  amount_refunded integer NOT NULL DEFAULT 0 CHECK (amount_refunded >= 0),
  stripe_session_id text,
  stripe_payment_intent_id text,
  stripe_customer_id text,
  stripe_payment_method_id text,
  stripe_subscription_id text,
  attribution jsonb,                          -- first-touch UTM + referrer of the visitor (services/attribution.ts)
  visitor jsonb NOT NULL DEFAULT '{}'::jsonb, -- visitor context kept for extensions (visitor id, affiliate cookies…)
  failure_message text,
  paid_at timestamptz,
  refunded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_paid_at_check CHECK (status NOT IN ('paid', 'refunded') OR paid_at IS NOT NULL)
);
CREATE INDEX orders_user_idx ON orders (user_id, created_at DESC, id DESC);
CREATE INDEX orders_user_status_idx ON orders (user_id, status, created_at DESC);
CREATE INDEX orders_contact_idx ON orders (contact_id, created_at DESC);
CREATE INDEX orders_funnel_idx ON orders (funnel_id);
CREATE INDEX orders_step_idx ON orders (step_id);
CREATE INDEX orders_parent_idx ON orders (parent_order_id);
CREATE UNIQUE INDEX orders_stripe_session_key ON orders (stripe_session_id) WHERE stripe_session_id IS NOT NULL;
CREATE INDEX orders_stripe_pi_idx ON orders (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
CREATE INDEX orders_stripe_sub_idx ON orders (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;

CREATE TABLE order_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id bigint REFERENCES products(id) ON DELETE SET NULL,
  price_id bigint REFERENCES product_prices(id) ON DELETE SET NULL,
  kind text NOT NULL DEFAULT 'main' CHECK (kind IN ('main', 'bump', 'upsell')),
  -- snapshot: the order stays readable when the product / offer changes or is deleted
  product_name text NOT NULL,
  price_name text NOT NULL DEFAULT '',
  type text NOT NULL CHECK (type IN ('one_time', 'subscription', 'installments')),
  "interval" text,
  installments integer,
  tax_rate numeric(5,2) NOT NULL DEFAULT 0,
  tax_inclusive boolean NOT NULL DEFAULT true,
  amount_subtotal integer NOT NULL CHECK (amount_subtotal >= 0),
  amount_tax integer NOT NULL DEFAULT 0 CHECK (amount_tax >= 0),
  amount_total integer NOT NULL CHECK (amount_total >= 0),
  tag_id bigint REFERENCES tags(id) ON DELETE SET NULL,
  campaign_id bigint REFERENCES campaigns(id) ON DELETE SET NULL,
  revoke_on_refund boolean NOT NULL DEFAULT true
);
CREATE INDEX order_items_order_idx ON order_items (order_id, id);
CREATE INDEX order_items_product_idx ON order_items (product_id);
CREATE INDEX order_items_price_idx ON order_items (price_id);
CREATE INDEX order_items_tag_idx ON order_items (tag_id);
CREATE INDEX order_items_campaign_idx ON order_items (campaign_id);

-- money actually collected / given back (revenue = payments - refunds)
CREATE TABLE order_transactions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('payment', 'refund')),
  amount integer NOT NULL CHECK (amount >= 0),
  currency text NOT NULL,
  -- payment: payment intent or invoice id; refund: 'refund:<charge or payment intent id>' (cumulative amount)
  stripe_id text NOT NULL,
  stripe_payment_intent_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_transactions_stripe_key UNIQUE (user_id, stripe_id)
);
CREATE INDEX order_transactions_order_idx ON order_transactions (order_id, id);
CREATE INDEX order_transactions_user_idx ON order_transactions (user_id, created_at);
CREATE INDEX order_transactions_pi_idx ON order_transactions (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;

-- ---------- processed webhook events (a replayed event is acknowledged without being applied twice) ----------
CREATE TABLE stripe_events (
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event_id)
);
`.execute(db);
  await rebuildSendKinds(SEND_KINDS, []).execute(db);
  await rebuildOAuthScopes(SCOPES, []).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
DROP TABLE IF EXISTS stripe_events;
DROP TABLE IF EXISTS order_transactions;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS product_prices;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS payment_settings;
DELETE FROM email_sends WHERE kind = 'order';
-- scope removed: applications / grants holding only this scope disappear, the others lose it
DELETE FROM oauth_clients WHERE scopes = ARRAY['sales:read'];
UPDATE oauth_clients SET scopes = array_remove(scopes, 'sales:read') WHERE 'sales:read' = ANY (scopes);
DELETE FROM oauth_tokens WHERE scopes = ARRAY['sales:read'];
UPDATE oauth_tokens SET scopes = array_remove(scopes, 'sales:read') WHERE 'sales:read' = ANY (scopes);
DELETE FROM oauth_codes WHERE scopes = ARRAY['sales:read'];
UPDATE oauth_codes SET scopes = array_remove(scopes, 'sales:read') WHERE 'sales:read' = ANY (scopes);
DELETE FROM oauth_consents WHERE scopes = ARRAY['sales:read'];
UPDATE oauth_consents SET scopes = array_remove(scopes, 'sales:read') WHERE 'sales:read' = ANY (scopes);
`.execute(db);
  await rebuildSendKinds([], SEND_KINDS).execute(db);
  await rebuildOAuthScopes([], SCOPES).execute(db);
}
