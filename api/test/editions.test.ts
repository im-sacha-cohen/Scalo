// Community edition: the core without the Enterprise directory. SCALO_DISABLE_EE=1 makes the registry (src/ee.ts)
// ignore `ee/` exactly as if it had been deleted (`npm run check:core` also runs the suite on a copy without it).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../src/db';
import { roleAllows } from '../src/access';
import { ee, loadEe } from '../src/ee';
import { client, http, registerUser, shutdown, startApp, type TestCtx } from './helpers';

process.env.SCALO_DISABLE_EE = '1';

let ctx: TestCtx;
before(async () => {
  ctx = await startApp();
});
after(() => shutdown(ctx));

describe('community edition (no ee/)', () => {
  test('the extension is not loaded; /api/edition answers community, owner, no license', async () => {
    assert.equal(await loadEe(), null);
    assert.equal(ee(), null);
    const u = await registerUser(ctx, 'Solo');
    const api = client(ctx, u.token);
    const ed = await api.get('/api/edition');
    assert.equal(ed.status, 200);
    assert.deepEqual(ed.body, {
      edition: 'community',
      license: { status: 'none', plan: null, features: [], seats: null, expires_at: null, grace_until: null },
      features: [],
      branding: null,
      role: 'owner',
      actor: { id: u.user.id, name: 'Solo', email: u.email },
      account: { id: u.user.id, name: 'Solo', email: u.email },
    });
    assert.equal((await http(ctx, 'GET', '/api/edition')).status, 401);
  });

  test('Enterprise routes do not exist; the core works', async () => {
    const api = client(ctx, (await registerUser(ctx)).token);
    for (const p of ['/api/team', '/api/license', '/api/audit', '/api/branding']) assert.equal((await api.get(p)).status, 404, p);
    assert.equal((await api.post('/api/team/invitations', { email: 'a@b.test', role: 'editor' })).status, 404);
    assert.equal((await http(ctx, 'GET', '/api/invitations/scalo_inv_x')).status, 401, 'no public invitation route: falls through to the authenticated API');
    assert.equal((await api.post('/api/contacts', { email: 'core@exemple.fr' })).status, 201);
    assert.equal((await api.put('/api/settings', { sender_name: 'Moi' })).status, 200);
    assert.equal((await api.get('/api/auth/me')).status, 200);
  });

  test('« Propulsé par Scalo » is shown on public pages and emails, and nothing can remove it', async () => {
    const api = client(ctx, (await registerUser(ctx)).token);
    const f = await api.post('/api/funnels', { name: 'Communautaire', template: 'optin' });
    const page = await http(ctx, 'GET', `/p/${f.body.slug}/${f.body.steps[0].slug}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /data-scalo-powered[^>]*>.*Propulsé par Scalo/);
    const mail = await api.post('/api/preview/email', { content: { settings: {}, blocks: [{ id: 't', type: 'text', text: 'Bonjour' }] }, subject: 'S' });
    assert.ok(mail.text.includes('Propulsé par Scalo'));
    assert.ok(mail.text.includes('Se désinscrire'));
  });

  test('team rows in the database are ignored: every user is the owner of his own account only', async () => {
    const a = await registerUser(ctx);
    const b = await registerUser(ctx);
    await client(ctx, a.token).post('/api/contacts', { email: 'prive@a.test' });
    // what the Enterprise code would have written
    await db.insertInto('account_members').values({ account_id: a.user.id, user_id: b.user.id, role: 'admin', invited_by: a.user.id }).execute();
    const asB = client(ctx, b.token);
    assert.equal((await asB.get('/api/contacts')).body.total, 0);
    assert.equal((await asB.get('/api/edition')).body.account.id, b.user.id);
    assert.equal((await asB.get('/api/edition')).body.role, 'owner');
  });

  test('the core never references ee/ outside its two registries', () => {
    const root = path.resolve(import.meta.dirname, '../..');
    const allowed = new Set(['api/src/ee.ts', 'web/src/lib/ee.ts', 'web/src/index.css']); // index.css: Tailwind @source only
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(ts|tsx|css)$/.test(e.name)) {
          const rel = path.relative(root, full);
          if (!allowed.has(rel) && /(from\s+|import\(\s*|require\(\s*|glob[^(]*\(\s*|@source\s+)['"][^'"]*(\.\.\/)+ee\//.test(fs.readFileSync(full, 'utf8'))) offenders.push(rel);
        }
      }
    };
    for (const d of ['api/src', 'api/test', 'web/src', 'shared/src']) walk(path.join(root, d));
    assert.deepEqual(offenders, []);
  });
});

describe('roles: generic rule by method and area (src/access.ts)', () => {
  const cases: [string, string, boolean, boolean, boolean, boolean][] = [
    // method, path, owner, admin, editor, viewer
    ['GET', '/contacts', true, true, true, true],
    ['GET', '/contacts/export', true, true, true, true],
    ['POST', '/contacts', true, true, true, false],
    ['PATCH', '/contacts/3', true, true, true, false],
    ['DELETE', '/funnels/3', true, true, true, false],
    ['POST', '/contacts/query', true, true, true, true],
    ['POST', '/segments/preview', true, true, true, true],
    ['POST', '/contacts/bulk', true, true, true, false],
    ['PUT', '/funnels/3/settings', true, true, true, false],
    ['GET', '/settings', true, true, true, true],
    ['PUT', '/settings', true, true, false, false],
    ['POST', '/settings/test-smtp', true, true, false, false],
    ['GET', '/team', true, true, false, false],
    ['POST', '/team/invitations', true, true, false, false],
    ['GET', '/billing/invoices', true, true, false, false],
    ['POST', '/billing/checkout', true, true, false, false],
    ['POST', '/payments/settings', true, true, false, false],
    ['PUT', '/payments/settings', true, true, false, false],
    ['GET', '/payments/settings', true, true, true, true],
    ['PUT', '/ai/key', true, true, false, false],
    ['POST', '/ai/funnels', true, true, true, false],
    ['POST', '/orders/7/refund', true, true, false, false],
    ['POST', '/orders/7/cancel-subscription', true, true, false, false],
    ['POST', '/products', true, true, true, false],
    ['POST', '/courses/3/modules', true, true, true, false],
    ['POST', '/imports', true, true, true, false],
    ['GET', '/developer/apps', true, true, false, false],
    ['POST', '/oauth/consent', true, true, false, false],
    ['GET', '/license', true, true, true, true],
    ['PUT', '/license', true, false, false, false],
    ['DELETE', '/account', true, false, false, false],
    ['POST', '/anything/new', true, true, true, false],
    ['GET', '/anything/new?x=1', true, true, true, true],
  ];
  for (const [method, p, ...expected] of cases) {
    test(`${method} ${p}`, () => {
      assert.deepEqual((['owner', 'admin', 'editor', 'viewer'] as const).map((r) => roleAllows(r, method, p)), expected);
    });
  }
});
