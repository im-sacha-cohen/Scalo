import { env } from './env';
import { checkDb, closeDb } from './db';
import { migrateToLatest } from './db/migrate';
import { createApp } from './app';
import { loadEe } from './ee';
import { closeAllTransports } from './services/email';
import { worker } from './worker';
import { cleanupOAuth } from './services/oauth-server';
import { cleanupAttempts } from './services/ratelimit';

async function main() {
  await checkDb();
  if (env.AUTO_MIGRATE) await migrateToLatest(undefined, { quiet: true });

  await loadEe(); // Enterprise extension, if ee/ is installed (before the first request and the first email)
  const server = createApp().listen(env.API_PORT, () => {
    console.log(`API prête sur http://localhost:${env.API_PORT}`);
  });
  server.on('error', (e) => {
    console.error('[api]', e.message);
    process.exit(1);
  });
  await worker.start();

  // expired OAuth requests / codes / tokens and old rate-limit counters
  const cleanup = () => Promise.all([cleanupOAuth(), cleanupAttempts(), loadEe().then((x) => x?.cleanup())]).catch((e) => console.error('[auth] cleanup:', e.message));
  void cleanup();
  setInterval(() => void cleanup(), 15 * 60_000).unref();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[api] ${signal} reçu, arrêt en cours…`);
    const force = setTimeout(() => process.exit(1), 25_000);
    force.unref();
    server.close();
    server.closeIdleConnections?.();
    await worker.stop().catch((e) => console.error('[worker] stop:', e));
    closeAllTransports();
    await closeDb().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error(`[api] Démarrage impossible : ${e instanceof Error ? e.message : e}`);
  void closeDb().finally(() => process.exit(1));
});
