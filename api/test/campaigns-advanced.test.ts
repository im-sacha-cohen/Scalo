import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db } from '../src/db';
import { BACKFILL_GRACE_S, backfillEmail } from '../src/services/campaigns';
import { EmailWorker } from '../src/worker';
import { client, registerUser, shutdown, startApp, type TestCtx } from './helpers';

let ctx: TestCtx;
before(async () => {
  ctx = await startApp();
});
after(() => shutdown(ctx));

const DAY = 86400_000;
type Api = ReturnType<typeof client>;

async function account() {
  const reg = await registerUser(ctx);
  return { api: client(ctx, reg.token), userId: reg.user.id };
}

async function contact(api: Api, email: string) {
  return (await api.post('/api/contacts', { email, first_name: email.split('@')[0] })).body as { id: number; email: string };
}

/** Enrolls a contact and moves its enrollment (and pending sends) `daysAgo` days in the past. */
async function enrollAt(api: Api, campaignId: number, contactId: number, daysAgo = 0) {
  assert.equal((await api.post(`/api/campaigns/${campaignId}/enroll`, { contact_id: contactId })).status, 200);
  if (daysAgo) {
    const shift = sql`make_interval(days => ${daysAgo})`;
    await db.updateTable('campaign_subscriptions').set({ created_at: sql`created_at - ${shift}` }).where('campaign_id', '=', campaignId).where('contact_id', '=', contactId).execute();
    await db.updateTable('email_sends').set({ send_at: sql`send_at - ${shift}` }).where('campaign_id', '=', campaignId).where('contact_id', '=', contactId).execute();
  }
}

const sendsOf = (campaignId: number, contactId: number) =>
  db
    .selectFrom('email_sends as s')
    .innerJoin('campaign_emails as e', 'e.id', 's.campaign_email_id')
    .select(['s.id', 's.status', 's.send_at', 's.error', 'e.subject', 'e.id as email_id'])
    .where('s.campaign_id', '=', campaignId)
    .where('s.contact_id', '=', contactId)
    .orderBy('e.position')
    .execute();
const drain = () => new EmailWorker({ throttle: false }).drain();
const near = (iso: string, t: number, tol = 60_000) => Math.abs(new Date(iso).getTime() - t) < tol;

describe('campaign backfill', () => {
  test('apply_to_existing true/false, due-date rule, never twice', async () => {
    const { api } = await account();
    const camp = (await api.post('/api/campaigns', { name: 'Seq' })).body;
    await api.post(`/api/campaigns/${camp.id}/emails`, { subject: 'E1', delay_days: 0 });
    const old = await contact(api, 'old@mail.fr'); // enrolled 3 days ago: E1 sent
    const fresh = await contact(api, 'fresh@mail.fr'); // enrolled now
    await enrollAt(api, camp.id, old.id, 3);
    await enrollAt(api, camp.id, fresh.id, 0);
    await drain();

    // E2 due at enrollment + 1 day: past for "old" → sent now; future for "fresh" → at +1 day
    const e2 = await api.post(`/api/campaigns/${camp.id}/emails`, { subject: 'E2', delay_days: 1 });
    assert.equal(e2.status, 201);
    assert.equal(e2.body.backfilled, 2);
    let o = await sendsOf(camp.id, old.id);
    assert.deepEqual(o.map((s) => s.subject), ['E1', 'E2']);
    assert.ok(near(o[1].send_at, Date.now() + BACKFILL_GRACE_S * 1000), 'past due → now (after the editing grace period)');
    let fr = await sendsOf(camp.id, fresh.id);
    assert.ok(near(fr[1].send_at, Date.now() + DAY), 'not reached yet → normal due date');

    // E3 (+1 day, i.e. enrollment + 2 days) with apply_to_existing=false: skipped by "old", kept for "fresh"
    const e3 = await api.post(`/api/campaigns/${camp.id}/emails`, { subject: 'E3', delay_days: 1, apply_to_existing: false });
    assert.equal(e3.body.backfilled, 1);
    o = await sendsOf(camp.id, old.id);
    assert.deepEqual(o.map((s) => s.subject), ['E1', 'E2']);
    fr = await sendsOf(camp.id, fresh.id);
    assert.deepEqual(fr.map((s) => s.subject), ['E1', 'E2', 'E3']);
    assert.ok(near(fr[2].send_at, Date.now() + 2 * DAY));

    // never twice: backfilling again creates nothing, even with apply_to_existing
    assert.equal(await backfillEmail(camp.id, e2.body.id, true), 0);
    await db.updateTable('email_sends').set({ send_at: sql`now()` }).where('campaign_email_id', '=', e2.body.id).where('contact_id', '=', old.id).execute();
    await drain();
    o = await sendsOf(camp.id, old.id);
    assert.equal(o.filter((s) => s.subject === 'E2').length, 1);
    assert.equal(o.find((s) => s.subject === 'E2')!.status, 'sent');
    await assert.rejects(
      db.insertInto('email_sends').values({ user_id: 1, contact_id: old.id, campaign_id: camp.id, campaign_email_id: e2.body.id, kind: 'campaign', to_email: 'old@mail.fr', subject: 'dup' }).execute(),
      /duplicate key|unique/,
    );

    // future subscribers get the whole sequence
    const later = await contact(api, 'later@mail.fr');
    await enrollAt(api, camp.id, later.id);
    assert.deepEqual((await sendsOf(camp.id, later.id)).map((s) => s.subject), ['E1', 'E2', 'E3']);
  });

  test('reorder, delay change and delete reschedule pending emails', async () => {
    const { api } = await account();
    const camp = (await api.post('/api/campaigns', { name: 'Order' })).body;
    const e1 = (await api.post(`/api/campaigns/${camp.id}/emails`, { subject: 'A', delay_days: 0 })).body;
    const e2 = (await api.post(`/api/campaigns/${camp.id}/emails`, { subject: 'B', delay_days: 2 })).body;
    const e3 = (await api.post(`/api/campaigns/${camp.id}/emails`, { subject: 'C', delay_days: 5 })).body;
    const c = await contact(api, 'order@mail.fr');
    await enrollAt(api, camp.id, c.id);
    const t0 = new Date((await db.selectFrom('campaign_subscriptions').select('created_at').where('contact_id', '=', c.id).executeTakeFirstOrThrow()).created_at).getTime();

    const re = await api.post(`/api/campaigns/${camp.id}/emails/reorder`, { ids: [e1.id, e3.id, e2.id] });
    assert.equal(re.status, 200);
    assert.deepEqual(re.body.emails.map((e: { subject: string }) => e.subject), ['A', 'C', 'B']);
    let s = await sendsOf(camp.id, c.id);
    assert.deepEqual(s.map((x) => [x.subject, (new Date(x.send_at).getTime() - t0) / DAY]), [['A', 0], ['C', 5], ['B', 7]]);

    // delay change of the first email shifts everything after it
    await api.patch(`/api/campaign-emails/${e1.id}`, { delay_days: 1 });
    s = await sendsOf(camp.id, c.id);
    assert.deepEqual(s.map((x) => (new Date(x.send_at).getTime() - t0) / DAY), [1, 6, 8]);
    assert.equal((await api.post(`/api/campaigns/${camp.id}/emails/reorder`, { ids: [e1.id, e2.id] })).status, 400);
    // deleting an email: the following ones lose its delay
    await api.del(`/api/campaign-emails/${e3.id}`);
    s = await sendsOf(camp.id, c.id);
    assert.deepEqual(s.map((x) => [x.subject, (new Date(x.send_at).getTime() - t0) / DAY]), [['A', 1], ['B', 3]]);
  });

  test('sequence order: a due email waits while an earlier one is still pending', async () => {
    const { api } = await account();
    const camp = (await api.post('/api/campaigns', { name: 'Wait' })).body;
    await api.post(`/api/campaigns/${camp.id}/emails`, { subject: 'First', delay_days: 0 });
    await api.post(`/api/campaigns/${camp.id}/emails`, { subject: 'Second', delay_days: 0 });
    const c = await contact(api, 'wait@mail.fr');
    await enrollAt(api, camp.id, c.id);
    const [first] = await sendsOf(camp.id, c.id);
    // first email in retry in 10 minutes
    await db.updateTable('email_sends').set({ attempts: 1, send_at: sql`now() + interval '10 minutes'` }).where('id', '=', first.id).execute();
    await drain();
    const s = await sendsOf(camp.id, c.id);
    assert.equal(s[1].status, 'pending', 'second waits for the first');
    assert.ok(new Date(s[1].send_at).getTime() > Date.now() + 9 * 60_000);
  });
});

describe('campaign conditions and stop tag', () => {
  test('skip / stop conditions, evaluated when due', async () => {
    const { api } = await account();
    const vip = (await api.post('/api/tags', { name: 'vip' })).body;
    const camp = (await api.post('/api/campaigns', { name: 'Cond' })).body;
    await api.post(`/api/campaigns/${camp.id}/emails`, { subject: 'Hello', delay_days: 0 });
    const vipOnly = await api.post(`/api/campaigns/${camp.id}/emails`, { subject: 'VIP only', delay_days: 0, condition: { type: 'has_tag', tag_id: vip.id, action: 'skip' } });
    assert.equal(vipOnly.status, 201);
    assert.deepEqual(vipOnly.body.condition, { type: 'has_tag', tag_id: vip.id, action: 'skip' });
    assert.equal((await api.post(`/api/campaigns/${camp.id}/emails`, { subject: 'x', delay_days: 0, condition: { type: 'has_tag', action: 'skip' } })).status, 400);
    // open-based conditions need a delay (evaluated when due, i.e. a day after the previous email)
    await api.post(`/api/campaigns/${camp.id}/emails`, { subject: 'Engaged', delay_days: 1, condition: { type: 'opened_previous', action: 'stop' } });
    await api.post(`/api/campaigns/${camp.id}/emails`, { subject: 'Last', delay_days: 0 });

    const a = await contact(api, 'a@mail.fr'); // no vip, never opens → skip VIP, stop at "Engaged"
    const b = await contact(api, 'b@mail.fr'); // vip, opens everything → all
    await api.post(`/api/contacts/${b.id}/tags`, { name: 'vip' });
    await enrollAt(api, camp.id, a.id);
    await enrollAt(api, camp.id, b.id);

    await drain(); // day 0: Hello (+ VIP only for b)
    assert.deepEqual((await sendsOf(camp.id, a.id)).map((s) => s.status), ['sent', 'skipped', 'pending', 'pending']);
    // b opens what it received; one day later the rest is due
    await db.updateTable('email_sends').set({ opened_at: sql`now()` }).where('contact_id', '=', b.id).where('status', '=', 'sent').execute();
    await db.updateTable('email_sends').set({ send_at: sql`now() - interval '1 second'` }).where('campaign_id', '=', camp.id).where('status', '=', 'pending').execute();
    await drain();

    const sa = await sendsOf(camp.id, a.id);
    assert.deepEqual(sa.map((s) => [s.subject, s.status]), [['Hello', 'sent'], ['VIP only', 'skipped'], ['Engaged', 'skipped'], ['Last', 'skipped']]);
    assert.match(sa[1].error ?? '', /Condition non remplie \(a le tag « vip »\)/);
    assert.match(sa[3].error ?? '', /Séquence arrêtée/);
    const sb = await sendsOf(camp.id, b.id);
    assert.deepEqual(sb.map((s) => s.status), ['sent', 'sent', 'sent', 'sent']);

    const subs = (await api.get(`/api/campaigns/${camp.id}/subscribers`)).body;
    assert.equal(subs.total, 2);
    const byEmail = Object.fromEntries(subs.items.map((s: { email: string }) => [s.email, s]));
    assert.equal(byEmail['a@mail.fr'].status, 'stopped');
    assert.match(byEmail['a@mail.fr'].stopped_reason, /ouvert l’email précédent/);
    assert.equal(byEmail['a@mail.fr'].sent, 1);
    assert.equal(byEmail['b@mail.fr'].status, 'completed');
    assert.equal(byEmail['b@mail.fr'].sent, 4);
    assert.equal(byEmail['b@mail.fr'].total, 4);
    const detail = (await api.get(`/api/campaigns/${camp.id}`)).body;
    assert.equal(detail.emails[1].stats.skipped, 1);
  });

  test('stop when the contact gets the stop tag; unsubscribe from the campaign', async () => {
    const { api } = await account();
    const client_ = (await api.post('/api/tags', { name: 'client' })).body;
    const camp = (await api.post('/api/campaigns', { name: 'Vente', stop_tag_id: client_.id })).body;
    assert.equal(camp.stop_tag_id, client_.id);
    await api.post(`/api/campaigns/${camp.id}/emails`, { subject: 'J0', delay_days: 0 });
    await api.post(`/api/campaigns/${camp.id}/emails`, { subject: 'J2', delay_days: 2 });
    const buyer = await contact(api, 'buyer@mail.fr');
    const quitter = await contact(api, 'quit@mail.fr');
    await enrollAt(api, camp.id, buyer.id);
    await enrollAt(api, camp.id, quitter.id);
    await drain();

    await api.post(`/api/contacts/${buyer.id}/tags`, { name: 'client' });
    let s = await sendsOf(camp.id, buyer.id);
    assert.deepEqual(s.map((x) => x.status), ['sent', 'skipped']);
    assert.match(s[1].error ?? '', /client/);
    // a contact who already has the stop tag is not enrolled
    const already = await contact(api, 'already@mail.fr');
    await api.post(`/api/contacts/${already.id}/tags`, { name: 'client' });
    await api.post(`/api/campaigns/${camp.id}/enroll`, { contact_id: already.id });
    assert.equal((await sendsOf(camp.id, already.id)).length, 0);

    const un = await api.post(`/api/campaigns/${camp.id}/subscribers/${quitter.id}/unsubscribe`);
    assert.equal(un.status, 200);
    s = await sendsOf(camp.id, quitter.id);
    assert.deepEqual(s.map((x) => x.status), ['sent', 'skipped']);
    assert.equal((await api.post(`/api/campaigns/${camp.id}/subscribers/${quitter.id}/unsubscribe`)).status, 409);
    const subs = (await api.get(`/api/campaigns/${camp.id}/subscribers?status=unsubscribed`)).body;
    assert.deepEqual(subs.items.map((x: { email: string }) => x.email), ['quit@mail.fr']);
    const stopped = (await api.get(`/api/campaigns/${camp.id}/subscribers?status=stopped`)).body;
    assert.deepEqual(stopped.items.map((x: { email: string }) => x.email), ['buyer@mail.fr']);
    // paginated
    const page = (await api.get(`/api/campaigns/${camp.id}/subscribers?limit=1&page=2`)).body;
    assert.equal(page.total, 2);
    assert.equal(page.items.length, 1);
    // the event is in the contact's timeline
    const ev = (await api.get(`/api/contacts/${buyer.id}`)).body.events.map((e: { type: string }) => e.type);
    assert.ok(ev.includes('campaign_left'));
  });
});
