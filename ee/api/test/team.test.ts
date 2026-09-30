/**
 * Scalo Enterprise Edition — Copyright (c) 2026 Scalo. All rights reserved.
 * Licensed under the Scalo Enterprise License (see ee/LICENSE): source-available, NOT open source.
 * Production use requires a valid Scalo Enterprise subscription and license key.
 */
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../../api/src/db';
import { client, http, registerUser, shutdown, startApp, type TestCtx } from '../../../api/test/helpers';
import { GRACE_DAYS } from '../src/license/format';
import { addMember, inDays, useLicense, type Api } from './ee-helpers';

let ctx: TestCtx;
before(async () => {
  ctx = await startApp();
});
after(() => shutdown(ctx));
beforeEach(() => useLicense({ seats: 10 }));

const tokenOf = (inviteUrl: string) => inviteUrl.split('/invite/')[1];

describe('invitations', () => {
  test('invite → hashed one-time link → the member signs in with his own email and password', async () => {
    const owner = await registerUser(ctx, 'Agence Martin');
    const api = client(ctx, owner.token);
    await api.post('/api/contacts', { email: 'client@exemple.fr' });

    const inv = await api.post('/api/team/invitations', { email: 'Lea@Equipe.test', role: 'editor' });
    assert.equal(inv.status, 201, inv.text);
    assert.equal(inv.body.invitation.email, 'lea@equipe.test');
    assert.equal(inv.body.email_sent, false, 'no SMTP configured in tests: the link is returned instead');
    const token = tokenOf(inv.body.invite_url);
    assert.match(token, /^scalo_inv_[\w-]{40,}$/);
    // only the SHA-256 of the token is stored
    const row = await db.selectFrom('account_invitations').selectAll().where('id', '=', inv.body.invitation.id).executeTakeFirstOrThrow();
    assert.notEqual(row.token_hash, token);
    assert.match(row.token_hash, /^[0-9a-f]{64}$/);

    const preview = await http(ctx, 'GET', `/api/invitations/${token}`);
    assert.equal(preview.status, 200);
    assert.deepEqual({ email: preview.body.email, role: preview.body.role, account_name: preview.body.account_name }, { email: 'lea@equipe.test', role: 'editor', account_name: 'Agence Martin' });
    assert.equal((await http(ctx, 'GET', '/api/invitations/scalo_inv_unknown')).status, 404);

    assert.equal((await http(ctx, 'POST', `/api/invitations/${token}/accept`, { json: { name: 'Léa', password: 'court' } })).status, 400);
    const acc = await http(ctx, 'POST', `/api/invitations/${token}/accept`, { json: { name: 'Léa', password: 'motdepasse123' } });
    assert.equal(acc.status, 201, acc.text);
    assert.equal(acc.body.user.email, 'lea@equipe.test');

    // single use
    assert.equal((await http(ctx, 'POST', `/api/invitations/${token}/accept`, { json: { name: 'Léa', password: 'motdepasse123' } })).status, 404);
    assert.equal((await http(ctx, 'GET', `/api/invitations/${token}`)).status, 404);

    // own credentials
    const login = await http(ctx, 'POST', '/api/auth/login', { json: { email: 'lea@equipe.test', password: 'motdepasse123' } });
    assert.equal(login.status, 200);
    const lea = client(ctx, login.body.token);
    const me = await lea.get('/api/auth/me');
    assert.equal(me.body.user.email, 'lea@equipe.test', '/auth/me is the signed-in person, not the account');
    const ed = await lea.get('/api/edition');
    assert.equal(ed.body.role, 'editor');
    assert.equal(ed.body.actor.email, 'lea@equipe.test');
    assert.equal(ed.body.account.id, owner.user.id);
    // she works on the owner's data
    const contacts = await lea.get('/api/contacts');
    assert.equal(contacts.body.total, 1);
    assert.equal(contacts.body.items[0].email, 'client@exemple.fr');

    const team = await api.get('/api/team');
    assert.equal(team.body.owner.id, owner.user.id);
    assert.equal(team.body.members.length, 1);
    assert.equal(team.body.members[0].role, 'editor');
    assert.equal(team.body.invitations.length, 0);
    assert.deepEqual(team.body.seats, { used: 2, limit: 10 });
  });

  test('expired invitation, revoked invitation, resent link', async () => {
    const api = client(ctx, (await registerUser(ctx)).token);
    const a = await api.post('/api/team/invitations', { email: 'a@expire.test', role: 'viewer' });
    await db.updateTable('account_invitations').set({ expires_at: inDays(-1) }).where('id', '=', a.body.invitation.id).execute();
    assert.equal((await http(ctx, 'GET', `/api/invitations/${tokenOf(a.body.invite_url)}`)).status, 404);
    const late = await http(ctx, 'POST', `/api/invitations/${tokenOf(a.body.invite_url)}/accept`, { json: { name: 'A', password: 'motdepasse123' } });
    assert.equal(late.status, 404);
    assert.match(late.body.error, /expirée/);
    assert.equal((await db.selectFrom('users').select('id').where('email', '=', 'a@expire.test').executeTakeFirst()), undefined);
    assert.equal((await api.get('/api/team')).body.invitations[0].expired, true);

    // resend: new link, the old one is dead
    const re = await api.post(`/api/team/invitations/${a.body.invitation.id}/resend`);
    assert.equal(re.status, 200);
    assert.notEqual(re.body.invite_url, a.body.invite_url);
    assert.equal((await http(ctx, 'GET', `/api/invitations/${tokenOf(a.body.invite_url)}`)).status, 404);
    assert.equal((await http(ctx, 'GET', `/api/invitations/${tokenOf(re.body.invite_url)}`)).status, 200);

    // revoke
    assert.equal((await api.del(`/api/team/invitations/${a.body.invitation.id}`)).status, 200);
    assert.equal((await http(ctx, 'POST', `/api/invitations/${tokenOf(re.body.invite_url)}/accept`, { json: { name: 'A', password: 'motdepasse123' } })).status, 404);
  });

  test('an email that already has an account cannot be invited; seats of the license are enforced', async () => {
    const owner = await registerUser(ctx);
    const other = await registerUser(ctx);
    const api = client(ctx, owner.token);
    assert.equal((await api.post('/api/team/invitations', { email: other.email, role: 'editor' })).status, 409);
    assert.equal((await api.post('/api/team/invitations', { email: 'pas-un-email', role: 'editor' })).status, 400);
    assert.equal((await api.post('/api/team/invitations', { email: 'x@y.test', role: 'owner' })).status, 400);

    // the address registers on its own between the invitation and its acceptance: refused, invitation still pending
    const inv = await api.post('/api/team/invitations', { email: 'race@y.test', role: 'editor' });
    await http(ctx, 'POST', '/api/auth/register', { json: { email: 'race@y.test', password: 'secret123', name: 'Race' } });
    assert.equal((await http(ctx, 'POST', `/api/invitations/${tokenOf(inv.body.invite_url)}/accept`, { json: { name: 'R', password: 'motdepasse123' } })).status, 409);
    await api.del(`/api/team/invitations/${inv.body.invitation.id}`);

    useLicense({ seats: 3 }); // owner + 2
    await addMember(ctx, api, 'editor');
    assert.equal((await api.post('/api/team/invitations', { email: 'two@y.test', role: 'viewer' })).status, 201);
    const full = await api.post('/api/team/invitations', { email: 'three@y.test', role: 'viewer' });
    assert.equal(full.status, 409);
    assert.match(full.body.error, /sièges/);
    assert.deepEqual((await api.get('/api/team')).body.seats, { used: 3, limit: 3 });
  });
});

describe('permissions by role (enforced by the API)', () => {
  let owner: Api, admin: Api, editor: Api, viewer: Api;
  let contactId: number, funnelId: number, memberIds: Record<string, number>;

  before(async () => {
    useLicense({ seats: 10 });
    const o = await registerUser(ctx, 'Compte principal');
    owner = client(ctx, o.token);
    contactId = (await owner.post('/api/contacts', { email: 'base@exemple.fr' })).body.id;
    funnelId = (await owner.post('/api/funnels', { name: 'Tunnel', template: 'blank' })).body.id;
    admin = (await addMember(ctx, owner, 'admin')).api;
    editor = (await addMember(ctx, owner, 'editor')).api;
    viewer = (await addMember(ctx, owner, 'viewer')).api;
    const team = await owner.get('/api/team');
    memberIds = Object.fromEntries(team.body.members.map((m: { role: string; id: number }) => [m.role, m.id]));
  });

  // [method, path, body, expected status for owner, admin, editor, viewer] — 403 = refused by the role
  const matrix: [string, string | (() => string), unknown, number, number, number, number][] = [
    // reads: everyone
    ['GET', '/api/contacts', undefined, 200, 200, 200, 200],
    ['GET', '/api/funnels', undefined, 200, 200, 200, 200],
    ['GET', '/api/broadcasts', undefined, 200, 200, 200, 200],
    ['GET', '/api/dashboard', undefined, 200, 200, 200, 200],
    ['GET', '/api/settings', undefined, 200, 200, 200, 200],
    ['GET', '/api/edition', undefined, 200, 200, 200, 200],
    ['POST', '/api/contacts/query', {}, 200, 200, 200, 200], // read-only POST
    // content mutations: not the read-only role
    ['POST', '/api/tags', { name: 'vip' }, 201, 409, 409, 403],
    ['PATCH', () => `/api/contacts/${contactId}`, { first_name: 'Zoé' }, 200, 200, 200, 403],
    ['POST', '/api/broadcasts', { subject: 'Hello' }, 201, 201, 201, 403],
    ['PATCH', () => `/api/funnels/${funnelId}`, { name: 'Tunnel 2' }, 200, 200, 200, 403],
    ['PUT', () => `/api/funnels/${funnelId}/settings`, {}, 200, 200, 200, 403], // a funnel's settings are content
    ['DELETE', '/api/contacts/999999', undefined, 404, 404, 404, 403],
    // administration: owner and administrators only
    ['PUT', '/api/settings', { sender_name: 'Nouveau' }, 200, 200, 403, 403],
    ['POST', '/api/settings/webhook-secret', {}, 200, 200, 403, 403],
    ['GET', '/api/team', undefined, 200, 200, 403, 403],
    ['POST', '/api/team/invitations', { email: 'pas-un-email', role: 'editor' }, 400, 400, 403, 403],
    ['GET', '/api/audit', undefined, 200, 200, 403, 403],
    ['GET', '/api/developer/apps', undefined, 200, 200, 403, 403],
    ['GET', '/api/oauth/authorizations', undefined, 200, 200, 403, 403],
    ['PUT', '/api/branding', {}, 400, 400, 403, 403],
    // routes that do not exist yet (billing, account deletion, a feature added later): covered by the generic rule
    ['POST', '/api/billing/portal', {}, 404, 404, 403, 403],
    ['POST', '/api/payments/settings', {}, 404, 404, 403, 403],
    ['POST', '/api/some-future-feature', {}, 404, 404, 404, 403],
    ['GET', '/api/some-future-feature', undefined, 404, 404, 404, 404],
    // owner only
    ['DELETE', '/api/account', undefined, 404, 403, 403, 403],
    ['PUT', '/api/license', { key: 'x' }, 403, 403, 403, 403], // instance administrator only (see license.test.ts)
  ];

  for (const [method, path, body, ...expected] of matrix) {
    test(`${method} ${typeof path === 'string' ? path : path().replace('undefined', ':id')} → owner ${expected[0]}, admin ${expected[1]}, editor ${expected[2]}, viewer ${expected[3]}`, async () => {
      const p = typeof path === 'string' ? path : path();
      const roles: [string, Api][] = [['owner', owner], ['admin', admin], ['editor', editor], ['viewer', viewer]];
      for (let i = 0; i < roles.length; i++) {
        const [role, api] = roles[i];
        const r = method === 'GET' ? await api.get(p) : method === 'POST' ? await api.post(p, body) : method === 'PATCH' ? await api.patch(p, body) : method === 'PUT' ? await api.put(p, body) : await api.del(p);
        assert.equal(r.status, expected[i], `${role}: ${method} ${p} → ${r.status} ${r.text.slice(0, 200)}`);
        if (r.status === 403) assert.equal(typeof r.body.error, 'string');
      }
    });
  }

  test('team management: administrators manage editors and readers, only the owner manages administrators', async () => {
    assert.equal((await admin.patch(`/api/team/members/${memberIds.viewer}`, { role: 'editor' })).status, 200);
    assert.equal((await admin.patch(`/api/team/members/${memberIds.viewer}`, { role: 'viewer' })).status, 200);
    assert.equal((await admin.patch(`/api/team/members/${memberIds.viewer}`, { role: 'admin' })).status, 403);
    assert.equal((await admin.patch(`/api/team/members/${memberIds.admin}`, { role: 'viewer' })).status, 403, 'own access');
    assert.equal((await admin.del(`/api/team/members/${memberIds.admin}`)).status, 403);
    const admin2 = await addMember(ctx, owner, 'admin');
    const id2 = (await owner.get('/api/team')).body.members.find((m: { user_id: number }) => m.user_id === admin2.userId).id;
    assert.equal((await admin.del(`/api/team/members/${id2}`)).status, 403, 'an admin cannot remove another admin');
    assert.equal((await owner.patch(`/api/team/members/${id2}`, { role: 'editor' })).status, 200);
    assert.equal((await admin2.api.get('/api/team')).status, 403, 'role change applies immediately');
    assert.equal((await owner.patch(`/api/team/members/${id2}`, { role: 'owner' })).status, 400);

    // removing a member closes his access and his login
    assert.equal((await admin.del(`/api/team/members/${id2}`)).status, 200);
    assert.equal((await admin2.api.get('/api/contacts')).status, 401);
    assert.equal((await http(ctx, 'POST', '/api/auth/login', { json: { email: admin2.email, password: 'motdepasse123' } })).status, 401);
  });

  test('isolation between accounts', async () => {
    const b = await registerUser(ctx, 'Autre compte');
    const other = client(ctx, b.token);
    const secret = (await other.post('/api/contacts', { email: 'secret@autre.fr' })).body.id;
    const otherMember = await addMember(ctx, other, 'admin');

    // members of account A never see account B
    for (const api of [admin, editor, viewer]) {
      assert.equal((await api.get(`/api/contacts/${secret}`)).status, 404);
      assert.ok(!(await api.get('/api/contacts')).body.items.some((c: { email: string }) => c.email === 'secret@autre.fr'));
    }
    assert.equal((await editor.patch(`/api/contacts/${secret}`, { first_name: 'x' })).status, 404);
    // B's owner / admin cannot touch A's team, and A's admin cannot touch B's
    const bTeam = await other.get('/api/team');
    assert.equal(bTeam.body.members.length, 1);
    assert.equal((await other.del(`/api/team/members/${memberIds.editor}`)).status, 404);
    assert.equal((await otherMember.api.patch(`/api/team/members/${memberIds.editor}`, { role: 'viewer' })).status, 404);
    assert.equal((await admin.del(`/api/team/members/${bTeam.body.members[0].id}`)).status, 404);
    const pending = await other.post('/api/team/invitations', { email: 'pending@autre.fr', role: 'viewer' });
    assert.equal((await admin.del(`/api/team/invitations/${pending.body.invitation.id}`)).status, 404);
    assert.equal((await admin.post(`/api/team/invitations/${pending.body.invitation.id}/resend`)).status, 404);
    // a member belongs to exactly one account: his email cannot be invited elsewhere
    assert.equal((await owner.post('/api/team/invitations', { email: otherMember.email, role: 'viewer' })).status, 409);
    // what a member creates belongs to the account, not to him
    const created = await editor.post('/api/contacts', { email: 'par-editeur@exemple.fr' });
    assert.equal(created.status, 201);
    assert.equal((await owner.get(`/api/contacts/${created.body.id}`)).status, 200);
    assert.equal((await other.get(`/api/contacts/${created.body.id}`)).status, 404);
  });

  test('license lapsed: members are refused with a clear message, the owner keeps everything and can clean up', async () => {
    useLicense({ expires_at: inDays(-(GRACE_DAYS + 1)) });
    const refused = await editor.get('/api/contacts');
    assert.equal(refused.status, 403);
    assert.match(refused.body.error, /licence Entreprise/);
    assert.equal((await owner.get('/api/contacts')).status, 200);
    assert.equal((await owner.post('/api/contacts', { email: 'apres-expiration@exemple.fr' })).status, 201);
    const team = await owner.get('/api/team');
    assert.equal(team.status, 200);
    assert.equal(team.body.seats.limit, 0);
    assert.equal((await owner.post('/api/team/invitations', { email: 'n@y.test', role: 'viewer' })).status, 402);
    assert.equal((await owner.del(`/api/team/members/${memberIds.viewer}`)).status, 200);
    // grace period: members still work
    useLicense({ expires_at: inDays(-1) });
    assert.equal((await editor.get('/api/contacts')).status, 200);
  });
});
