/**
 * Scalo Enterprise Edition — Copyright (c) 2026 Scalo. All rights reserved.
 * Licensed under the Scalo Enterprise License (see ee/LICENSE): source-available, NOT open source.
 * Production use requires a valid Scalo Enterprise subscription and license key.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { client, registerUser, shutdown, startApp, type TestCtx } from '../../../api/test/helpers';
import { GRACE_DAYS, generateKeyPair, LICENSE_PREFIX, validity, verifyLicense } from '../src/license/format';
import { PRODUCTION_PUBLIC_KEYS, setTestPublicKeys, trustedPublicKeys } from '../src/license/keys';
import { license, licenseState } from '../src/license/service';
import { inDays, issue, testKeys, useLicense } from './ee-helpers';

let ctx: TestCtx;
before(async () => {
  ctx = await startApp();
});
after(() => shutdown(ctx));

describe('license key format (offline Ed25519)', () => {
  test('a key signed with the trusted private key verifies and carries customer, plan, features, seats, expiration', () => {
    const key = issue({ customer: 'Agence Dupont', plan: 'agency', features: ['team'], seats: 12 });
    assert.ok(key.startsWith(LICENSE_PREFIX));
    const r = verifyLicense(key, [testKeys.publicKey]);
    assert.ok(r.ok);
    assert.equal(r.payload.customer, 'Agence Dupont');
    assert.equal(r.payload.plan, 'agency');
    assert.deepEqual(r.payload.features, ['team']);
    assert.equal(r.payload.seats, 12);
    assert.ok(Date.parse(r.payload.expires_at) > Date.now());
  });

  test('tampered payload (more seats, later expiration) is refused', () => {
    const key = issue({ seats: 2 });
    const [body, sig] = key.slice(LICENSE_PREFIX.length).split('.');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    const forged = Buffer.from(JSON.stringify({ ...payload, seats: 500, expires_at: inDays(9999) })).toString('base64url');
    const r = verifyLicense(`${LICENSE_PREFIX}${forged}.${sig}`, [testKeys.publicKey]);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /Signature invalide/);
  });

  test('a key signed by another private key is refused (bad signature)', () => {
    const other = generateKeyPair();
    const r = verifyLicense(issue({}, other.privateKeyPem), [testKeys.publicKey]);
    assert.equal(r.ok, false);
    // …and accepted once that key is trusted too (rotation: any trusted key)
    assert.equal(verifyLicense(issue({}, other.privateKeyPem), [testKeys.publicKey, other.publicKey]).ok, true);
  });

  test('malformed keys and missing public key', () => {
    for (const bad of ['', 'hello', 'scalo_lic_', 'scalo_lic_abc', 'scalo_lic_abc.def', `${issue()}x`, `${issue()}.extra`, issue().replace(LICENSE_PREFIX, 'other_')]) {
      assert.equal(verifyLicense(bad, [testKeys.publicKey]).ok, false, bad);
    }
    assert.equal(verifyLicense(issue(), []).ok, false);
    assert.equal(verifyLicense(issue(), ['not-a-key']).ok, false);
  });

  test('validity: valid, grace period, expired', () => {
    assert.equal(validity({ expires_at: inDays(10) }).status, 'valid');
    assert.equal(validity({ expires_at: inDays(10) }).daysLeft, 10);
    assert.equal(validity({ expires_at: inDays(-1) }).status, 'grace');
    assert.equal(validity({ expires_at: inDays(-(GRACE_DAYS - 1)) }).status, 'grace');
    assert.equal(validity({ expires_at: inDays(-(GRACE_DAYS + 1)) }).status, 'expired');
  });

  test('the production public key is a documented placeholder; test keys are ignored in production', () => {
    assert.deepEqual(PRODUCTION_PUBLIC_KEYS, []);
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      process.env.SCALO_LICENSE_PUBLIC_KEY = testKeys.publicKey;
      assert.deepEqual(trustedPublicKeys(), PRODUCTION_PUBLIC_KEYS);
      setTestPublicKeys(['ignored']);
      assert.deepEqual(trustedPublicKeys(), PRODUCTION_PUBLIC_KEYS);
    } finally {
      process.env.NODE_ENV = env;
      delete process.env.SCALO_LICENSE_PUBLIC_KEY;
    }
    assert.deepEqual(trustedPublicKeys(), [testKeys.publicKey]);
  });
});

describe('license service and Paramètres → Licence', () => {
  test('no license: Enterprise edition loaded, no feature, the core is untouched', async () => {
    useLicense(null);
    const api = client(ctx, (await registerUser(ctx)).token);
    const ed = await api.get('/api/edition');
    assert.equal(ed.status, 200);
    assert.equal(ed.body.edition, 'enterprise');
    assert.equal(ed.body.license.status, 'none');
    assert.deepEqual(ed.body.features, []);
    assert.equal(ed.body.role, 'owner');
    assert.equal(license.has('team'), false);
    // Enterprise features answer 402, the core keeps working
    assert.equal((await api.post('/api/team/invitations', { email: 'x@y.test', role: 'editor' })).status, 402);
    assert.equal((await api.get('/api/audit')).status, 402);
    assert.equal((await api.put('/api/branding', { hide_powered_by: true, powered_by_text: '', powered_by_url: '', app_name: '', logo_url: '' })).status, 402);
    assert.equal((await api.post('/api/contacts', { email: 'core@works.test' })).status, 201);
  });

  test('entering a key from the interface: invalid refused (nothing stored), valid stored, removable', async () => {
    useLicense(null);
    // the first account of the instance is its administrator
    const first = await registerUser(ctx);
    const { db } = await import('../../../api/src/db');
    const minId = (await db.selectFrom('users').select((eb) => eb.fn.min('id').as('id')).executeTakeFirstOrThrow()).id;
    const admin = await db.selectFrom('users').select('email').where('id', '=', minId).executeTakeFirstOrThrow();
    const login = await client(ctx, '').post('/api/auth/login', { email: admin.email, password: 'secret123' });
    const api = client(ctx, login.body.token);
    void first;

    const before = await api.get('/api/license');
    assert.equal(before.body.status, 'none');
    assert.equal(before.body.can_manage, true);

    const forged = issue({}, generateKeyPair().privateKeyPem);
    const bad = await api.put('/api/license', { key: forged });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /Signature invalide/);
    assert.equal((await api.put('/api/license', { key: 'n-importe-quoi' })).status, 400);
    assert.equal((await api.get('/api/license')).body.status, 'none');

    const ok = await api.put('/api/license', { key: issue({ customer: 'Client SA', seats: 7, features: ['team', 'audit_log'] }) });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.status, 'valid');
    assert.equal(ok.body.source, 'database');
    assert.equal(ok.body.customer, 'Client SA');
    assert.equal(ok.body.seats, 7);
    assert.deepEqual(ok.body.features, ['team', 'audit_log']);
    assert.equal(license.has('team'), true);
    assert.equal(license.has('white_label'), false, 'feature not in the key');
    // feature missing from an otherwise valid license
    assert.equal((await api.put('/api/branding', { hide_powered_by: true, powered_by_text: '', powered_by_url: '', app_name: '', logo_url: '' })).status, 402);
    assert.equal((await api.get('/api/audit')).status, 200);

    // another account (not the instance administrator) sees the state but cannot change it
    const other = client(ctx, (await registerUser(ctx)).token);
    const seen = await other.get('/api/license');
    assert.equal(seen.body.status, 'valid');
    assert.equal(seen.body.can_manage, false);
    assert.equal((await other.put('/api/license', { key: issue() })).status, 403);
    assert.equal((await other.del('/api/license')).status, 403);

    // SCALO_LICENSE_KEY wins and locks the interface
    useLicense({ customer: 'Env SARL' });
    const env = await api.get('/api/license');
    assert.equal(env.body.source, 'env');
    assert.equal(env.body.customer, 'Env SARL');
    assert.equal(env.body.can_manage, false);
    assert.equal((await api.put('/api/license', { key: issue() })).status, 409);
    useLicense(null);

    const removed = await api.del('/api/license');
    assert.equal(removed.body.status, 'none');
    assert.equal(license.has('team'), false);
  });

  test('expired license: grace period keeps the features (banner state), then they turn off — never the core', async () => {
    const api = client(ctx, (await registerUser(ctx)).token);

    useLicense({ expires_at: inDays(-2) });
    assert.equal(licenseState().status, 'grace');
    assert.equal(license.has('team'), true);
    const grace = await api.get('/api/edition');
    assert.equal(grace.body.license.status, 'grace');
    assert.ok(Date.parse(grace.body.license.grace_until) > Date.now());
    assert.deepEqual(grace.body.features, ['team', 'audit_log', 'white_label']);
    assert.equal((await api.get('/api/team')).status, 200);

    useLicense({ expires_at: inDays(-(GRACE_DAYS + 3)) });
    assert.equal(licenseState().status, 'expired');
    assert.equal(license.has('team'), false);
    const expired = await api.get('/api/edition');
    assert.equal(expired.body.license.status, 'expired');
    assert.deepEqual(expired.body.features, []);
    assert.deepEqual(expired.body.license.features, ['team', 'audit_log', 'white_label'], 'the key still lists what it covered');
    assert.equal((await api.post('/api/team/invitations', { email: 'late@y.test', role: 'editor' })).status, 402);
    const info = await api.get('/api/license');
    assert.equal(info.body.status, 'expired');
    assert.ok(info.body.days_left < 0);
    // data and core: untouched
    assert.equal((await api.post('/api/contacts', { email: 'still@works.test' })).status, 201);
    assert.equal((await api.get('/api/contacts')).body.total, 1);
    assert.equal((await api.get('/api/settings')).status, 200);
  });

  test('invalid key in the environment: status invalid, no feature, no crash', async () => {
    process.env.SCALO_LICENSE_KEY = `${issue()}tampered`;
    const api = client(ctx, (await registerUser(ctx)).token);
    const ed = await api.get('/api/edition');
    assert.equal(ed.body.license.status, 'invalid');
    assert.deepEqual(ed.body.features, []);
    assert.match((await api.get('/api/license')).body.error, /Signature|mal formée/);
    assert.equal((await api.get('/api/contacts')).status, 200);
    useLicense(null);
  });
});
