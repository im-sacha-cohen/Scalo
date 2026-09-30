import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db } from '../src/db';
import { migrateDown, migrateToLatest, migrator } from '../src/db/migrate';
import { client, registerUser, shutdown, startApp, type TestCtx } from './helpers';

let ctx: TestCtx;
before(async () => {
  ctx = await startApp();
});
after(() => shutdown(ctx));

test('migrations roll back and re-apply cleanly', async () => {
  const total = (await migrator().getMigrations()).length;
  for (let i = 0; i < total; i++) await migrateDown();
  const { rows } = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM pg_tables WHERE schemaname = current_schema() AND tablename = 'users'`.execute(db);
  assert.equal(rows[0].n, 0);
  assert.equal(await migrateToLatest(db, { quiet: true }), total);
  assert.ok((await migrator().getMigrations()).every((m) => m.executedAt));
  assert.equal(await migrateToLatest(db, { quiet: true }), 0, 'idempotent');
});

test('schema constraints back the API (unique violations → 409, never 500)', async () => {
  const api = client(ctx, (await registerUser(ctx)).token);
  const results = await Promise.all(Array.from({ length: 5 }, () => api.post('/api/contacts', { email: 'race@mail.fr' })));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409, 409]);
  const id = results.find((r) => r.status === 201)!.body.id;
  // concurrent get-or-create of the same tag + idempotent contact_tags insert
  const tags = await Promise.all(Array.from({ length: 5 }, (_, i) => api.post(`/api/contacts/${id}/tags`, { name: i % 2 ? 'same' : 'Same' })));
  assert.deepEqual(tags.map((r) => r.status), [200, 200, 200, 200, 200]);
  assert.equal((await api.get(`/api/contacts/${id}`)).body.tags.length, 1);
  await assert.rejects(
    db.insertInto('steps').values({ funnel_id: 999999, name: 'x', slug: 'x', type: 'nope' as never, content: '{}' }).execute(),
    /violates check constraint|violates foreign key/,
  );
});

const tableExists = async (name: string) =>
  (await sql<{ n: number }>`SELECT COUNT(*) AS n FROM pg_tables WHERE schemaname = current_schema() AND tablename = ${name}`.execute(db)).rows[0].n === 1;

test('0004_oauth_provider: rolls back to the social-login schema, refuses accounts without password', async () => {
  // data in the OAuth tables must not block the rollback
  const owner = await registerUser(ctx);
  const app = await client(ctx, owner.token).post('/api/developer/apps', {
    name: 'App',
    type: 'confidential',
    redirect_uris: ['https://app.example.com/cb'],
    scopes: ['profile'],
  });
  assert.equal(app.status, 201, app.text);

  // migrations added after 0004 (0005, 0006…) are rolled back first, then 0004
  const after0004 = (await migrator().getMigrations()).filter((m) => m.name > '0004_oauth_provider').length;
  for (let i = 0; i < after0004; i++) await migrateDown();
  await migrateDown(); // 0004 down
  assert.ok(await tableExists('user_identities'));
  assert.ok(!(await tableExists('oauth_clients')));
  // back in the 0003 state: accounts without password are possible again
  const { rows } = await sql<{ id: number }>`INSERT INTO users (email, password_hash, name) VALUES ('nopw@mail.fr', NULL, 'N') RETURNING id`.execute(db);
  await assert.rejects(migrateToLatest(db, { quiet: true }), /sans mot de passe/);
  assert.ok(!(await tableExists('oauth_clients')), 'failed migration rolled back');
  await sql`DELETE FROM users WHERE id = ${rows[0].id}`.execute(db);
  assert.equal(await migrateToLatest(db, { quiet: true }), 1 + after0004);
  assert.ok(await tableExists('oauth_clients'));
  assert.ok(!(await tableExists('user_identities')) && !(await tableExists('auth_login_codes')) && !(await tableExists('auth_link_tickets')));
  assert.ok(await tableExists('auth_attempts'), 'brute-force counters kept');
  await assert.rejects(sql`INSERT INTO users (email, password_hash, name) VALUES ('nopw2@mail.fr', NULL, 'N')`.execute(db), /null value/);

  // roll back every migration after 0001 and re-apply them
  const later = (await migrator().getMigrations()).filter((m) => m.name > '0001_init').length;
  for (let i = 0; i < later; i++) await migrateDown();
  assert.ok(!(await tableExists('auth_attempts')));
  assert.equal(await migrateToLatest(db, { quiet: true }), later);
  assert.ok(await tableExists('oauth_tokens'));
  // CHECK constraints: unknown scope, confidential client without secret
  await assert.rejects(
    sql`INSERT INTO oauth_clients (client_id, user_id, name, type, secret_hash, redirect_uris, scopes)
        VALUES ('x', ${owner.user.id}, 'X', 'confidential', 'h', ARRAY['https://a.fr'], ARRAY['admin'])`.execute(db),
    /violates check constraint/,
  );
  await assert.rejects(
    sql`INSERT INTO oauth_clients (client_id, user_id, name, type, redirect_uris, scopes)
        VALUES ('y', ${owner.user.id}, 'Y', 'confidential', ARRAY['https://a.fr'], ARRAY['profile'])`.execute(db),
    /violates check constraint/,
  );
});
