// Onboarding: a new sign-up is sent to the welcome flow, existing accounts (migration backfill, demo seed) are not;
// every item of the "Bien démarrer" checklist turns done when the real data exists (never ticked by hand); goal,
// step, funnel, skip / finish / hide / reopen; validation; tenant isolation; team members never see the welcome flow.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { OnboardingState } from '@scalo/shared';
import { roleAllows } from '../src/access';
import { db } from '../src/db';
import { migrateToLatest, migrator } from '../src/db/migrate';
import { CHECKLISTS, markOnboardingDone, onboardingState } from '../src/services/onboarding';
import { client, http, registerUser, shutdown, startApp, type TestCtx } from './helpers';

let ctx: TestCtx;
before(async () => {
  ctx = await startApp();
});
after(() => shutdown(ctx));

type Api = ReturnType<typeof client>;
async function account() {
  const reg = await registerUser(ctx);
  return { api: client(ctx, reg.token), userId: reg.user.id, email: reg.email };
}
async function state(api: Api) {
  const r = await api.get<OnboardingState>('/api/onboarding');
  assert.equal(r.status, 200, r.text);
  return r.body;
}
async function put(api: Api, body: unknown) {
  const r = await api.put<OnboardingState>('/api/onboarding', body);
  assert.equal(r.status, 200, r.text);
  return r.body;
}
const doneIds = (s: OnboardingState) => s.checklist.items.filter((i) => i.done).map((i) => i.id);
const ids = (s: OnboardingState) => s.checklist.items.map((i) => i.id);

describe('welcome flow', () => {
  test('requires a session', async () => {
    assert.equal((await http(ctx, 'GET', '/api/onboarding')).status, 401);
    assert.equal((await http(ctx, 'PUT', '/api/onboarding', { json: { skip: true } })).status, 401);
  });

  test('a new sign-up must go through the welcome flow, starting at the goal', async () => {
    const { api } = await account();
    const s = await state(api);
    assert.equal(s.required, true);
    assert.equal(s.member, false);
    assert.equal(s.can_edit, true);
    assert.equal(s.goal, null);
    assert.equal(s.step, 'goal');
    assert.equal(s.funnel, null);
    assert.equal(s.completed_at, null);
    assert.equal(s.skipped_at, null);
    // nothing done yet: the sender name and email are prefilled at sign-up, but the postal address is missing
    assert.deepEqual(ids(s), CHECKLISTS.leads);
    assert.deepEqual(doneIds(s), []);
    assert.deepEqual({ done: s.checklist.done, total: s.checklist.total, complete: s.checklist.complete, hidden: s.checklist.hidden }, { done: 0, total: 6, complete: false, hidden: false });
    for (const i of s.checklist.items) {
      assert.ok(i.title && i.description && i.minutes > 0, i.id);
      assert.match(i.href, /^\/[a-z]/, i.id);
    }
  });

  test('accounts that exist when the migration runs are never sent to the welcome flow', async () => {
    await migrator().migrateTo('0012_affiliates');
    const old = await account(); // created before 0013: no onboarding table yet
    // 0013 and the migrations added after it
    const later = (await migrator().getMigrations()).filter((m) => m.name > '0012_affiliates').length;
    assert.ok(later >= 1);
    assert.equal(await migrateToLatest(db, { quiet: true }), later);
    const s = await state(old.api);
    assert.equal(s.required, false);
    assert.ok(s.completed_at);
    assert.equal(s.checklist.hidden, true, 'no checklist pushed on an existing account (it can be reopened)');
    // … while an account created after the migration is
    assert.equal((await state((await account()).api)).required, true);
  });

  test('the demo account of the seed is marked as done', async () => {
    const { api, userId } = await account();
    await db.deleteFrom('account_onboarding').where('user_id', '=', userId).execute();
    await markOnboardingDone(userId);
    const s = await state(api);
    assert.equal(s.required, false);
    assert.equal(s.checklist.hidden, true);
    await markOnboardingDone(userId); // idempotent
  });

  test('goal and step are saved: the flow resumes where it stopped', async () => {
    const { api } = await account();
    let s = await put(api, { goal: 'sell', step: 'business' });
    assert.equal(s.goal, 'sell');
    assert.equal(s.step, 'business');
    assert.equal(s.required, true);
    assert.deepEqual(ids(s), CHECKLISTS.sell);
    s = await put(api, { step: 'funnel' });
    assert.equal(s.goal, 'sell', 'a partial update keeps the rest');
    assert.equal((await state(api)).step, 'funnel');
    // going back
    assert.equal((await put(api, { step: 'goal', goal: 'course' })).goal, 'course');
    assert.deepEqual(ids(await state(api)), CHECKLISTS.course);
    assert.deepEqual(ids(await put(api, { goal: 'migrate' })), CHECKLISTS.migrate);
    for (const list of Object.values(CHECKLISTS)) assert.ok(list.length >= 5 && list.length <= 7);
  });

  test('the funnel created in the flow is returned by the last step, and forgotten when it is deleted', async () => {
    const { api } = await account();
    const f = await api.post('/api/funnels', { name: 'Mon premier tunnel', template: 'optin' });
    assert.equal(f.status, 201, f.text);
    let s = await put(api, { funnel_id: f.body.id, step: 'live' });
    assert.equal(s.step, 'live');
    assert.deepEqual(s.funnel, { id: f.body.id, name: 'Mon premier tunnel', slug: f.body.slug, step_id: f.body.steps[0].id });
    assert.equal((await api.del(`/api/funnels/${f.body.id}`)).status, 200);
    s = await state(api);
    assert.equal(s.funnel, null);
    assert.equal(s.step, 'funnel', 'back to the funnel step: there is nothing to show as "live"');
  });

  test('finish: never required again, the date does not move', async () => {
    const { api } = await account();
    const s = await put(api, { complete: true });
    assert.equal(s.required, false);
    assert.ok(s.completed_at);
    assert.equal(s.skipped_at, null);
    const again = await put(api, { complete: true, step: 'live' });
    assert.equal(again.completed_at, s.completed_at);
    assert.equal((await state(api)).required, false);
  });

  test('skip is remembered; the checklist stays available', async () => {
    const { api } = await account();
    const s = await put(api, { skip: true });
    assert.equal(s.required, false);
    assert.ok(s.skipped_at);
    assert.equal(s.completed_at, null);
    assert.equal(s.checklist.hidden, false);
    assert.equal((await put(api, { skip: true })).skipped_at, s.skipped_at);
    assert.equal((await state(api)).required, false);
  });

  test('hide and reopen the checklist', async () => {
    const { api } = await account();
    assert.equal((await put(api, { checklist_hidden: true })).checklist.hidden, true);
    const s = await state(api);
    assert.equal(s.checklist.hidden, true);
    assert.equal(s.required, true, 'hiding the checklist is not skipping the welcome flow');
    assert.equal(s.checklist.items.length, 6, 'still computed while hidden');
    assert.equal((await put(api, { checklist_hidden: false })).checklist.hidden, false);
    assert.equal((await state(api)).checklist.hidden, false);
  });

  test('validation', async () => {
    const { api } = await account();
    const other = await account();
    const foreign = await other.api.post('/api/funnels', { name: 'Autre', template: 'blank' });
    for (const body of [{ goal: 'nope' }, { step: 'done' }, { complete: false }, { skip: 'yes' }, { checklist_hidden: 1 }, { funnel_id: 'x' }, { items: [] }, { completed_at: null }]) {
      assert.equal((await api.put('/api/onboarding', body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await api.put('/api/onboarding', { funnel_id: foreign.body.id })).status, 404, 'funnel of another account');
    assert.equal((await api.put('/api/onboarding', { funnel_id: 999_999 })).status, 404);
    assert.equal((await state(api)).step, 'goal', 'nothing written by the refused requests');
  });

  test('tenant isolation', async () => {
    const a = await account();
    const b = await account();
    await put(a.api, { goal: 'course', step: 'funnel', checklist_hidden: true, skip: true });
    await a.api.post('/api/funnels', { name: 'Tunnel de A', template: 'optin' });
    await a.api.post('/api/contacts', { email: 'a@mail.fr' });
    const s = await state(b.api);
    assert.equal(s.required, true);
    assert.equal(s.goal, null);
    assert.equal(s.step, 'goal');
    assert.equal(s.checklist.hidden, false);
    assert.deepEqual(doneIds(s), []);
    // deleting the account removes its state
    await db.deleteFrom('users').where('id', '=', a.userId).execute();
    assert.equal((await db.selectFrom('account_onboarding').select('user_id').where('user_id', '=', a.userId).execute()).length, 0);
  });
});

describe('checklist computed from the real data', () => {
  test('capture goal: each item turns done when its data exists', async () => {
    const { api, userId } = await account();
    await put(api, { goal: 'leads' });
    const expectDone = async (expected: string[], msg = 'items done') => assert.deepEqual(doneIds(await state(api)).sort(), [...expected].sort(), msg);
    await expectDone([]);

    // sender: name + email (prefilled) + postal address
    assert.equal((await api.put('/api/settings', { company_address: '   ' })).status, 200);
    await expectDone([], 'a blank address does not count');
    assert.equal((await api.put('/api/settings', { company_address: '1 rue de la Paix, 75002 Paris' })).status, 200);
    await expectDone(['sender']);
    assert.equal((await api.put('/api/settings', { sender_name: '' })).status, 200);
    await expectDone([], 'the sender name is required too');
    assert.equal((await api.put('/api/settings', { sender_name: 'Atelier' })).status, 200);

    // funnel
    const f = await api.post('/api/funnels', { name: 'Guide offert', template: 'optin' });
    assert.equal(f.status, 201, f.text);
    await expectDone(['sender', 'funnel']);
    let s = await state(api);
    assert.equal(s.checklist.items.find((i) => i.id === 'visitor')!.href, `/funnels/${f.body.id}`, 'links to the funnel to share');

    // first visitor: a page view
    await db.insertInto('page_views').values({ user_id: userId, funnel_id: f.body.id, step_id: f.body.steps[0].id, visitor_id: 'v1' }).execute();
    await expectDone(['sender', 'funnel', 'visitor']);

    // sending: SMTP server configured
    assert.equal((await api.put('/api/settings', { smtp_host: 'smtp.exemple.fr', smtp_port: 587 })).status, 200);
    await expectDone(['sender', 'funnel', 'visitor', 'sending']);

    // contacts
    assert.equal((await api.post('/api/contacts', { email: 'marie@mail.fr' })).status, 201);
    await expectDone(['sender', 'funnel', 'visitor', 'sending', 'contacts']);

    // first email: a draft newsletter is not enough, a campaign (or a scheduled / sent newsletter) is
    const draft = await api.post('/api/broadcasts', { subject: 'Bonjour' });
    assert.equal(draft.status, 201, draft.text);
    await expectDone(['sender', 'funnel', 'visitor', 'sending', 'contacts']);
    await db.updateTable('broadcasts').set({ status: 'sent', sent_at: new Date().toISOString() }).where('id', '=', draft.body.id).execute();
    s = await state(api);
    assert.deepEqual({ done: s.checklist.done, total: s.checklist.total, complete: s.checklist.complete }, { done: 6, total: 6, complete: true });

    // computed, not stored: deleting the funnel un-ticks the item
    assert.equal((await api.del(`/api/funnels/${f.body.id}`)).status, 200);
    s = await state(api);
    assert.ok(!doneIds(s).includes('funnel'));
    assert.equal(s.checklist.complete, false);
    assert.equal(s.checklist.items.find((i) => i.id === 'visitor')!.href, '/funnels');
  });

  test('an opt-in counts as a first visitor, a campaign as a first email', async () => {
    const { api, userId } = await account();
    const c = await api.post('/api/contacts', { email: 'lead@mail.fr' });
    await db.insertInto('contact_events').values({ user_id: userId, contact_id: c.body.id, type: 'optin' }).execute();
    assert.equal((await api.post('/api/campaigns', { name: 'Bienvenue' })).status, 201);
    assert.deepEqual(doneIds(await state(api)).sort(), ['contacts', 'first_email', 'visitor']);
  });

  test('selling goal: Stripe connected, product created', async () => {
    const { api, userId } = await account();
    const s = await put(api, { goal: 'sell' });
    assert.deepEqual(ids(s), ['sender', 'funnel', 'stripe', 'product', 'visitor', 'sending', 'first_email']);
    assert.deepEqual(doneIds(s), []);
    // a payment settings row without key (webhook URL shown in the settings) is not a connection
    await db.insertInto('payment_settings').values({ user_id: userId, webhook_token: `tok-${userId}` }).execute();
    assert.ok(!doneIds(await state(api)).includes('stripe'));
    await db.updateTable('payment_settings').set({ stripe_secret_key: 'enc', stripe_secret_hint: '4242', mode: 'test' }).where('user_id', '=', userId).execute();
    assert.deepEqual(doneIds(await state(api)), ['stripe']);
    const { id } = await db.insertInto('products').values({ user_id: userId, name: 'Coaching' }).returning('id').executeTakeFirstOrThrow();
    assert.deepEqual(doneIds(await state(api)), ['stripe', 'product']);
    await db.updateTable('products').set({ archived: true }).where('id', '=', id).execute();
    assert.deepEqual(doneIds(await state(api)), ['stripe'], 'an archived product does not count');
  });

  test('course goal: course created', async () => {
    const { api } = await account();
    const s = await put(api, { goal: 'course' });
    assert.deepEqual(ids(s), ['sender', 'course', 'stripe', 'product', 'funnel', 'sending', 'visitor']);
    assert.equal((await api.post('/api/courses', { title: 'Ma formation' })).status, 201);
    assert.deepEqual(doneIds(await state(api)), ['course']);
  });

  test('migration goal: import started', async () => {
    const { api, userId } = await account();
    let s = await put(api, { goal: 'migrate' });
    assert.deepEqual(ids(s), ['sender', 'import', 'sending', 'funnel', 'first_email', 'visitor']);
    assert.equal(s.import_started, false);
    await db.insertInto('import_jobs').values({ user_id: userId, source: 'csv', status: 'completed' }).execute();
    s = await state(api);
    assert.equal(s.import_started, true);
    assert.deepEqual(doneIds(s), ['import']);
  });
});

describe('team members (Enterprise edition)', () => {
  test('a member acting for the account never sees the welcome flow', async () => {
    const owner = await account();
    const member = await account();
    assert.equal((await state(owner.api)).required, true);
    for (const role of ['admin', 'editor', 'viewer'] as const) {
      const s = await onboardingState(owner.userId, { actorId: member.userId, role });
      assert.equal(s.required, false, role);
      assert.equal(s.member, true, role);
      assert.equal(s.can_edit, role !== 'viewer', role);
      assert.equal(s.checklist.items.length, 6, 'the checklist of the account is still readable');
    }
    const s = await onboardingState(owner.userId, { actorId: owner.userId, role: 'owner' });
    assert.deepEqual([s.required, s.member, s.can_edit], [true, false, true]);
  });

  test('generic role rule: a read-only member cannot change the state', () => {
    assert.equal(roleAllows('viewer', 'GET', '/onboarding'), true);
    assert.equal(roleAllows('viewer', 'PUT', '/onboarding'), false);
    assert.equal(roleAllows('editor', 'PUT', '/onboarding'), true);
    assert.equal(roleAllows('admin', 'PUT', '/onboarding'), true);
  });
});
