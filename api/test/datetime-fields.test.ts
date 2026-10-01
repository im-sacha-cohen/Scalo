// Custom field type « Date et heure » (datetime): strict validation, time zones (Europe/Paris when no offset), segments,
// funnel form, CSV export / import, merge tags — and the import mapping step (typed fields created on the fly, column
// statistics, invalid values counted and journaled, ignored columns).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { formatFieldDateTime, parseFieldDateTime, suggestFieldType } from '@scalo/shared';
import { db } from '../src/db';
import { formatFieldValue } from '../src/services/fields';
import { columnStats } from '../src/services/import-sources';
import { setSystemeIoFetch } from '../src/services/systeme-io';
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
async function field(api: Api, body: Record<string, unknown>) {
  const r = await api.post('/api/custom-fields', body);
  assert.equal(r.status, 201, r.text);
  return r.body as { key: string; type: string; options: string[] };
}
const drain = () => new EmailWorker({ throttle: false }).drain();

describe('date et heure : validation et fuseaux', () => {
  test('parseur partagé : ISO avec / sans fuseau, JJ/MM/AAAA HH:mm, heure d’été / d’hiver, refus', () => {
    assert.equal(parseFieldDateTime('2026-10-01T14:30'), '2026-10-01T12:30:00.000Z', 'heure d’été à Paris : UTC+2');
    assert.equal(parseFieldDateTime('2026-01-15 10:00'), '2026-01-15T09:00:00.000Z', 'heure d’hiver : UTC+1');
    assert.equal(parseFieldDateTime('01/10/2026 14:30'), '2026-10-01T12:30:00.000Z');
    assert.equal(parseFieldDateTime('1/1/2026 9h05'), '2026-01-01T08:05:00.000Z');
    assert.equal(parseFieldDateTime('2026-10-01T14:30:00+05:30'), '2026-10-01T09:00:00.000Z');
    assert.equal(parseFieldDateTime('2026-10-01T12:30:00.250Z'), '2026-10-01T12:30:00.250Z');
    assert.equal(parseFieldDateTime('2026-10-01T14:30', 'America/New_York'), '2026-10-01T18:30:00.000Z', 'fuseau explicite');
    for (const bad of ['2026-10-01', 'demain', '31/02/2026 10:00', '2026-10-01T24:00', '2026-13-01T10:00', '2026-10-01T10:00+15:00', '']) {
      assert.equal(parseFieldDateTime(bad), null, bad);
    }
    assert.equal(formatFieldDateTime('2026-10-01T12:30:00.000Z'), '01/10/2026 14:30');
    assert.equal(formatFieldDateTime('2026-01-15T09:00:00.000Z'), '15/01/2026 10:00');
    assert.equal(formatFieldValue('datetime', '2026-10-01T12:30:00.000Z'), '01/10/2026 14:30');
  });

  test('API : stockage en UTC, validation stricte (400), valeur vide = effacée', async () => {
    const { api } = await account();
    const f = await field(api, { label: 'Rendez-vous', type: 'datetime' });
    assert.equal(f.type, 'datetime');
    assert.equal(f.key, 'rendez_vous');
    const c = (await api.post('/api/contacts', { email: 'rdv@d.fr', fields: { rendez_vous: '2026-10-01T14:30' } })).body;
    assert.equal(c.fields.rendez_vous, '2026-10-01T12:30:00.000Z', 'sans fuseau : heure de Paris');
    const p1 = await api.patch(`/api/contacts/${c.id}`, { fields: { rendez_vous: '2026-12-24T18:00:00-05:00' } });
    assert.equal(p1.status, 200, p1.text);
    assert.equal(p1.body.fields.rendez_vous, '2026-12-24T23:00:00.000Z');
    const p2 = await api.patch(`/api/contacts/${c.id}`, { fields: { rendez_vous: '24/12/2026 18:00' } });
    assert.equal(p2.body.fields.rendez_vous, '2026-12-24T17:00:00.000Z');
    for (const bad of ['2026-12-24', 'jeudi 18h', 1790000000]) {
      const r = await api.patch(`/api/contacts/${c.id}`, { fields: { rendez_vous: bad } });
      assert.equal(r.status, 400, `${bad} → ${r.text}`);
      assert.match(r.body.error, /Rendez-vous/);
    }
    const cleared = await api.patch(`/api/contacts/${c.id}`, { fields: { rendez_vous: null } });
    assert.deepEqual(cleared.body.fields, {});
    // the type cannot change afterwards
    const fid = (await api.get('/api/custom-fields')).body[0].id;
    assert.equal((await api.patch(`/api/custom-fields/${fid}`, { type: 'text' })).status, 400);
  });

  test('migration : la contrainte CHECK accepte « datetime » et garde les autres types', async () => {
    const { rows } = await sql<{ def: string }>`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'custom_fields_type_check'`.execute(db);
    for (const t of ['text', 'number', 'date', 'datetime', 'select', 'checkbox']) assert.match(rows[0].def, new RegExp(`'${t}'`));
    const { userId } = await account();
    await assert.rejects(db.insertInto('custom_fields').values({ user_id: userId, key: 'x', label: 'X', type: 'heure' as never, created_at: new Date().toISOString() }).execute());
  });
});

describe('date et heure : segments, formulaires, exports, variables', () => {
  test('segments : après, avant, dans les N derniers jours, vide', async () => {
    const { api } = await account();
    await field(api, { key: 'rdv', label: 'RDV', type: 'datetime' });
    await field(api, { key: 'naissance', label: 'Naissance', type: 'date' });
    const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const today = new Date().toISOString().slice(0, 10);
    await api.post('/api/contacts', { email: 'recent@s.fr', fields: { rdv: recent, naissance: today } });
    await api.post('/api/contacts', { email: 'old@s.fr', fields: { rdv: old, naissance: '1990-01-01' } });
    await api.post('/api/contacts', { email: 'future@s.fr', fields: { rdv: future } });
    await api.post('/api/contacts', { email: 'none@s.fr' });
    const match = async (cond: Record<string, unknown>) => {
      const r = await api.post('/api/contacts/query', { filter: { match: 'all', conditions: [{ type: 'field', ...cond }] }, limit: 100 });
      assert.equal(r.status, 200, r.text);
      return (r.body.items as { email: string }[]).map((c) => c.email).sort();
    };
    const mid = new Date(Date.now() - 10 * 86_400_000).toISOString();
    assert.deepEqual(await match({ key: 'rdv', op: 'gt', value: mid }), ['future@s.fr', 'recent@s.fr']);
    assert.deepEqual(await match({ key: 'rdv', op: 'lt', value: mid }), ['old@s.fr']);
    // an offset or a Paris time are accepted too
    assert.deepEqual(await match({ key: 'rdv', op: 'gt', value: '2000-01-01T00:00' }), ['future@s.fr', 'old@s.fr', 'recent@s.fr']);
    assert.deepEqual(await match({ key: 'rdv', op: 'within_days', value: 7 }), ['recent@s.fr'], 'le futur n’est pas « dans les derniers jours »');
    assert.deepEqual(await match({ key: 'rdv', op: 'empty' }), ['none@s.fr']);
    assert.deepEqual(await match({ key: 'rdv', op: 'not_empty' }), ['future@s.fr', 'old@s.fr', 'recent@s.fr']);
    assert.deepEqual(await match({ key: 'naissance', op: 'within_days', value: 3 }), ['recent@s.fr'], 'aussi pour les dates');
    // validation
    const bad = (cond: Record<string, unknown>) => api.post('/api/segments/preview', { filter: { match: 'all', conditions: [{ type: 'field', ...cond }] } });
    assert.equal((await bad({ key: 'rdv', op: 'gt', value: 'hier' })).status, 400);
    assert.equal((await bad({ key: 'rdv', op: 'within_days', value: -1 })).status, 400);
    assert.equal((await bad({ key: 'email', op: 'within_days', value: 3 })).status, 400);
    assert.equal((await bad({ key: 'rdv', op: 'within_days', value: 3 })).status, 200);
  });

  test('formulaire de tunnel : champ date et heure rendu, soumission lue à l’heure de Paris, valeur invalide ignorée', async () => {
    const { api } = await account();
    await field(api, { key: 'creneau', label: 'Créneau', type: 'datetime' });
    const f = (await api.post('/api/funnels', { name: 'RDV', template: 'optin' })).body;
    const step = f.steps[0];
    const r = await api.patch(`/api/steps/${step.id}`, {
      content: {
        settings: {},
        blocks: [{ id: 'form1', type: 'form', submitLabel: 'Réserver', fields: [{ name: 'email', label: 'Email', required: true }, { name: 'field.creneau', label: 'Créneau', input: 'datetime' }] }],
      },
    });
    assert.equal(r.status, 200, r.text);
    const page = await http(ctx, 'GET', `/p/${f.slug}/${step.slug}`);
    assert.match(page.text, /<input type="datetime-local" name="field\.creneau"/);
    assert.match(page.text, /heure de Paris/);
    const sub = await http(ctx, 'POST', `/p/${f.slug}/${step.slug}/submit`, { form: { email: 'form@d.fr', 'field.creneau': '2026-11-05T09:15', _block: 'form1' } });
    assert.equal(sub.status, 303);
    const sub2 = await http(ctx, 'POST', `/p/${f.slug}/${step.slug}/submit`, { form: { email: 'bad@d.fr', 'field.creneau': 'n’importe quand', _block: 'form1' } });
    assert.equal(sub2.status, 303, 'formulaire tolérant');
    const list = (await api.get('/api/contacts?limit=10')).body.items as { email: string; fields: Record<string, unknown> }[];
    assert.equal(list.find((c) => c.email === 'form@d.fr')!.fields.creneau, '2026-11-05T08:15:00.000Z');
    assert.deepEqual(list.find((c) => c.email === 'bad@d.fr')!.fields, {});
  });

  test('export CSV lisible (JJ/MM/AAAA HH:mm, Paris), réimport à l’identique, variables {{field.cle}}', async () => {
    const { api } = await account();
    await field(api, { key: 'rdv', label: 'RDV', type: 'datetime' });
    await api.post('/api/contacts', { email: 'x@d.fr', fields: { rdv: '2026-07-14T08:00:00.000Z' } });
    const csv = (await api.get('/api/contacts/export')).text;
    const [head, line] = csv.replace(/^﻿/, '').trim().split('\n');
    const cols = head.split(',');
    assert.equal(line.split(',')[cols.indexOf('rdv')], '14/07/2026 10:00');
    // the same file imported in another account gives the same instant
    const other = await account();
    await field(other.api, { key: 'rdv', label: 'RDV', type: 'datetime' });
    const imp = await other.api.post('/api/contacts/import', { csv });
    assert.equal(imp.status, 200, imp.text);
    assert.equal(imp.body.invalid_values, 0);
    assert.equal((await other.api.get('/api/contacts')).body.items[0].fields.rdv, '2026-07-14T08:00:00.000Z');
    // merge tags in an email: readable, Paris time
    const b = (await api.post('/api/broadcasts', { subject: 'RDV le {{field.rdv}}' })).body;
    await api.patch(`/api/broadcasts/${b.id}`, { content: { settings: {}, blocks: [{ id: 't', type: 'text', text: 'À bientôt' }] } });
    assert.equal((await api.post(`/api/broadcasts/${b.id}/send`)).status, 200);
    await drain();
    const send = await db.selectFrom('email_sends').select('subject').where('broadcast_id', '=', b.id).executeTakeFirstOrThrow();
    assert.equal(send.subject, 'RDV le 14/07/2026 10:00');
  });
});

describe('import : correspondance et création de champs personnalisés', () => {
  test('statistiques des colonnes : type proposé, valeurs invalides, valeurs distinctes', () => {
    assert.equal(suggestFieldType(['12', '1 200', '3,5']), 'number');
    assert.equal(suggestFieldType(['0612345678', '0698765432']), 'text', 'un téléphone n’est pas un nombre');
    assert.equal(suggestFieldType(['01/10/2026 14:30', '2026-10-02T10:00']), 'datetime');
    assert.equal(suggestFieldType(['01/10/2026', '2026-10-02']), 'date');
    assert.equal(suggestFieldType(['oui', 'non', 'oui']), 'checkbox');
    assert.equal(suggestFieldType(['Or', 'Argent', 'Or', 'Argent', 'Or']), 'select');
    assert.equal(suggestFieldType(['Paris', 'Lyon']), 'text');
    const st = columnStats(['12', '', 'abc', '7', 'x']);
    assert.equal(st.filled, 4);
    assert.equal(st.invalid.number.count, 2);
    assert.deepEqual(st.invalid.number.examples, ['abc', 'x']);
    assert.equal(st.suggested_type, 'text');
    assert.deepEqual(st.distinct, ['12', 'abc', '7', 'x']);
  });

  test('champs typés créés pendant l’import (dont date et heure, liste), valeurs invalides comptées et journalisées, colonnes ignorées', async () => {
    const { api, userId } = await account();
    const existing = await field(api, { key: 'budget', label: 'Budget', type: 'number' });
    const csv = [
      'Email;Rendez-vous;Inscrit le;Niveau;Client;Budget;Note interne',
      'a@imp.fr;01/10/2026 14:30;2026-03-01;Or;oui;1 500;secret A',
      'b@imp.fr;2026-10-02T09:00:00Z;01/04/2026;Argent;non;abc;secret B',
      'c@imp.fr;bientôt;2026-02-30;Bronze;peut-être;20;secret C',
      'd@imp.fr;;;Or;;;',
    ].join('\n');
    const an = await api.post('/api/imports/csv/analyze', { csv });
    assert.equal(an.status, 200, an.text);
    const col = (name: string) => (an.body.columns as { column: string; stats: { suggested_type: string; invalid: Record<string, { count: number; examples: string[] }>; distinct: string[] } }[]).find((c) => c.column === name)!;
    assert.equal(col('Rendez-vous').stats.invalid.datetime.count, 1);
    assert.deepEqual(col('Rendez-vous').stats.invalid.datetime.examples, ['bientôt']);
    assert.equal(col('Rendez-vous').stats.suggested_type, 'text', 'une valeur invalide : pas de type proposé');
    assert.equal(col('Client').stats.invalid.checkbox.count, 1);
    assert.deepEqual(col('Niveau').stats.distinct, ['Or', 'Argent', 'Bronze']);
    assert.equal(col('Budget').stats.invalid.number.count, 1);
    assert.equal((an.body.mapping as { column: string; target: string; field_key?: string }[]).find((m) => m.column === 'Budget')!.field_key, 'budget', 'champ existant reconnu');

    const mapping = [
      { column: 'Email', target: 'email' },
      { column: 'Rendez-vous', target: 'field', create: { label: 'Rendez-vous', type: 'datetime' } },
      { column: 'Inscrit le', target: 'field', create: { label: 'Inscrit le', type: 'date' } },
      { column: 'Niveau', target: 'field', create: { label: 'Niveau', type: 'select', options: ['Or', 'Argent'] } },
      { column: 'Client', target: 'field', create: { label: 'Client', type: 'checkbox' } },
      { column: 'Budget', target: 'field', field_key: existing.key },
      { column: 'Note interne', target: 'ignore' },
    ];
    // two columns on the same standard field / list without options: refused before anything is created
    assert.equal((await api.post('/api/imports/preview', { source: 'csv', csv, mapping: [...mapping.slice(0, 6), { column: 'Note interne', target: 'email' }] })).status, 400);
    assert.equal((await api.post('/api/imports/preview', { source: 'csv', csv, mapping: mapping.map((m) => (m.column === 'Niveau' ? { ...m, create: { label: 'Niveau', type: 'select' } } : m)) })).status, 400);

    const prev = await api.post('/api/imports/preview', { source: 'csv', csv, mapping });
    assert.equal(prev.status, 200, prev.text);
    const inv = Object.fromEntries((prev.body.invalid_values as { column: string; count: number }[]).map((x) => [x.column, x.count]));
    assert.deepEqual(inv, { 'Rendez-vous': 1, 'Inscrit le': 1, Niveau: 1, Client: 1, Budget: 1 });
    assert.deepEqual(prev.body.new_fields, ['Rendez-vous', 'Inscrit le', 'Niveau', 'Client']);
    assert.equal((await db.selectFrom('custom_fields').select('id').where('user_id', '=', userId).execute()).length, 1, 'l’aperçu ne crée rien');

    const job = await api.post('/api/imports', { source: 'csv', csv, mapping, options: { consent: true } });
    assert.equal(job.status, 201, job.text);
    const defs = (await api.get('/api/custom-fields')).body as { key: string; type: string; options: string[] }[];
    const byKey = Object.fromEntries(defs.map((d) => [d.key, d]));
    assert.equal(byKey.rendez_vous.type, 'datetime');
    assert.equal(byKey.inscrit_le.type, 'date');
    assert.deepEqual([byKey.niveau.type, byKey.niveau.options], ['select', ['Or', 'Argent']]);
    assert.equal(byKey.client.type, 'checkbox');
    assert.equal(byKey.note_interne, undefined, 'colonne ignorée : aucun champ');

    await drain();
    const done = (await api.get(`/api/imports/${job.body.id}`)).body;
    assert.equal(done.status, 'completed');
    assert.equal(done.created, 4);
    assert.equal(done.warnings, 5, 'une valeur invalide par colonne typée');
    const items = (await api.get('/api/contacts?limit=10')).body.items as { email: string; fields: Record<string, unknown> }[];
    const f = (email: string) => items.find((c) => c.email === email)!.fields;
    assert.deepEqual(f('a@imp.fr'), { rendez_vous: '2026-10-01T12:30:00.000Z', inscrit_le: '2026-03-01', niveau: 'Or', client: true, budget: 1500 });
    assert.deepEqual(f('b@imp.fr'), { rendez_vous: '2026-10-02T09:00:00.000Z', inscrit_le: '2026-04-01', niveau: 'Argent', client: false });
    assert.deepEqual(f('c@imp.fr'), { budget: 20 }, 'valeurs invalides ignorées');
    assert.deepEqual(f('d@imp.fr'), { niveau: 'Or' });
    assert.ok(!JSON.stringify(items).includes('secret'), 'colonne ignorée non importée');
    const journal = (await api.get(`/api/imports/${job.body.id}/errors.csv`)).text;
    for (const v of ['bientôt', '2026-02-30', 'Bronze', 'peut-être', 'abc']) assert.ok(journal.includes(v), `journal : ${v}`);
    assert.match(journal, /Valeur ignorée pour le champ « Rendez-vous »/);
  });

  test('source systeme.io : mêmes statistiques et création de champs typés depuis les champs de l’API', async () => {
    const { api } = await account();
    const people = [
      { id: 1, email: 'sio1@d.fr', registeredAt: '2024-01-02T03:04:05+00:00', unsubscribed: false, bounced: false, fields: [{ slug: 'first_name', value: 'Ana' }, { slug: 'webinaire', value: '2026-11-05 18:00' }, { slug: 'score', value: '12' }], tags: [] },
      { id: 2, email: 'sio2@d.fr', registeredAt: '2024-01-03T03:04:05+00:00', unsubscribed: false, bounced: false, fields: [{ slug: 'first_name', value: 'Bob' }, { slug: 'webinaire', value: 'plus tard' }, { slug: 'score', value: '7' }], tags: [] },
    ];
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    setSystemeIoFetch((async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/tags')) return json({ items: [], hasMore: false });
      if (url.pathname.endsWith('/contact_fields')) return json({ items: [{ slug: 'webinaire', fieldName: 'Webinaire' }, { slug: 'score', fieldName: 'Score' }] });
      return json({ items: people, hasMore: false });
    }) as typeof fetch);
    try {
      const an = await api.post('/api/imports/systeme-io/connect', { api_key: 'sio-test-key-123' });
      assert.equal(an.status, 200, an.text);
      const cols = an.body.columns as { column: string; label: string; stats: { suggested_type: string; invalid: Record<string, { count: number }> } }[];
      const web = cols.find((c) => c.column === 'field:webinaire')!;
      assert.equal(web.label, 'Webinaire');
      assert.equal(web.stats.invalid.datetime.count, 1);
      assert.equal(cols.find((c) => c.column === 'field:score')!.stats.suggested_type, 'number');
      const mapping = (an.body.mapping as { column: string; target: string }[]).map((m) =>
        m.column === 'field:webinaire' ? { column: m.column, target: 'field', create: { label: 'Webinaire', type: 'datetime' } } : m.column === 'field:score' ? { column: m.column, target: 'field', create: { label: 'Score', type: 'number' } } : m,
      );
      const job = await api.post('/api/imports', { source: 'systeme_io', api_key: 'sio-test-key-123', mapping, options: { consent: true } });
      assert.equal(job.status, 201, job.text);
      await drain();
      const done = (await api.get(`/api/imports/${job.body.id}`)).body;
      assert.equal(done.status, 'completed', done.error ?? '');
      assert.equal(done.warnings, 1);
      const items = (await api.get('/api/contacts?limit=10')).body.items as { email: string; first_name: string; fields: Record<string, unknown> }[];
      const ana = items.find((c) => c.email === 'sio1@d.fr')!;
      assert.equal(ana.first_name, 'Ana');
      assert.deepEqual(ana.fields, { webinaire: '2026-11-05T17:00:00.000Z', score: 12 });
      assert.deepEqual(items.find((c) => c.email === 'sio2@d.fr')!.fields, { score: 7 });
    } finally {
      setSystemeIoFetch(null);
    }
  });
});
