import { sql, type Kysely } from 'kysely';

// Affiliate program (core, AGPL):
// 1. affiliate_programs: one per account — on/off, default commission (percent or fixed), recurring commissions,
//    cookie lifetime, attribution model, validation delay, payout threshold, signup mode, terms, address `/a/<slug>`.
// 2. affiliates: a contact of the account with a readable unique code, a status and an optional personal commission;
//    payout details (IBAN / PayPal…) stored encrypted (services/secretbox.ts).
// 3. affiliate_commission_rules: commission override for a product or one of its offers.
// 4. affiliate_clicks: one row per (affiliate, visitor, day) — no IP, no user agent.
// 5. affiliate_referrals: what an affiliate brought — a lead (optin, statistics only) or a sale (an order).
// 6. affiliate_commissions: ledger. `sale` / `recurring` rows come from order payments (pending → approved after the
//    validation delay → paid by a payout, or cancelled); `clawback` rows are negative and reverse a commission that was
//    already paid out when its order is refunded (the negative balance is carried over to the next payout).
// 7. affiliate_payouts: manual payout register (method + free reference); a payout marks its commissions as paid.
// 8. Contact event types `affiliate_joined`, `affiliate_commission`; automation trigger `affiliate_approved`.
//
// The contact_events type CHECK and the automations trigger CHECK are rebuilt from their *current* values (plus /
// minus ours), so migrations developed in parallel apply in any order (same approach as 0005 / 0008).

const EVENT_TYPES = ['affiliate_joined', 'affiliate_commission'];
const TRIGGER_TYPES = ['affiliate_approved'];

// DO blocks cannot take bind parameters: inline the (constant, trusted) arrays as literals.
const lit = (arr: string[]) => sql.raw(`ARRAY[${arr.map((v) => `'${v.replace(/'/g, "''")}'`).join(',')}]::text[]`);
const rebuildCheck = (table: string, column: string, add: string[], remove: string[]) => {
  const constraint = `${table}_${column}_check`;
  return sql`
DO $$
DECLARE vals text[];
BEGIN
  IF to_regclass(${sql.lit(table)}) IS NULL THEN RETURN; END IF;
  SELECT array_agg(DISTINCT v ORDER BY v) INTO vals FROM (
    SELECT (regexp_matches(pg_get_constraintdef(oid), '''([a-z_:]+)''::text', 'g'))[1] AS v
      FROM pg_constraint WHERE conname = ${sql.lit(constraint)} AND conrelid = ${sql.lit(table)}::regclass
    UNION SELECT unnest(${lit(add)})) s
  WHERE v <> ALL (${lit(remove)});
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', ${sql.lit(table)}, ${sql.lit(constraint)});
  -- ARRAY['a'::text, …] form (like the original constraint) so that the next rebuild can parse it again
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%I = ANY (ARRAY[', ${sql.lit(table)}, ${sql.lit(constraint)}, ${sql.lit(column)})
    || (SELECT string_agg(quote_literal(x), ',') FROM unnest(vals) x) || ']::text[]))';
END $$`;
};

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
-- ---------- program ----------
CREATE TABLE affiliate_programs (
  user_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  -- public address of the affiliate area: /a/<slug> (globally unique)
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,58}[a-z0-9])?$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  -- default commission: percent (0–100, of the amount collected excluding tax) or fixed (minor units, per line sold)
  commission_type text NOT NULL DEFAULT 'percent' CHECK (commission_type IN ('percent', 'fixed')),
  commission_value numeric(12,2) NOT NULL DEFAULT 30 CHECK (commission_value >= 0),
  -- commissions on the later payments of a subscription (optionally only during N months after the order)
  recurring boolean NOT NULL DEFAULT true,
  recurring_months integer CHECK (recurring_months IS NULL OR recurring_months BETWEEN 1 AND 120),
  cookie_days integer NOT NULL DEFAULT 30 CHECK (cookie_days BETWEEN 1 AND 365),
  attribution text NOT NULL DEFAULT 'last_click' CHECK (attribution IN ('last_click', 'first_click')),
  -- days before a pending commission becomes payable (covers refunds)
  validation_days integer NOT NULL DEFAULT 30 CHECK (validation_days BETWEEN 0 AND 365),
  -- minimum payable balance (minor units) before a payout can be created
  min_payout integer NOT NULL DEFAULT 0 CHECK (min_payout >= 0),
  -- open: anybody who confirms his email is approved; approval: the account validates each affiliate
  signup_mode text NOT NULL DEFAULT 'approval' CHECK (signup_mode IN ('open', 'approval')),
  terms text NOT NULL DEFAULT '' CHECK (char_length(terms) <= 20000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT affiliate_programs_slug_key UNIQUE (slug),
  CONSTRAINT affiliate_programs_percent_check CHECK (commission_type <> 'percent' OR commission_value <= 100)
);

-- ---------- affiliates ----------
CREATE TABLE affiliates (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id bigint NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'suspended')),
  -- personal commission (NULL = the program's)
  commission_type text CHECK (commission_type IN ('percent', 'fixed')),
  commission_value numeric(12,2) CHECK (commission_value >= 0),
  -- free text (IBAN, PayPal…), AES-256-GCM (services/secretbox.ts): only the account admin and the affiliate read it
  payout_details_enc text,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT affiliates_user_contact_key UNIQUE (user_id, contact_id),
  CONSTRAINT affiliates_user_code_key UNIQUE (user_id, code),
  CONSTRAINT affiliates_commission_check CHECK ((commission_type IS NULL) = (commission_value IS NULL)
    AND (commission_type IS DISTINCT FROM 'percent' OR commission_value <= 100))
);
CREATE INDEX affiliates_user_status_idx ON affiliates (user_id, status, id DESC);
CREATE INDEX affiliates_contact_idx ON affiliates (contact_id);

-- ---------- commission overrides (product / offer) ----------
CREATE TABLE affiliate_commission_rules (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id bigint NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  -- NULL = every offer of the product
  price_id bigint REFERENCES product_prices(id) ON DELETE CASCADE,
  commission_type text NOT NULL CHECK (commission_type IN ('percent', 'fixed')),
  commission_value numeric(12,2) NOT NULL CHECK (commission_value >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT affiliate_commission_rules_percent_check CHECK (commission_type <> 'percent' OR commission_value <= 100)
);
CREATE UNIQUE INDEX affiliate_commission_rules_target_key ON affiliate_commission_rules (user_id, product_id, COALESCE(price_id, 0));

-- ---------- clicks ----------
CREATE TABLE affiliate_clicks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  affiliate_id bigint NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  -- random visitor id of the funnel pages (cookie scalo_vid): no IP address, no user agent
  visitor_id text NOT NULL,
  day date NOT NULL,
  funnel_id bigint REFERENCES funnels(id) ON DELETE SET NULL,
  step_id bigint REFERENCES steps(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT affiliate_clicks_daily_key UNIQUE (affiliate_id, visitor_id, day)
);
CREATE INDEX affiliate_clicks_user_idx ON affiliate_clicks (user_id, created_at);

-- ---------- referrals (leads and sales brought by an affiliate) ----------
CREATE TABLE affiliate_referrals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  affiliate_id bigint NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('lead', 'sale')),
  contact_id bigint REFERENCES contacts(id) ON DELETE SET NULL,
  order_id bigint REFERENCES orders(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT affiliate_referrals_order_check CHECK ((kind = 'sale') = (order_id IS NOT NULL))
);
-- an order belongs to one affiliate; a contact is the lead of one affiliate (the first one)
CREATE UNIQUE INDEX affiliate_referrals_order_key ON affiliate_referrals (order_id) WHERE kind = 'sale';
CREATE UNIQUE INDEX affiliate_referrals_lead_key ON affiliate_referrals (user_id, contact_id) WHERE kind = 'lead';
CREATE INDEX affiliate_referrals_affiliate_idx ON affiliate_referrals (affiliate_id, kind, created_at);

-- ---------- payouts (manual register) ----------
CREATE TABLE affiliate_payouts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  affiliate_id bigint NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  currency text NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  amount integer NOT NULL CHECK (amount > 0),
  method text NOT NULL DEFAULT '' CHECK (char_length(method) <= 80),
  reference text NOT NULL DEFAULT '' CHECK (char_length(reference) <= 200),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX affiliate_payouts_affiliate_idx ON affiliate_payouts (affiliate_id, id DESC);
CREATE INDEX affiliate_payouts_user_idx ON affiliate_payouts (user_id, id DESC);

-- ---------- commissions (ledger) ----------
CREATE TABLE affiliate_commissions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  affiliate_id bigint NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  order_id bigint REFERENCES orders(id) ON DELETE SET NULL,
  order_item_id bigint REFERENCES order_items(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('sale', 'recurring', 'clawback')),
  -- what created the row: 'tx:<order_transactions.id>' (payment) or 'refund:<cumulative refunded>' (clawback)
  source_key text NOT NULL,
  -- clawback: the commission (already paid out) it takes back
  reverses_id bigint REFERENCES affiliate_commissions(id) ON DELETE CASCADE,
  product_name text NOT NULL DEFAULT '',
  currency text NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  -- amount collected for the line, excluding tax (minor units)
  base_amount integer NOT NULL DEFAULT 0,
  rate_type text NOT NULL CHECK (rate_type IN ('percent', 'fixed')),
  rate_value numeric(12,2) NOT NULL,
  -- as computed when created / after partial refunds (negative for a clawback)
  amount_initial integer NOT NULL,
  amount integer NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid', 'cancelled')),
  approve_at timestamptz NOT NULL,
  approved_at timestamptz,
  payout_id bigint REFERENCES affiliate_payouts(id) ON DELETE SET NULL,
  paid_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT affiliate_commissions_sign_check CHECK ((kind = 'clawback' AND amount <= 0) OR (kind <> 'clawback' AND amount >= 0)),
  CONSTRAINT affiliate_commissions_paid_check CHECK (status <> 'paid' OR paid_at IS NOT NULL)
);
-- idempotency: one commission per (order line, payment), one clawback per (commission, refund)
CREATE UNIQUE INDEX affiliate_commissions_source_key ON affiliate_commissions (order_id, order_item_id, source_key) WHERE kind <> 'clawback';
CREATE UNIQUE INDEX affiliate_commissions_clawback_key ON affiliate_commissions (reverses_id, source_key) WHERE kind = 'clawback';
CREATE INDEX affiliate_commissions_affiliate_idx ON affiliate_commissions (affiliate_id, status, currency);
CREATE INDEX affiliate_commissions_user_idx ON affiliate_commissions (user_id, id DESC);
CREATE INDEX affiliate_commissions_order_idx ON affiliate_commissions (order_id);
-- worker: pending commissions whose validation delay is over
CREATE INDEX affiliate_commissions_due_idx ON affiliate_commissions (approve_at) WHERE status = 'pending';
CREATE INDEX affiliate_commissions_payout_idx ON affiliate_commissions (payout_id) WHERE payout_id IS NOT NULL;
`.execute(db);
  await rebuildCheck('contact_events', 'type', EVENT_TYPES, []).execute(db);
  await rebuildCheck('automations', 'trigger_type', TRIGGER_TYPES, []).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
DROP TABLE IF EXISTS affiliate_commissions;
DROP TABLE IF EXISTS affiliate_payouts;
DROP TABLE IF EXISTS affiliate_referrals;
DROP TABLE IF EXISTS affiliate_clicks;
DROP TABLE IF EXISTS affiliate_commission_rules;
DROP TABLE IF EXISTS affiliates;
DROP TABLE IF EXISTS affiliate_programs;
DELETE FROM contact_events WHERE type IN ('affiliate_joined', 'affiliate_commission');
`.execute(db);
  await sql`DO $$ BEGIN IF to_regclass('automations') IS NOT NULL THEN DELETE FROM automations WHERE trigger_type = 'affiliate_approved'; END IF; END $$`.execute(db);
  await rebuildCheck('contact_events', 'type', [], EVENT_TYPES).execute(db);
  await rebuildCheck('automations', 'trigger_type', [], TRIGGER_TYPES).execute(db);
}
