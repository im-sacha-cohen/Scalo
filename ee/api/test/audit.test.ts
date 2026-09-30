/**
 * Scalo Enterprise Edition — Copyright (c) 2026 Scalo. All rights reserved.
 * Licensed under the Scalo Enterprise License (see ee/LICENSE): source-available, NOT open source.
 * Production use requires a valid Scalo Enterprise subscription and license key.
 */
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../../api/src/db';
import { client, registerUser, shutdown, startApp, type TestCtx } from '../../../api/test/helpers';
import { auditIdle, describeAction, purgeAuditLogs } from '../src/audit';
import { addMember, inDays, useLicense } from './ee-helpers';

let ctx: TestCtx;
before(async () => {
  ctx = await startApp();
});
after(() => shutdown(ctx));
beforeEach(() => useLicense());

/** Entries are written after the response is sent. */
async function entries(api: ReturnType<typeof client>, query = '') {
  await new Promise((r) => setTimeout(r, 30));
  await auditIdle();
  const r = await api.get(`/api/audit${query}`);
  assert.equal(r.status, 200, r.text);
  return r.body as { items: any[]; total: number; retention_days: number };
}

describe('audit log', () => {
  test('action names', () => {
    assert.deepEqual(describeAction('POST', '/contacts'), { action: 'contacts.create', resourceType: 'contacts', resourceId: null });
    assert.deepEqual(describeAction('PATCH', '/contacts/12'), { action: 'contacts.update', resourceType: 'contacts', resourceId: '12' });
    assert.deepEqual(describeAction('DELETE', '/contacts/12/tags/5'), { action: 'contacts.tags.delete', resourceType: 'contacts', resourceId: '12' });
    assert.deepEqual(describeAction('POST', '/broadcasts/5/send'), { action: 'broadcasts.send', resourceType: 'broadcasts', resourceId: '5' });
    assert.deepEqual(describeAction('PUT', '/settings'), { action: 'settings.update', resourceType: 'settings', resourceId: null });
  });

  test('who did what: actor, role, action, resource, IP, date — mutations only, refusals included', async () => {
    const o = await registerUser(ctx);
    const owner = client(ctx, o.token);
    const editor = await addMember(ctx, owner, 'editor', 'edith@audit.test');
    const viewer = await addMember(ctx, owner, 'viewer', 'victor@audit.test');

    const c = await editor.api.post('/api/contacts', { email: 'nouveau@exemple.fr' });
    await editor.api.patch(`/api/contacts/${c.body.id}`, { first_name: 'Nina' });
    await editor.api.get('/api/contacts'); // reads are not logged
    await editor.api.post('/api/contacts', { email: 'pas-un-email' }); // 400: nothing happened, not logged
    await viewer.api.del(`/api/contacts/${c.body.id}`); // refused: logged as 403
    await owner.put('/api/settings', { sender_name: 'Audit' });

    const log = await entries(owner);
    const byAction = (a: string) => log.items.filter((e) => e.action === a);

    const created = byAction('contacts.create');
    assert.equal(created.length, 1);
    assert.equal(created[0].actor_email, 'edith@audit.test');
    assert.equal(created[0].actor_id, editor.userId);
    assert.equal(created[0].actor_role, 'editor');
    assert.equal(created[0].method, 'POST');
    assert.equal(created[0].path, '/contacts');
    assert.equal(created[0].status, 201);
    assert.match(created[0].ip, /127\.0\.0\.1/);
    assert.ok(Date.now() - Date.parse(created[0].created_at) < 60_000);

    const updated = byAction('contacts.update')[0];
    assert.equal(updated.resource_type, 'contacts');
    assert.equal(updated.resource_id, String(c.body.id));

    const refused = byAction('contacts.delete')[0];
    assert.equal(refused.status, 403);
    assert.equal(refused.actor_email, 'victor@audit.test');
    assert.equal(refused.actor_role, 'viewer');

    const settings = byAction('settings.update')[0];
    assert.equal(settings.actor_email, o.email);
    assert.equal(settings.actor_role, 'owner');

    // team events: invitations sent by the owner, accepted by the members
    assert.equal(byAction('team.invitations').length, 2);
    assert.equal(byAction('team.invitation_accepted').length, 2);
    assert.ok(!log.items.some((e) => e.method === 'GET'));
    assert.ok(!log.items.some((e) => e.status === 400));
    // newest first
    assert.deepEqual(log.items.map((e) => e.id), [...log.items.map((e) => e.id)].sort((a, b) => b - a));

    // filters and pagination
    assert.equal((await entries(owner, `?actor_id=${viewer.userId}`)).total, 2); // accepted invitation + refused delete
    assert.equal((await entries(owner, '?search=settings')).total, 1);
    const page = await entries(owner, '?limit=2&page=2');
    assert.equal(page.items.length, 2);
    assert.equal(page.total, log.total);
    // request bodies (passwords, secrets) are never stored
    const raw = await db.selectFrom('audit_logs').selectAll().where('account_id', '=', o.user.id).execute();
    assert.ok(!JSON.stringify(raw).includes('motdepasse123'));
  });

  test('CSV export', async () => {
    const owner = client(ctx, (await registerUser(ctx)).token);
    await owner.post('/api/tags', { name: '=cmd|calc' });
    await owner.post('/api/contacts', { email: 'csv@exemple.fr' });
    await entries(owner);
    const r = await owner.get('/api/audit/export');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /text\/csv/);
    assert.match(r.headers.get('content-disposition') ?? '', /journal-audit\.csv/);
    const lines = r.text.replace(/^﻿/, '').trim().split('\n');
    assert.equal(lines[0], 'date,acteur,role,action,methode,chemin,ressource,id_ressource,statut,ip');
    assert.equal(lines.length, 3);
    assert.ok(lines.some((l) => l.includes(',contacts.create,POST,/contacts,contacts,,201,')));
  });

  test('isolation: an account only sees its own entries; editors and readers cannot read the log', async () => {
    const a = client(ctx, (await registerUser(ctx)).token);
    const b = client(ctx, (await registerUser(ctx)).token);
    await a.post('/api/contacts', { email: 'a@a.test' });
    await b.post('/api/contacts', { email: 'b@b.test' });
    await b.post('/api/tags', { name: 'b' });
    assert.equal((await entries(a)).total, 1);
    assert.equal((await entries(b)).total, 2);
    const editor = await addMember(ctx, a, 'editor');
    assert.equal((await editor.api.get('/api/audit')).status, 403);
    assert.equal((await editor.api.get('/api/audit/export')).status, 403);
    assert.equal((await editor.api.put('/api/audit/settings', { retention_days: 1 })).status, 403);
  });

  test('configurable retention', async () => {
    const o = await registerUser(ctx);
    const owner = client(ctx, o.token);
    const other = await registerUser(ctx);
    await owner.post('/api/contacts', { email: 'recent@exemple.fr' });
    await client(ctx, other.token).post('/api/contacts', { email: 'autre@exemple.fr' });
    assert.equal((await entries(owner)).retention_days, 365);
    // two old entries on each account: 40 and 400 days
    for (const id of [o.user.id, other.user.id]) {
      for (const days of [40, 400]) {
        await db.insertInto('audit_logs').values({ account_id: id, actor_id: id, action: `old.${days}`, method: 'POST', path: '/old', status: 200, created_at: inDays(-days) }).execute();
      }
    }
    // default retention (365 days): the 400-day entries go, on every account
    assert.equal(await purgeAuditLogs(), 2);
    assert.equal((await entries(owner)).total, 2);

    assert.equal((await owner.put('/api/audit/settings', { retention_days: 0 })).status, 400);
    assert.equal((await owner.put('/api/audit/settings', { retention_days: 5000 })).status, 400);
    const set = await owner.put('/api/audit/settings', { retention_days: 30 });
    assert.equal(set.status, 200);
    assert.equal(set.body.purged, 1, 'the 40-day entry of this account is purged at once');
    const after = await entries(owner);
    assert.equal(after.retention_days, 30);
    assert.ok(!after.items.some((e) => e.action.startsWith('old.')));
    // the other account keeps its own (default) retention
    const kept = await db.selectFrom('audit_logs').select('action').where('account_id', '=', other.user.id).where('action', 'like', 'old.%').execute();
    assert.deepEqual(kept.map((k) => k.action), ['old.40']);
  });

  test('without the audit_log feature: nothing is recorded, the screen answers 402, existing entries stay exportable', async () => {
    const o = await registerUser(ctx);
    const owner = client(ctx, o.token);
    await owner.post('/api/contacts', { email: 'avant@exemple.fr' });
    await entries(owner);

    useLicense({ features: ['team'] });
    await owner.post('/api/contacts', { email: 'pendant@exemple.fr' });
    await new Promise((r) => setTimeout(r, 30));
    await auditIdle();
    assert.equal((await owner.get('/api/audit')).status, 402);
    assert.equal((await owner.put('/api/audit/settings', { retention_days: 30 })).status, 402);
    const n = await db.selectFrom('audit_logs').select((eb) => eb.fn.countAll<number>().as('n')).where('account_id', '=', o.user.id).executeTakeFirstOrThrow();
    assert.equal(n.n, 1);
    // data is never held hostage
    const exp = await owner.get('/api/audit/export');
    assert.equal(exp.status, 200);
    assert.equal(exp.text.trim().split('\n').length, 2);
    // an account with no entry at all gets the Enterprise answer
    const fresh = client(ctx, (await registerUser(ctx)).token);
    assert.equal((await fresh.get('/api/audit/export')).status, 402);
  });
});
