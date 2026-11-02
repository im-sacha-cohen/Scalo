import { sql, type Kysely } from 'kysely';

// OAuth scope `emails:write` (public API and MCP: write, test and schedule newsletters, create campaigns and their
// emails). The scopes CHECK is rebuilt from its *current* values plus ours (same approach as 0005 / 0007). Clients
// that registered themselves (Claude, user_id NULL) receive every scope: they get this one too, and the user grants it
// on the consent screen the next time the client connects.

const SCOPES = ['emails:write'];

// DO blocks cannot take bind parameters: inline the (constant, trusted) arrays as literals.
const lit = (arr: string[]) => sql.raw(`ARRAY[${arr.map((v) => `'${v.replace(/'/g, "''")}'`).join(',')}]::text[]`);
const rebuildOAuthScopes = (add: string[], remove: string[]) => sql`
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
  await rebuildOAuthScopes(SCOPES, []).execute(db);
  await sql`UPDATE oauth_clients SET scopes = array_append(scopes, 'emails:write') WHERE user_id IS NULL AND NOT 'emails:write' = ANY (scopes)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // scope removed: applications / grants holding only this scope disappear, the others lose it
  for (const table of ['oauth_clients', 'oauth_tokens', 'oauth_codes', 'oauth_consents']) {
    await sql`DELETE FROM ${sql.table(table)} WHERE scopes = ARRAY['emails:write']`.execute(db);
    await sql`UPDATE ${sql.table(table)} SET scopes = array_remove(scopes, 'emails:write') WHERE 'emails:write' = ANY (scopes)`.execute(db);
  }
  await rebuildOAuthScopes([], SCOPES).execute(db);
}
