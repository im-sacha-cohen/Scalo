// Migration from another tool: CSV presets, fields created on the fly, import jobs run by the worker (no trigger by
// default, resume after a crash, cancellation, error journal), systeme.io API source (fake fetch: pagination, 429 with
// resume, invalid key, key never kept), page import by URL (SSRF refused, scripts removed).
import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db';
import { claimImportJobs, decryptSecret, IMPORT_BATCH, processImportJob, recoverImportJobs } from '../src/services/imports';
import { detectPreset, parseCsv, parseDateTime, splitTags, statusValue } from '../src/services/import-sources';
import { htmlToBlocks, setPageFetchDeps, type PageResponse } from '../src/services/page-import';
import { parseWait, setSystemeIoFetch, SYSTEME_IO_BASE } from '../src/services/systeme-io';
import { EmailWorker } from '../src/worker';
import { client, registerUser, shutdown, startApp, type TestCtx } from './helpers';

let ctx: TestCtx;
before(async () => {
  ctx = await startApp();
});
after(() => shutdown(ctx));
afterEach(() => {
  setSystemeIoFetch(null);
  setPageFetchDeps(null);
});

type Api = ReturnType<typeof client>;
async function account() {
  const reg = await registerUser(ctx);
  return { api: client(ctx, reg.token), userId: reg.user.id, token: reg.token };
}
const drain = () => new EmailWorker({ throttle: false }).drain();
const OPTS = { consent: true };

interface Mapping { column: string; target: string; field_key?: string; create?: { label: string; type: string } }
async function analyze(api: Api, csv: string) {
  const r = await api.post('/api/imports/csv/analyze', { csv });
  assert.equal(r.status, 200, r.text);
  return r.body as { preset: string; preset_label: string; rows: number; columns: { column: string; samples: string[] }[]; mapping: Mapping[] };
}
const targets = (m: Mapping[]) => Object.fromEntries(m.map((x) => [x.column, x.target === 'field' ? `field:${x.field_key}` : x.target]));
async function startCsv(api: Api, csv: string, mapping: Mapping[], options: Record<string, unknown> = OPTS) {
  const r = await api.post('/api/imports', { source: 'csv', csv, mapping, options, file_name: 'contacts.csv' });
  assert.equal(r.status, 201, r.text);
  return r.body as { id: number; status: string; total: number };
}
const job = async (api: Api, id: number) => (await api.get(`/api/imports/${id}`)).body as {
  status: string; processed: number; created: number; updated: number; skipped: number; errors: number; warnings: number; error: string | null; note: string | null; resume_at: string | null; total: number | null;
};
const contacts = async (api: Api) =>
  ((await api.get('/api/contacts?limit=500')).body.items as { id: number; email: string; first_name: string | null; last_name: string | null; phone: string | null; unsubscribed: number; bounced: number; status: string; created_at: string; tags: { name: string }[]; fields: Record<string, unknown> }[]);
const byEmail = async (api: Api, email: string) => (await contacts(api)).find((c) => c.email === email)!;
const tagNames = (c: { tags: { name: string }[] }) => c.tags.map((t) => t.name).sort();
const count = async (table: 'campaign_subscriptions' | 'email_sends' | 'automation_runs' | 'contacts', userId: number) => {
  if (table === 'campaign_subscriptions') {
    const r = await db.selectFrom('campaign_subscriptions as s').innerJoin('campaigns as c', 'c.id', 's.campaign_id').select((eb) => eb.fn.countAll<number>().as('n')).where('c.user_id', '=', userId).executeTakeFirstOrThrow();
    return r.n;
  }
  const r = await db.selectFrom(table).select((eb) => eb.fn.countAll<number>().as('n')).where('user_id', '=', userId).executeTakeFirstOrThrow();
  return r.n;
};

describe('lecture des sources', () => {
  test('analyse CSV : séparateurs, guillemets, retours à la ligne, en-têtes en double', () => {
    const csv = parseCsv('﻿Email;Nom;Tags;Tags\n"a@x.fr";"Du\nPont";"x;y";z\n\n b@x.fr ;B;;\n');
    assert.deepEqual(csv.columns, ['Email', 'Nom', 'Tags', 'Tags (2)']);
    assert.equal(csv.rows.length, 2);
    assert.deepEqual(csv.rows[0].cells, ['a@x.fr', 'Du\nPont', 'x;y', 'z']);
    assert.equal(csv.rows[0].line, 2);
    assert.equal(csv.rows[1].line, 5);
    assert.deepEqual(parseCsv('email\tnom\na@x.fr\tA').rows[0].cells, ['a@x.fr', 'A']);
  });

  test('tags, statuts et dates', () => {
    assert.deepEqual(splitTags('"VIP","Client 2024"'), ['VIP', 'Client 2024']);
    assert.deepEqual(splitTags('a, b;c|d , a'), ['a', 'b', 'c', 'd']);
    assert.equal(statusValue('Unsubscribed'), 'unsubscribed');
    assert.equal(statusValue('Désinscrit'), 'unsubscribed');
    assert.equal(statusValue('cancelled'), 'unsubscribed');
    assert.equal(statusValue('Bounced'), 'bounced');
    assert.equal(statusValue('cleaned'), 'bounced');
    assert.equal(statusValue('Unconfirmed'), 'pending');
    assert.equal(statusValue('Active'), 'subscribed');
    assert.equal(parseDateTime('2021-03-04 10:20:30'), '2021-03-04T10:20:30.000Z');
    assert.equal(parseDateTime('04/03/2021'), '2021-03-04T00:00:00.000Z');
    assert.equal(parseDateTime('03/25/2021 08:00'), '2021-03-25T08:00:00.000Z');
    assert.equal(parseDateTime('2022-01-02T03:04:05+02:00'), '2022-01-02T01:04:05.000Z');
    assert.equal(parseDateTime('2999-01-01'), null); // future
    assert.equal(parseDateTime('hier'), null);
  });

  test('attente demandée par la source (Retry-After, X-RateLimit-Refill)', () => {
    const now = Date.UTC(2026, 0, 1);
    assert.equal(parseWait('30', now), 30_000);
    assert.equal(parseWait('0', now), 1000); // at least 1 s
    assert.equal(parseWait('99999', now), 15 * 60_000); // capped
    assert.equal(parseWait(new Date(now + 60_000).toUTCString(), now), 60_000);
    assert.equal(parseWait(String(now / 1000 + 45), now), 45_000); // unix seconds
    assert.equal(parseWait('bientôt', now), null);
    assert.equal(parseWait(null, now), null);
  });
});

describe('préréglages CSV', () => {
  const FILES: Record<string, { csv: string; expect: Record<string, string> }> = {
    systeme_io: {
      csv: 'Email,First name,Surname,Phone number,Country,Tags,Date registered\nlea@sio.fr,Léa,Martin,+33600000001,FR,"lead,client",2023-05-06 07:08:09\n',
      expect: { Email: 'email', 'First name': 'first_name', Surname: 'last_name', 'Phone number': 'phone', Country: 'ignore', Tags: 'tags', 'Date registered': 'created_at' },
    },
    mailchimp: {
      csv: 'Email Address,First Name,Last Name,Phone Number,MEMBER_RATING,OPTIN_TIME,OPTIN_IP,CONFIRM_TIME,LAST_CHANGED,LEID,EUID,NOTES,TAGS,UNSUB_TIME\nmc@x.fr,Marc,C,,2,2020-02-03 04:05:06,1.2.3.4,2020-02-03 04:06:00,2021-01-01 00:00:00,123,abc,,"""VIP"",""Blog""",\n',
      expect: { 'Email Address': 'email', 'First Name': 'first_name', 'Last Name': 'last_name', 'Phone Number': 'phone', MEMBER_RATING: 'ignore', OPTIN_TIME: 'created_at', OPTIN_IP: 'ignore', CONFIRM_TIME: 'ignore', LAST_CHANGED: 'ignore', LEID: 'ignore', EUID: 'ignore', NOTES: 'ignore', TAGS: 'tags', UNSUB_TIME: 'unsubscribed' },
    },
    brevo: {
      csv: 'EMAIL;LASTNAME;FIRSTNAME;SMS;EMAIL_BLACKLISTED;SMS_BLACKLISTED;ADDED_TIME;MODIFIED_TIME\nbr@x.fr;Durand;Bruno;33611111111;Yes;No;12-04-2022 09:30;13-04-2022 10:00\n',
      expect: { EMAIL: 'email', LASTNAME: 'last_name', FIRSTNAME: 'first_name', SMS: 'phone', EMAIL_BLACKLISTED: 'unsubscribed', SMS_BLACKLISTED: 'ignore', ADDED_TIME: 'created_at', MODIFIED_TIME: 'ignore' },
    },
    activecampaign: {
      csv: 'Email,First Name,Last Name,Phone,Tags,Date Created,IP,Status\nac@x.fr,Alice,C,0102030405,"prospect, webinar",2021-07-08 09:10:11,1.1.1.1,Unsubscribed\n',
      expect: { Email: 'email', 'First Name': 'first_name', 'Last Name': 'last_name', Phone: 'phone', Tags: 'tags', 'Date Created': 'created_at', IP: 'ignore', Status: 'status' },
    },
    kit: {
      csv: 'first_name,email,created_at,status\nKim,kit@x.fr,2022-09-10T11:12:13Z,bounced\n',
      expect: { first_name: 'first_name', email: 'email', created_at: 'created_at', status: 'status' },
    },
    generic: {
      csv: 'Prénom;Nom;E-mail;Téléphone;Ville\nGil;G;gen@x.fr;0600000000;Lyon\n',
      expect: { 'Prénom': 'first_name', Nom: 'last_name', 'E-mail': 'email', 'Téléphone': 'phone', Ville: 'ignore' },
    },
  };

  let shared: Awaited<ReturnType<typeof account>> | undefined;
  for (const [preset, f] of Object.entries(FILES)) {
    test(`${preset} : détection par les en-têtes et correspondance proposée`, async () => {
      const { api } = (shared ??= await account());
      const a = await analyze(api, f.csv);
      assert.equal(a.preset, preset);
      assert.equal(a.rows, 1);
      assert.deepEqual(targets(a.mapping), f.expect);
      assert.equal(detectPreset(a.columns.map((c) => c.column)), preset);
    });
  }

  test('chaque préréglage s’importe tel quel : tags, statut, date d’inscription conservée', async () => {
    const { api } = await account();
    for (const f of Object.values(FILES)) {
      const a = await analyze(api, f.csv);
      await startCsv(api, f.csv, a.mapping);
      await drain();
    }
    const sio = await byEmail(api, 'lea@sio.fr');
    assert.deepEqual([sio.first_name, sio.last_name, sio.phone], ['Léa', 'Martin', '+33600000001']);
    assert.deepEqual(tagNames(sio), ['client', 'lead']);
    assert.equal(sio.created_at, '2023-05-06T07:08:09.000Z');
    assert.equal(sio.status, 'active'); // imported contacts are confirmed

    const mc = await byEmail(api, 'mc@x.fr');
    assert.deepEqual(tagNames(mc), ['Blog', 'VIP']);
    assert.equal(mc.created_at, '2020-02-03T04:05:06.000Z');
    assert.equal(mc.unsubscribed, 0);

    const br = await byEmail(api, 'br@x.fr');
    assert.deepEqual([br.first_name, br.last_name, br.phone, br.unsubscribed], ['Bruno', 'Durand', '33611111111', 1]);
    assert.equal(br.created_at, '2022-04-12T09:30:00.000Z');

    const ac = await byEmail(api, 'ac@x.fr');
    assert.deepEqual(tagNames(ac), ['prospect', 'webinar']);
    assert.equal(ac.unsubscribed, 1);

    const kit = await byEmail(api, 'kit@x.fr');
    assert.equal(kit.bounced, 1);
    assert.equal(kit.created_at, '2022-09-10T11:12:13.000Z');
    assert.equal((await byEmail(api, 'gen@x.fr')).first_name, 'Gil');
  });
});

describe('import CSV par le worker', () => {
  test('attestation de consentement obligatoire, email obligatoire dans la correspondance', async () => {
    const { api } = await account();
    const csv = 'email,nom\na@x.fr,A\n';
    const { mapping } = await analyze(api, csv);
    const noConsent = await api.post('/api/imports', { source: 'csv', csv, mapping, options: {} });
    assert.equal(noConsent.status, 400);
    assert.match(noConsent.body.error, /attester/);
    const noEmail = await api.post('/api/imports', { source: 'csv', csv, mapping: mapping.map((m) => ({ ...m, target: 'ignore' })), options: OPTS });
    assert.equal(noEmail.status, 400);
    assert.match(noEmail.body.error, /adresse email/);
    const unknownCol = await api.post('/api/imports', { source: 'csv', csv, mapping: [...mapping, { column: 'Absente', target: 'phone' }], options: OPTS });
    assert.equal(unknownCol.status, 400);
    assert.equal((await api.get('/api/imports')).body.length, 0);
  });

  test('champs créés à la volée, aperçu, compteurs et journal d’erreurs téléchargeable', async () => {
    const { api, userId } = await account();
    const existing = await api.post('/api/custom-fields', { label: 'Budget', type: 'number' });
    assert.equal(existing.status, 201);
    const csv = [
      'Email,Prénom,Budget,Ville,Date de naissance,Tags',
      'ok@x.fr,Olga,1200,Lyon,1990-02-03,"a|b"',
      'pas-un-email,X,1,Paris,,',
      ',Sans,1,Paris,,',
      'bad-value@x.fr,Bea,beaucoup,Nice,31/31/2000,',
      'ok@x.fr,Doublon,5,Metz,,',
    ].join('\n');
    const a = await analyze(api, csv);
    assert.equal(targets(a.mapping).Budget, 'field:budget'); // matched by label
    assert.equal(targets(a.mapping).Ville, 'ignore'); // unknown column: nothing is created without confirmation
    const mapping = a.mapping.map((m) =>
      m.column === 'Ville' ? { column: m.column, target: 'field', create: { label: 'Ville', type: 'text' } }
      : m.column === 'Date de naissance' ? { column: m.column, target: 'field', create: { label: 'Date de naissance', type: 'date' } }
      : m);

    const preview = await api.post('/api/imports/preview', { source: 'csv', csv, mapping });
    assert.equal(preview.status, 200, preview.text);
    assert.deepEqual(
      { total: preview.body.total, valid: preview.body.valid, invalid: preview.body.invalid, empty: preview.body.empty, duplicates: preview.body.duplicates, existing: preview.body.existing },
      { total: 5, valid: 2, invalid: 1, empty: 1, duplicates: 1, existing: 0 },
    );
    assert.deepEqual(preview.body.new_fields, ['Ville', 'Date de naissance']);
    assert.deepEqual(preview.body.tags, ['a', 'b']);
    assert.equal((await api.get('/api/custom-fields')).body.length, 1); // the preview creates nothing

    const j = await startCsv(api, csv, mapping, { consent: true, tag: 'Import mars' });
    assert.equal(j.status, 'pending');
    assert.equal(j.total, 5);
    assert.deepEqual((await api.get('/api/custom-fields')).body.map((f: { key: string; type: string }) => `${f.key}:${f.type}`), ['budget:number', 'ville:text', 'date_de_naissance:date']);
    assert.equal(await count('contacts', userId), 0); // nothing is imported in the HTTP request

    await drain();
    const done = await job(api, j.id);
    assert.deepEqual(
      { status: done.status, processed: done.processed, created: done.created, updated: done.updated, skipped: done.skipped, errors: done.errors, warnings: done.warnings },
      { status: 'completed', processed: 5, created: 2, updated: 0, skipped: 2, errors: 1, warnings: 3 },
    );
    const ok = await byEmail(api, 'ok@x.fr');
    assert.deepEqual(ok.fields, { budget: 1200, ville: 'Lyon', date_de_naissance: '1990-02-03' });
    assert.equal(ok.first_name, 'Olga'); // the duplicate line is ignored
    assert.deepEqual(tagNames(ok), ['Import mars', 'a', 'b']);
    assert.deepEqual((await byEmail(api, 'bad-value@x.fr')).fields, { ville: 'Nice' });

    const log = await api.get(`/api/imports/${j.id}/errors.csv`);
    assert.equal(log.status, 200);
    assert.match(log.headers.get('content-type')!, /text\/csv/);
    assert.match(log.headers.get('content-disposition')!, /attachment/);
    const lines = log.text.replace(/^﻿/, '').trim().split('\n');
    assert.equal(lines[0], 'ligne,email,niveau,message');
    assert.deepEqual(lines.slice(1), [
      '3,pas-un-email,erreur,Adresse email invalide',
      '5,bad-value@x.fr,avertissement,Valeur ignorée pour le champ « Budget » : « beaucoup »',
      '5,bad-value@x.fr,avertissement,Valeur ignorée pour le champ « Date de naissance » : « 31/31/2000 »',
      '6,ok@x.fr,avertissement,Doublon dans la source : ligne ignorée',
    ]);
    // the file is not kept once the import is over
    const row = await db.selectFrom('import_jobs').select(['payload', 'secret_enc']).where('id', '=', j.id).executeTakeFirstOrThrow();
    assert.deepEqual(row, { payload: null, secret_enc: null });
    // another account cannot read the job or its journal
    const other = await account();
    assert.equal((await other.api.get(`/api/imports/${j.id}`)).status, 404);
    assert.equal((await other.api.get(`/api/imports/${j.id}/errors.csv`)).status, 404);
    assert.equal((await other.api.post(`/api/imports/${j.id}/cancel`)).status, 404);
  });

  test('ne déclenche ni campagne ni automatisation par défaut ; les déclenche si l’option est cochée', async () => {
    const { api, userId } = await account();
    const tag = (await api.post('/api/tags', { name: 'bienvenue' })).body as { id: number };
    const campaign = (await api.post('/api/campaigns', { name: 'Séquence', trigger_tag_id: tag.id })).body as { id: number };
    assert.equal((await api.post(`/api/campaigns/${campaign.id}/emails`, { subject: 'Bonjour', delay_days: 0 })).status < 300, true);
    const auto = (await api.post('/api/tags', { name: 'auto' })).body as { id: number };
    for (const trigger of [{ type: 'contact_created' }, { type: 'tag_added', tag_id: tag.id }]) {
      const r = await api.post('/api/automations', { name: 'Auto', enabled: true, trigger, actions: [{ type: 'add_tag', tag_id: auto.id }] });
      assert.equal(r.status, 201, r.text);
    }
    const csv = 'email,tags\nn1@x.fr,bienvenue\nn2@x.fr,bienvenue\n';
    const { mapping } = await analyze(api, csv);

    const quiet = await startCsv(api, csv, mapping, { consent: true, tag: 'bienvenue' });
    await drain();
    assert.equal((await job(api, quiet.id)).created, 2);
    assert.deepEqual(tagNames(await byEmail(api, 'n1@x.fr')), ['bienvenue']);
    assert.equal(await count('campaign_subscriptions', userId), 0);
    assert.equal(await count('email_sends', userId), 0);
    assert.equal(await count('automation_runs', userId), 0);
    // the timeline still records what happened
    const c1 = await byEmail(api, 'n1@x.fr');
    const types = ((await api.get(`/api/contacts/${c1.id}`)).body.events as { type: string }[]).map((e) => e.type).sort();
    assert.deepEqual(types, ['imported', 'tag_added']);
    // outside an import, the same tag still triggers
    const manual = await api.post('/api/contacts', { email: 'manuel@x.fr', tags: ['bienvenue'] });
    assert.equal(manual.status, 201);
    assert.equal(await count('campaign_subscriptions', userId), 1);
    assert.equal(await count('automation_runs', userId), 2);

    const csv2 = 'email,tags\nt1@x.fr,bienvenue\n';
    const loud = await startCsv(api, csv2, (await analyze(api, csv2)).mapping, { consent: true, trigger: true });
    await drain();
    assert.equal((await job(api, loud.id)).created, 1);
    assert.equal(await count('campaign_subscriptions', userId), 2);
    assert.equal(await count('automation_runs', userId), 4);
  });

  test('désinscrits et bounces respectés, champs existants conservés sur demande, date d’origine gardée', async () => {
    const { api, userId } = await account();
    const tag = (await api.post('/api/tags', { name: 'news' })).body as { id: number };
    const campaign = (await api.post('/api/campaigns', { name: 'C', trigger_tag_id: tag.id })).body as { id: number };
    await api.post(`/api/campaigns/${campaign.id}/emails`, { subject: 'S', delay_days: 3 });
    const gone = (await api.post('/api/contacts', { email: 'gone@x.fr', first_name: 'Ancien' })).body as { id: number; created_at: string };
    await api.patch(`/api/contacts/${gone.id}`, { unsubscribed: true });
    const active = (await api.post('/api/contacts', { email: 'active@x.fr', first_name: 'Garde', tags: ['news'] })).body as { id: number };
    assert.equal(await count('email_sends', userId), 1);

    const csv = [
      'email,first_name,last_name,status,created_at',
      'gone@x.fr,Nouveau,Nom,subscribed,2019-01-01',
      'active@x.fr,Ecrase,Dupont,unsubscribed,2019-01-01',
      'b@x.fr,B,,bounced,2018-06-07',
      'p@x.fr,P,,unconfirmed,',
    ].join('\n');
    const { mapping } = await analyze(api, csv);
    const j = await startCsv(api, csv, mapping, { consent: true, keep_existing: true });
    await drain();
    assert.deepEqual([(await job(api, j.id)).created, (await job(api, j.id)).updated], [2, 2]);

    const g = await byEmail(api, 'gone@x.fr');
    assert.equal(g.unsubscribed, 1); // never re-subscribed by an import
    assert.deepEqual([g.first_name, g.last_name], ['Ancien', 'Nom']); // existing value kept, empty one filled
    assert.equal(g.created_at, gone.created_at); // an existing contact keeps its date
    const a = await byEmail(api, 'active@x.fr');
    assert.deepEqual([a.first_name, a.last_name, a.unsubscribed], ['Garde', 'Dupont', 1]);
    assert.equal(a.id, active.id);
    const sub = await db.selectFrom('campaign_subscriptions').select('status').where('contact_id', '=', a.id).executeTakeFirstOrThrow();
    assert.equal(sub.status, 'unsubscribed');
    const b = await byEmail(api, 'b@x.fr');
    assert.deepEqual([b.bounced, b.created_at], [1, '2018-06-07T00:00:00.000Z']);
    assert.equal((await byEmail(api, 'p@x.fr')).status, 'pending_confirmation');

    // default: imported values win
    const csv2 = 'email,first_name\ngone@x.fr,Nouveau\n';
    await startCsv(api, csv2, (await analyze(api, csv2)).mapping);
    await drain();
    assert.equal((await byEmail(api, 'gone@x.fr')).first_name, 'Nouveau');
  });

  const bigCsv = (n: number, prefix: string) => ['email,first_name,tags', ...Array.from({ length: n }, (_, i) => `${prefix}${i}@big.fr,P${i},gros`)].join('\n');

  test('reprise d’une tâche interrompue : rien n’est rejoué, rien n’est perdu', async () => {
    const { api, userId } = await account();
    const n = IMPORT_BATCH * 2 + 50;
    const csv = bigCsv(n, 'r');
    const j = await startCsv(api, csv, (await analyze(api, csv)).mapping);
    // an instance takes the job, commits one batch, then dies (the job stays "running", claimed by a ghost)
    const [claimed] = await claimImportJobs('instance-morte');
    assert.equal(claimed.id, j.id);
    await processImportJob(claimed, 'instance-morte', { maxBatches: 1 });
    let st = await job(api, j.id);
    assert.deepEqual([st.status, st.processed, st.created], ['running', IMPORT_BATCH, IMPORT_BATCH]);
    assert.equal(await count('contacts', userId), IMPORT_BATCH);
    await drain(); // a running job is not taken by another worker
    assert.equal((await job(api, j.id)).processed, IMPORT_BATCH);

    assert.equal(await recoverImportJobs(), 1);
    assert.equal((await job(api, j.id)).status, 'pending');
    await drain();
    st = await job(api, j.id);
    assert.deepEqual([st.status, st.processed, st.created, st.updated, st.errors], ['completed', n, n, 0, 0]);
    assert.equal(await count('contacts', userId), n);
    const events = await db.selectFrom('contact_events').select((eb) => eb.fn.countAll<number>().as('n')).where('user_id', '=', userId).where('type', '=', 'imported').executeTakeFirstOrThrow();
    assert.equal(events.n, n); // exactly one per contact

    // the ghost comes back: its claim is gone, its batch is rolled back and the counters do not move
    await processImportJob(claimed, 'instance-morte', { maxBatches: 1 });
    assert.equal((await job(api, j.id)).processed, n);
  });

  test('annulation : avant le démarrage, puis en cours de traitement', async () => {
    const { api, userId } = await account();
    const csv = bigCsv(IMPORT_BATCH + 20, 'c');
    const mapping = (await analyze(api, csv)).mapping;
    const first = await startCsv(api, csv, mapping);
    const cancelled = await api.post(`/api/imports/${first.id}/cancel`);
    assert.equal(cancelled.status, 200, cancelled.text);
    assert.equal(cancelled.body.status, 'cancelled');
    await drain();
    assert.equal(await count('contacts', userId), 0);
    assert.equal((await api.post(`/api/imports/${first.id}/cancel`)).status, 409);
    assert.equal((await db.selectFrom('import_jobs').select('payload').where('id', '=', first.id).executeTakeFirstOrThrow()).payload, null);

    const second = await startCsv(api, csv, mapping);
    const [claimed] = await claimImportJobs('w1');
    await processImportJob(claimed, 'w1', { maxBatches: 1 });
    assert.equal((await api.post(`/api/imports/${second.id}/cancel`)).body.status, 'cancelled');
    await processImportJob(claimed, 'w1'); // the worker keeps going: every further batch is refused
    await drain();
    const st = await job(api, second.id);
    assert.deepEqual([st.status, st.processed], ['cancelled', IMPORT_BATCH]);
    assert.equal(await count('contacts', userId), IMPORT_BATCH); // what was imported before the cancellation stays
  });

  test('une ligne refusée par la base est journalisée sans bloquer le reste', async () => {
    const { api, userId } = await account();
    // a custom field deleted between the mapping and the run makes nothing fail; a NUL-free oversized name is truncated
    const csv = `email,first_name\nlong@x.fr,${'x'.repeat(500)}\nfin@x.fr,Fin\n`;
    const j = await startCsv(api, csv, (await analyze(api, csv)).mapping);
    await drain();
    const st = await job(api, j.id);
    assert.deepEqual([st.status, st.created, st.errors], ['completed', 2, 0]);
    assert.equal((await byEmail(api, 'long@x.fr')).first_name!.length, 200);
    assert.equal(await count('contacts', userId), 2);
  });
});

describe('source systeme.io (API publique, faux serveur)', () => {
  const KEY = 'sio_test_key_0123456789abcdef';
  interface Call { path: string; after: string | null; limit: string | null; order: string | null; key: string | null }

  /** Fake api.systeme.io: `n` contacts, cursor pagination, optional 429 on the k-th contacts call. */
  function fakeSio(n: number, opts: { rateLimitOnCall?: number; retryAfter?: string; exhaustAfterCall?: number } = {}) {
    const calls: Call[] = [];
    const all = Array.from({ length: n }, (_, i) => ({
      id: 1000 + i,
      email: i === 3 ? 'INVALIDE' : `sio${i}@exemple.fr`,
      registeredAt: '2022-03-04T05:06:07+00:00',
      locale: 'fr',
      unsubscribed: i === 1,
      bounced: i === 2,
      needsConfirmation: i === 4,
      fields: [
        { fieldName: 'First name', slug: 'first_name', value: `Prénom${i}` },
        { fieldName: 'Surname', slug: 'surname', value: `Nom${i}` },
        { fieldName: 'Phone number', slug: 'phone_number', value: i === 0 ? '+33611223344' : null },
        { fieldName: 'Country', slug: 'country', value: 'FR' },
        { fieldName: 'Niveau', slug: 'niveau', value: i % 2 ? 'avancé' : 'débutant' },
      ],
      tags: i % 2 ? [{ id: 1, name: 'Client' }] : [{ id: 1, name: 'Client' }, { id: 2, name: 'Newsletter' }],
    }));
    let contactCalls = 0;
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'X-RateLimit-Limit': '60', 'X-RateLimit-Remaining': '59', ...headers } });
    setSystemeIoFetch((async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      assert.equal(url.origin + url.pathname.replace(/\/(contacts|tags|contact_fields)$/, ''), SYSTEME_IO_BASE);
      assert.equal(init?.method, 'GET');
      const key = new Headers(init?.headers).get('x-api-key');
      const path = url.pathname.replace('/api', '');
      calls.push({ path, after: url.searchParams.get('startingAfter'), limit: url.searchParams.get('limit'), order: url.searchParams.get('order'), key });
      if (key !== KEY) return json({ type: 'unauthorized', title: 'Unauthorized' }, 401);
      if (path === '/tags') return json({ items: [{ id: 1, name: 'Client' }, { id: 2, name: 'Newsletter' }], hasMore: false });
      if (path === '/contact_fields') return json({ items: [{ slug: 'first_name', fieldName: 'First name' }, { slug: 'surname', fieldName: 'Surname' }, { slug: 'niveau', fieldName: 'Niveau' }] });
      contactCalls++;
      if (opts.rateLimitOnCall === contactCalls) return json({ title: 'Too Many Requests' }, 429, { 'Retry-After': opts.retryAfter ?? '120', 'X-RateLimit-Remaining': '0' });
      const limit = Number(url.searchParams.get('limit') ?? 10);
      const after = url.searchParams.get('startingAfter');
      const start = after ? all.findIndex((c) => String(c.id) === after) + 1 : 0;
      const items = all.slice(start, start + limit);
      const hasMore = start + limit < all.length;
      return json({ items, hasMore }, 200, opts.exhaustAfterCall === contactCalls ? { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Refill': '90' } : {});
    }) as typeof fetch);
    return { calls, contactCalls: () => contactCalls };
  }
  const connect = async (api: Api, key = KEY) => api.post('/api/imports/systeme-io/connect', { api_key: key });
  const start = async (api: Api, mapping: Mapping[], options: Record<string, unknown> = OPTS, key = KEY) => {
    const r = await api.post('/api/imports', { source: 'systeme_io', api_key: key, mapping, options });
    assert.equal(r.status, 201, r.text);
    return r.body as { id: number; total: number | null };
  };

  test('connexion : clé invalide refusée sans déconnecter l’utilisateur, colonnes et correspondance proposées', async () => {
    const { api } = await account();
    const sio = fakeSio(7);
    const bad = await connect(api, 'mauvaise-cle-123');
    assert.equal(bad.status, 400); // not a 401: the Scalo session is fine
    assert.match(bad.body.error, /Clé API systeme\.io refusée/);
    assert.doesNotMatch(bad.text, /mauvaise-cle-123/);

    const ok = await connect(api);
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.preset_label, 'systeme.io');
    assert.deepEqual(targets(ok.body.mapping), {
      email: 'email', registeredAt: 'created_at', unsubscribed: 'unsubscribed', bounced: 'bounced', tags: 'tags',
      'field:first_name': 'first_name', 'field:surname': 'last_name', 'field:niveau': 'ignore', 'field:phone_number': 'phone', 'field:country': 'ignore',
    });
    assert.deepEqual(ok.body.tags, ['Client', 'Newsletter']);
    assert.ok(sio.calls.every((c) => c.path !== '/contacts' || c.order === 'asc'));
    assert.doesNotMatch(ok.text, new RegExp(KEY));
  });

  test('import complet : pagination par curseur, champs, tags, désinscrits, clé chiffrée puis effacée', async () => {
    const { api, userId } = await account();
    const n = 230;
    const sio = fakeSio(n);
    const analysis = (await connect(api)).body as { mapping: Mapping[] };
    const mapping = analysis.mapping.map((m) => (m.column === 'field:niveau' ? { column: m.column, target: 'field', create: { label: 'Niveau', type: 'text' } } : m));
    const preview = await api.post('/api/imports/preview', { source: 'systeme_io', api_key: KEY, mapping });
    assert.equal(preview.status, 200, preview.text);
    assert.deepEqual([preview.body.partial, preview.body.total, preview.body.invalid, preview.body.unsubscribed, preview.body.bounced, preview.body.pending], [true, 50, 1, 1, 1, 1]);

    const before = sio.contactCalls();
    const j = await start(api, mapping, { consent: true, tag: 'Migration systeme.io' });
    assert.equal(j.total, null);
    const stored = await db.selectFrom('import_jobs').select(['secret_enc', 'payload', 'mapping']).where('id', '=', j.id).executeTakeFirstOrThrow();
    assert.ok(stored.secret_enc && !stored.secret_enc.includes(KEY)); // encrypted at rest while the job runs
    assert.equal(decryptSecret(stored.secret_enc!), KEY);
    assert.doesNotMatch(JSON.stringify((await api.get(`/api/imports/${j.id}`)).body), new RegExp(KEY));

    await drain();
    const st = await job(api, j.id);
    assert.deepEqual([st.status, st.processed, st.created, st.errors, st.error], ['completed', n, n - 1, 1, null]);
    // 3 pages of 100, each after the last id of the previous one
    const pages = sio.calls.filter((c) => c.path === '/contacts').slice(before);
    assert.deepEqual(pages.map((c) => [c.limit, c.after]), [['100', null], ['100', '1099'], ['100', '1199']]);
    assert.ok(sio.calls.every((c) => c.key !== null));

    assert.equal(await count('contacts', userId), n - 1);
    const c0 = await byEmail(api, 'sio0@exemple.fr');
    assert.deepEqual([c0.first_name, c0.last_name, c0.phone], ['Prénom0', 'Nom0', '+33611223344']);
    assert.deepEqual(c0.fields, { niveau: 'débutant' });
    assert.deepEqual(tagNames(c0), ['Client', 'Migration systeme.io', 'Newsletter']);
    assert.equal(c0.created_at, '2022-03-04T05:06:07.000Z');
    assert.equal((await byEmail(api, 'sio1@exemple.fr')).unsubscribed, 1);
    assert.equal((await byEmail(api, 'sio2@exemple.fr')).bounced, 1);
    assert.equal((await byEmail(api, 'sio4@exemple.fr')).status, 'pending_confirmation');
    assert.match((await api.get(`/api/imports/${j.id}/errors.csv`)).text, /4,invalide,erreur,Adresse email invalide/);

    const end = await db.selectFrom('import_jobs').select(['secret_enc', 'payload']).where('id', '=', j.id).executeTakeFirstOrThrow();
    assert.deepEqual(end, { secret_enc: null, payload: null }); // the key is not kept after the import
  });

  test('429 : attente du Retry-After puis reprise au bon curseur, sans doublon', async () => {
    const { api, userId } = await account();
    const n = 150;
    const sio = fakeSio(n, { rateLimitOnCall: 3, retryAfter: '120' }); // call 1 = connect, 2 = page 1, 3 = page 2 → 429
    const { mapping } = (await connect(api)).body as { mapping: Mapping[] };
    const j = await start(api, mapping);
    await drain();
    let st = await job(api, j.id);
    assert.deepEqual([st.status, st.processed, st.errors], ['pending', 100, 1]);
    assert.match(st.note!, /Limite de débit de systeme\.io.*2 min/);
    const waitS = (new Date(st.resume_at!).getTime() - Date.now()) / 1000;
    assert.ok(waitS > 110 && waitS <= 120, `attente ${waitS}s`);
    const callsBefore = sio.contactCalls();
    await drain(); // not due yet: systeme.io is left alone
    assert.equal(sio.contactCalls(), callsBefore);

    await db.updateTable('import_jobs').set({ resume_at: new Date().toISOString() }).where('id', '=', j.id).execute(); // time passes
    await drain();
    st = await job(api, j.id);
    assert.deepEqual([st.status, st.processed, st.note, st.resume_at], ['completed', n, null, null]);
    assert.equal(sio.calls.filter((c) => c.path === '/contacts').at(-1)!.after, '1099');
    assert.equal(await count('contacts', userId), n - 1);
  });

  test('quota épuisé (X-RateLimit-Remaining: 0) : pause jusqu’au X-RateLimit-Refill avant la page suivante', async () => {
    const { api } = await account();
    fakeSio(120, { exhaustAfterCall: 2 });
    const { mapping } = (await connect(api)).body as { mapping: Mapping[] };
    const j = await start(api, mapping);
    await drain();
    const st = await job(api, j.id);
    assert.deepEqual([st.status, st.processed], ['pending', 100]);
    const waitS = (new Date(st.resume_at!).getTime() - Date.now()) / 1000;
    assert.ok(waitS > 80 && waitS <= 90, `attente ${waitS}s`);
  });

  test('clé révoquée pendant l’import : tâche en échec avec un message clair, clé effacée', async () => {
    const { api } = await account();
    fakeSio(10);
    const { mapping } = (await connect(api)).body as { mapping: Mapping[] };
    const j = await start(api, mapping, OPTS, 'cle-revoquee-0123456789');
    await drain();
    const st = await job(api, j.id);
    assert.equal(st.status, 'failed');
    assert.match(st.error!, /Clé API systeme\.io refusée/);
    assert.doesNotMatch(st.error!, /cle-revoquee/);
    assert.equal((await db.selectFrom('import_jobs').select('secret_enc').where('id', '=', j.id).executeTakeFirstOrThrow()).secret_enc, null);
  });

  test('panne de la source : nouveaux essais espacés, la progression est conservée', async () => {
    const { api } = await account();
    let fail = true;
    setSystemeIoFetch((async () => {
      if (fail) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ items: [{ id: 1, email: 'apres@panne.fr', fields: [], tags: [] }], hasMore: false }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch);
    const j = await start(api, [{ column: 'email', target: 'email' }]);
    await drain();
    let st = await job(api, j.id);
    assert.equal(st.status, 'pending');
    assert.match(st.note!, /Connexion à systeme\.io impossible — nouvel essai automatique/);
    fail = false;
    await db.updateTable('import_jobs').set({ resume_at: new Date().toISOString() }).where('id', '=', j.id).execute();
    await drain();
    st = await job(api, j.id);
    assert.deepEqual([st.status, st.created], ['completed', 1]);
  });
});

describe('import d’une page par URL', () => {
  const PUBLIC = [{ address: '93.184.216.34', family: 4 as const }];
  const page = (html: string, extra: Partial<PageResponse> = {}): PageResponse => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: Buffer.from(html), truncated: false, ...extra });
  const HTML = `<!doctype html><html><head><title>Ma page &amp; moi</title><style>h1{color:red}</style>
    <script>window.secret = "volé"</script></head>
    <body onload="alert(1)">
      <nav><a href="/">Accueil</a></nav>
      <div class="hero"><h1 style="color:red" onclick="evil()">Doublez vos <strong>ventes</strong></h1>
      <div>Une méthode simple<br>en 3 étapes.<script>document.write('<p>injecté</p>')</script></div>
      <img src="/img/photo.png" alt="Photo" onerror="evil()"><img src="data:image/png;base64,AAAA"><img src="https://t.example/p.gif" width="1" height="1">
      <ul><li>Premier <em>point</em></li><li>Deuxième point</li></ul>
      <a class="btn btn-primary" href="/commander?x=1">Je commande</a>
      <a href="javascript:alert(1)" class="button">Piège</a>
      <div style="display:none"><p>Texte caché</p></div>
      <iframe src="https://evil.example"></iframe>
      <form action="https://ancien-outil.example/submit" method="post">
        <input type="hidden" name="token" value="abc"><input type="text" name="first_name" placeholder="Prénom">
        <input type="email" name="email" placeholder="Votre meilleur email"><button type="submit">Recevoir le guide</button>
      </form>
      <h2>FAQ</h2><p>1 &lt; 2 &amp; c'est <b>tout</b></p>
      <svg><text>vectoriel</text></svg></div>
    </body></html>`;

  test('structure et textes convertis en blocs éditables, scripts et code retirés', async () => {
    const { api } = await account();
    const asked: string[] = [];
    setPageFetchDeps({
      lookup: async () => PUBLIC,
      get: async (url, address) => {
        asked.push(`${url} via ${address.address}`);
        return page(HTML);
      },
    });
    const noConsent = await api.post('/api/imports/page', { url: 'https://exemple.fr/offre' });
    assert.equal(noConsent.status, 400);
    assert.match(noConsent.body.error, /attester que cette page vous appartient/);
    assert.equal(asked.length, 0);

    const r = await api.post('/api/imports/page', { url: 'exemple.fr/offre', consent: true });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(asked, ['https://exemple.fr/offre via 93.184.216.34']); // pinned to the validated address
    assert.equal(r.body.title, 'Ma page & moi');
    const blocks = r.body.content.blocks as Record<string, any>[];
    assert.deepEqual(blocks.map((b) => b.type), ['text', 'heading', 'text', 'image', 'list', 'button', 'button', 'form', 'heading', 'text']);
    assert.equal(blocks[1].text, 'Doublez vos <strong>ventes</strong>');
    assert.equal(blocks[1].level, 1);
    assert.equal(blocks[2].text, 'Une méthode simple<br>en 3 étapes.');
    assert.deepEqual([blocks[3].src, blocks[3].alt], ['https://exemple.fr/img/photo.png', 'Photo']);
    assert.deepEqual(blocks[4].items, ['Premier <em>point</em>', 'Deuxième point']);
    assert.deepEqual([blocks[5].label, blocks[5].action, blocks[5].url], ['Je commande', 'url', 'https://exemple.fr/commander?x=1']);
    assert.deepEqual([blocks[6].action, blocks[6].url], ['next', undefined]); // javascript: link dropped
    assert.deepEqual(blocks[7].fields.map((f: { name: string }) => f.name), ['first_name', 'email']);
    assert.equal(blocks[7].submitLabel, 'Recevoir le guide');
    assert.equal(blocks[9].text, '1 &lt; 2 &amp; c&#39;est <b>tout</b>');
    assert.deepEqual(r.body.stats, { headings: 2, texts: 3, lists: 1, images: 1, buttons: 2, forms: 1 });
    const dump = JSON.stringify(r.body.content);
    for (const bad of ['script', 'volé', 'injecté', 'onclick', 'onerror', 'onload', 'evil', 'javascript:', 'data:image', 'iframe', 'Texte caché', 'color:red', 'vectoriel', 'ancien-outil', 'token', 't.example']) {
      assert.ok(!dump.includes(bad), `« ${bad} » ne doit pas être importé`);
    }
    assert.ok(new Set(blocks.map((b) => b.id)).size === blocks.length);
    // the result is a valid page content: it can be saved as a funnel step
    const funnel = (await api.post('/api/funnels', { name: 'Importé', template: 'blank' })).body as { id: number };
    const step = await api.post(`/api/funnels/${funnel.id}/steps`, { name: r.body.title, type: 'optin', content: r.body.content });
    assert.ok(step.status === 200 || step.status === 201, step.text);
  });

  test('SSRF refusé : schéma, adresses privées, DNS interne, redirection vers l’intérieur', async () => {
    const { api } = await account();
    let fetched = 0;
    setPageFetchDeps({
      lookup: async (host) => (host === 'interne.exemple.fr' ? [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.8', family: 4 }] : PUBLIC),
      get: async (url) => {
        fetched++;
        if (url.hostname === 'redirige.exemple.fr') return page('', { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data/' } });
        if (url.hostname === 'boucle.exemple.fr') return page('', { status: 301, headers: { location: 'https://boucle.exemple.fr/encore' } });
        if (url.hostname === 'pdf.exemple.fr') return page('%PDF', { headers: { 'content-type': 'application/pdf' } });
        if (url.hostname === 'vide.exemple.fr') return page('<html><body><div id="root"></div><script src="/app.js"></script></body></html>');
        return page(HTML);
      },
    });
    const go = (url: string) => api.post('/api/imports/page', { url, consent: true });
    for (const url of ['http://exemple.fr/', 'ftp://exemple.fr/', 'file:///etc/passwd', 'https://127.0.0.1/', 'https://10.1.2.3/', 'https://[::1]/', 'https://169.254.169.254/latest', 'https://localhost/', 'https://app.internal/', 'https://user:pass@exemple.fr/', 'https://exemple.fr:8443/', 'https://[::ffff:10.0.0.1]/']) {
      const r = await go(url);
      assert.equal(r.status, 400, `${url} → ${r.status} ${r.text}`);
    }
    assert.equal(fetched, 0);
    const internal = await go('https://interne.exemple.fr/');
    assert.equal(internal.status, 400);
    assert.match(internal.body.error, /réseau privé/);
    assert.equal(fetched, 0); // one private answer is enough to refuse
    const redirected = await go('https://redirige.exemple.fr/');
    assert.equal(redirected.status, 400); // the redirect target is validated like the first URL
    assert.equal(fetched, 1);
    assert.equal((await go('https://boucle.exemple.fr/')).status, 502);
    assert.equal(fetched, 5); // 1 + 3 redirects followed at most
    assert.equal((await go('https://pdf.exemple.fr/')).status, 415);
    const empty = await go('https://vide.exemple.fr/');
    assert.equal(empty.status, 422);
    assert.match(empty.body.error, /JavaScript/);
  });

  test('conversion défensive : balises mal fermées, document tronqué, formulaire sans <form>', () => {
    const r = htmlToBlocks('<h3>Titre<p>Para <b>gras<p>suite</b><input type=email name=EMAIL><a role="button" href="#">OK</a><p>Après<script>var x = "<p>pas du texte</p>"', 'https://exemple.fr/a/b');
    assert.deepEqual(r.content.blocks.map((b) => b.type), ['heading', 'text', 'text', 'form', 'text']);
    const form = r.content.blocks[3] as { fields: { name: string }[]; submitLabel: string };
    assert.deepEqual([form.fields.map((f) => f.name), form.submitLabel], [['email'], 'OK']);
    assert.ok(!JSON.stringify(r.content).includes('pas du texte'));
    assert.equal(htmlToBlocks('', 'https://exemple.fr').content.blocks.length, 0);
    const many = htmlToBlocks(Array.from({ length: 1000 }, (_, i) => `<p>Paragraphe ${i}</p>`).join(''), 'https://exemple.fr');
    assert.equal(many.content.blocks.length, 300);
    assert.match(many.warnings[0], /300 premiers éléments/);
  });
});
