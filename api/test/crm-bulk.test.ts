// Bulk actions on contacts: by ids or by filter, every action, side effects (campaign triggers, events, automations).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db';
import { BULK_BATCH } from '../src/services/bulk';
import { client, registerUser, shutdown, startApp, type TestCtx } from './helpers';

let ctx: TestCtx;
before(async () => {
  ctx = await startApp();
});
after(() => shutdown(ctx));

type Api = ReturnType<typeof client>;
async function account() {
  const reg = await registerUser(ctx);
  return { api: client(ctx, reg.token), userId: reg.user.id };
}
const mk = async (api: Api, email: string, extra: Record<string, unknown> = {}) => (await api.post('/api/contacts', { email, ...extra })).body as { id: number };
const bulk = (api: Api, selection: unknown, action: unknown) => api.post('/api/contacts/bulk', { selection, action });
const tagsOf = async (api: Api, id: number) => ((await api.get(`/api/contacts/${id}`)).body.tags as { name: string }[]).map((t) => t.name).sort();

describe('bulk actions', () => {
  test('by ids: add / remove tag with campaign trigger, events, ids of other accounts ignored', async () => {
    const { api, userId } = await account();
    const camp = (await api.post('/api/campaigns', { name: 'Bienvenue' })).body;
    await api.post(`/api/campaigns/${camp.id}/emails`, { subject: 'E1', delay_days: 0 });
    const tag = (await api.post('/api/tags', { name: 'client' })).body;
    await api.patch(`/api/campaigns/${camp.id}`, { trigger_tag_id: tag.id });
    const a = await mk(api, 'a@b.fr');
    const b = await mk(api, 'b@b.fr', { tags: ['client'] });
    const c = await mk(api, 'c@b.fr');
    const other = await account();
    const foreign = await mk(other.api, 'x@b.fr');

    const r = await bulk(api, { ids: [a.id, b.id, foreign.id] }, { type: 'add_tag', tag_name: 'Client' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body, { matched: 2, processed: 1 }); // b already had it, foreign ignored
    assert.deepEqual(await tagsOf(api, a.id), ['client']);
    assert.deepEqual(await tagsOf(api, c.id), []);
    assert.deepEqual(await tagsOf(other.api, foreign.id), []);
    // side effects: campaign enrollment + timeline
    const subs = await db.selectFrom('campaign_subscriptions').select('contact_id').where('campaign_id', '=', camp.id).execute();
    assert.deepEqual(subs.map((s) => s.contact_id).sort(), [a.id, b.id].sort());
    const ev = await db.selectFrom('contact_events').select('type').where('contact_id', '=', a.id).where('type', 'in', ['tag_added', 'campaign_enrolled']).execute();
    assert.equal(ev.length, 2);

    const rm = await bulk(api, { ids: [a.id, b.id, c.id] }, { type: 'remove_tag', tag_id: tag.id });
    assert.deepEqual(rm.body, { matched: 3, processed: 2 });
    assert.equal((await db.selectFrom('contact_events').select('id').where('user_id', '=', userId).where('type', '=', 'tag_removed').execute()).length, 2);
    assert.equal((await bulk(api, { ids: [a.id] }, { type: 'remove_tag', tag_id: 999999 })).status, 404);
    assert.equal((await bulk(other.api, { ids: [a.id] }, { type: 'remove_tag', tag_id: tag.id })).status, 404);
  });

  test('by filter ("all matching"): search, tag, status, segment, ad hoc filter; batches', async () => {
    const { api } = await account();
    await api.post('/api/custom-fields', { key: 'score', label: 'Score', type: 'number' });
    const n = BULK_BATCH + 15; // more than one batch
    const csv = ['email,score', ...Array.from({ length: n }, (_, i) => `u${i}@lot.fr,${i}`), 'other@else.fr,1000'].join('\n');
    assert.equal((await api.post('/api/contacts/import', { csv })).body.created, n + 1);
    const r = await bulk(api, { all: true, search: '@lot.fr' }, { type: 'add_tag', tag_name: 'lot' });
    assert.deepEqual(r.body, { matched: n, processed: n });
    // ad hoc filter + tag
    const tag = (await api.get('/api/tags')).body[0];
    const f = { match: 'all', conditions: [{ type: 'field', key: 'score', op: 'lt', value: 10 }] };
    const r2 = await bulk(api, { all: true, tag_id: tag.id, filter: f }, { type: 'set_field', key: 'score', value: -1 });
    assert.deepEqual(r2.body, { matched: 10, processed: 10 });
    assert.equal((await api.post('/api/segments/preview', { filter: { match: 'all', conditions: [{ type: 'field', key: 'score', op: 'eq', value: -1 }] } })).body.count, 10);
    assert.equal((await bulk(api, { all: true, filter: f }, { type: 'set_field', key: 'score', value: 'abc' })).status, 400);
    // saved segment
    const seg = (await api.post('/api/segments', { name: 'Gros scores', filter: { match: 'all', conditions: [{ type: 'field', key: 'score', op: 'gt', value: 200 }] } })).body;
    const r3 = await bulk(api, { all: true, segment_id: seg.id }, { type: 'unsubscribe' });
    assert.deepEqual(r3.body, { matched: n - 201 + 1, processed: n - 201 + 1 }); // scores 201..n-1 + other@else.fr
    // status filter on the result
    const r4 = await bulk(api, { all: true, status: 'unsubscribed' }, { type: 'unsubscribe' });
    assert.deepEqual(r4.body, { matched: n - 200, processed: 0 });
    // delete everything matching a search
    const del = await bulk(api, { all: true, search: 'else.fr' }, { type: 'delete' });
    assert.deepEqual(del.body, { matched: 1, processed: 1 });
    assert.equal((await api.get('/api/contacts?search=else.fr')).body.total, 0);
    assert.equal((await api.get('/api/contacts')).body.total, n);
  });

  test('enroll / unenroll / unsubscribe side effects', async () => {
    const { api, userId } = await account();
    const camp = (await api.post('/api/campaigns', { name: 'Seq' })).body;
    await api.post(`/api/campaigns/${camp.id}/emails`, { subject: 'E1', delay_days: 1 });
    const a = await mk(api, 'a@e.fr');
    const b = await mk(api, 'b@e.fr');
    await db.updateTable('contacts').set({ confirmed_at: null }).where('id', '=', b.id).execute(); // double opt-in pending
    const en = await bulk(api, { ids: [a.id, b.id] }, { type: 'enroll', campaign_id: camp.id });
    assert.deepEqual(en.body, { matched: 2, processed: 1 });
    assert.equal((await db.selectFrom('email_sends').select('id').where('campaign_id', '=', camp.id).where('status', '=', 'pending').execute()).length, 1);
    const un = await bulk(api, { ids: [a.id, b.id] }, { type: 'unenroll', campaign_id: camp.id });
    assert.deepEqual(un.body, { matched: 2, processed: 1 });
    const sub = await db.selectFrom('campaign_subscriptions').select('status').where('contact_id', '=', a.id).executeTakeFirstOrThrow();
    assert.equal(sub.status, 'unsubscribed');
    assert.equal((await db.selectFrom('email_sends').select('status').where('contact_id', '=', a.id).executeTakeFirstOrThrow()).status, 'skipped');

    await api.post(`/api/campaigns/${camp.id}/enroll`, { contact_id: (await mk(api, 'c@e.fr')).id });
    const us = await bulk(api, { all: true }, { type: 'unsubscribe' });
    assert.deepEqual(us.body, { matched: 3, processed: 3 });
    const evs = await db.selectFrom('contact_events').select('data').where('user_id', '=', userId).where('type', '=', 'unsubscribed').execute();
    assert.equal(evs.length, 3);
    assert.deepEqual(evs[0].data, { by: 'bulk' });
    assert.equal((await db.selectFrom('email_sends').select('id').where('user_id', '=', userId).where('status', '=', 'pending').execute()).length, 0);
    assert.equal((await bulk(api, { ids: [a.id] }, { type: 'enroll', campaign_id: 424242 })).status, 404);
    assert.equal((await bulk(api, { ids: [] }, { type: 'delete' })).status, 400);
  });
});
