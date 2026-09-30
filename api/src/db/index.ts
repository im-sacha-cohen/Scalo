import pg from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { env } from '../env';
import type { Database } from './schema';

export * from './schema';

// ---- type parsing at the driver boundary (keeps the API contract: numbers and ISO strings) ----
// int8 (COUNT(*), bigint ids) → number. Ids and counters stay far below 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));
// timestamptz → ISO-8601 UTC string, exactly like `new Date().toISOString()`.
pg.types.setTypeParser(pg.types.builtins.TIMESTAMPTZ, (v) => new Date(v).toISOString());
pg.types.setTypeParser(pg.types.builtins.TIMESTAMP, (v) => new Date(`${v.replace(' ', 'T')}Z`).toISOString());
// date → 'YYYY-MM-DD' (no timezone shift)
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

const url = new URL(env.DATABASE_URL);
const sslFromUrl = ['require', 'verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode') ?? '');

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 15_000,
  idle_in_transaction_session_timeout: 30_000,
  application_name: 'scalo-api',
  ...(env.DATABASE_SSL ?? sslFromUrl ? { ssl: { rejectUnauthorized: url.searchParams.get('sslmode') === 'verify-full' } } : {}),
});
// An idle client erroring (e.g. the server restarted) must not crash the process; the pool replaces it.
pool.on('error', (e) => console.error('[db] idle client error:', e.message));

export const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });

/** `db` or a transaction: services take one so they compose inside `db.transaction()`. */
export type Db = Kysely<Database>;

/** Runs `fn` in a transaction, or directly on `ex` if it already is one. */
export function inTx<T>(ex: Db, fn: (trx: Db) => Promise<T>): Promise<T> {
  return ex.isTransaction ? fn(ex) : ex.transaction().execute(fn);
}

export const nowIso = () => new Date().toISOString();

/** Fails fast with a readable message when the database is unreachable. */
export async function checkDb() {
  try {
    await sql`select 1`.execute(db);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    throw new Error(
      `Base de données injoignable (${url.protocol}//${url.hostname}:${url.port || 5432}${url.pathname}) : ${err.code ?? ''} ${err.message ?? e}\n` +
        '  → Lancez PostgreSQL avec `npm run db:up` (Docker) ou vérifiez DATABASE_URL dans .env',
    );
  }
}

/** Empties all application tables (keeps the migration history). */
export async function truncateAll() {
  const { rows } = await sql<{ tablename: string }>`
    SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename NOT LIKE 'kysely_%'`.execute(db);
  if (rows.length) await sql`TRUNCATE ${sql.join(rows.map((r) => sql.table(r.tablename)))} RESTART IDENTITY CASCADE`.execute(db);
}

export async function closeDb() {
  await db.destroy(); // ends the pool
}

// ---- Postgres error helpers ----

export const pgCode = (e: unknown) => (e as { code?: string } | null)?.code;
export const isUniqueViolation = (e: unknown, constraint?: string) =>
  pgCode(e) === '23505' && (!constraint || (e as { constraint?: string }).constraint === constraint);
