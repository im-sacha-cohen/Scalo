// Self-hosting: the API serves the built web app (routes/spa.ts) without hiding any server route, and ALLOW_SIGNUPS
// closes public sign-ups once the first account exists.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http_ from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { db } from '../src/db';
import { env } from '../src/env';
import { isServerPath, resolveWebDist } from '../src/routes/spa';
import { http, registerUser, shutdown, startApp, type TestCtx } from './helpers';

const SHELL = '<!doctype html><title>scalo-app-shell</title><div id="root"></div>';
let dist: string;
let ctx: TestCtx;

before(async () => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'scalo-dist-'));
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'index.html'), SHELL);
  fs.writeFileSync(path.join(dist, 'assets', 'index-abc123.js'), 'console.log("app")');
  fs.writeFileSync(path.join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  ctx = await startApp({ webDist: dist });
});
after(async () => {
  env.ALLOW_SIGNUPS = true;
  await shutdown(ctx);
  fs.rmSync(dist, { recursive: true, force: true });
});

/** GET with an arbitrary Host header (fetch cannot set it). */
function getWithHost(base: string, host: string, p: string): Promise<{ status: number; text: string }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http_.request({ host: u.hostname, port: u.port, path: p, method: 'GET', headers: { host } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('error', reject);
    req.end();
  });
}

const isShell = (r: { status: number; text: string }) => r.status === 200 && r.text.includes('scalo-app-shell');

describe('web app served by the API', () => {
  test('app routes get index.html (never cached), deep links included', async () => {
    for (const p of ['/', '/login', '/register', '/contacts/12', '/funnels/3/steps/4/edit', '/share/scalo_sh_abc', '/home', '/p', '/account', '/pricing']) {
      if (isServerPath(p)) continue;
      const r = await http(ctx, 'GET', p);
      assert.ok(isShell(r), `${p} → app shell (got ${r.status})`);
      assert.equal(r.headers.get('cache-control'), 'no-cache', p);
      assert.match(r.headers.get('content-type') ?? '', /text\/html/);
    }
  });

  test('hashed assets are cached forever, other files briefly, missing files are 404', async () => {
    const asset = await http(ctx, 'GET', '/assets/index-abc123.js');
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.match(asset.headers.get('content-type') ?? '', /javascript/);
    assert.equal(asset.headers.get('x-content-type-options'), 'nosniff');

    const icon = await http(ctx, 'GET', '/favicon.svg');
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get('cache-control'), 'public, max-age=3600');

    for (const p of ['/assets/index-old.js', '/robots.txt', '/.env', '/.git/config', '/assets/../../package.json']) {
      const r = await http(ctx, 'GET', p);
      assert.ok(!isShell(r) && r.status === 404, `${p} → 404 (got ${r.status})`);
    }
  });

  test('the OAuth consent screen cannot be framed', async () => {
    const r = await http(ctx, 'GET', '/oauth/consent?request=scalo_ar_x');
    assert.ok(isShell(r));
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('content-security-policy'), "frame-ancestors 'none'");
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.equal((await http(ctx, 'GET', '/login')).headers.get('x-frame-options'), null);
  });

  test('server routes are never replaced by the app shell', async () => {
    const health = await http(ctx, 'GET', '/api/health');
    assert.deepEqual(health.body, { ok: true, db: 'up' });
    assert.equal((await http(ctx, 'GET', '/api/nope')).status, 401);
    const user = await registerUser(ctx);
    const unknownApi = await http(ctx, 'GET', '/api/nope', { token: user.token });
    assert.equal(unknownApi.status, 404);
    assert.equal(unknownApi.body.error, 'Route introuvable');

    const meta = await http(ctx, 'GET', '/.well-known/oauth-authorization-server');
    assert.equal(meta.status, 200);
    assert.ok(meta.body.token_endpoint);

    const paths = [
      '/p/unknown-funnel', '/p/unknown-funnel/step', '/t/o/x.gif', '/t/c/1', '/t/other', '/u/bad-token', '/c/bad-token', '/m/unknown-space',
      '/a/unknown', '/a', '/uploads/1/missing.png', '/uploads/other', '/mcp', '/.well-known/unknown', '/oauth/authorize', '/oauth/token',
      '/oauth/revoke', '/oauth/introspect', '/api',
    ];
    for (const p of paths) {
      assert.ok(isServerPath(p), `${p} is a server path`);
      const r = await http(ctx, 'GET', p);
      assert.ok(!r.text.includes('scalo-app-shell'), `${p} must not return the app shell (status ${r.status})`);
    }
    // only GET / HEAD fall back to the app
    const post = await http(ctx, 'POST', '/contacts', { json: {} });
    assert.equal(post.status, 404);
    assert.ok(!post.text.includes('scalo-app-shell'));
  });

  test('a custom-domain or unknown host never receives the app', async () => {
    for (const p of ['/', '/login', '/assets/index-abc123.js', '/api/health']) {
      const r = await getWithHost(ctx.base, 'offre.exemple-client.fr', p);
      assert.equal(r.status, 404, p);
      assert.ok(!r.text.includes('scalo-app-shell') && !r.text.includes('console.log("app")'), p);
    }
    assert.ok(isShell(await getWithHost(ctx.base, 'localhost', '/login')));
  });

  test('WEB_DIST resolution: off in dev / tests unless set, "false" disables, missing build ignored', () => {
    const saved = process.env.WEB_DIST;
    try {
      delete process.env.WEB_DIST;
      assert.equal(resolveWebDist(), null); // NODE_ENV=test: nothing served by default
      assert.equal(resolveWebDist(null), null);
      process.env.WEB_DIST = dist;
      assert.equal(resolveWebDist(), dist);
      process.env.WEB_DIST = 'false';
      assert.equal(resolveWebDist(), null);
      assert.equal(resolveWebDist(path.join(dist, 'nope')), null);
    } finally {
      if (saved === undefined) delete process.env.WEB_DIST;
      else process.env.WEB_DIST = saved;
    }
  });
});

describe('ALLOW_SIGNUPS', () => {
  const body = (email: string) => ({ json: { email, password: 'secret123', name: 'Nouveau' } });

  test('open by default', async () => {
    assert.equal(env.ALLOW_SIGNUPS, true);
    assert.deepEqual((await http(ctx, 'GET', '/api/auth/config')).body, { signups: true });
  });

  test('false: the first account of an empty instance can be created, then sign-ups are closed', async () => {
    await db.deleteFrom('users').execute();
    await db.deleteFrom('auth_attempts').execute();
    env.ALLOW_SIGNUPS = false;
    try {
      assert.deepEqual((await http(ctx, 'GET', '/api/auth/config')).body, { signups: true });
      const first = await http(ctx, 'POST', '/api/auth/register', body('owner@selfhost.test'));
      assert.equal(first.status, 201);

      assert.deepEqual((await http(ctx, 'GET', '/api/auth/config')).body, { signups: false });
      const second = await http(ctx, 'POST', '/api/auth/register', body('intrus@selfhost.test'));
      assert.equal(second.status, 403);
      assert.match(second.body.error, /inscriptions sont fermées/);
      assert.equal(await db.selectFrom('users').select('id').where('email', '=', 'intrus@selfhost.test').executeTakeFirst(), undefined);

      // the existing account still signs in
      const login = await http(ctx, 'POST', '/api/auth/login', { json: { email: 'owner@selfhost.test', password: 'secret123' } });
      assert.equal(login.status, 200);
      assert.ok(login.body.token);
    } finally {
      env.ALLOW_SIGNUPS = true;
    }
    await registerUser(ctx); // open again
  });
});
