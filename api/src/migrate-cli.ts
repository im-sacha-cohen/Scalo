// npm run migrate [-- down]   — applies all pending migrations, or rolls back the last one.
import './env';
import { checkDb, closeDb } from './db';
import { migrateDown, migrateToLatest, migrator } from './db/migrate';

async function main() {
  await checkDb();
  const cmd = process.argv[2] ?? 'latest';
  if (cmd === 'latest' || cmd === 'up') {
    const n = await migrateToLatest();
    if (!n) console.log('[migrate] base à jour');
  } else if (cmd === 'down') {
    await migrateDown();
  } else if (cmd === 'status') {
    for (const m of await migrator().getMigrations()) console.log(`${m.executedAt ? '✓' : '·'} ${m.name}${m.executedAt ? `  (${m.executedAt.toISOString()})` : ''}`);
  } else {
    throw new Error(`Commande inconnue « ${cmd} » (latest | down | status)`);
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
