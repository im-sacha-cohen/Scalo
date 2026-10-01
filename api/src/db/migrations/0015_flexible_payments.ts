import { sql, type Kysely } from 'kysely';

// Payments on the funnel's own page (Stripe Elements instead of Stripe Checkout) and installments chosen by the buyer.
//
// 1. product_prices: an `installments` offer now stores the price paid in one go (`amount`) and the range of
//    installments the buyer may choose from (`installments_min`..`installments_max`, 1 = "in one go" allowed), the
//    rhythm (`interval` week / month × `interval_count`) and an optional surcharge per number of installments
//    (`installment_fees`: { "3": 5 } = +5 % when paid in 3 times). Existing offers ("N monthly payments of X") become
//    "N times, total N × X, fixed".
// 2. order_items: the chosen plan — `installments` (count chosen), `installment_amount` (regular installment, tax
//    included; the first one absorbs the rounding cents) and `interval_count`. `amount_*` of an installments line is
//    now the whole plan (it was one installment): existing lines are converted.
// 3. payment_settings: SEPA Direct Debit switch, payment method domains already registered (Apple Pay / Google Pay).
// 4. stripe_products: Stripe Product of each Scalo product per mode (subscriptions need one).

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
ALTER TABLE product_prices DROP CONSTRAINT product_prices_shape_check;
ALTER TABLE product_prices DROP CONSTRAINT IF EXISTS product_prices_interval_check;
ALTER TABLE product_prices ADD COLUMN installments_min integer CHECK (installments_min BETWEEN 1 AND 36);
ALTER TABLE product_prices ADD COLUMN installments_max integer CHECK (installments_max BETWEEN 2 AND 36);
ALTER TABLE product_prices ADD COLUMN interval_count integer NOT NULL DEFAULT 1 CHECK (interval_count BETWEEN 1 AND 12);
ALTER TABLE product_prices ADD COLUMN installment_fees jsonb NOT NULL DEFAULT '{}'::jsonb;
UPDATE product_prices
   SET installments_min = installments, installments_max = installments, amount = LEAST(amount * installments, 99999999)
 WHERE type = 'installments';
ALTER TABLE product_prices DROP COLUMN installments;
ALTER TABLE product_prices ADD CONSTRAINT product_prices_interval_check CHECK ("interval" IN ('week', 'month', 'year'));
ALTER TABLE product_prices ADD CONSTRAINT product_prices_shape_check CHECK (
  (type = 'one_time' AND "interval" IS NULL AND installments_min IS NULL AND installments_max IS NULL)
  OR (type = 'subscription' AND "interval" IS NOT NULL AND installments_min IS NULL AND installments_max IS NULL)
  OR (type = 'installments' AND "interval" IN ('week', 'month') AND installments_min IS NOT NULL AND installments_max IS NOT NULL
      AND installments_min <= installments_max));

ALTER TABLE order_items ADD COLUMN installment_amount integer CHECK (installment_amount >= 0);
ALTER TABLE order_items ADD COLUMN interval_count integer NOT NULL DEFAULT 1;
UPDATE order_items
   SET installment_amount = amount_total,
       amount_subtotal = amount_subtotal * installments, amount_tax = amount_tax * installments, amount_total = amount_total * installments
 WHERE type = 'installments' AND installments IS NOT NULL;

ALTER TABLE payment_settings ADD COLUMN sepa_debit boolean NOT NULL DEFAULT false;
ALTER TABLE payment_settings ADD COLUMN payment_domains jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE stripe_products (
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id bigint NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  livemode boolean NOT NULL,
  stripe_product_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, livemode)
);
CREATE INDEX stripe_products_user_idx ON stripe_products (user_id);
`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
DROP TABLE IF EXISTS stripe_products;
ALTER TABLE payment_settings DROP COLUMN IF EXISTS payment_domains;
ALTER TABLE payment_settings DROP COLUMN IF EXISTS sepa_debit;

UPDATE order_items
   SET amount_subtotal = amount_subtotal / installments, amount_tax = amount_tax / installments, amount_total = COALESCE(installment_amount, amount_total / installments)
 WHERE type = 'installments' AND installments IS NOT NULL AND installments > 0;
ALTER TABLE order_items DROP COLUMN IF EXISTS interval_count;
ALTER TABLE order_items DROP COLUMN IF EXISTS installment_amount;

-- offers that cannot be expressed in the old model (weekly rhythm, buyer's choice) become fixed monthly plans
ALTER TABLE product_prices DROP CONSTRAINT product_prices_shape_check;
ALTER TABLE product_prices DROP CONSTRAINT IF EXISTS product_prices_interval_check;
ALTER TABLE product_prices ADD COLUMN installments integer CHECK (installments BETWEEN 2 AND 36);
UPDATE product_prices
   SET installments = installments_max, "interval" = 'month', amount = GREATEST(50, amount / installments_max)
 WHERE type = 'installments';
ALTER TABLE product_prices DROP COLUMN installment_fees;
ALTER TABLE product_prices DROP COLUMN interval_count;
ALTER TABLE product_prices DROP COLUMN installments_max;
ALTER TABLE product_prices DROP COLUMN installments_min;
ALTER TABLE product_prices ADD CONSTRAINT product_prices_interval_check CHECK ("interval" IN ('month', 'year'));
ALTER TABLE product_prices ADD CONSTRAINT product_prices_shape_check CHECK (
  (type = 'one_time' AND "interval" IS NULL AND installments IS NULL)
  OR (type = 'subscription' AND "interval" IS NOT NULL AND installments IS NULL)
  OR (type = 'installments' AND "interval" = 'month' AND installments IS NOT NULL));
`.execute(db);
}
