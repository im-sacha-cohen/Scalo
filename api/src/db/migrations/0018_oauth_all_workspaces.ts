import { sql, type Kysely } from 'kysely';

// OAuth access to every workspace of a person (consent screen → « Tous mes espaces »). `person_id` set on a code, a
// token or a remembered consent = the grant covers each workspace that person may authorize (owner or administrator),
// including those created later; `user_id` stays the workspace it was granted from (connected applications, revocation,
// rate limit). The client names the workspace of each call (X-Scalo-Workspace header, `workspace_id` of MCP tools).
// NULL: the grant is bound to `user_id` only, as before.

const TABLES = ['oauth_codes', 'oauth_tokens', 'oauth_consents'] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const t of TABLES) {
    await sql`ALTER TABLE ${sql.table(t)} ADD COLUMN person_id bigint REFERENCES users(id) ON DELETE CASCADE`.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const t of TABLES) await sql`ALTER TABLE ${sql.table(t)} DROP COLUMN IF EXISTS person_id`.execute(db);
}
