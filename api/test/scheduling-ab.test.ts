import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db } from '../src/db';
import { AB_MIN_RECIPIENTS, decideAbTests, pickWinner, runBroadcastScheduler } from '../src/services/broadcasts';
import { EmailWorker } from '../src/worker';
import { client, registerUser, shutdown, startApp, type TestCtx } from './helpers';

let ctx: TestCtx;
before(async () => {
  ctx = await startApp();
});
after(() => shutdown(ctx));

type Api = ReturnType<typeof client>;

async function account(n: number, prefix = 'c') {
  const reg = await registerUser(ctx);
  const api = client(ctx, reg.token);
  if (n) {
    const csv = `email,first_name\n${Array.from({ length: n }, (_, i) => `${prefix}${i}@mail.fr,P${i}`).join('\n')}\n`;
    assert.equal((await api.post('/api/contacts/import', { csv })).status, 200);
  }
  return { api, userId: reg.user.id };
}

const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const sendsOf = (broadcastId: number) =>
  db.selectFrom('email_sends').selectAll().where('broadcast_id', '=', broadcastId).where('is_test', '=', false).orderBy('id').execute();
/** Makes a scheduled newsletter due now (instead of waiting). */
const makeDue = (id: number) => db.updateTable('broadcasts').set({ scheduled_at: sql`now() - interval '1 second'` }).where('id', '=', id).execute();

async function newBroadcast(api: Api, subject = 'News {{first_name}}') {
  return (await api.post('/api/broadcasts', { subject })).body as { id: number };
}

describe('scheduled newsletters', () => {
  test('schedule / unschedule / validation / edits allowed until it starts', async () => {
    const { api } = await account(2);
    const b = await newBroadcast(api);

    for (const [when, re] of [
      [inMinutes(-5), /au moins 1 minute/],
      [new Date(Date.now() + 20_000).toISOString(), /au moins 1 minute/],
      [new Date(Date.now() + 400 * 86400_000).toISOString(), /1 an/],
    ] as const) {
      const r = await api.post(`/api/broadcasts/${b.id}/schedule`, { scheduled_at: when });
      assert.equal(r.status, 400, when);
      assert.match(r.body.error, re);
    }
    assert.equal((await api.post(`/api/broadcasts/${b.id}/schedule`, { scheduled_at: 'demain' })).status, 400);
    assert.equal((await api.post(`/api/broadcasts/${b.id}/unschedule`)).status, 409); // not scheduled

    const at = inMinutes(90);
    const s = await api.post(`/api/broadcasts/${b.id}/schedule`, { scheduled_at: at });
    assert.equal(s.status, 200);
    assert.equal(s.body.status, 'scheduled');
    assert.equal(s.body.scheduled_at, new Date(at).toISOString());
    // rescheduling ("Modifier la date") and editing content are allowed while scheduled
    const later = inMinutes(120);
    assert.equal((await api.post(`/api/broadcasts/${b.id}/schedule`, { scheduled_at: later })).body.scheduled_at, later);
    const edited = await api.patch(`/api/broadcasts/${b.id}`, { subject: 'Edited {{first_name}}' });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.status, 'scheduled');

    const list = (await api.get('/api/broadcasts')).body;
    assert.equal(list[0].status, 'scheduled');
    const queue = (await api.get('/api/emails/queue')).body;
    assert.deepEqual(queue.upcoming.map((u: { broadcast_id: number }) => u.broadcast_id), [b.id]);
    assert.equal(queue.upcoming[0].subject, 'Edited {{first_name}}');

    const un = await api.post(`/api/broadcasts/${b.id}/unschedule`);
    assert.equal(un.body.status, 'draft');
    assert.equal(un.body.scheduled_at, null);
    assert.equal((await api.get('/api/emails/queue')).body.upcoming.length, 0);
    assert.equal((await sendsOf(b.id)).length, 0, 'nothing queued while scheduled');

    // once started: cannot unschedule, edit or reschedule
    await api.post(`/api/broadcasts/${b.id}/schedule`, { scheduled_at: later });
    await makeDue(b.id);
    assert.equal(await runBroadcastScheduler(), 1);
    assert.equal((await api.get(`/api/broadcasts/${b.id}`)).body.status, 'sent');
    assert.equal((await api.post(`/api/broadcasts/${b.id}/unschedule`)).status, 409);
    assert.equal((await api.patch(`/api/broadcasts/${b.id}`, { subject: 'x' })).status, 409);
    assert.equal((await api.post(`/api/broadcasts/${b.id}/schedule`, { scheduled_at: later })).status, 409);
  });

  test('recipients are computed at send time, not when scheduling', async () => {
    const { api } = await account(2, 'r');
    const b = await newBroadcast(api);
    await api.post(`/api/broadcasts/${b.id}/schedule`, { scheduled_at: inMinutes(30) });
    // after scheduling: one more contact, one unsubscribes
    await api.post('/api/contacts', { email: 'late@mail.fr', first_name: 'Late' });
    const r0 = (await api.get('/api/contacts?search=r0@mail.fr')).body.items[0];
    await api.patch(`/api/contacts/${r0.id}`, { unsubscribed: true });

    await makeDue(b.id);
    await new EmailWorker({ throttle: false }).drain();
    const sends = await sendsOf(b.id);
    assert.deepEqual(sends.map((s) => s.to_email).sort(), ['late@mail.fr', 'r1@mail.fr']);
    assert.ok(sends.every((s) => s.status === 'sent'));
    assert.ok(sends.some((s) => s.subject === 'News Late'));
  });

  test('two schedulers (and "send now") never start the same newsletter twice', async () => {
    const { api, userId } = await account(40, 'm');
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const b = await newBroadcast(api, `Multi ${i}`);
      await api.post(`/api/broadcasts/${b.id}/schedule`, { scheduled_at: inMinutes(10) });
      await makeDue(b.id);
      ids.push(b.id);
    }
    const w1 = new EmailWorker({ throttle: false, instanceId: 's1' });
    const w2 = new EmailWorker({ throttle: false, instanceId: 's2' });
    const [a, bb, , , sendNow] = await Promise.all([
      runBroadcastScheduler(),
      runBroadcastScheduler(),
      w1.runSchedulers(),
      w2.runSchedulers(),
      api.post(`/api/broadcasts/${ids[0]}/send`),
    ]);
    assert.ok(a + bb <= 3);
    assert.ok(sendNow.status === 200 || sendNow.status === 409);
    await Promise.all([w1.drain(), w2.drain()]);
    for (const id of ids) {
      const sends = await sendsOf(id);
      assert.equal(sends.length, 40, `newsletter ${id} queued once`);
      assert.equal(new Set(sends.map((s) => s.contact_id)).size, 40);
      assert.ok(sends.every((s) => s.status === 'sent' && s.attempts === 1));
    }
    const events = await db
      .selectFrom('contact_events')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('user_id', '=', userId)
      .where('type', '=', 'email_sent')
      .executeTakeFirstOrThrow();
    assert.equal(events.n, 120);
  });
});

describe('A/B test on the subject', () => {
  test('validation', async () => {
    const { api } = await account(0);
    const b = await newBroadcast(api);
    assert.equal((await api.patch(`/api/broadcasts/${b.id}`, { ab_test: { subjects: [], test_percent: 20, wait_hours: 4 } })).status, 400);
    assert.equal((await api.patch(`/api/broadcasts/${b.id}`, { ab_test: { subjects: ['B', 'C'], test_percent: 40, wait_hours: 4 } })).status, 400);
    assert.equal((await api.patch(`/api/broadcasts/${b.id}`, { ab_test: { subjects: ['B'], test_percent: 2, wait_hours: 4 } })).status, 400);
    const ok = await api.patch(`/api/broadcasts/${b.id}`, { ab_test: { subjects: ['Objet B'] } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.ab_test, { subjects: ['Objet B'], test_percent: 20, wait_hours: 4 });
    assert.equal((await api.patch(`/api/broadcasts/${b.id}`, { ab_test: null })).body.ab_test, null);
  });

  test('test phase split, winner by open rate after the wait, then the rest', async () => {
    const { api } = await account(200, 'ab');
    const b = await newBroadcast(api, 'Objet A');
    await api.patch(`/api/broadcasts/${b.id}`, { ab_test: { subjects: ['Objet B {{first_name}}'], test_percent: 20, wait_hours: 4 } });
    const started = await api.post(`/api/broadcasts/${b.id}/send`);
    assert.equal(started.status, 200);
    assert.equal(started.body.ab.phase, 'testing');
    const decideIn = new Date(started.body.ab.decide_at).getTime() - Date.now();
    assert.ok(Math.abs(decideIn - 4 * 3600_000) < 60_000, `decides in ~4 h (${decideIn})`);

    let sends = await sendsOf(b.id);
    assert.equal(sends.length, 80, '20 % per variant');
    assert.equal(sends.filter((s) => s.variant === 0).length, 40);
    assert.equal(sends.filter((s) => s.variant === 1).length, 40);

    await new EmailWorker({ throttle: false }).drain();
    sends = await sendsOf(b.id);
    assert.ok(sends.filter((s) => s.variant === 1).every((s) => /^Objet B P\d+$/.test(s.subject)), 'variant subject rendered');
    assert.ok(sends.filter((s) => s.variant === 0).every((s) => s.subject === 'Objet A'));
    // the queue job is not "done" while waiting for the winner
    const job = (await api.get('/api/emails/queue')).body.jobs.find((j: { broadcast_id: number }) => j.broadcast_id === b.id);
    assert.equal(job.ab_phase, 'testing');
    assert.equal(job.done, false);

    // variant B opens better
    const open = (variant: number, n: number) =>
      sql`UPDATE email_sends SET opened_at = now() WHERE id IN (
            SELECT id FROM email_sends WHERE broadcast_id = ${b.id} AND variant = ${variant} ORDER BY id LIMIT ${n})`.execute(db);
    await open(0, 8);
    await open(1, 14);
    assert.equal(await decideAbTests(), 0, 'not before the wait is over');
    await db.updateTable('broadcasts').set({ ab_decide_at: sql`now() - interval '1 second'` }).where('id', '=', b.id).execute();
    await new EmailWorker({ throttle: false }).drain();

    sends = await sendsOf(b.id);
    assert.equal(sends.length, 200, 'every recipient exactly once');
    assert.equal(new Set(sends.map((s) => s.contact_id)).size, 200);
    assert.equal(sends.filter((s) => s.variant === 1).length, 160);
    assert.ok(sends.every((s) => s.status === 'sent'));
    const detail = (await api.get(`/api/broadcasts/${b.id}`)).body;
    assert.equal(detail.ab.phase, 'done');
    assert.equal(detail.ab.winner, 1);
    assert.equal(detail.ab.split_only, false);
    assert.equal(detail.ab.variants[0].test_recipients, 40);
    assert.equal(detail.ab.variants[1].test_recipients, 40);
    assert.equal(detail.ab.variants[1].sent, 160);
    assert.equal(detail.ab.variants[0].open_rate, 8 / 40);
    assert.equal(await decideAbTests(), 0, 'decided once');
  });

  test('3 variants, 10 % each; small list → even split without winner phase', async () => {
    const big = await account(150, 'three');
    const b3 = await newBroadcast(big.api, 'A');
    await big.api.patch(`/api/broadcasts/${b3.id}`, { ab_test: { subjects: ['B', 'C'], test_percent: 10, wait_hours: 1 } });
    await big.api.post(`/api/broadcasts/${b3.id}/send`);
    const s3 = await sendsOf(b3.id);
    assert.deepEqual([0, 1, 2].map((v) => s3.filter((s) => s.variant === v).length), [15, 15, 15]);

    const small = await account(AB_MIN_RECIPIENTS - 70, 'small'); // 30 recipients
    const b = await newBroadcast(small.api, 'A');
    await small.api.patch(`/api/broadcasts/${b.id}`, { ab_test: { subjects: ['B'], test_percent: 20, wait_hours: 4 } });
    const started = (await small.api.post(`/api/broadcasts/${b.id}/send`)).body;
    assert.equal(started.ab.phase, 'done');
    assert.equal(started.ab.split_only, true);
    assert.equal(started.ab.winner, null);
    const sends = await sendsOf(b.id);
    assert.equal(sends.length, 30);
    assert.equal(sends.filter((s) => s.variant === 0).length, 15);
    assert.equal(sends.filter((s) => s.variant === 1).length, 15);
  });

  test('A/B + scheduling: the split happens when the scheduled send starts', async () => {
    const { api } = await account(120, 'sab');
    const b = await newBroadcast(api, 'A');
    await api.patch(`/api/broadcasts/${b.id}`, { ab_test: { subjects: ['B'], test_percent: 25, wait_hours: 2 } });
    await api.post(`/api/broadcasts/${b.id}/schedule`, { scheduled_at: inMinutes(60) });
    assert.equal((await api.get('/api/emails/queue')).body.upcoming[0].ab, true);
    await makeDue(b.id);
    await runBroadcastScheduler();
    const sends = await sendsOf(b.id);
    assert.equal(sends.length, 60);
    assert.equal((await api.get(`/api/broadcasts/${b.id}`)).body.ab.phase, 'testing');
  });

  test('winner selection: open rate, then click rate, then first variant', () => {
    assert.equal(pickWinner([{ variant: 0, sent: 10, opened: 3, clicked: 0 }, { variant: 1, sent: 10, opened: 5, clicked: 0 }], 2), 1);
    assert.equal(pickWinner([{ variant: 0, sent: 10, opened: 5, clicked: 1 }, { variant: 1, sent: 10, opened: 5, clicked: 2 }], 2), 1);
    assert.equal(pickWinner([{ variant: 0, sent: 10, opened: 5, clicked: 2 }, { variant: 1, sent: 10, opened: 5, clicked: 2 }], 2), 0);
    assert.equal(pickWinner([], 3), 0);
  });
});
