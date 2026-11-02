import { sql, type Kysely } from 'kysely';

// Workspaces: one person can run several separate businesses, each with its own data (contacts, funnels, emails,
// payments, settings…).
//
// - `accounts` is the tenant: every `user_id` column of the business tables now references accounts(id) instead of
//   users(id) (the column names stay, no query changes). The columns that mean a *person* keep referencing users.
// - The account of a person keeps the id of the person (zero data to move). Workspaces created later draw their id
//   from the sequence of users.id, so an account id is never the id of another person.
// - Deleting a person deletes the accounts he owns (CASCADE), hence all their data.
// - oauth_authorization_requests.account_id: the workspace an authorization is bound to, when the client asked for
//   the MCP endpoint of a workspace (`resource` = …/mcp/<id>, RFC 8707).

/** FK columns that reference a person, not a tenant: they keep pointing at users. */
const PERSON_COLUMNS = [
  ['user_identities', 'user_id'],
  ['auth_login_codes', 'user_id'],
  ['auth_link_tickets', 'user_id'],
  ['account_members', 'user_id'],
  ['account_members', 'invited_by'],
  ['account_invitations', 'invited_by'],
  ['audit_logs', 'actor_id'],
  ['instance_license', 'updated_by'],
  ['accounts', 'owner_id'],
];

const excluded = sql.raw(PERSON_COLUMNS.map(([t, c]) => `('${t}','${c}')`).join(','));

/** Re-targets every single-column FK referencing `from`(id) (except the person columns) to `to`(id), same ON DELETE. */
const retarget = (from: string, to: string) => sql`
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.conname, c.conrelid::regclass::text AS tbl, a.attname AS col, c.confdeltype
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f' AND c.confrelid = ${sql.lit(from)}::regclass AND cardinality(c.conkey) = 1
       AND (c.conrelid::regclass::text, a.attname::text) NOT IN (${excluded})
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.tbl, r.conname);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I(id) ON DELETE %s', r.tbl, r.conname, r.col, ${sql.lit(to)},
      CASE r.confdeltype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'r' THEN 'RESTRICT' ELSE 'NO ACTION' END);
  END LOOP;
END $$`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
CREATE TABLE accounts (
  id bigint PRIMARY KEY,
  owner_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (btrim(name) <> ''),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- workspace switcher: the accounts of a person, oldest first
CREATE INDEX accounts_owner_idx ON accounts (owner_id, created_at, id);

-- every person gets his own account (same id), except the logins of team members (Enterprise), which only exist for
-- their membership
INSERT INTO accounts (id, owner_id, name, created_at)
SELECT u.id, u.id, coalesce(nullif(btrim(u.name), ''), split_part(u.email, '@', 1)), u.created_at
  FROM users u
 WHERE NOT EXISTS (SELECT 1 FROM account_members m WHERE m.user_id = u.id);
`.execute(db);
  await retarget('users', 'accounts').execute(db);
  await sql`ALTER TABLE oauth_authorization_requests ADD COLUMN account_id bigint REFERENCES accounts(id) ON DELETE CASCADE`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE oauth_authorization_requests DROP COLUMN account_id`.execute(db);
  // only the account of each person can go back to users: the other workspaces (and their data) are deleted
  await sql`DELETE FROM accounts WHERE id <> owner_id`.execute(db);
  await retarget('accounts', 'users').execute(db);
  await sql`DROP TABLE accounts`.execute(db);
}
