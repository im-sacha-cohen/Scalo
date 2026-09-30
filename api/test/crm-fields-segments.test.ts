// CRM: custom fields (definitions, validation, contact page, CSV, forms, merge tags) and segments (compiler, saved
// segments, contact list filters, newsletters targeted by segment).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db } from '../src/db';
import { coerceFieldValue, parseDate } from '../src/services/fields';
import { EmailWorker } from '../src/worker';
import { client, http, registerUser, shutdown, startApp, type TestCtx } from './helpers';

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
const contact = async (api: Api, email: string, extra: Record<string, unknown> = {}) => {
  const r = await api.post('/api/contacts', { email, ...extra });
  assert.equal(r.status, 201, r.text);
  return r.body as { id: number; email: string; fields: Record<string, unknown> };
};
const emails = (r: { body: { items: { email: string }[] } }) => r.body.items.map((c) => c.email).sort();
const query = (api: Api, filter: unknown, extra: Record<string, unknown> = {}) => api.post('/api/contacts/query', { filter, limit: 500, ...extra });

async function fields(api: Api) {
  const mk = async (b: Record<string, unknown>) => {
    const r = await api.post('/api/custom-fields', b);
    assert.equal(r.status, 201, r.text);
    return r.body;
  };
  return {
    company: await mk({ label: 'Entreprise', type: 'text' }),
    budget: await mk({ key: 'budget', label: 'Budget', type: 'number' }),
    birthday: await mk({ label: 'Date de naissance', type: 'date' }),
    plan: await mk({ key: 'plan', label: 'Offre', type: 'select', options: ['Basic', 'Pro'] }),
    vip: await mk({ key: 'vip', label: 'VIP', type: 'checkbox' }),
  };
}

describe('custom fields', () => {
  test('value coercion by type', () => {
    const def = (type: string, options: string[] = []) => ({ key: 'k', label: 'K', type, options }) as never;
    assert.equal(coerceFieldValue(def('text'), '  Acme  '), 'Acme');
    assert.equal(coerceFieldValue(def('text'), ''), null);
    assert.equal(coerceFieldValue(def('number'), '1 234,5'), 1234.5);
    assert.throws(() => coerceFieldValue(def('number'), 'abc'), /nombre attendu/);
    assert.equal(coerceFieldValue(def('date'), '31/12/2024'), '2024-12-31');
    assert.equal(coerceFieldValue(def('date'), '2024-02-29'), '2024-02-29');
    assert.throws(() => coerceFieldValue(def('date'), '2023-02-29'), /date attendue/);
    assert.equal(parseDate('2024-05-01T10:00:00Z'), '2024-05-01');
    assert.equal(coerceFieldValue(def('select', ['Basic', 'Pro']), 'pro'), 'Pro');
    assert.throws(() => coerceFieldValue(def('select', ['Basic', 'Pro']), 'Gold'), /absente de la liste/);
    assert.equal(coerceFieldValue(def('checkbox'), 'oui'), true);
    assert.equal(coerceFieldValue(def('checkbox'), 0), false);
    assert.throws(() => coerceFieldValue(def('checkbox'), 'peut-être'), /oui \/ non/);
  });

  test('definitions CRUD: generated key, reserved / duplicate keys, immutable type, delete clears values', async () => {
    const { api } = await account();
    const f = await fields(api);
    assert.equal(f.company.key, 'entreprise');
    assert.equal(f.birthday.key, 'date_de_naissance');
    assert.equal((await api.post('/api/custom-fields', { key: 'budget', label: 'Autre', type: 'text' })).status, 409);
    assert.equal((await api.post('/api/custom-fields', { key: 'email', label: 'Email', type: 'text' })).status, 409);
    assert.equal((await api.post('/api/custom-fields', { key: '1abc', label: 'X', type: 'text' })).status, 400);
    assert.equal((await api.post('/api/custom-fields', { label: 'Liste vide', type: 'select' })).status, 400);
    assert.equal((await api.patch(`/api/custom-fields/${f.budget.id}`, { type: 'text' })).status, 400); // strict: no type change
    const upd = await api.patch(`/api/custom-fields/${f.plan.id}`, { label: 'Formule', options: ['Basic', 'Pro', 'Gold', 'gold'] });
    assert.equal(upd.body.label, 'Formule');
    assert.deepEqual(upd.body.options, ['Basic', 'Pro', 'gold']);
    const list = await api.get('/api/custom-fields');
    assert.deepEqual(list.body.map((x: { key: string }) => x.key), ['entreprise', 'budget', 'date_de_naissance', 'plan', 'vip']);

    const c = await contact(api, 'a@f.fr', { fields: { budget: 100, entreprise: 'Acme' } });
    assert.deepEqual(c.fields, { budget: 100, entreprise: 'Acme' });
    assert.equal((await api.del(`/api/custom-fields/${f.budget.id}`)).status, 200);
    assert.deepEqual((await api.get(`/api/contacts/${c.id}`)).body.fields, { entreprise: 'Acme' });
    // other accounts cannot touch the definitions
    const other = await account();
    assert.equal((await other.api.patch(`/api/custom-fields/${f.company.id}`, { label: 'x' })).status, 404);
  });

  test('contact create / patch: strict validation, merge, null empties', async () => {
    const { api } = await account();
    await fields(api);
    assert.equal((await api.post('/api/contacts', { email: 'x@f.fr', fields: { inconnu: 'a' } })).status, 400);
    const bad = await api.post('/api/contacts', { email: 'x@f.fr', fields: { budget: 'beaucoup' } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /Budget/);
    const c = await contact(api, 'x@f.fr', { fields: { budget: '42', plan: 'pro', vip: 'oui', date_de_naissance: '01/02/1990' } });
    assert.deepEqual(c.fields, { budget: 42, plan: 'Pro', vip: true, date_de_naissance: '1990-02-01' });
    const p = await api.patch(`/api/contacts/${c.id}`, { fields: { budget: null, entreprise: 'Globex' } });
    assert.equal(p.status, 200);
    assert.deepEqual(p.body.fields, { plan: 'Pro', vip: true, date_de_naissance: '1990-02-01', entreprise: 'Globex' });
    assert.equal((await api.patch(`/api/contacts/${c.id}`, { fields: { plan: 'Gold' } })).status, 400);
  });

  test('CSV import (by key or label, invalid values ignored) and export', async () => {
    const { api } = await account();
    await fields(api);
    const csv = 'email;prenom;Entreprise;field.budget;Offre;VIP\nimp1@f.fr;Ana;Acme;1500;Pro;oui\nimp2@f.fr;Bob;;abc;Gold;non\n';
    const r = await api.post('/api/contacts/import', { csv });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.created, 2);
    assert.deepEqual(r.body.fields.sort(), ['budget', 'entreprise', 'plan', 'vip']);
    assert.equal(r.body.invalid_values, 2); // abc, Gold
    const list = (await api.get('/api/contacts?search=imp')).body.items as { email: string; fields: unknown }[];
    assert.deepEqual(list.find((c) => c.email === 'imp1@f.fr')!.fields, { entreprise: 'Acme', budget: 1500, plan: 'Pro', vip: true });
    assert.deepEqual(list.find((c) => c.email === 'imp2@f.fr')!.fields, { vip: false });
    // re-import: empty cells keep the existing values
    await api.post('/api/contacts/import', { csv: 'email,entreprise,budget\nimp1@f.fr,,2000\n' });
    assert.deepEqual((await api.get('/api/contacts?search=imp1')).body.items[0].fields, { entreprise: 'Acme', budget: 2000, plan: 'Pro', vip: true });

    const exp = await api.get('/api/contacts/export');
    const lines = exp.text.replace(/^﻿/, '').trim().split('\n');
    assert.equal(lines[0], 'email,first_name,last_name,phone,tags,unsubscribed,created_at,confirmed_at,entreprise,budget,date_de_naissance,plan,vip');
    const row = lines.find((l) => l.startsWith('imp1@f.fr'))!;
    assert.ok(row.endsWith(',Acme,2000,,Pro,oui'), row);
  });

  test('funnel form: custom inputs rendered and stored (lenient), {{field.key}} in emails', async () => {
    const { api } = await account();
    await fields(api);
    const f = (await api.post('/api/funnels', { name: 'Champs perso', template: 'optin' })).body;
    const step = f.steps[0];
    await api.patch(`/api/steps/${step.id}`, {
      content: {
        settings: {},
        blocks: [
          {
            id: 'form1',
            type: 'form',
            submitLabel: 'Go',
            fields: [
              { name: 'email', label: 'Email', required: true },
              { name: 'field.entreprise', label: 'Votre entreprise', input: 'text' },
              { name: 'field.plan', label: 'Offre', input: 'select', options: ['Basic', 'Pro'] },
              { name: 'field.vip', label: 'VIP ?', input: 'checkbox' },
              { name: 'field.budget', label: 'Budget', input: 'number' },
            ],
          },
        ],
      },
    });
    const page = await http(ctx, 'GET', `/p/${f.slug}/${step.slug}`);
    assert.match(page.text, /name="field\.entreprise"/);
    assert.match(page.text, /<select name="field\.plan"[^>]*>.*<option value="Pro">Pro<\/option>/s);
    assert.match(page.text, /type="checkbox" name="field\.vip"/);
    const sub = await http(ctx, 'POST', `/p/${f.slug}/${step.slug}/submit`, {
      // budget invalid → ignored; date_de_naissance not in the form → ignored
      form: { email: 'form@f.fr', 'field.entreprise': 'Initech', 'field.plan': 'pro', 'field.vip': 'true', 'field.budget': 'n/a', 'field.date_de_naissance': '2000-01-01', _block: 'form1' },
    });
    assert.equal(sub.status, 303);
    const c = (await api.get('/api/contacts?search=form@f.fr')).body.items[0];
    assert.deepEqual(c.fields, { entreprise: 'Initech', plan: 'Pro', vip: true });

    // merge tags in a newsletter
    const b = (await api.post('/api/broadcasts', { subject: 'Offre {{field.plan}}' })).body;
    await api.patch(`/api/broadcasts/${b.id}`, {
      content: { settings: {}, blocks: [{ id: 't', type: 'text', text: 'Bonjour {{field.entreprise}} / VIP {{field.vip}} / {{field.budget}}.' }] },
    });
    assert.equal((await api.post(`/api/broadcasts/${b.id}/send`)).status, 200);
    await new EmailWorker({ throttle: false }).drain();
    const send = await db.selectFrom('email_sends').select(['subject', 'html']).where('broadcast_id', '=', b.id).executeTakeFirstOrThrow();
    assert.equal(send.subject, 'Offre Pro');
    assert.match(send.html!, /Bonjour Initech \/ VIP Oui \/ \./);
  });
});

describe('segments', () => {
  test('compiler: every condition type, ET / OU, nested groups', async () => {
    const { api, userId } = await account();
    await fields(api);
    const tagA = (await api.post('/api/tags', { name: 'A' })).body;
    const tagB = (await api.post('/api/tags', { name: 'B' })).body;
    const ann = await contact(api, 'ann@s.fr', { first_name: 'Ann', tags: ['A'], fields: { budget: 500, entreprise: 'Acme Corp', plan: 'Pro', vip: true, date_de_naissance: '1990-06-15' } });
    const ben = await contact(api, 'ben@s.fr', { first_name: 'Ben', tags: ['A', 'B'], fields: { budget: 50, plan: 'Basic' } });
    const cat = await contact(api, 'cat@s.fr', { first_name: 'Cat', tags: ['B'], fields: { entreprise: 'Globex' } });
    const dan = await contact(api, 'dan@s.fr', { first_name: 'Dan' });
    // statuses / dates / activity
    await api.patch(`/api/contacts/${dan.id}`, { unsubscribed: true });
    await db.updateTable('contacts').set({ confirmed_at: null }).where('id', '=', cat.id).execute();
    await db.updateTable('contacts').set({ created_at: sql`now() - interval '40 days'` }).where('id', '=', ben.id).execute();
    await db.updateTable('contacts').set({ created_at: '2020-01-10T12:00:00Z' }).where('id', '=', dan.id).execute();
    const now = new Date().toISOString();
    await db
      .insertInto('email_sends')
      .values([
        { user_id: userId, contact_id: ann.id, to_email: ann.email, subject: 's', status: 'sent', send_at: now, sent_at: now, opened_at: now, clicked_at: now, created_at: now },
        { user_id: userId, contact_id: ben.id, to_email: ben.email, subject: 's', status: 'sent', send_at: now, sent_at: now, opened_at: sql`now() - interval '20 days'`, created_at: now },
      ])
      .execute();
    // optin through a funnel, campaign, purchase
    const f = (await api.post('/api/funnels', { name: 'Seg', template: 'optin' })).body;
    await http(ctx, 'POST', `/p/${f.slug}/${f.steps[0].slug}/submit`, { form: { email: 'ben@s.fr' } });
    const camp = (await api.post('/api/campaigns', { name: 'C' })).body;
    await api.post(`/api/campaigns/${camp.id}/enroll`, { contact_id: ann.id });
    await db.insertInto('contact_events').values({ user_id: userId, contact_id: cat.id, type: 'purchase', data: JSON.stringify({ product: 'Formation' }), created_at: now }).execute();

    const cases: [unknown, string[]][] = [
      [{ match: 'all', conditions: [] }, ['ann@s.fr', 'ben@s.fr', 'cat@s.fr', 'dan@s.fr']],
      [{ match: 'all', conditions: [{ type: 'tag', op: 'has', tag_id: tagA.id }] }, ['ann@s.fr', 'ben@s.fr']],
      [{ match: 'all', conditions: [{ type: 'tag', op: 'has', tag_id: tagA.id }, { type: 'tag', op: 'has', tag_id: tagB.id }] }, ['ben@s.fr']],
      [{ match: 'any', conditions: [{ type: 'tag', op: 'has', tag_id: tagA.id }, { type: 'tag', op: 'has', tag_id: tagB.id }] }, ['ann@s.fr', 'ben@s.fr', 'cat@s.fr']],
      [{ match: 'all', conditions: [{ type: 'tag', op: 'not_has', tag_id: tagA.id }] }, ['cat@s.fr', 'dan@s.fr']],
      [{ match: 'all', conditions: [{ type: 'field', key: 'budget', op: 'gt', value: 100 }] }, ['ann@s.fr']],
      [{ match: 'all', conditions: [{ type: 'field', key: 'budget', op: 'lt', value: 100 }] }, ['ben@s.fr']],
      [{ match: 'all', conditions: [{ type: 'field', key: 'budget', op: 'eq', value: '50' }] }, ['ben@s.fr']],
      [{ match: 'all', conditions: [{ type: 'field', key: 'entreprise', op: 'contains', value: 'acme' }] }, ['ann@s.fr']],
      [{ match: 'all', conditions: [{ type: 'field', key: 'entreprise', op: 'not_contains', value: 'acme' }] }, ['ben@s.fr', 'cat@s.fr', 'dan@s.fr']],
      [{ match: 'all', conditions: [{ type: 'field', key: 'entreprise', op: 'eq', value: 'GLOBEX' }] }, ['cat@s.fr']],
      [{ match: 'all', conditions: [{ type: 'field', key: 'entreprise', op: 'empty' }] }, ['ben@s.fr', 'dan@s.fr']],
      [{ match: 'all', conditions: [{ type: 'field', key: 'plan', op: 'neq', value: 'Pro' }] }, ['ben@s.fr', 'cat@s.fr', 'dan@s.fr']],
      [{ match: 'all', conditions: [{ type: 'field', key: 'vip', op: 'eq', value: true }] }, ['ann@s.fr']],
      [{ match: 'all', conditions: [{ type: 'field', key: 'vip', op: 'eq', value: false }] }, ['ben@s.fr', 'cat@s.fr', 'dan@s.fr']],
      [{ match: 'all', conditions: [{ type: 'field', key: 'date_de_naissance', op: 'lt', value: '2000-01-01' }] }, ['ann@s.fr']],
      [{ match: 'all', conditions: [{ type: 'field', key: 'first_name', op: 'eq', value: 'ben' }] }, ['ben@s.fr']],
      [{ match: 'all', conditions: [{ type: 'field', key: 'email', op: 'contains', value: '%' }] }, []], // LIKE wildcards escaped
      [{ match: 'all', conditions: [{ type: 'status', op: 'is', value: 'confirmed' }] }, ['ann@s.fr', 'ben@s.fr']],
      [{ match: 'all', conditions: [{ type: 'status', op: 'is', value: 'pending_confirmation' }] }, ['cat@s.fr']],
      [{ match: 'all', conditions: [{ type: 'status', op: 'is', value: 'unsubscribed' }] }, ['dan@s.fr']],
      [{ match: 'all', conditions: [{ type: 'status', op: 'is_not', value: 'unsubscribed' }] }, ['ann@s.fr', 'ben@s.fr', 'cat@s.fr']],
      [{ match: 'all', conditions: [{ type: 'created', op: 'within_days', value: 30 }] }, ['ann@s.fr', 'cat@s.fr']],
      [{ match: 'all', conditions: [{ type: 'created', op: 'older_than_days', value: 30 }] }, ['ben@s.fr', 'dan@s.fr']],
      [{ match: 'all', conditions: [{ type: 'created', op: 'before', value: '2020-01-11' }] }, ['dan@s.fr']],
      [{ match: 'all', conditions: [{ type: 'created', op: 'after', value: '2020-01-10' }] }, ['ann@s.fr', 'ben@s.fr', 'cat@s.fr']],
      [{ match: 'all', conditions: [{ type: 'email_activity', op: 'opened', days: 7 }] }, ['ann@s.fr']],
      [{ match: 'all', conditions: [{ type: 'email_activity', op: 'opened', days: 30 }] }, ['ann@s.fr', 'ben@s.fr']],
      [{ match: 'all', conditions: [{ type: 'email_activity', op: 'clicked', days: 30 }] }, ['ann@s.fr']],
      [{ match: 'all', conditions: [{ type: 'email_activity', op: 'not_opened', days: 7 }] }, ['ben@s.fr', 'cat@s.fr', 'dan@s.fr']],
      [{ match: 'all', conditions: [{ type: 'optin', op: 'did', funnel_id: f.id }] }, ['ben@s.fr']],
      [{ match: 'all', conditions: [{ type: 'optin', op: 'did_not', funnel_id: null }] }, ['ann@s.fr', 'cat@s.fr', 'dan@s.fr']],
      [{ match: 'all', conditions: [{ type: 'campaign', op: 'enrolled', campaign_id: camp.id }] }, ['ann@s.fr']],
      [{ match: 'all', conditions: [{ type: 'campaign', op: 'not_enrolled', campaign_id: camp.id }] }, ['ben@s.fr', 'cat@s.fr', 'dan@s.fr']],
      [{ match: 'all', conditions: [{ type: 'purchase', op: 'did', product: 'formation' }] }, ['cat@s.fr']],
      [{ match: 'all', conditions: [{ type: 'purchase', op: 'did_not' }] }, ['ann@s.fr', 'ben@s.fr', 'dan@s.fr']],
      // (A and budget > 100) or (B and pending)
      [
        {
          match: 'any',
          conditions: [
            { match: 'all', conditions: [{ type: 'tag', op: 'has', tag_id: tagA.id }, { type: 'field', key: 'budget', op: 'gt', value: 100 }] },
            { match: 'all', conditions: [{ type: 'tag', op: 'has', tag_id: tagB.id }, { type: 'status', op: 'is', value: 'pending_confirmation' }] },
          ],
        },
        ['ann@s.fr', 'cat@s.fr'],
      ],
    ];
    for (const [filter, expected] of cases) {
      const r = await query(api, filter);
      assert.equal(r.status, 200, `${JSON.stringify(filter)} → ${r.text}`);
      assert.deepEqual(emails(r), expected, JSON.stringify(filter));
      const n = await api.post('/api/segments/preview', { filter });
      assert.equal(n.body.count, expected.length);
    }

    // validation: foreign / unknown references, bad values, depth
    const other = await account();
    const foreignTag = (await other.api.post('/api/tags', { name: 'X' })).body;
    assert.equal((await query(api, { match: 'all', conditions: [{ type: 'tag', op: 'has', tag_id: foreignTag.id }] })).status, 404);
    assert.equal((await query(api, { match: 'all', conditions: [{ type: 'field', key: 'nope', op: 'eq', value: 'x' }] })).status, 404);
    assert.equal((await query(api, { match: 'all', conditions: [{ type: 'field', key: 'budget', op: 'gt' }] })).status, 400);
    assert.equal((await query(api, { match: 'all', conditions: [{ type: 'created', op: 'before', value: 'hier' }] })).status, 400);
    assert.equal((await query(api, { match: 'all', conditions: [{ type: 'bogus' }] })).status, 400);
    const deep = { match: 'all', conditions: [{ match: 'all', conditions: [{ match: 'all', conditions: [{ match: 'all', conditions: [] }] }] }] };
    assert.equal((await query(api, deep)).status, 400);
    // injection attempts are plain values
    const inj = await query(api, { match: 'all', conditions: [{ type: 'field', key: 'entreprise', op: 'eq', value: "x' OR '1'='1" }] });
    assert.deepEqual(emails(inj), []);
  });

  test('saved segments: CRUD, counts, list filter, newsletter recipients computed at send time', async () => {
    const { api } = await account();
    await fields(api);
    await contact(api, 'p1@s.fr', { fields: { plan: 'Pro' } });
    await contact(api, 'p2@s.fr', { fields: { plan: 'Pro' }, tags: ['lead'] });
    await contact(api, 'b1@s.fr', { fields: { plan: 'Basic' } });
    const filter = { match: 'all', conditions: [{ type: 'field', key: 'plan', op: 'eq', value: 'Pro' }] };
    const s = await api.post('/api/segments', { name: 'Clients Pro', filter });
    assert.equal(s.status, 201, s.text);
    assert.equal(s.body.contacts_count, 2);
    assert.equal((await api.post('/api/segments', { name: 'clients pro', filter })).status, 409);
    assert.equal((await api.get('/api/segments')).body[0].contacts_count, 2);
    // GET /contacts?segment_id (+ other filters)
    assert.deepEqual(emails(await api.get(`/api/contacts?segment_id=${s.body.id}`)), ['p1@s.fr', 'p2@s.fr']);
    const lead = (await api.get('/api/tags')).body.find((t: { name: string }) => t.name === 'lead');
    assert.deepEqual(emails(await api.get(`/api/contacts?segment_id=${s.body.id}&tag_id=${lead.id}`)), ['p2@s.fr']);
    // other account: 404
    const other = await account();
    assert.equal((await other.api.get(`/api/segments/${s.body.id}`)).status, 404);
    assert.equal((await other.api.get(`/api/contacts?segment_id=${s.body.id}`)).status, 404);

    // newsletter targeted by the segment: recipients computed when the send starts
    const b = (await api.post('/api/broadcasts', { subject: 'Pro only' })).body;
    assert.equal((await other.api.patch(`/api/broadcasts/${b.id}`, { segment_id: s.body.id })).status, 404);
    const seg = await api.patch(`/api/broadcasts/${b.id}`, { segment_id: s.body.id });
    assert.equal(seg.body.segment_id, s.body.id);
    assert.equal((await api.get(`/api/broadcasts/${b.id}/recipients-count`)).body.count, 2);
    assert.equal((await api.get(`/api/broadcasts/${b.id}/recipients-count?segment_id=`)).body.count, 3);
    // deleting a segment used by a draft is refused
    assert.equal((await api.del(`/api/segments/${s.body.id}`)).status, 409);
    await contact(api, 'p3@s.fr', { fields: { plan: 'pro' } }); // joins before the send
    await api.post(`/api/broadcasts/${b.id}/send`);
    const to = await db.selectFrom('email_sends').select('to_email').where('broadcast_id', '=', b.id).execute();
    assert.deepEqual(to.map((r) => r.to_email).sort(), ['p1@s.fr', 'p2@s.fr', 'p3@s.fr']);

    // edit the filter; delete once the newsletter is sent (FK → NULL)
    const edited = await api.patch(`/api/segments/${s.body.id}`, { filter: { match: 'any', conditions: [...filter.conditions, { type: 'field', key: 'plan', op: 'eq', value: 'Basic' }] } });
    assert.equal(edited.body.contacts_count, 4);
    assert.equal((await api.del(`/api/segments/${s.body.id}`)).status, 200);
    assert.equal((await api.get(`/api/broadcasts/${b.id}`)).body.segment_id, null);
  });
});
