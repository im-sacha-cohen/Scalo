/**
 * Scalo Enterprise Edition — Copyright (c) 2026 Scalo. All rights reserved.
 * Licensed under the Scalo Enterprise License (see ee/LICENSE): source-available, NOT open source.
 * Production use requires a valid Scalo Enterprise subscription and license key.
 */
// Paramètres → Données et compte with a team: reserved to the owner (403 for every member, administrators included);
// deleting the account removes the members' logins, the invitations and the audit log.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../../api/src/db';
import { client, http, registerUser, shutdown, startApp, type TestCtx } from '../../../api/test/helpers';
import { auditIdle } from '../src/audit';
import { addMember, useLicense } from './ee-helpers';

let ctx: TestCtx;
before(async () => {
  ctx = await startApp({ account: { waitMs: 200 } });
});
after(() => shutdown(ctx));
beforeEach(() => useLicense({ seats: 10 }));

describe('données et compte : équipe', () => {
  test('un membre d’équipe reçoit 403, même administrateur ; rien n’est supprimé', async () => {
    const owner = await registerUser(ctx, 'Agence Équipe');
    const api = client(ctx, owner.token);
    await api.post('/api/contacts', { email: 'client@equipe.fr' });
    for (const role of ['admin', 'editor', 'viewer'] as const) {
      const m = await addMember(ctx, api, role);
      const body = { password: 'motdepasse123', confirm: owner.email };
      for (const [method, path] of [
        ['GET', '/api/account/summary'],
        ['POST', '/api/account/export'],
        ['POST', '/api/account/reset'],
        ['POST', '/api/account/delete'],
      ] as const) {
        const r = await http(ctx, method, path, { token: m.token, ...(method === 'POST' ? { json: body } : {}) });
        assert.equal(r.status, 403, `${role} ${method} ${path} → ${r.status}`);
        // administrators: owner-only area; editors / viewers: the generic role rule or the owner check
        if (role === 'admin' || method === 'GET') assert.match(r.body.error, /propriétaire/);
      }
    }
    assert.equal((await api.get('/api/contacts')).body.total, 1);
    assert.equal((await api.get('/api/account/summary')).body.counts.team_members, 3);
  });

  test('suppression du compte : membres (et leurs connexions), invitations et journal d’audit supprimés', async () => {
    const owner = await registerUser(ctx, 'Agence Fermée');
    const api = client(ctx, owner.token);
    const admin = await addMember(ctx, api, 'admin');
    const editor = await addMember(ctx, api, 'editor');
    assert.equal((await api.post('/api/team/invitations', { email: 'pas-encore@equipe.test', role: 'viewer' })).status, 201);
    await api.post('/api/contacts', { email: 'x@equipe.fr' });
    await auditIdle();
    assert.ok((await db.selectFrom('audit_logs').select('id').where('account_id', '=', owner.user.id).execute()).length > 0);
    const other = await registerUser(ctx, 'Autre agence');
    const otherMember = await addMember(ctx, client(ctx, other.token), 'editor');

    const r = await api.post('/api/account/delete', { password: 'secret123', confirm: owner.email });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.deleted.team_members, 2);
    await auditIdle();

    for (const m of [admin, editor]) {
      assert.equal((await http(ctx, 'GET', '/api/auth/me', { token: m.token })).status, 401, 'JWT du membre');
      assert.equal((await http(ctx, 'POST', '/api/auth/login', { json: { email: m.email, password: 'motdepasse123' } })).status, 401);
    }
    assert.equal((await db.selectFrom('users').select('id').where('id', 'in', [owner.user.id, admin.userId, editor.userId]).execute()).length, 0);
    assert.equal((await db.selectFrom('account_members').select('id').where('account_id', '=', owner.user.id).execute()).length, 0);
    assert.equal((await db.selectFrom('account_invitations').select('id').where('account_id', '=', owner.user.id).execute()).length, 0);
    assert.equal((await db.selectFrom('audit_logs').select('id').where('account_id', '=', owner.user.id).execute()).length, 0);
    // the other account and its team are untouched
    assert.equal((await http(ctx, 'GET', '/api/auth/me', { token: other.token })).status, 200);
    assert.equal((await http(ctx, 'GET', '/api/contacts', { token: otherMember.token })).status, 200);
  });
});
