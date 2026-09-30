// Automation engine: triggers, conditions, actions, delayed actions (resume, crash recovery), incoming webhooks
// (secret, rate limit), outgoing webhooks (SSRF protection, signature), loop protection, public API (v1).
import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sql } from 'kysely';
import { db } from '../src/db';
import { HOOK_LIMIT } from '../src/routes/automations';
import { claimRuns, MAX_DEPTH, recoverAutomationRuns } from '../src/services/automations';
import { sha256 } from '../src/services/oauth-server';
import { isPrivateAddress, setWebhookDeps, signPayload, webhookUrlError } from '../src/services/webhook-http';
import { EmailWorker } from '../src/worker';
import { client, http, registerUser, shutdown, startApp, type TestCtx } from './helpers';

let ctx: TestCtx;
before(async () => {
  ctx = await startApp();
});
after(() => shutdown(ctx));
afterEach(() => setWebhookDeps(null));

type Api = ReturnType<typeof client>;
async function account() {
  const reg = await registerUser(ctx);
  return { api: client(ctx, reg.token), userId: reg.user.id };
}
const mk = async (api: Api, email: string, extra: Record<string, unknown> = {}) => {
  const r = await api.post('/api/contacts', { email, ...extra });
  assert.equal(r.status, 201, r.text);
  return r.body as { id: number; email: string };
};
const tag = async (api: Api, name: string) => (await api.post('/api/tags', { name })).body as { id: number; name: string };
async function automation(api: Api, body: Record<string, unknown>) {
  const r = await api.post('/api/automations', { name: 'Auto', enabled: true, actions: [], ...body });
  assert.equal(r.status, 201, r.text);
  return r.body as { id: number; webhook_url: string | null; signing_secret: string };
}
const drain = () => new EmailWorker({ throttle: false }).drain();
const tagsOf = async (api: Api, id: number) => ((await api.get(`/api/contacts/${id}`)).body.tags as { name: string }[]).map((t) => t.name).sort();
const runsOf = async (api: Api, automationId: number) =>
  (await api.get(`/api/automations/${automationId}/runs?limit=100`)).body.items as { id: number; status: string; error: string | null; step: number; depth: number; contact_id: number; log: { message: string; ok: boolean }[]; trigger_data: Record<string, unknown> }[];

/** Access token of a third-party app for the public API (inserted directly). */
async function v1Token(userId: number, scopes: string[]) {
  const now = new Date().toISOString();
  const c = await db
    .insertInto('oauth_clients')
    .values({
      client_id: `scalo_app_${crypto.randomBytes(12).toString('hex')}`,
      user_id: userId,
      name: 'Test',
      type: 'public',
      secret_hash: null,
      secret_hint: null,
      website: null,
      logo_url: null,
      redirect_uris: ['http://localhost:3000/cb'],
      scopes,
      created_at: now,
      updated_at: now,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const token = `scalo_at_${crypto.randomBytes(32).toString('base64url')}`;
  await db
    .insertInto('oauth_tokens')
    .values({ token_hash: sha256(token), type: 'access', family_id: crypto.randomUUID(), client_id: c.id, user_id: userId, scopes, expires_at: new Date(Date.now() + 3600_000).toISOString(), created_at: now })
    .execute();
  return token;
}
const v1 = (token: string, method: string, path: string, json?: unknown) => http(ctx, method, `/api/v1${path}`, { token, json });

describe('triggers', () => {
  test('tag added / tag removed / contact created, trigger parameters, disabled automations', async () => {
    const { api } = await account();
    const lead = await tag(api, 'lead');
    const client_ = await tag(api, 'client');
    const onAdd = await automation(api, { trigger: { type: 'tag_added', tag_id: lead.id }, actions: [{ type: 'add_tag', tag_id: client_.id }] });
    const onRemove = await automation(api, { trigger: { type: 'tag_removed', tag_id: lead.id }, actions: [{ type: 'remove_tag', tag_id: client_.id }] });
    const onCreate = await automation(api, { trigger: { type: 'contact_created' }, actions: [] });
    const disabled = await automation(api, { enabled: false, trigger: { type: 'contact_created' }, actions: [] });

    const c = await mk(api, 'a@auto.fr');
    await api.post(`/api/contacts/${c.id}/tags`, { name: 'autre' }); // other tag: no run
    await api.post(`/api/contacts/${c.id}/tags`, { name: 'lead' });
    assert.deepEqual(await tagsOf(api, c.id), ['autre', 'lead']); // asynchronous: not yet
    await drain();
    assert.deepEqual(await tagsOf(api, c.id), ['autre', 'client', 'lead']);
    const r = await runsOf(api, onAdd.id);
    assert.equal(r.length, 1);
    assert.equal(r[0].status, 'completed');
    assert.equal(r[0].log[0].message, 'Tag « client » ajouté');
    assert.equal(r[0].trigger_data.tag, 'lead');

    await api.del(`/api/contacts/${c.id}/tags/${lead.id}`);
    await drain();
    assert.deepEqual(await tagsOf(api, c.id), ['autre']);
    assert.equal((await runsOf(api, onRemove.id))[0].status, 'completed');
    assert.equal((await runsOf(api, onCreate.id)).length, 1);
    assert.equal((await runsOf(api, disabled.id)).length, 0);
    // CSV import also counts as a creation
    await api.post('/api/contacts/import', { csv: 'email\nimp@auto.fr\n' });
    assert.equal((await runsOf(api, onCreate.id)).length, 2);
    // global journal
    const all = (await api.get('/api/automations/runs')).body;
    assert.equal(all.total, 4);
    assert.ok(all.items.every((x: { automation_name: string }) => x.automation_name === 'Auto'));
  });

  test('optin (any funnel / one step), double opt-in fires on confirmation only', async () => {
    const { api } = await account();
    const f = (await api.post('/api/funnels', { name: 'Optin auto', template: 'optin' })).body;
    const step = f.steps[0];
    await api.patch(`/api/steps/${step.id}`, { content: { settings: {}, blocks: [{ id: 'f1', type: 'form', submitLabel: 'Go', fields: [{ name: 'email', label: 'Email' }] }] } });
    const any = await automation(api, { trigger: { type: 'optin' } });
    const thisStep = await automation(api, { trigger: { type: 'optin', funnel_id: f.id, step_id: step.id } });
    const otherStep = await automation(api, { trigger: { type: 'optin', funnel_id: f.id, step_id: f.steps[1].id } });
    await http(ctx, 'POST', `/p/${f.slug}/${step.slug}/submit`, { form: { email: 'optin@auto.fr', _block: 'f1' } });
    assert.equal((await runsOf(api, any.id)).length, 1);
    assert.equal((await runsOf(api, thisStep.id)).length, 1);
    assert.equal((await runsOf(api, otherStep.id)).length, 0);
    assert.equal((await runsOf(api, any.id))[0].trigger_data.funnel, 'Optin auto');

    // double opt-in: nothing on submit, the run is created when the contact confirms
    await api.patch(`/api/steps/${step.id}`, {
      content: { settings: {}, blocks: [{ id: 'f1', type: 'form', submitLabel: 'Go', doubleOptin: true, fields: [{ name: 'email', label: 'Email' }] }] },
    });
    await http(ctx, 'POST', `/p/${f.slug}/${step.slug}/submit`, { form: { email: 'doi@auto.fr', _block: 'f1' } });
    assert.equal((await runsOf(api, any.id)).length, 1);
    // confirm through the stored request (token hash known only to the email): use a fresh token
    const token = 'x'.repeat(43);
    const { hashToken } = await import('../src/services/optin');
    await db.updateTable('pending_optins').set({ token_hash: hashToken(token) }).where('confirmed_at', 'is', null).execute();
    assert.equal((await http(ctx, 'POST', `/c/${token}`)).status, 200);
    const runs = await runsOf(api, any.id);
    assert.equal(runs.length, 2);
    assert.equal(runs[0].trigger_data.double_optin, true);
  });

  test('link clicked (url contains, newsletter), campaign completed', async () => {
    const { api } = await account();
    const c = await mk(api, 'clic@auto.fr');
    const camp = (await api.post('/api/campaigns', { name: 'Courte' })).body;
    await api.post(`/api/campaigns/${camp.id}/emails`, { subject: 'Unique', delay_days: 0 });
    const done = await automation(api, { trigger: { type: 'campaign_completed', campaign_id: camp.id } });
    await api.post(`/api/campaigns/${camp.id}/enroll`, { contact_id: c.id });
    await drain();
    const doneRuns = await runsOf(api, done.id);
    assert.equal(doneRuns.length, 1);
    assert.equal(doneRuns[0].trigger_data.campaign, 'Courte');
    const timeline = (await api.get(`/api/contacts/${c.id}`)).body.events.map((e: { type: string }) => e.type);
    assert.ok(timeline.includes('campaign_completed'));

    const b = (await api.post('/api/broadcasts', { subject: 'Promo' })).body;
    await api.patch(`/api/broadcasts/${b.id}`, {
      content: { settings: {}, blocks: [{ id: 'b1', type: 'button', label: 'Voir', action: 'url', url: 'https://shop.example.com/offre?x=1' }, { id: 'b2', type: 'button', label: 'Blog', action: 'url', url: 'https://blog.example.com/' }] },
    });
    const byUrl = await automation(api, { trigger: { type: 'link_clicked', url_contains: 'SHOP.example' } });
    const byBroadcast = await automation(api, { trigger: { type: 'link_clicked', broadcast_id: b.id } });
    const otherBroadcast = await automation(api, { trigger: { type: 'link_clicked', campaign_id: camp.id } });
    await api.post(`/api/broadcasts/${b.id}/send`);
    await drain();
    const send = await db.selectFrom('email_sends').select('id').where('broadcast_id', '=', b.id).executeTakeFirstOrThrow();
    assert.equal((await http(ctx, 'GET', `/t/c/${send.id}?u=${encodeURIComponent('https://blog.example.com/')}`)).status, 302);
    assert.equal((await http(ctx, 'GET', `/t/c/${send.id}?u=${encodeURIComponent('https://shop.example.com/offre?x=1')}`)).status, 302);
    assert.equal((await runsOf(api, byUrl.id)).length, 1);
    assert.equal((await runsOf(api, byBroadcast.id)).length, 2);
    assert.equal((await runsOf(api, otherBroadcast.id)).length, 0);
    assert.equal((await runsOf(api, byUrl.id))[0].trigger_data.url, 'https://shop.example.com/offre?x=1');
  });

  test('purchase (public API, product filter, idempotent external_id) and v1 CRM endpoints', async () => {
    const { api, userId } = await account();
    const buyer = await tag(api, 'acheteur');
    const any = await automation(api, { trigger: { type: 'purchase' }, actions: [{ type: 'add_tag', tag_id: buyer.id }] });
    const formation = await automation(api, { trigger: { type: 'purchase', product: 'Formation' } });
    const token = await v1Token(userId, ['contacts:read', 'contacts:write', 'purchases:write']);
    const p = await v1(token, 'POST', '/purchases', { email: 'Buyer@Auto.fr', first_name: 'Bea', product: 'formation', amount: 97, currency: 'eur', external_id: 'ord_1' });
    assert.equal(p.status, 201, p.text);
    assert.equal(p.body.purchase.currency, 'EUR');
    assert.equal(p.body.contact.email, 'buyer@auto.fr');
    const again = await v1(token, 'POST', '/purchases', { contact_id: p.body.contact.id, product: 'formation', amount: 97, external_id: 'ord_1' });
    assert.equal(again.status, 200); // same external_id: not recorded twice
    assert.equal(again.body.purchase.id, p.body.purchase.id);
    await v1(token, 'POST', '/purchases', { contact_id: p.body.contact.id, product: 'Ebook' });
    await drain();
    assert.equal((await runsOf(api, any.id)).length, 2);
    assert.equal((await runsOf(api, formation.id)).length, 1);
    assert.deepEqual(await tagsOf(api, p.body.contact.id), ['acheteur']);
    const purchases = (await api.get(`/api/contacts/${p.body.contact.id}`)).body.events.filter((e: { type: string }) => e.type === 'purchase');
    assert.equal(purchases.length, 2);
    // scopes / validation
    const readOnly = await v1Token(userId, ['contacts:read']);
    assert.equal((await v1(readOnly, 'POST', '/purchases', { contact_id: p.body.contact.id, product: 'x' })).status, 403);
    const purchaseOnly = await v1Token(userId, ['purchases:write']);
    assert.equal((await v1(purchaseOnly, 'POST', '/purchases', { email: 'new@auto.fr', product: 'x' })).status, 403); // creating needs contacts:write
    assert.equal((await v1(token, 'POST', '/purchases', { product: 'x' })).status, 400);
    assert.equal((await v1(token, 'POST', '/purchases', { contact_id: 999999, product: 'x' })).status, 404);

    // custom fields + segments through the public API
    const cf = await v1(token, 'POST', '/custom-fields', { label: 'Pays', type: 'select', options: ['France', 'Belgique'] });
    assert.equal(cf.status, 201, cf.text);
    assert.equal((await v1(readOnly, 'POST', '/custom-fields', { label: 'X', type: 'text' })).status, 403);
    assert.equal((await v1(readOnly, 'GET', '/custom-fields')).body[0].key, 'pays');
    const up = await v1(token, 'POST', '/contacts', { email: 'buyer@auto.fr', fields: { pays: 'france' } });
    assert.equal(up.status, 200);
    assert.deepEqual(up.body.fields, { pays: 'France' });
    assert.equal((await v1(token, 'POST', '/contacts', { email: 'z@auto.fr', fields: { pays: 'Suisse' } })).status, 400);
    assert.deepEqual((await v1(token, 'PATCH', `/contacts/${up.body.id}`, { fields: { pays: null } })).body.fields, {});
    const seg = (await api.post('/api/segments', { name: 'Acheteurs', filter: { match: 'all', conditions: [{ type: 'purchase', op: 'did' }] } })).body;
    const segs = await v1(readOnly, 'GET', '/segments');
    assert.equal(segs.body[0].contacts_count, 1);
    assert.equal((await v1(readOnly, 'GET', `/segments/${seg.id}`)).body.name, 'Acheteurs');
    const members = await v1(readOnly, 'GET', `/segments/${seg.id}/contacts`);
    assert.deepEqual(members.body.items.map((c: { email: string }) => c.email), ['buyer@auto.fr']);
    assert.equal((await v1(readOnly, 'GET', `/contacts?segment_id=${seg.id}`)).body.total, 1);
    assert.equal((await v1(await v1Token(userId, ['profile']), 'GET', '/segments')).status, 403);
  });
});

describe('conditions and actions', () => {
  test('conditions evaluated when the run starts; enroll / unenroll / set_field / unsubscribe', async () => {
    const { api } = await account();
    await api.post('/api/custom-fields', { key: 'niveau', label: 'Niveau', type: 'text' });
    const vip = await tag(api, 'vip');
    const go = await tag(api, 'go');
    const camp = (await api.post('/api/campaigns', { name: 'Parcours' })).body;
    await api.post(`/api/campaigns/${camp.id}/emails`, { subject: 'E1', delay_days: 2 });
    const a = await automation(api, {
      trigger: { type: 'tag_added', tag_id: go.id },
      conditions: { match: 'all', conditions: [{ type: 'tag', op: 'has', tag_id: vip.id }] },
      actions: [
        { type: 'enroll', campaign_id: camp.id },
        { type: 'set_field', key: 'niveau', value: 'or' },
      ],
    });
    const yes = await mk(api, 'yes@auto.fr', { tags: ['vip'] });
    const no = await mk(api, 'no@auto.fr');
    await api.post(`/api/contacts/${yes.id}/tags`, { name: 'go' });
    await api.post(`/api/contacts/${no.id}/tags`, { name: 'go' });
    await drain();
    const runs = await runsOf(api, a.id);
    assert.equal(runs.find((r) => r.contact_id === no.id)!.status, 'skipped');
    assert.equal(runs.find((r) => r.contact_id === no.id)!.error, 'Conditions non remplies');
    const ok = runs.find((r) => r.contact_id === yes.id)!;
    assert.equal(ok.status, 'completed');
    assert.deepEqual(ok.log.map((l) => l.message), ['Inscrit à la campagne « Parcours »', 'Champ « Niveau » = or']);
    assert.deepEqual((await api.get(`/api/contacts/${yes.id}`)).body.fields, { niveau: 'or' });
    assert.ok(await db.selectFrom('campaign_subscriptions').select('id').where('contact_id', '=', yes.id).where('status', '=', 'active').executeTakeFirst());

    const stop = await automation(api, { trigger: { type: 'tag_removed', tag_id: go.id }, actions: [{ type: 'unenroll', campaign_id: camp.id }, { type: 'unsubscribe' }] });
    await api.del(`/api/contacts/${yes.id}/tags/${go.id}`);
    await drain();
    assert.deepEqual((await runsOf(api, stop.id))[0].log.map((l) => l.message), ['Retiré de la campagne « Parcours »', 'Contact désinscrit des emails']);
    const c = (await api.get(`/api/contacts/${yes.id}`)).body;
    assert.equal(c.unsubscribed, 1);
    assert.equal((await db.selectFrom('email_sends').select('status').where('contact_id', '=', yes.id).executeTakeFirstOrThrow()).status, 'skipped');

    // an action whose tag was deleted fails the run (journaled), later actions are not executed
    const tmp = await tag(api, 'tmp');
    const broken = await automation(api, { trigger: { type: 'contact_created' }, actions: [{ type: 'add_tag', tag_id: tmp.id }, { type: 'add_tag', tag_id: vip.id }] });
    await api.del(`/api/tags/${tmp.id}`);
    const z = await mk(api, 'z@auto.fr');
    await drain();
    const br = (await runsOf(api, broken.id))[0];
    assert.equal(br.status, 'failed');
    assert.equal(br.error, 'Tag introuvable (supprimé ?)');
    assert.deepEqual(await tagsOf(api, z.id), []);
  });

  test('validation: foreign references, field values, webhook URLs', async () => {
    const { api } = await account();
    const other = await account();
    const foreign = await tag(other.api, 'x');
    const bad = (body: Record<string, unknown>) => api.post('/api/automations', { name: 'x', trigger: { type: 'contact_created' }, actions: [], ...body });
    assert.equal((await bad({ trigger: { type: 'tag_added', tag_id: foreign.id } })).status, 404);
    assert.equal((await bad({ actions: [{ type: 'add_tag', tag_id: foreign.id }] })).status, 404);
    assert.equal((await bad({ actions: [{ type: 'set_field', key: 'inconnu', value: 'a' }] })).status, 404);
    assert.equal((await bad({ actions: [{ type: 'webhook', url: 'http://example.com/hook' }] })).status, 400);
    assert.equal((await bad({ actions: [{ type: 'webhook', url: 'https://127.0.0.1/hook' }] })).status, 400);
    assert.equal((await bad({ actions: [{ type: 'webhook', url: 'https://user:pw@example.com/' }] })).status, 400);
    assert.equal((await bad({ actions: [{ type: 'wait', amount: 0, unit: 'days' }] })).status, 400);
    assert.equal((await bad({ conditions: { match: 'all', conditions: [{ type: 'tag', op: 'has', tag_id: foreign.id }] } })).status, 404);
    const a = await automation(api, { trigger: { type: 'contact_created' } });
    assert.equal((await other.api.get(`/api/automations/${a.id}`)).status, 404);
    assert.equal((await other.api.patch(`/api/automations/${a.id}`, { enabled: false })).status, 404);
    const off = await api.patch(`/api/automations/${a.id}`, { enabled: false });
    assert.equal(off.body.enabled, false);
    assert.equal((await api.del(`/api/automations/${a.id}`)).status, 200);
  });
});

describe('delayed actions', () => {
  test('wait: resumed by the worker when due, exactly once; crash recovery resumes at the current step', async () => {
    const { api, userId } = await account();
    const t1 = await tag(api, 'etape1');
    const t2 = await tag(api, 'etape2');
    const a = await automation(api, {
      trigger: { type: 'contact_created' },
      actions: [{ type: 'add_tag', tag_id: t1.id }, { type: 'wait', amount: 2, unit: 'hours' }, { type: 'add_tag', tag_id: t2.id }],
    });
    const c = await mk(api, 'wait@auto.fr');
    await drain();
    let run = (await runsOf(api, a.id))[0];
    assert.equal(run.status, 'waiting');
    assert.equal(run.step, 2);
    const row = await db.selectFrom('automation_runs').select('resume_at').where('id', '=', run.id).executeTakeFirstOrThrow();
    assert.ok(Math.abs(new Date(row.resume_at!).getTime() - (Date.now() + 2 * 3600_000)) < 60_000);
    assert.deepEqual(await tagsOf(api, c.id), ['etape1']);
    assert.equal((await api.get('/api/automations')).body[0].stats.waiting, 1);
    // due now
    await db.updateTable('automation_runs').set({ resume_at: sql`now() - interval '1 second'` }).where('id', '=', run.id).execute();
    await drain();
    run = (await runsOf(api, a.id))[0];
    assert.equal(run.status, 'completed');
    assert.deepEqual(await tagsOf(api, c.id), ['etape1', 'etape2']);

    // crash after the first action (step already advanced in its transaction): not replayed after recovery
    await api.del(`/api/contacts/${c.id}/tags/${t1.id}`);
    await api.del(`/api/contacts/${c.id}/tags/${t2.id}`);
    const now = new Date().toISOString();
    const crashed = await db
      .insertInto('automation_runs')
      .values({ user_id: userId, automation_id: a.id, contact_id: c.id, status: 'running', step: 2, claimed_by: 'ghost-instance', claimed_at: now, created_at: now, updated_at: now })
      .returning('id')
      .executeTakeFirstOrThrow();
    assert.equal(await recoverAutomationRuns(), 1);
    await drain();
    const after = (await runsOf(api, a.id)).find((r) => r.id === crashed.id)!;
    assert.equal(after.status, 'completed');
    assert.deepEqual(await tagsOf(api, c.id), ['etape2']); // action 0 (etape1) not executed again

    // a live instance's runs are never recovered; concurrent claims are disjoint
    await db.insertInto('worker_instances').values({ id: 'alive', hostname: 'h', pid: 1 }).execute();
    await db
      .insertInto('automation_runs')
      .values({ user_id: userId, automation_id: a.id, contact_id: c.id, status: 'running', step: 3, claimed_by: 'alive', created_at: now, updated_at: now })
      .execute();
    assert.equal(await recoverAutomationRuns(), 0);
    await db.deleteFrom('automation_runs').where('claimed_by', '=', 'alive').execute();
    for (let i = 0; i < 6; i++) {
      await db.insertInto('automation_runs').values({ user_id: userId, automation_id: a.id, contact_id: c.id, status: 'pending', step: 3, resume_at: now, created_at: now, updated_at: now }).execute();
    }
    const [x, y] = await Promise.all([claimRuns('w1', 4), claimRuns('w2', 4)]);
    assert.equal(x.length + y.length, 6);
    assert.equal(new Set([...x, ...y].map((r) => r.id)).size, 6);
  });

  test('disabled automation: pending / waiting runs are skipped', async () => {
    const { api } = await account();
    const t = await tag(api, 't');
    const a = await automation(api, { trigger: { type: 'contact_created' }, actions: [{ type: 'wait', amount: 1, unit: 'minutes' }, { type: 'add_tag', tag_id: t.id }] });
    const c = await mk(api, 'off@auto.fr');
    await drain();
    await api.patch(`/api/automations/${a.id}`, { enabled: false });
    await db.updateTable('automation_runs').set({ resume_at: sql`now()` }).where('automation_id', '=', a.id).execute();
    await drain();
    const r = (await runsOf(api, a.id))[0];
    assert.equal(r.status, 'skipped');
    assert.equal(r.error, 'Automatisation désactivée');
    assert.deepEqual(await tagsOf(api, c.id), []);
  });
});

describe('loop protection', () => {
  test('an automation never re-triggers itself for the same contact in its chain; max depth', async () => {
    const { api } = await account();
    const ping = await tag(api, 'ping');
    // tag_added ping → remove ping, add ping: would loop forever
    const self = await automation(api, { trigger: { type: 'tag_added', tag_id: ping.id }, actions: [{ type: 'remove_tag', tag_id: ping.id }, { type: 'add_tag', tag_id: ping.id }] });
    const c = await mk(api, 'loop@auto.fr');
    await api.post(`/api/contacts/${c.id}/tags`, { name: 'ping' });
    await drain();
    const runs = await runsOf(api, self.id);
    assert.equal(runs.length, 2);
    const skipped = runs.find((r) => r.status === 'skipped')!;
    assert.match(skipped.error!, /Boucle évitée/);
    assert.equal(skipped.depth, 1);
    assert.equal(runs.find((r) => r.status === 'completed')!.depth, 0);
    // a new, independent trigger (the user adds the tag again) runs again
    await api.del(`/api/contacts/${c.id}/tags/${ping.id}`);
    await api.post(`/api/contacts/${c.id}/tags`, { name: 'ping' });
    await drain();
    assert.equal((await runsOf(api, self.id)).filter((r) => r.status === 'completed').length, 2);

    // chain T0 → T1 → … : the (MAX_DEPTH+1)-th automation of the chain is stopped
    const tags = [];
    for (let i = 0; i <= MAX_DEPTH + 1; i++) tags.push(await tag(api, `t${i}`));
    const chain = [];
    for (let i = 0; i <= MAX_DEPTH; i++) chain.push(await automation(api, { trigger: { type: 'tag_added', tag_id: tags[i].id }, actions: [{ type: 'add_tag', tag_id: tags[i + 1].id }] }));
    const d = await mk(api, 'deep@auto.fr');
    await api.post(`/api/contacts/${d.id}/tags`, { name: 't0' });
    await drain();
    for (let i = 0; i < MAX_DEPTH; i++) assert.equal((await runsOf(api, chain[i].id))[0].status, 'completed', `level ${i}`);
    const last = (await runsOf(api, chain[MAX_DEPTH].id))[0];
    assert.equal(last.status, 'skipped');
    assert.match(last.error!, /Chaîne arrêtée/);
    assert.deepEqual((await tagsOf(api, d.id)).length, MAX_DEPTH + 1); // t0..t5, not t6
  });

  test('run_once: at most one run per contact', async () => {
    const { api } = await account();
    const a = await automation(api, { trigger: { type: 'tag_added', tag_id: (await tag(api, 'r')).id }, run_once: true });
    const c = await mk(api, 'once@auto.fr', { tags: ['r'] });
    const tagId = (await api.get('/api/tags')).body[0].id;
    await api.del(`/api/contacts/${c.id}/tags/${tagId}`);
    await api.post(`/api/contacts/${c.id}/tags`, { name: 'r' });
    assert.equal((await runsOf(api, a.id)).length, 1);
  });
});

describe('incoming webhook', () => {
  test('secret URL, contact upsert + fields + purchase, disabled, rate limit, rotation', async () => {
    const { api } = await account();
    await api.post('/api/custom-fields', { key: 'source', label: 'Source', type: 'text' });
    const t = await tag(api, 'webhook');
    const a = await automation(api, { trigger: { type: 'webhook' }, actions: [{ type: 'add_tag', tag_id: t.id }] });
    const buy = await automation(api, { trigger: { type: 'purchase', product: 'Coaching' } });
    assert.match(a.webhook_url!, /\/api\/hooks\/automations\/hk_[\w-]+$/);
    const path = new URL(a.webhook_url!).pathname;

    const r = await http(ctx, 'POST', path, { json: { email: 'Hook@Auto.fr', first_name: 'Hugo', source: 'zapier', inconnu: 'x', product: 'Coaching', amount: '49,90', currency: 'EUR' } });
    assert.equal(r.status, 202, r.text);
    assert.equal(r.body.created, true);
    assert.ok(r.body.run_id);
    assert.ok(r.body.purchase_id);
    // form-encoded + nested fields
    const f = await http(ctx, 'POST', path, { form: { email: 'form@auto.fr', 'fields[source]': 'x' } });
    assert.equal(f.status, 202);
    await drain();
    const c = (await api.get(`/api/contacts/${r.body.contact_id}`)).body;
    assert.equal(c.first_name, 'Hugo');
    assert.deepEqual(c.fields, { source: 'zapier' });
    assert.deepEqual(c.tags.map((x: { name: string }) => x.name), ['webhook']);
    const purchase = c.events.find((e: { type: string }) => e.type === 'purchase');
    assert.deepEqual({ product: purchase.data.product, amount: purchase.data.amount }, { product: 'Coaching', amount: 49.9 });
    assert.equal((await runsOf(api, buy.id)).length, 1);
    assert.equal((await runsOf(api, a.id)).length, 2);

    assert.equal((await http(ctx, 'POST', path, { json: { email: 'pas-un-email' } })).status, 400);
    assert.equal((await http(ctx, 'POST', '/api/hooks/automations/hk_wrongwrongwrongwrongwrong', { json: { email: 'a@b.fr' } })).status, 404);
    // disabled → 409
    await api.patch(`/api/automations/${a.id}`, { enabled: false });
    assert.equal((await http(ctx, 'POST', path, { json: { email: 'a@b.fr' } })).status, 409);
    await api.patch(`/api/automations/${a.id}`, { enabled: true });
    // rate limit (per automation)
    const max = HOOK_LIMIT.max;
    HOOK_LIMIT.max = 6;
    try {
      let last = 0;
      let retry: string | null = null;
      for (let i = 0; i < 4; i++) {
        const x = await http(ctx, 'POST', path, { json: { email: `rl${i}@auto.fr` } });
        last = x.status;
        retry = x.headers.get('retry-after');
      }
      assert.equal(last, 429);
      assert.ok(Number(retry) > 0);
    } finally {
      HOOK_LIMIT.max = max;
    }
    // rotation: the old URL stops working
    const rotated = (await api.post(`/api/automations/${a.id}/rotate-secret`, { which: 'webhook' })).body;
    assert.notEqual(rotated.webhook_url, a.webhook_url);
    assert.equal((await http(ctx, 'POST', path, { json: { email: 'a@b.fr' } })).status, 404);
  });
});

describe('outgoing webhook', () => {
  test('SSRF: private, loopback, link-local, mapped addresses refused (after DNS resolution)', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.5.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::10.0.0.1', '224.0.0.1']) {
      assert.equal(isPrivateAddress(ip), true, ip);
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
    assert.match(webhookUrlError('http://example.com')!, /https/);
    assert.match(webhookUrlError('https://[::1]/x')!, /privée/);
    assert.match(webhookUrlError('https://localhost/x')!, /locale/);
    assert.equal(webhookUrlError('https://hooks.example.com/x?y=1'), null);

    const { api } = await account();
    const sent: string[] = [];
    // the hostname resolves to an internal address (DNS rebinding / internal service): refused, nothing sent
    setWebhookDeps({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }],
      transport: async (url) => {
        sent.push(url.toString());
        return { status: 200 };
      },
    });
    const a = await automation(api, { trigger: { type: 'contact_created' }, actions: [{ type: 'webhook', url: 'https://internal.example.com/hook' }] });
    await mk(api, 'ssrf@auto.fr');
    await drain();
    const run = (await runsOf(api, a.id))[0];
    assert.equal(run.status, 'failed');
    assert.match(run.error!, /10\.0\.0\.5 refusée/);
    assert.deepEqual(sent, []);

    // redirects are not followed; HTTP errors fail the run
    setWebhookDeps({ lookup: async () => [{ address: '93.184.216.34', family: 4 }], transport: async () => ({ status: 302 }) });
    await mk(api, 'redirect@auto.fr');
    await drain();
    assert.match((await runsOf(api, a.id))[0].error!, /Redirection 302 non suivie/);
  });

  test('signed POST (HMAC-SHA256 with timestamp), stable delivery id, contact payload', async () => {
    const { api } = await account();
    const calls: { url: string; address: string; headers: Record<string, string>; body: string }[] = [];
    setWebhookDeps({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async (url, address, init) => {
        calls.push({ url: url.toString(), address: address.address, ...init });
        return { status: 204 };
      },
    });
    await api.post('/api/custom-fields', { key: 'ville', label: 'Ville', type: 'text' });
    const t = await tag(api, 'hook');
    const a = await automation(api, { trigger: { type: 'tag_added', tag_id: t.id }, actions: [{ type: 'webhook', url: 'https://hooks.example.com/in?k=1' }] });
    const c = await mk(api, 'sig@auto.fr', { first_name: 'Sig', fields: { ville: 'Lyon' } });
    await api.post(`/api/contacts/${c.id}/tags`, { name: 'hook' });
    await drain();
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.url, 'https://hooks.example.com/in?k=1');
    assert.equal(call.address, '93.184.216.34'); // connection pinned to the validated address
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(call.headers['X-Scalo-Signature']);
    assert.ok(m, call.headers['X-Scalo-Signature']);
    const expected = crypto.createHmac('sha256', a.signing_secret).update(`${m[1]}.${call.body}`).digest('hex');
    assert.equal(m[2], expected);
    assert.equal(signPayload(a.signing_secret, call.body, Number(m[1])), call.headers['X-Scalo-Signature']);
    assert.ok(Math.abs(Number(m[1]) - Date.now() / 1000) < 60);
    const body = JSON.parse(call.body);
    assert.equal(body.event, 'automation.webhook');
    assert.equal(call.headers['X-Scalo-Delivery'], body.delivery_id);
    assert.equal(body.automation.id, a.id);
    assert.equal(body.trigger.type, 'tag_added');
    assert.equal(body.contact.email, 'sig@auto.fr');
    assert.deepEqual(body.contact.fields, { ville: 'Lyon' });
    assert.deepEqual(body.contact.tags.map((x: { name: string }) => x.name), ['hook']);
    const run = (await runsOf(api, a.id))[0];
    assert.equal(run.status, 'completed');
    assert.equal(run.log[0].message, 'Webhook appelé (HTTP 204)');
    // rotating the signing secret changes the signature key
    const rotated = (await api.post(`/api/automations/${a.id}/rotate-secret`, { which: 'signing' })).body;
    assert.notEqual(rotated.signing_secret, a.signing_secret);
  });
});
