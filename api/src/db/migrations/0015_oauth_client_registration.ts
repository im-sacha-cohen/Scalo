import { sql, type Kysely } from 'kysely';

// Dynamic client registration (RFC 7591, POST /oauth/register): a client registered by itself, Claude for instance,
// belongs to no account, so oauth_clients.user_id becomes nullable. The `down` removes those clients first.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE oauth_clients ALTER COLUMN user_id DROP NOT NULL`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM oauth_clients WHERE user_id IS NULL`.execute(db);
  await sql`ALTER TABLE oauth_clients ALTER COLUMN user_id SET NOT NULL`.execute(db);
}
