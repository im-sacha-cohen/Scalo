import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db';
import { client, http, registerUser, shutdown, startApp, type TestCtx } from './helpers';

let ctx: TestCtx;
before(async () => {
  ctx = await startApp();
});
after(() => shutdown(ctx));

describe('health', () => {
  test('GET /api/health checks the database', async () => {
    const r = await http(ctx, 'GET', '/api/health');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, db: 'up' });
  });
});

describe('auth', () => {
  test('register → login → me', async () => {
    const reg = await http(ctx, 'POST', '/api/auth/register', { json: { email: 'Alice@Example.com', password: 'secret123', name: 'Alice' } });
    assert.equal(reg.status, 201);
    assert.equal(reg.body.user.email, 'alice@example.com');
    assert.equal(typeof reg.body.user.id, 'number');
    assert.match(reg.body.user.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const dup = await http(ctx, 'POST', '/api/auth/register', { json: { email: 'alice@example.com', password: 'secret123', name: 'A' } });
    assert.equal(dup.status, 409);

    const bad = await http(ctx, 'POST', '/api/auth/login', { json: { email: 'alice@example.com', password: 'nope' } });
    assert.equal(bad.status, 401);

    const login = await http(ctx, 'POST', '/api/auth/login', { json: { email: 'ALICE@example.com', password: 'secret123' } });
    assert.equal(login.status, 200);
    const me = await http(ctx, 'GET', '/api/auth/me', { token: login.body.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.name, 'Alice');

    // default settings row created with the account
    const settings = await client(ctx, login.body.token).get('/api/settings');
    assert.equal(settings.body.sender_email, 'alice@example.com');
    assert.equal(settings.body.smtp_secure, false);
    assert.equal(settings.body.rate_per_minute, 60);
  });

  test('401 without / with an invalid token', async () => {
    assert.equal((await http(ctx, 'GET', '/api/contacts')).status, 401);
    assert.equal((await http(ctx, 'GET', '/api/contacts', { token: 'garbage' })).status, 401);
  });

  test('400 on invalid payload', async () => {
    const r = await http(ctx, 'POST', '/api/auth/register', { json: { email: 'nope', password: '1', name: '' } });
    assert.equal(r.status, 400);
    assert.ok(r.body.error);
  });
});

describe('contacts & tags', () => {
  test('CRUD, tags, search, pagination', async () => {
    const { token } = await registerUser(ctx);
    const api = client(ctx, token);

    const c = await api.post('/api/contacts', { email: 'Jean.Dupont@Mail.fr', first_name: 'Jean', last_name: 'Dupont', tags: ['vip', 'lead'] });
    assert.equal(c.status, 201);
    assert.equal(c.body.email, 'jean.dupont@mail.fr');
    assert.equal(c.body.unsubscribed, 0);
    assert.equal(c.body.bounced, 0);
    assert.deepEqual(c.body.tags.map((t: { name: string }) => t.name), ['lead', 'vip']);

    assert.equal((await api.post('/api/contacts', { email: 'jean.dupont@mail.fr' })).status, 409);
    await api.post('/api/contacts', { email: 'marie@mail.fr', first_name: 'Marie' });

    const search = await api.get('/api/contacts?search=JEAN%20dup');
    assert.equal(search.body.total, 1);
    const page = await api.get('/api/contacts?limit=1&page=2');
    assert.equal(page.body.total, 2);
    assert.equal(page.body.items.length, 1);
    assert.equal(page.body.items[0].email, 'jean.dupont@mail.fr'); // created_at desc

    // LIKE wildcards are escaped
    assert.equal((await api.get('/api/contacts?search=%25')).body.total, 0);

    const tags = await api.get('/api/tags');
    const vip = tags.body.find((t: { name: string }) => t.name === 'vip');
    assert.equal(vip.contacts_count, 1);
    assert.equal((await api.get(`/api/contacts?tag_id=${vip.id}`)).body.total, 1);
    assert.equal((await api.post('/api/tags', { name: 'VIP' })).status, 409); // case-insensitive

    const withTag = await api.post(`/api/contacts/${c.body.id}/tags`, { name: 'Client' });
    assert.equal(withTag.body.tags.length, 3);
    const untag = await api.del(`/api/contacts/${c.body.id}/tags/${vip.id}`);
    assert.deepEqual(untag.body.tags.map((t: { name: string }) => t.name), ['Client', 'lead']);

    const patched = await api.patch(`/api/contacts/${c.body.id}`, { phone: '0600000000', unsubscribed: true });
    assert.equal(patched.body.phone, '0600000000');
    assert.equal(patched.body.unsubscribed, 1);
    assert.equal((await api.patch(`/api/contacts/${c.body.id}`, { email: 'marie@mail.fr' })).status, 409);

    const detail = await api.get(`/api/contacts/${c.body.id}`);
    const types = detail.body.events.map((e: { type: string }) => e.type);
    for (const t of ['created', 'tag_added', 'tag_removed', 'unsubscribed']) assert.ok(types.includes(t), t);
    assert.equal(typeof detail.body.events[0].data, 'object');

    const exp = await api.get('/api/contacts/export');
    assert.match(exp.headers.get('content-type') ?? '', /text\/csv/);
    assert.match(exp.text, /jean\.dupont@mail\.fr,Jean,Dupont,0600000000,Client\|lead,1,/);

    assert.deepEqual((await api.del(`/api/contacts/${c.body.id}`)).body, { ok: true });
    assert.equal((await api.get(`/api/contacts/${c.body.id}`)).status, 404);
    assert.equal((await api.del(`/api/tags/${vip.id}`)).status, 200);
    assert.equal((await api.del(`/api/tags/${vip.id}`)).status, 404);
  });

  test('CSV import (separators, headers, upsert, tag + campaign enrollment)', async () => {
    const { token } = await registerUser(ctx);
    const api = client(ctx, token);
    await api.post('/api/contacts', { email: 'exists@mail.fr', first_name: 'Old' });
    const tag = (await api.post('/api/tags', { name: 'import' })).body;
    const camp = (await api.post('/api/campaigns', { name: 'Bienvenue', trigger_tag_id: tag.id })).body;
    await api.post(`/api/campaigns/${camp.id}/emails`, { subject: 'Hello', delay_days: 0 });

    const csv = '﻿E-mail;Prénom;Nom;Téléphone\nnew1@mail.fr;Anne;A;01\nEXISTS@mail.fr;New;;\nnot-an-email;x;y;z\n"new2@mail.fr";"Ann ""Q""";B;\n';
    const r = await api.post('/api/contacts/import', { csv, tag: 'import' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { created: 2, updated: 1, skipped: 1 });

    const list = await api.get('/api/contacts?limit=10');
    const byEmail = Object.fromEntries(list.body.items.map((c: { email: string }) => [c.email, c]));
    assert.equal(byEmail['exists@mail.fr'].first_name, 'New');
    assert.equal(byEmail['new2@mail.fr'].first_name, 'Ann "Q"');
    assert.equal(byEmail['new1@mail.fr'].phone, '01');
    assert.ok(byEmail['new1@mail.fr'].tags.some((t: { name: string }) => t.name === 'import'));

    // tag → campaign → one pending send per contact
    const sends = await db.selectFrom('email_sends').select(['to_email', 'status']).where('campaign_id', '=', camp.id).execute();
    assert.equal(sends.length, 3);
    assert.ok(sends.every((s) => s.status === 'pending'));
    const c = await api.get(`/api/campaigns/${camp.id}`);
    assert.equal(c.body.subscribers, 3);

    // idempotent: re-importing doesn't enroll twice
    await api.post('/api/contacts/import', { csv, tag: 'import' });
    assert.equal((await db.selectFrom('email_sends').select('id').where('campaign_id', '=', camp.id).execute()).length, 3);

    assert.equal((await api.post('/api/contacts/import', { csv: 'name\nfoo' })).status, 400);
  });

  test('tenant isolation: other accounts get 404', async () => {
    const a = client(ctx, (await registerUser(ctx, 'A')).token);
    const b = client(ctx, (await registerUser(ctx, 'B')).token);
    const c = (await a.post('/api/contacts', { email: 'secret@mail.fr' })).body;
    const tag = (await a.post('/api/tags', { name: 'private' })).body;
    assert.equal((await b.get(`/api/contacts/${c.id}`)).status, 404);
    assert.equal((await b.patch(`/api/contacts/${c.id}`, { first_name: 'x' })).status, 404);
    assert.equal((await b.del(`/api/contacts/${c.id}`)).status, 404);
    assert.equal((await b.post(`/api/contacts/${c.id}/tags`, { name: 'x' })).status, 404);
    assert.equal((await b.del(`/api/tags/${tag.id}`)).status, 404);
    assert.equal((await b.get('/api/contacts')).body.total, 0);
    // same email is fine in another account
    assert.equal((await b.post('/api/contacts', { email: 'secret@mail.fr' })).status, 201);
    assert.equal((await a.get('/api/contacts/abc')).status, 404);
  });
});

describe('dashboard', () => {
  test('30 UTC days, zero-filled, with today’s activity', async () => {
    const { token } = await registerUser(ctx);
    const api = client(ctx, token);
    await api.post('/api/contacts', { email: 'd1@mail.fr' });
    await api.post('/api/contacts', { email: 'd2@mail.fr' });
    const r = await api.get('/api/dashboard');
    assert.equal(r.status, 200);
    assert.equal(r.body.daily.length, 30);
    const today = new Date().toISOString().slice(0, 10);
    const start = new Date(Date.now() - 29 * 86400_000).toISOString().slice(0, 10);
    assert.equal(r.body.daily[29].date, today);
    assert.equal(r.body.daily[0].date, start);
    for (let i = 1; i < 30; i++) assert.ok(r.body.daily[i].date > r.body.daily[i - 1].date);
    assert.equal(r.body.daily[29].contacts, 2);
    assert.equal(r.body.contacts, 2);
    assert.equal(r.body.new_contacts_7d, 2);
    assert.equal(r.body.open_rate, 0);
    for (const k of ['funnels', 'views_30d', 'optins_30d', 'emails_sent_30d']) assert.equal(typeof r.body[k], 'number');
  });
});
