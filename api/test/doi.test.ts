import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db } from '../src/db';
import { claimSends, EmailWorker } from '../src/worker';
import { client, http, registerUser, shutdown, startApp, type TestCtx } from './helpers';

let ctx: TestCtx;
before(async () => {
  ctx = await startApp();
});
after(() => shutdown(ctx));

let funnelSeq = 0;

/** Account with a campaign and an opt-in funnel whose form uses double opt-in (unless `doubleOptin` says otherwise). */
async function setup(form: Record<string, unknown> = { doubleOptin: true }) {
  const reg = await registerUser(ctx);
  const api = client(ctx, reg.token);
  const camp = (await api.post('/api/campaigns', { name: 'Bienvenue' })).body;
  await api.post(`/api/campaigns/${camp.id}/emails`, { subject: 'Guide {{first_name}}', delay_days: 0 });
  const name = `Guide DOI ${++funnelSeq}`;
  const f = (await api.post('/api/funnels', { name, template: 'optin' })).body;
  const [optin, merci] = f.steps;
  await api.patch(`/api/steps/${optin.id}`, {
    content: {
      settings: {},
      blocks: [
        {
          id: 'form1',
          type: 'form',
          fields: [{ name: 'email', label: 'Email', required: true }, { name: 'first_name', label: 'Prénom' }],
          submitLabel: 'Go',
          tagName: 'lead',
          campaignId: camp.id,
          ...form,
        },
      ],
    },
  });
  const submit = (email: string, first_name = 'Zoé') =>
    http(ctx, 'POST', `/p/${f.slug}/${optin.slug}/submit`, { form: { email, first_name, _block: 'form1' } });
  return { api, userId: reg.user.id, camp, f, optin, merci, submit };
}

const contactByEmail = async (api: ReturnType<typeof client>, email: string) => (await api.get(`/api/contacts?search=${encodeURIComponent(email)}`)).body.items[0];
const confirmationSends = (contactId: number) =>
  db.selectFrom('email_sends').selectAll().where('contact_id', '=', contactId).where('kind', '=', 'confirmation').orderBy('id').execute();
const tokenOf = (html: string | null) => /\/c\/([\w-]{20,})/.exec(html ?? '')?.[1] ?? '';

describe('double opt-in', () => {
  test('submit → pending contact, nothing applied, confirmation email queued first', async () => {
    const { api, userId, camp, f, merci, submit } = await setup();
    // a newsletter already waiting in the queue for another contact
    await api.post('/api/contacts', { email: 'other@mail.fr' });
    const b = (await api.post('/api/broadcasts', { subject: 'News' })).body;
    await api.post(`/api/broadcasts/${b.id}/send`);

    const r = await submit('Zoe@Mail.fr');
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), `/p/${f.slug}/${merci.slug}?doi=1`);
    const page = await http(ctx, 'GET', r.headers.get('location')!);
    assert.match(page.text, /Vérifiez votre boîte mail/);

    const c = await contactByEmail(api, 'zoe@mail.fr');
    assert.equal(c.status, 'pending_confirmation');
    assert.equal(c.confirmed_at, null);
    assert.deepEqual(c.tags, [], 'tag applied only on confirmation');
    assert.equal((await api.get(`/api/campaigns/${camp.id}`)).body.subscribers, 0);
    assert.equal((await api.get('/api/contacts?status=pending_confirmation')).body.total, 1);
    assert.equal((await api.get('/api/contacts?status=confirmed')).body.total, 1);

    // excluded from newsletters
    const b2 = (await api.post('/api/broadcasts', { subject: 'Later' })).body;
    assert.equal((await api.get(`/api/broadcasts/${b2.id}/recipients-count`)).body.count, 1);

    const [conf] = await confirmationSends(c.id);
    assert.equal(conf.status, 'pending');
    assert.equal(conf.subject, 'Confirmez votre inscription');
    // top priority: claimed before the older newsletter send
    const [first] = await claimSends(userId, 1, 'prio');
    assert.equal(first.id, conf.id);
    assert.equal(first.kind, 'confirmation');
    await db.updateTable('email_sends').set({ status: 'pending', attempts: 0, claimed_by: null }).where('id', '=', conf.id).execute();

    await new EmailWorker({ throttle: false }).drain();
    const [sent] = await confirmationSends(c.id);
    assert.equal(sent.status, 'sent');
    assert.ok(tokenOf(sent.html), 'confirmation link in the email');
    assert.doesNotMatch(sent.html ?? '', /\/t\/o\//, 'no tracking pixel in the confirmation email');
    // not counted in newsletter stats
    assert.equal((await api.get(`/api/broadcasts/${b.id}`)).body.stats.sent, 1);
    const events = (await api.get(`/api/contacts/${c.id}`)).body.events.map((e: { type: string }) => e.type);
    assert.ok(events.includes('confirmation_sent'));
  });

  test('GET shows a button (mail scanners), POST confirms and applies tag + campaign', async () => {
    const { api, camp, submit } = await setup();
    await submit('ana@mail.fr', 'Ana');
    const c = await contactByEmail(api, 'ana@mail.fr');
    const token = tokenOf((await confirmationSends(c.id))[0].html);

    const get = await http(ctx, 'GET', `/c/${token}`);
    assert.equal(get.status, 200);
    assert.match(get.text, /Confirmer mon inscription/);
    assert.match(get.text, /method="post"/);
    assert.equal((await api.get(`/api/contacts/${c.id}`)).body.status, 'pending_confirmation', 'GET does not confirm');

    const post = await http(ctx, 'POST', `/c/${token}`);
    assert.equal(post.status, 200);
    assert.match(post.text, /Inscription confirmée/);
    const after = (await api.get(`/api/contacts/${c.id}`)).body;
    assert.equal(after.status, 'active');
    assert.ok(after.confirmed_at);
    assert.deepEqual(after.tags.map((t: { name: string }) => t.name), ['lead']);
    assert.ok(after.events.some((e: { type: string }) => e.type === 'optin_confirmed'));
    assert.equal((await api.get(`/api/campaigns/${camp.id}`)).body.subscribers, 1);
    const campaignSends = await db.selectFrom('email_sends').select('status').where('campaign_id', '=', camp.id).where('contact_id', '=', c.id).execute();
    assert.equal(campaignSends.length, 1);

    // idempotent: already confirmed
    const again = await http(ctx, 'POST', `/c/${token}`);
    assert.equal(again.status, 200);
    assert.match(again.text, /confirmée/);
    assert.equal((await api.get(`/api/campaigns/${camp.id}`)).body.subscribers, 1);
    assert.match((await http(ctx, 'GET', `/c/${token}`)).text, /confirmée/);
  });

  test('tag trigger campaigns fire on confirmation; configured redirect', async () => {
    const reg = await registerUser(ctx);
    const api = client(ctx, reg.token);
    const tag = (await api.post('/api/tags', { name: 'ebook' })).body;
    const camp = (await api.post('/api/campaigns', { name: 'Ebook', trigger_tag_id: tag.id })).body;
    await api.post(`/api/campaigns/${camp.id}/emails`, { subject: 'Ebook', delay_days: 0 });
    const f = (await api.post('/api/funnels', { name: `Ebook DOI ${++funnelSeq}`, template: 'optin' })).body;
    await api.patch(`/api/steps/${f.steps[0].id}`, {
      content: {
        settings: {},
        blocks: [{ id: 'f', type: 'form', fields: [{ name: 'email', label: 'Email' }], submitLabel: 'Go', tagName: 'ebook', doubleOptin: true, doubleOptinRedirect: 'https://exemple.com/merci', doubleOptinSubject: 'Un clic {{first_name}} !' }],
      },
    });
    await http(ctx, 'POST', `/p/${f.slug}/${f.steps[0].slug}/submit`, { form: { email: 'eb@mail.fr', first_name: 'Eb' } });
    const c = await contactByEmail(api, 'eb@mail.fr');
    const [conf] = await confirmationSends(c.id);
    assert.equal(conf.subject, 'Un clic Eb !');
    const post = await http(ctx, 'POST', `/c/${tokenOf(conf.html)}`);
    assert.equal(post.status, 303);
    assert.equal(post.headers.get('location'), 'https://exemple.com/merci');
    assert.equal((await api.get(`/api/campaigns/${camp.id}`)).body.subscribers, 1);
  });

  test('expired and invalid tokens', async () => {
    const { api, submit } = await setup();
    await submit('exp@mail.fr');
    const c = await contactByEmail(api, 'exp@mail.fr');
    const token = tokenOf((await confirmationSends(c.id))[0].html);
    await db.updateTable('pending_optins').set({ expires_at: sql`now() - interval '1 minute'` }).where('contact_id', '=', c.id).execute();
    assert.equal((await http(ctx, 'GET', `/c/${token}`)).status, 410);
    assert.equal((await http(ctx, 'POST', `/c/${token}`)).status, 410);
    assert.equal((await api.get(`/api/contacts/${c.id}`)).body.status, 'pending_confirmation');
    assert.equal((await http(ctx, 'GET', '/c/not-a-real-token-at-all-xxxxxxxx')).status, 404);
    assert.equal((await http(ctx, 'POST', '/c/short')).status, 404);
  });

  test('resend (rate-limited, new link), account default, unconfirmed excluded at send time', async () => {
    const { api, userId, submit } = await setup({});
    // account default applies to forms without an explicit setting
    assert.equal((await api.put('/api/settings', { double_optin_default: true })).body.double_optin_default, true);
    await submit('def@mail.fr');
    const c = await contactByEmail(api, 'def@mail.fr');
    assert.equal(c.status, 'pending_confirmation');
    const oldToken = tokenOf((await confirmationSends(c.id))[0].html);

    const tooSoon = await api.post(`/api/contacts/${c.id}/resend-confirmation`);
    assert.equal(tooSoon.status, 429);
    await db.updateTable('contacts').set({ confirmation_sent_at: sql`now() - interval '10 minutes'` }).where('id', '=', c.id).execute();
    const resent = await api.post(`/api/contacts/${c.id}/resend-confirmation`);
    assert.equal(resent.status, 200);
    const sends = await confirmationSends(c.id);
    assert.equal(sends.length, 2);
    const newToken = tokenOf(sends[1].html);
    assert.notEqual(newToken, oldToken);
    assert.equal((await http(ctx, 'GET', `/c/${oldToken}`)).status, 404, 'old link replaced');
    // 3 confirmation emails per hour and per contact
    await db.updateTable('contacts').set({ confirmation_sent_at: sql`now() - interval '10 minutes'` }).where('id', '=', c.id).execute();
    assert.equal((await api.post(`/api/contacts/${c.id}/resend-confirmation`)).status, 200);
    await db.updateTable('contacts').set({ confirmation_sent_at: sql`now() - interval '10 minutes'` }).where('id', '=', c.id).execute();
    assert.equal((await api.post(`/api/contacts/${c.id}/resend-confirmation`)).status, 429);
    assert.equal((await http(ctx, 'GET', `/c/${tokenOf((await confirmationSends(c.id)).at(-1)!.html)}`)).status, 200, 'last link still valid after a refused resend');

    // manual enrollment of an unconfirmed contact is refused; a send queued anyway is skipped by the worker
    const camp = (await api.get('/api/campaigns')).body[0];
    assert.equal((await api.post(`/api/campaigns/${camp.id}/enroll`, { contact_id: c.id })).status, 409);
    const b = (await api.post('/api/broadcasts', { subject: 'X' })).body;
    await db.insertInto('email_sends').values({ user_id: userId, contact_id: c.id, broadcast_id: b.id, kind: 'broadcast', to_email: c.email, subject: 'X' }).execute();
    await new EmailWorker({ throttle: false }).drain();
    const skipped = await db.selectFrom('email_sends').select(['status', 'error']).where('broadcast_id', '=', b.id).executeTakeFirstOrThrow();
    assert.equal(skipped.status, 'skipped');
    assert.match(skipped.error ?? '', /non confirmé/);

    // confirmed contact → resend refused
    const token = tokenOf((await confirmationSends(c.id)).at(-1)!.html);
    await http(ctx, 'POST', `/c/${token}`);
    assert.equal((await api.post(`/api/contacts/${c.id}/resend-confirmation`)).status, 409);
  });

  test('without double opt-in nothing changes (tag + campaign right away)', async () => {
    const { api, camp, submit } = await setup({ doubleOptin: false });
    const r = await submit('direct@mail.fr');
    assert.doesNotMatch(r.headers.get('location') ?? '', /doi=1/);
    const c = await contactByEmail(api, 'direct@mail.fr');
    assert.equal(c.status, 'active');
    assert.deepEqual(c.tags.map((t: { name: string }) => t.name), ['lead']);
    assert.equal((await api.get(`/api/campaigns/${camp.id}`)).body.subscribers, 1);
    assert.equal((await confirmationSends(c.id)).length, 0);
  });
});
