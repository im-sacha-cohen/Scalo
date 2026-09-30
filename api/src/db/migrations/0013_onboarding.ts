import { sql, type Kysely } from 'kysely';

// Onboarding of new accounts (welcome flow + "Bien démarrer" checklist of the dashboard):
// 1. account_onboarding: one row per account — goal chosen in the welcome flow, current step (to resume where the
//    owner stopped), the funnel created during the flow, and three dates: finished, skipped, checklist hidden.
//    An account WITHOUT a row (or with neither completed_at nor skipped_at) is sent to the welcome flow once.
// 2. Accounts that exist when the migration runs never see the welcome flow: they get a row marked as finished, with
//    the checklist hidden (it can be reopened from the account menu).
//
// The checklist itself is not stored: it is computed from the account's data (services/onboarding.ts).

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
CREATE TABLE account_onboarding (
  user_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  goal text CONSTRAINT account_onboarding_goal_check CHECK (goal IN ('leads', 'sell', 'course', 'migrate')),
  step text NOT NULL DEFAULT 'goal' CONSTRAINT account_onboarding_step_check CHECK (step IN ('goal', 'business', 'funnel', 'live')),
  -- the funnel created during the welcome flow (shown by the last step)
  funnel_id bigint REFERENCES funnels(id) ON DELETE SET NULL,
  completed_at timestamptz,
  skipped_at timestamptz,
  checklist_hidden_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO account_onboarding (user_id, step, completed_at, checklist_hidden_at)
SELECT id, 'live', now(), now() FROM users;
`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
DROP TABLE IF EXISTS account_onboarding;
`.execute(db);
}
