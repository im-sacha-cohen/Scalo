import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db } from '../src/db';
import { signId } from '../src/util';
import { claimSends, EmailWorker, MAX_ATTEMPTS } from '../src/worker';
import { client, fakeSmtp, http, registerUser, shutdown, startApp, type FakeSmtp, type TestCtx } from './helpers';

let ctx: TestCtx;
let smtp: FakeSmtp;
before(async () => {
  ctx = await startApp();
  smtp = await fakeSmtp();
});
after(async () => {
  await smtp.close();
  await shutdown(ctx);
});

async function accountWithContacts(emails: string[]) {
  const reg = await registerUser(ctx);
  const api = client(ctx, reg.token);
  const csv = `email,first_name\n${emails.map((e, i) => `${e},P${i}`).join('\n')}\n`;
  await api.post('/api/contacts/import', { csv });
  return { api, userId: reg.user.id };
}

async function sendBroadcast(api: ReturnType<typeof client>, subject = 'News {{first_name}}') {
  const b = (await api.post('/api/broadcasts', { subject })).body;
  const sent = await api.post(`/api/broadcasts/${b.id}/send`);
  assert.equal(sent.status, 200);
  return sent.body;
}

const sendsOf = (userId: number) =>
  db.selectFrom('email_sends').selectAll().where('user_id', '=', userId).where('is_test', '=', false).orderBy('id').execute();

describe('broadcasts (dev mode)', () => {
  test('send → worker delivers → outbox, stats, tracking, 409 on resend', async () => {
    const { api, userId } = await accountWithContacts(['a@mail.fr', 'b@mail.fr', 'c@mail.fr']);
    const unsub = (await api.get('/api/contacts?search=c@mail.fr')).body.items[0];
    await api.patch(`/api/contacts/${unsub.id}`, { unsubscribed: true });

    const b = (await api.post('/api/broadcasts', { subject: 'Hello {{first_name}}' })).body;
    assert.equal(b.status, 'draft');
    assert.deepEqual(b.stats, { sent: 0, opened: 0, clicked: 0, pending: 0, sending: 0, failed: 0 });
    assert.equal((await api.get(`/api/broadcasts/${b.id}/recipients-count`)).body.count, 2);
    const withLink = {
      settings: {},
      blocks: [{ id: 'btn', type: 'button', label: 'Go', action: 'url', url: 'https://example.com/landing?x=1' }],
    };
    assert.equal((await api.patch(`/api/broadcasts/${b.id}`, { content: withLink })).status, 200);

    const sent = await api.post(`/api/broadcasts/${b.id}/send`);
    assert.equal(sent.body.status, 'sent');
    assert.equal(sent.body.stats.pending, 2);
    assert.equal((await api.post(`/api/broadcasts/${b.id}/send`)).status, 409);
    assert.equal((await api.patch(`/api/broadcasts/${b.id}`, { subject: 'x' })).status, 409);

    const queue = (await api.get('/api/emails/queue')).body;
    assert.equal(queue.dev_mode, true);
    assert.equal(queue.due, 2);
    assert.equal(queue.state, 'sending');

    await new EmailWorker({ throttle: false }).drain();

    const outbox = (await api.get('/api/emails/outbox')).body;
    assert.equal(outbox.total, 2);
    assert.ok(outbox.items.every((s: { status: string; source: string }) => s.status === 'sent' && s.source === `broadcast:${b.id}`));
    assert.deepEqual(outbox.items.map((s: { subject: string }) => s.subject).sort(), ['Hello P0', 'Hello P1']);
    assert.equal((await api.get('/api/emails/outbox?status=failed')).body.total, 0);
    assert.equal((await api.get('/api/emails/outbox?search=A@MAIL')).body.total, 1);

    const send = outbox.items[0];
    const html = await api.get(`/api/emails/sends/${send.id}/html`);
    assert.match(html.text, new RegExp(`/t/o/${send.id}\\.gif`));
    assert.match(html.text, /\/u\/\d+\./); // unsubscribe link

    // tracking: open pixel + click redirect (only to links of the mail)
    const pixel = await http(ctx, 'GET', `/t/o/${send.id}.gif`);
    assert.equal(pixel.headers.get('content-type'), 'image/gif');
    const click = await http(ctx, 'GET', `/t/c/${send.id}?u=${encodeURIComponent('https://example.com/landing?x=1')}`);
    assert.equal(click.status, 302);
    assert.equal(click.headers.get('location'), 'https://example.com/landing?x=1');
    assert.equal((await http(ctx, 'GET', `/t/c/${send.id}?u=${encodeURIComponent('https://evil.example')}`)).status, 404);

    const stats = (await api.get(`/api/broadcasts/${b.id}`)).body.stats;
    assert.deepEqual(stats, { sent: 2, opened: 1, clicked: 1, pending: 0, sending: 0, failed: 0 });
    const dash = (await api.get('/api/dashboard')).body;
    assert.equal(dash.emails_sent_30d, 2);
    assert.equal(dash.open_rate, 0.5);

    const events = await db.selectFrom('contact_events').select('type').where('user_id', '=', userId).where('type', 'in', ['email_sent', 'email_opened', 'email_clicked']).execute();
    assert.equal(events.filter((e) => e.type === 'email_sent').length, 2);
    assert.equal(events.filter((e) => e.type === 'email_opened').length, 1);
    assert.equal(events.filter((e) => e.type === 'email_clicked').length, 1);

    const q = (await api.get('/api/emails/queue')).body;
    assert.equal(q.sent_24h, 2);
    assert.equal(q.jobs.length, 1);
    assert.equal(q.jobs[0].done, true);
  });

  test('unsubscribe: GET only confirms, POST unsubscribes and cancels pending sends', async () => {
    const { api } = await accountWithContacts(['u@mail.fr']);
    const c = (await api.get('/api/contacts')).body.items[0];
    await sendBroadcast(api);
    const token = signId('unsub', c.id);

    const get = await http(ctx, 'GET', `/u/${token}`);
    assert.equal(get.status, 200);
    assert.match(get.text, /Confirmer la désinscription/);
    assert.equal((await api.get(`/api/contacts/${c.id}`)).body.unsubscribed, 0);

    const post = await http(ctx, 'POST', `/u/${token}`, { form: { 'List-Unsubscribe': 'One-Click' } });
    assert.equal(post.status, 200);
    const after = (await api.get(`/api/contacts/${c.id}`)).body;
    assert.equal(after.unsubscribed, 1);
    assert.ok(after.events.some((e: { type: string; data: { via?: string } }) => e.type === 'unsubscribed' && e.data.via === 'one-click'));
    const outbox = (await api.get('/api/emails/outbox')).body.items;
    assert.equal(outbox[0].status, 'failed');
    assert.equal(outbox[0].error, 'unsubscribed');

    assert.match((await http(ctx, 'GET', `/u/${token}`)).text, /déjà désinscrit/);
    assert.equal((await http(ctx, 'GET', `/u/${c.id}.forged`)).status, 404);
  });
});

describe('worker concurrency (FOR UPDATE SKIP LOCKED)', () => {
  test('concurrent claimers take disjoint rows', async () => {
    const emails = Array.from({ length: 60 }, (_, i) => `claim${i}@mail.fr`);
    const { api, userId } = await accountWithContacts(emails);
    await sendBroadcast(api);
    const [a, b, c] = await Promise.all([claimSends(userId, 25, 'A'), claimSends(userId, 25, 'B'), claimSends(userId, 25, 'C')]);
    const ids = [...a, ...b, ...c].map((s) => s.id);
    assert.equal(ids.length, 60, 'all due rows claimed');
    assert.equal(new Set(ids).size, 60, 'no row claimed twice');
    const rows = await sendsOf(userId);
    assert.ok(rows.every((r) => r.status === 'sending' && r.attempts === 1 && r.last_attempt_at));
    assert.equal(rows.filter((r) => r.claimed_by === 'A').length, a.length);
    assert.equal((await claimSends(userId, 10, 'D')).length, 0);
    await db.deleteFrom('email_sends').where('user_id', '=', userId).execute(); // don't leave orphans for the next tests
  });

  test('two workers draining the same queue never deliver twice', async () => {
    const emails = Array.from({ length: 80 }, (_, i) => `w${i}@mail.fr`);
    const { api, userId } = await accountWithContacts(emails);
    await sendBroadcast(api);
    const w1 = new EmailWorker({ throttle: false, instanceId: 'w1' });
    const w2 = new EmailWorker({ throttle: false, instanceId: 'w2' });
    await Promise.all([w1.drain(), w2.drain(), w1.drain(), w2.drain()]);
    const rows = await sendsOf(userId);
    assert.equal(rows.length, 80);
    assert.ok(rows.every((r) => r.status === 'sent' && r.attempts === 1), 'each send attempted exactly once');
    const sentEvents = await db
      .selectFrom('contact_events')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('user_id', '=', userId)
      .where('type', '=', 'email_sent')
      .executeTakeFirstOrThrow();
    assert.equal(sentEvents.n, 80);
  });

  test('crash recovery only touches sends of dead instances', async () => {
    const { api, userId } = await accountWithContacts(['r1@mail.fr', 'r2@mail.fr']);
    await sendBroadcast(api);
    const [s1, s2] = await sendsOf(userId);
    await db.insertInto('worker_instances').values({ id: 'alive', hostname: 'h', pid: 1 }).execute();
    await db.updateTable('email_sends').set({ status: 'sending', attempts: 1, claimed_by: 'dead' }).where('id', '=', s1.id).execute();
    await db.updateTable('email_sends').set({ status: 'sending', attempts: 1, claimed_by: 'alive' }).where('id', '=', s2.id).execute();
    const n = await new EmailWorker({ instanceId: 'rescuer' }).recoverInterruptedSends();
    assert.equal(n, 1);
    const [r1, r2] = await sendsOf(userId);
    assert.equal(r1.status, 'pending'); // dev mode: requeued
    assert.equal(r1.attempts, 0);
    assert.equal(r2.status, 'sending'); // owned by a live instance: untouched
    // once the live instance stops heart-beating, it is recovered too
    await db.updateTable('worker_instances').set({ heartbeat_at: sql`now() - interval '5 minutes'` }).where('id', '=', 'alive').execute();
    assert.equal(await new EmailWorker({ instanceId: 'rescuer' }).recoverInterruptedSends(), 1);
  });
});

describe('SMTP delivery (fake server)', () => {
  test('550 → bounce, 451 → retry with backoff then abandon, 535 → queue paused', async () => {
    const { api, userId } = await accountWithContacts(['ok@mail.fr', 'bounce@mail.fr', 'temp@mail.fr']);
    const put = await api.put('/api/settings', { smtp_host: '127.0.0.1', smtp_port: smtp.port, smtp_user: 'good', smtp_pass: 'pw', sender_email: 'me@mail.fr' });
    assert.equal(put.body.smtp_configured, true);
    assert.equal(put.body.smtp_pass, '');
    await sendBroadcast(api, 'Hi {{first_name}}');
    const worker = new EmailWorker({ throttle: false });
    await worker.runOnce();

    const byEmail = async () => Object.fromEntries((await sendsOf(userId)).map((s) => [s.to_email, s]));
    let s = await byEmail();
    assert.equal(s['ok@mail.fr'].status, 'sent');
    assert.equal(smtp.messages.length, 1);
    assert.deepEqual(smtp.messages[0].to, ['ok@mail.fr']);
    assert.match(smtp.messages[0].data, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/i);

    assert.equal(s['bounce@mail.fr'].status, 'failed');
    assert.match(s['bounce@mail.fr'].error ?? '', /Adresse rejetée/);
    const bounced = (await api.get('/api/contacts?search=bounce')).body.items[0];
    assert.equal(bounced.bounced, 1);
    assert.ok((await api.get(`/api/contacts/${bounced.id}`)).body.events.some((e: { type: string }) => e.type === 'bounced'));
    assert.equal((await api.post(`/api/emails/sends/${s['bounce@mail.fr'].id}/retry`)).status, 409);

    const temp = s['temp@mail.fr'];
    assert.equal(temp.status, 'pending');
    assert.equal(temp.attempts, 1);
    const delay = new Date(temp.send_at).getTime() - Date.now();
    assert.ok(delay > 50_000 && delay <= 60_000, `retry in ~1 min (got ${delay} ms)`);
    assert.equal((await api.get('/api/emails/queue')).body.retrying, 1);

    // next attempts: +5 min, +30 min, then abandon after MAX_ATTEMPTS
    const expected = [5 * 60_000, 30 * 60_000];
    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
      await db.updateTable('email_sends').set({ send_at: sql`now() - interval '1 second'` }).where('id', '=', temp.id).execute();
      await worker.runOnce();
      s = await byEmail();
      if (attempt < MAX_ATTEMPTS) {
        assert.equal(s['temp@mail.fr'].status, 'pending');
        const d = new Date(s['temp@mail.fr'].send_at).getTime() - Date.now();
        assert.ok(Math.abs(d - expected[attempt - 2]) < 10_000, `attempt ${attempt}: ${d}`);
      }
    }
    assert.equal(s['temp@mail.fr'].status, 'failed');
    assert.equal(s['temp@mail.fr'].attempts, MAX_ATTEMPTS);
    assert.match(s['temp@mail.fr'].error ?? '', /abandon après 4 tentatives/);

    // manual retry of the abandoned send
    const retried = await api.post(`/api/emails/sends/${temp.id}/retry`);
    assert.equal(retried.status, 200);
    assert.equal(retried.body.status, 'pending');
    assert.equal(retried.body.attempts, 0);
    await api.post('/api/emails/queue/cancel', { broadcast_id: s['temp@mail.fr'].broadcast_id });

    // auth failure pauses the whole queue and gives the attempt back
    await api.put('/api/settings', { smtp_user: 'bad' });
    await sendBroadcast(api, 'Second');
    await worker.runOnce();
    const second = (await sendsOf(userId)).filter((x) => x.subject === 'Second' || x.status === 'pending');
    const okSecond = second.find((x) => x.to_email === 'ok@mail.fr' && x.status === 'pending');
    assert.ok(okSecond, 'send given back to the queue');
    assert.equal(okSecond.attempts, 0);
    const q = (await api.get('/api/emails/queue')).body;
    assert.equal(q.state, 'paused');
    assert.match(q.paused_reason, /authentification/);
    assert.equal(smtp.messages.length, 1);

    // fix credentials + resume → delivered
    await api.put('/api/settings', { smtp_user: 'good' });
    assert.equal((await api.post('/api/emails/queue/resume')).body.state, 'sending');
    await worker.runOnce();
    assert.equal(smtp.messages.length, 2);
    assert.equal((await api.post('/api/emails/queue/pause')).body.state, 'paused');
  });
});
