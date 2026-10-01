// Paramètres → Données et compte: GDPR export (ZIP, no secret), deletion of all the data (account kept, other accounts
// untouched, files removed, nothing left in the sending queue), deletion of the account (sessions, public pages,
// custom domains), password + confirmation, rate limit.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import nodeHttp from 'node:http';
import path from 'node:path';
import { sql } from 'kysely';
import { db } from '../src/db';
import { UPLOAD_DIR } from '../src/routes/uploads';
import { KEPT_ON_RESET } from '../src/services/account';
import { storedFilePath } from '../src/services/courses';
import { readZip } from '../src/services/zip';
import { EmailWorker } from '../src/worker';
import { client, fakeSmtp, http, registerUser, shutdown, startApp, type FakeSmtp, type TestCtx } from './helpers';

let ctx: TestCtx;
let smtp: FakeSmtp;
before(async () => {
  ctx = await startApp({ account: { waitMs: 300 } });
  smtp = await fakeSmtp();
});
after(async () => {
  await smtp.close();
  await shutdown(ctx);
});

const PASSWORD = 'secret123';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const SECRETS = {
  smtp: 'SMTP-PASS-ne-doit-pas-sortir',
  stripe: 'sk_test_StripeSecretNeDoitPasSortir42',
  webhook: 'whsec_WebhookSecretNeDoitPasSortir42',
  ai: 'sk-ant-api03-AiSecretNeDoitPasSortir-0123456789',
};
const drain = () => new EmailWorker({ throttle: false }).drain();
const paused = async (userId: number) => (await db.selectFrom('settings').select('sending_paused').where('user_id', '=', userId).executeTakeFirstOrThrow()).sending_paused;

/** Tables with a user_id column (every table of an account, whatever is added later). */
async function accountTables(): Promise<string[]> {
  const { rows } = await sql<{ t: string }>`
    SELECT table_name AS t FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'user_id' ORDER BY 1`.execute(db);
  return rows.map((r) => r.t);
}
async function rowsOf(userId: number) {
  const out: Record<string, number> = {};
  for (const t of await accountTables()) {
    const { rows } = await sql<{ n: number }>`SELECT count(*) AS n FROM ${sql.table(t)} WHERE user_id = ${userId}`.execute(db);
    out[t] = rows[0].n;
  }
  return out;
}

function hostGet(host: string, p: string): Promise<number> {
  const url = new URL(ctx.base);
  return new Promise((resolve, reject) => {
    const req = nodeHttp.request({ hostname: url.hostname, port: url.port, method: 'GET', path: p, headers: { host } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

/** An account with something in every area: contacts, fields, funnel (+ domain), emails in the queue, automation,
 *  course with a file, media, affiliation, Stripe / AI keys, SMTP settings. */
async function fullAccount(name = 'Agence Données') {
  const reg = await registerUser(ctx, name);
  // ids restart with the emptied test database: files left on disk by an earlier run must not count
  for (const dir of [path.join(UPLOAD_DIR, String(reg.user.id)), path.join(UPLOAD_DIR, '_courses', String(reg.user.id))]) fs.rmSync(dir, { recursive: true, force: true });
  const api = client(ctx, reg.token);
  const ok = (r: { status: number; text: string }, status = 200) => assert.equal(r.status, status, r.text);
  ok(await api.put('/api/settings', { sender_name: 'Mon Agence', sender_email: 'agence@exemple.fr', company_address: '1 rue X', smtp_host: '127.0.0.1', smtp_port: smtp.port, smtp_user: 'good', smtp_pass: SECRETS.smtp }));
  ok(await api.put('/api/payments/settings', { secret_key: SECRETS.stripe, webhook_secret: SECRETS.webhook }));
  ok(await api.put('/api/ai/key', { api_key: SECRETS.ai }));
  ok(await api.post('/api/custom-fields', { key: 'rdv', label: 'RDV', type: 'datetime' }), 201);
  const tag = (await api.post('/api/tags', { name: 'Client' })).body;
  for (const i of [1, 2, 3]) ok(await api.post('/api/contacts', { email: `c${i}-${reg.user.id}@exemple.fr`, first_name: `Prénom${i}`, tags: ['Client'], fields: { rdv: '2026-10-01T14:30' } }), 201);
  ok(await api.post('/api/segments', { name: 'Clients', filter: { match: 'all', conditions: [{ type: 'tag', op: 'has', tag_id: tag.id }] } }), 201);
  const f = (await api.post('/api/funnels', { name: 'Tunnel public', template: 'optin' })).body;
  const domain = `www.${reg.user.id}-donnees.fr`;
  await db.insertInto('custom_domains').values({ user_id: reg.user.id, funnel_id: f.id, domain, verify_token: 'v', status: 'verified', verified_at: new Date().toISOString() }).execute();
  const auto = await api.post('/api/automations', { name: 'Webhook entrant', trigger: { type: 'webhook' }, actions: [{ type: 'add_tag', tag_id: tag.id }], enabled: true });
  ok(auto, 201);
  const camp = (await api.post('/api/campaigns', { name: 'Séquence' })).body;
  // emails waiting in the queue (a newsletter queued for later)
  const b = (await api.post('/api/broadcasts', { subject: 'Bientôt' })).body;
  await api.patch(`/api/broadcasts/${b.id}`, { content: { settings: {}, blocks: [{ id: 't', type: 'text', text: 'Bonjour' }] } });
  ok(await api.post(`/api/broadcasts/${b.id}/send`));
  await db.updateTable('email_sends').set({ send_at: new Date(Date.now() + 3600_000).toISOString() }).where('broadcast_id', '=', b.id).execute();
  // media + lesson file on disk
  const up = await fetch(`${ctx.base}/api/uploads`, { method: 'POST', headers: { authorization: `Bearer ${reg.token}`, 'content-type': 'image/png' }, body: PNG });
  assert.equal(up.status, 201);
  const media = (await up.json()) as { name: string };
  const course = (await api.post('/api/courses', { title: 'Formation' })).body;
  const lesson = (await api.post(`/api/course-modules/${course.modules[0].id}/lessons`, { title: 'Leçon 1' })).body;
  ok(await http(ctx, 'POST', `/api/lessons/${lesson.id}/files?name=${encodeURIComponent('support.pdf')}`, { token: reg.token, body: '%PDF-1.4 support' }), 201);
  const file = await db.selectFrom('course_files').select('stored').where('user_id', '=', reg.user.id).executeTakeFirstOrThrow();
  const area = (await api.get('/api/member-area')).body;
  const program = await api.put('/api/affiliation/settings', { enabled: true });
  ok(program);
  ok(await api.post('/api/products', { name: 'Coaching', prices: [{ type: 'one_time', amount: 9900, currency: 'eur' }] }), 201);
  return {
    ...reg,
    api,
    funnel: f,
    domain,
    automation: auto.body as { webhook_url: string; signing_secret: string },
    campaign: camp,
    broadcastId: b.id as number,
    mediaPath: path.join(UPLOAD_DIR, String(reg.user.id), media.name),
    lessonFilePath: storedFilePath(reg.user.id, file.stored),
    memberArea: `/m/${area.slug}`,
    affiliateArea: `/a/${program.body.slug}`,
  };
}
type Full = Awaited<ReturnType<typeof fullAccount>>;
const confirm = (a: Full, extra: Record<string, unknown> = {}) => ({ password: PASSWORD, confirm: a.email.toUpperCase(), ...extra });

describe('export des données', () => {
  test('archive ZIP : contacts (tags, champs, événements), tunnels, emails, automatisations… et aucun secret', async () => {
    const a = await fullAccount();
    const sum = await a.api.get('/api/account/summary');
    assert.equal(sum.status, 200, sum.text);
    assert.equal(sum.body.email, a.email);
    assert.equal(sum.body.counts.contacts, 3);
    assert.equal(sum.body.counts.queued_emails, 3);
    assert.equal(sum.body.counts.media_files, 1);
    assert.equal(sum.body.stripe_connected, true);

    const res = await fetch(`${ctx.base}/api/account/export`, { method: 'POST', headers: { authorization: `Bearer ${a.token}` } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="scalo-export-\d{4}-\d{2}-\d{2}\.zip"/);
    const zip = readZip(Buffer.from(await res.arrayBuffer()));
    for (const name of ['LISEZMOI.txt', 'compte.json', 'contacts.json', 'contacts.csv', 'tags.json', 'champs-personnalises.json', 'segments.json', 'tunnels.json', 'emails.json', 'automatisations.json', 'ventes.json', 'formations.json', 'affiliation.json', 'imports.json', 'medias.json']) {
      assert.ok(zip.has(name), name);
    }
    const j = (name: string) => JSON.parse(zip.get(name)!.toString('utf8'));
    const contacts = j('contacts.json') as { email: string; tags: { name: string }[]; fields: Record<string, string>; events: { type: string }[] }[];
    assert.equal(contacts.length, 3);
    assert.deepEqual(contacts[0].tags.map((t) => t.name), ['Client']);
    assert.equal(contacts[0].fields.rdv, '2026-10-01T12:30:00.000Z');
    assert.ok(contacts[0].events.some((e) => e.type === 'created'));
    assert.match(zip.get('contacts.csv')!.toString('utf8'), /01\/10\/2026 14:30/);
    assert.equal(j('tunnels.json')[0].name, 'Tunnel public');
    assert.ok(j('tunnels.json')[0].steps.length > 0);
    assert.equal(j('tunnels.json')[0].domains[0].domain, a.domain);
    assert.equal(j('emails.json').newsletters[0].subject, 'Bientôt');
    assert.equal(j('emails.json').campaigns[0].name, 'Séquence');
    assert.equal(j('automatisations.json')[0].name, 'Webhook entrant');
    assert.equal(j('segments.json')[0].name, 'Clients');
    assert.equal(j('ventes.json').products[0].name, 'Coaching');
    assert.equal(j('formations.json').courses[0].lessons[0].files[0].name, 'support.pdf');
    assert.equal(j('compte.json').settings.sender_name, 'Mon Agence');
    assert.equal(j('compte.json').account.email, a.email);
    assert.ok([...zip.keys()].some((k) => k.startsWith('medias/') && k.endsWith('.png')));
    assert.ok([...zip.keys()].some((k) => k.startsWith('formations/fichiers/') && k.endsWith('support.pdf')));

    // no secret anywhere
    const all = [...zip.values()].map((b) => b.toString('latin1')).join('\n');
    const settings = await db.selectFrom('settings').select('webhook_secret').where('user_id', '=', a.user.id).executeTakeFirstOrThrow();
    const auto = await db.selectFrom('automations').select(['webhook_token', 'signing_secret']).where('user_id', '=', a.user.id).executeTakeFirstOrThrow();
    const hash = await db.selectFrom('users').select('password_hash').where('id', '=', a.user.id).executeTakeFirstOrThrow();
    const secrets = [...Object.values(SECRETS), auto.webhook_token, auto.signing_secret, hash.password_hash, PASSWORD, settings.webhook_secret].filter((x): x is string => !!x);
    assert.ok(secrets.length >= 8);
    for (const secret of secrets) {
      assert.ok(!all.includes(secret), `secret exporté : ${secret.slice(0, 12)}…`);
    }
    for (const key of ['password_hash', 'smtp_pass', 'stripe_secret_key', 'stripe_webhook_secret', 'api_key_enc', 'webhook_token', 'signing_secret', 'secret_hash', 'token_hash', 'payout_details_enc', 'share_token_hash', 'secret_enc']) {
      assert.ok(!all.includes(`"${key}"`), `colonne exportée : ${key}`);
    }
  });
});

describe('suppression des données', () => {
  test('tout est supprimé (base, fichiers, file d’envoi), les réglages restent, l’autre compte est intact, le compte reste utilisable', async () => {
    const a = await fullAccount('Compte A');
    const b = await fullAccount('Compte B');
    const before = await rowsOf(b.user.id);
    assert.ok(fs.existsSync(a.mediaPath) && fs.existsSync(a.lessonFilePath));

    const r = await a.api.post('/api/account/reset', confirm(a));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.deleted.contacts, 3);

    // every table of the account is empty, except the settings that a reset keeps
    const left = await rowsOf(a.user.id);
    for (const [t, n] of Object.entries(left)) {
      if (KEPT_ON_RESET.includes(t)) continue;
      assert.equal(n, 0, `${t} : ${n} ligne(s) restante(s)`);
    }
    assert.equal(left.settings, 1);
    assert.equal(left.payment_settings, 1, 'connexion Stripe conservée');
    const s = (await a.api.get('/api/settings')).body;
    assert.equal(s.sender_name, 'Mon Agence', 'expéditeur conservé');
    assert.equal(await paused(a.user.id), false, 'file d’envoi rendue dans son état précédent');
    // files removed from the disk
    assert.ok(!fs.existsSync(a.mediaPath), 'image de la médiathèque supprimée');
    assert.ok(!fs.existsSync(a.lessonFilePath), 'fichier de leçon supprimé');
    assert.ok(!fs.existsSync(path.join(UPLOAD_DIR, String(a.user.id))));
    // the other account is intact
    const after = await rowsOf(b.user.id);
    for (const t of Object.keys(before)) assert.equal(after[t], before[t], `compte B : ${t}`);
    assert.ok(fs.existsSync(b.mediaPath) && fs.existsSync(b.lessonFilePath));
    assert.equal(await hostGet(b.domain, '/'), 200);
    // nothing will be sent: the worker finds nothing of this account
    await db.updateTable('email_sends').set({ send_at: new Date().toISOString() }).where('user_id', '=', b.user.id).execute();
    const sentBefore = smtp.messages.length;
    await drain();
    const toA = smtp.messages.slice(sentBefore).filter((m) => m.to.some((t) => t.includes(`-${a.user.id}@`)));
    assert.equal(toA.length, 0, 'aucun email du compte vidé');
    assert.equal(smtp.messages.length - sentBefore, 3, 'les envois de l’autre compte partent normalement');
    // public pages answer 404, the account still works
    assert.equal((await http(ctx, 'GET', `/p/${a.funnel.slug}`)).status, 404);
    assert.equal(await hostGet(a.domain, '/'), 404);
    const me = await a.api.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal((await a.api.post('/api/contacts', { email: 'nouveau@exemple.fr' })).status, 201);
    assert.equal((await a.api.get('/api/contacts')).body.total, 1);
  });

  test('mot de passe, confirmation, limitation de débit : rien n’est supprimé', async () => {
    const a = await fullAccount('Compte C');
    const wrong = await a.api.post('/api/account/reset', confirm(a, { password: 'mauvais' }));
    assert.equal(wrong.status, 403, 'pas 401 : la session reste valide');
    assert.equal(wrong.body.error, 'Mot de passe incorrect');
    const noConfirm = await a.api.post('/api/account/reset', confirm(a, { confirm: 'autre@exemple.fr' }));
    assert.equal(noConfirm.status, 400);
    assert.match(noConfirm.body.error, /adresse email du compte/);
    assert.equal((await a.api.post('/api/account/delete', confirm(a, { password: 'mauvais' }))).status, 403);
    // 5 failed checks in the window (the success above reset the counter): the next one is refused
    for (let i = 0; i < 4; i++) assert.equal((await a.api.post('/api/account/delete', confirm(a, { password: `mauvais${i}` }))).status, 403);
    const limited = await a.api.post('/api/account/delete', confirm(a));
    assert.equal(limited.status, 429, 'même le bon mot de passe est refusé pendant la fenêtre');
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal((await a.api.get('/api/contacts')).body.total, 3);
    assert.equal((await a.api.get('/api/auth/me')).status, 200);
    assert.equal(await paused(a.user.id), false);
  });
});

describe('suppression du compte', () => {
  test('connexion impossible, JWT existant refusé, pages publiques et domaine en 404, autre compte intact', async () => {
    const a = await fullAccount('Compte D');
    const b = await fullAccount('Compte E');
    // an OAuth application + access token of the account
    const app = await a.api.post('/api/developer/apps', { name: 'Mon app', type: 'confidential', redirect_uris: ['https://app.exemple.fr/cb'], scopes: ['profile'] });
    assert.equal(app.status, 201, app.text);
    assert.equal((await http(ctx, 'GET', a.memberArea)).status, 302, 'espace membres actif');
    assert.equal((await http(ctx, 'GET', a.affiliateArea)).status, 200, 'espace affilié actif');
    assert.equal(await hostGet(a.domain, '/'), 200);
    const beforeB = await rowsOf(b.user.id);

    const r = await a.api.post('/api/account/delete', confirm(a));
    assert.equal(r.status, 200, r.text);

    assert.equal((await a.api.get('/api/auth/me')).status, 401, 'JWT existant');
    assert.equal((await a.api.get('/api/contacts')).status, 401);
    assert.equal((await http(ctx, 'POST', '/api/auth/login', { json: { email: a.email, password: PASSWORD } })).status, 401);
    assert.equal((await db.selectFrom('users').select('id').where('id', '=', a.user.id).executeTakeFirst()), undefined);
    for (const [t, n] of Object.entries(await rowsOf(a.user.id))) assert.equal(n, 0, t);
    assert.equal((await db.selectFrom('oauth_clients').select('id').where('user_id', '=', a.user.id).execute()).length, 0);
    assert.equal((await http(ctx, 'GET', `/p/${a.funnel.slug}`)).status, 404);
    assert.equal((await http(ctx, 'GET', a.memberArea)).status, 404);
    assert.equal((await http(ctx, 'GET', a.affiliateArea)).status, 404);
    assert.equal(await hostGet(a.domain, '/'), 404);
    assert.equal((await http(ctx, 'POST', new URL(a.automation.webhook_url).pathname, { json: { email: 'x@y.fr' } })).status, 404, 'webhook entrant');
    assert.ok(!fs.existsSync(a.mediaPath) && !fs.existsSync(a.lessonFilePath));
    // the other account
    const afterB = await rowsOf(b.user.id);
    for (const t of Object.keys(beforeB)) assert.equal(afterB[t], beforeB[t], `compte B : ${t}`);
    assert.equal((await b.api.get('/api/auth/me')).status, 200);
    assert.equal(await hostGet(b.domain, '/'), 200);
    // the email can sign up again
    assert.equal((await http(ctx, 'POST', '/api/auth/register', { json: { email: a.email, password: PASSWORD, name: 'Retour' } })).status, 201);
  });

  test('un envoi en cours retarde la suppression ; au-delà du délai : 409 et rien n’est supprimé', async () => {
    const a = await fullAccount('Compte F');
    // a live worker instance is delivering one email of the account
    await db.insertInto('worker_instances').values({ id: 'test-live-worker', hostname: 'test', pid: 1 }).onConflict((oc) => oc.column('id').doUpdateSet({ heartbeat_at: sql`now()` })).execute();
    const one = await db.selectFrom('email_sends').select('id').where('user_id', '=', a.user.id).executeTakeFirstOrThrow();
    await db.updateTable('email_sends').set({ status: 'sending', claimed_by: 'test-live-worker' }).where('id', '=', one.id).execute();
    const r = await a.api.post('/api/account/delete', confirm(a));
    assert.equal(r.status, 409, r.text);
    assert.equal((await a.api.get('/api/auth/me')).status, 200);
    assert.equal((await a.api.get('/api/contacts')).body.total, 3);
    assert.equal(await paused(a.user.id), false, 'file d’envoi remise en route');
    // the delivery ends → the deletion goes through
    await db.updateTable('email_sends').set({ status: 'sent', sent_at: new Date().toISOString() }).where('id', '=', one.id).execute();
    assert.equal((await a.api.post('/api/account/delete', confirm(a))).status, 200);
    await db.deleteFrom('worker_instances').where('id', '=', 'test-live-worker').execute();
  });
});
