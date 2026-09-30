import { Migrator, type Migration, type MigrationProvider, type MigrationResultSet } from 'kysely';
import { db, type Db } from './index';
import * as m0010 from './migrations/0010_imports';
import * as m0001 from './migrations/0001_init';
import * as m0002 from './migrations/0002_oauth';
import * as m0003 from './migrations/0003_email_features';
import * as m0004 from './migrations/0004_oauth_provider';
import * as m0005 from './migrations/0005_automations_crm';
import * as m0006 from './migrations/0006_funnels_growth';
import * as m0011 from './migrations/0011_ee';
import * as m0007 from './migrations/0007_payments';
import * as m0008 from './migrations/0008_courses';
import * as m0009 from './migrations/0009_ai';
import * as m0012 from './migrations/0012_affiliates';
import * as m0013 from './migrations/0013_onboarding';

/**
 * Versioned migrations. Static provider (no filesystem scanning) so it works the same under tsx, a bundler or plain
 * node. To add a migration: create `migrations/000N_name.ts` exporting `up`/`down` and register it below.
 * Migrations run in order, each in its own transaction; Kysely takes a lock so concurrent starts are safe.
 */
const migrations: Record<string, Migration> = {
  '0001_init': m0001,
  '0002_oauth': m0002,
  '0003_email_features': m0003,
  '0004_oauth_provider': m0004,
  '0005_automations_crm': m0005,
  '0006_funnels_growth': m0006,
  '0007_payments': m0007,
  '0008_courses': m0008,
  '0009_ai': m0009,
  '0010_imports': m0010,
  '0011_ee': m0011,
  '0012_affiliates': m0012,
  '0013_onboarding': m0013,
};

const provider: MigrationProvider = { getMigrations: async () => migrations };

// Unordered: features developed in parallel may be applied to a database in a different order than their numbers.
export const migrator = (ex: Db = db) => new Migrator({ db: ex, provider, allowUnorderedMigrations: true });

function report(label: string, { error, results }: MigrationResultSet) {
  for (const r of results ?? []) {
    const icon = r.status === 'Success' ? '✓' : r.status === 'Error' ? '✗' : '·';
    console.log(`[migrate] ${icon} ${r.direction === 'Down' ? 'down' : 'up'} ${r.migrationName} (${r.status})`);
  }
  if (error) throw new Error(`[migrate] ${label} a échoué : ${error instanceof Error ? error.message : String(error)}`);
}

export async function migrateToLatest(ex: Db = db, { quiet = false } = {}) {
  const res = await migrator(ex).migrateToLatest();
  if (!quiet || res.error) report('migrate:latest', res);
  return res.results?.filter((r) => r.status === 'Success').length ?? 0;
}

export async function migrateDown(ex: Db = db) {
  report('migrate:down', await migrator(ex).migrateDown());
}
