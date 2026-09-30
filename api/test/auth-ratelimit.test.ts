// DB-backed brute-force protection of the auth routes (login / register), shared by every API instance.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import type { AddressInfo } from 'node:net';
import { db } from '../src/db';
import { createApp, type AppOptions } from '../src/app';
import { http, registerUser, shutdown, startApp, type TestCtx } from './helpers';

/** Another app instance on the same database (without resetting it, unlike startApp). */
async function extraInstance(opts: AppOptions = {}): Promise<TestCtx> {
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = createApp(opts).listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

let ctx: TestCtx;
before(async () => {
  ctx = await startApp();
});
after(() => shutdown(ctx));
beforeEach(async () => {
  await db.deleteFrom('auth_attempts').execute();
});

const uniq = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`;

describe('brute-force protection', () => {
  test('per email: 5 failures / 15 min → 429 + Retry-After, even with the right password', async () => {
    const reg = await registerUser(ctx);
    for (let i = 0; i < 5; i++) {
      assert.equal((await http(ctx, 'POST', '/api/auth/login', { json: { email: reg.email, password: 'wrong' } })).status, 401);
    }
    const blocked = await http(ctx, 'POST', '/api/auth/login', { json: { email: reg.email, password: 'secret123' } });
    assert.equal(blocked.status, 429);
    assert.match(blocked.body.error, /Trop de tentatives/);
    const ra = Number(blocked.headers.get('retry-after'));
    assert.ok(ra > 800 && ra <= 900, `Retry-After ${ra}`);
    // another account from the same IP is not affected
    const other = await registerUser(ctx);
    assert.equal((await http(ctx, 'POST', '/api/auth/login', { json: { email: other.email, password: 'secret123' } })).status, 200);
    // window elapsed → allowed again
    await db.updateTable('auth_attempts').set({ window_start: sql`now() - interval '16 minutes'` }).execute();
    assert.equal((await http(ctx, 'POST', '/api/auth/login', { json: { email: reg.email, password: 'secret123' } })).status, 200);
  });

  test('a successful login resets the email counter', async () => {
    const reg = await registerUser(ctx);
    const login = (password: string) => http(ctx, 'POST', '/api/auth/login', { json: { email: reg.email, password } });
    for (let i = 0; i < 4; i++) assert.equal((await login('wrong')).status, 401);
    assert.equal((await login('secret123')).status, 200);
    for (let i = 0; i < 5; i++) assert.equal((await login('wrong')).status, 401);
    assert.equal((await login('wrong')).status, 429);
  });

  test('parallel guesses cannot exceed the limit', async () => {
    const reg = await registerUser(ctx);
    const rs = await Promise.all(Array.from({ length: 12 }, () => http(ctx, 'POST', '/api/auth/login', { json: { email: reg.email, password: 'wrong' } })));
    assert.equal(rs.filter((r) => r.status === 401).length, 5);
    assert.equal(rs.filter((r) => r.status === 429).length, 7);
  });

  test('per IP: 20 failed logins across emails → 429', async () => {
    for (let i = 0; i < 20; i++) {
      assert.equal((await http(ctx, 'POST', '/api/auth/login', { json: { email: `ghost${i}@mail.fr`, password: 'x' } })).status, 401);
    }
    const r = await http(ctx, 'POST', '/api/auth/login', { json: { email: 'ghost-new@mail.fr', password: 'x' } });
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) > 0);
  });

  test('per IP: registrations are limited', async () => {
    for (let i = 0; i < 20; i++) {
      const r = await http(ctx, 'POST', '/api/auth/register', { json: { email: `bulk${i}-${uniq()}@mail.fr`, password: 'secret123', name: 'B' } });
      assert.equal(r.status, 201);
    }
    const r = await http(ctx, 'POST', '/api/auth/register', { json: { email: `bulk-${uniq()}@mail.fr`, password: 'secret123', name: 'B' } });
    assert.equal(r.status, 429);
    assert.ok(r.headers.get('retry-after'));
  });

  test('counters are stored in the database (shared across instances) and cleaned up', async () => {
    await http(ctx, 'POST', '/api/auth/login', { json: { email: 'shared@mail.fr', password: 'x' } });
    const rows = await db.selectFrom('auth_attempts').selectAll().where('key', 'like', 'login:%').execute();
    assert.ok(rows.some((r) => r.key === 'login:email:shared@mail.fr' && r.count === 1));
    // a second app instance on the same database sees the same counter
    const second = await extraInstance();
    try {
      for (let i = 0; i < 4; i++) await http(second, 'POST', '/api/auth/login', { json: { email: 'shared@mail.fr', password: 'x' } });
      assert.equal((await http(ctx, 'POST', '/api/auth/login', { json: { email: 'shared@mail.fr', password: 'x' } })).status, 429);
    } finally {
      await second.close();
    }
    const { cleanupAttempts } = await import('../src/services/ratelimit');
    await db.updateTable('auth_attempts').set({ window_start: sql`now() - interval '2 days'` }).execute();
    await cleanupAttempts();
    assert.equal((await db.selectFrom('auth_attempts').select('key').execute()).length, 0);
  });
});
