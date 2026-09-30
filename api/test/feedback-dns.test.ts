import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db';
import type { DnsResolver } from '../src/services/dns';
import { EmailWorker } from '../src/worker';
import { client, fakeSmtp, http, registerUser, shutdown, startApp, type FakeSmtp, type TestCtx } from './helpers';

// ---------- fakes injected into the app ----------

const fetchCalls: string[] = [];
const fakeFetch = (async (url: string | URL) => {
  fetchCalls.push(String(url));
  return new Response('<ConfirmSubscriptionResponse/>', { status: 200 });
}) as typeof fetch;

/** host → TXT records (or an error code) ; MX under `mx:<host>`. */
const zones = new Map<string, string[][] | { mx: { exchange: string; priority: number }[] } | string>();
const dnsError = (code: string) => Object.assign(new Error(code), { code });
const fakeDns: DnsResolver = {
  async resolveTxt(host) {
    const z = zones.get(host);
    if (typeof z === 'string') throw dnsError(z);
    if (!z || !Array.isArray(z)) throw dnsError('ENOTFOUND');
    return z;
  },
  async resolveMx(host) {
    const z = zones.get(`mx:${host}`);
    if (!z || typeof z === 'string' || Array.isArray(z)) throw dnsError('ENODATA');
    return z.mx;
  },
};

let ctx: TestCtx;
let smtp: FakeSmtp;
before(async () => {
  ctx = await startApp({ dns: fakeDns, fetch: fakeFetch });
  smtp = await fakeSmtp();
});
after(async () => {
  await smtp.close();
  await shutdown(ctx);
});

async function account() {
  const reg = await registerUser(ctx);
  const api = client(ctx, reg.token);
  const settings = (await api.get('/api/settings')).body;
  assert.match(settings.webhook_secret, /^[\w-]{20,}$/);
  const rawHook = async (provider: string, body: string, contentType: string) => {
    const res = await fetch(`${ctx.base}/api/webhooks/email/${provider}/${settings.webhook_secret}`, { method: 'POST', headers: { 'content-type': contentType }, body });
    return { status: res.status, body: (await res.json()) as any };
  };
  const jsonHook = (provider: string, body: unknown) => rawHook(provider, JSON.stringify(body), 'application/json');
  return { api, userId: reg.user.id, secret: settings.webhook_secret as string, rawHook, jsonHook };
}

async function withSentEmail(api: ReturnType<typeof client>, emails: string[]) {
  const csv = `email\n${emails.join('\n')}\n`;
  await api.post('/api/contacts/import', { csv });
  const b = (await api.post('/api/broadcasts', { subject: 'Hello' })).body;
  await api.post(`/api/broadcasts/${b.id}/send`);
  await new EmailWorker({ throttle: false }).drain();
  return b.id as number;
}

const contactOf = async (api: ReturnType<typeof client>, email: string) => {
  const c = (await api.get(`/api/contacts?search=${encodeURIComponent(email)}`)).body.items[0];
  return (await api.get(`/api/contacts/${c.id}`)).body;
};

describe('complaint & bounce webhooks', () => {
  test('bad secret / unknown provider → 404; generic complaint and bounce', async () => {
    const { api, secret, jsonHook } = await account();
    assert.equal((await http(ctx, 'POST', '/api/webhooks/email/generic/not-the-secret-xxxxxxxxxxx', { json: { type: 'complaint', email: 'a@b.fr' } })).status, 404);
    assert.equal((await http(ctx, 'POST', `/api/webhooks/email/sendgrid/${secret}`, { json: {} })).status, 404);
    assert.equal((await http(ctx, 'POST', `/api/webhooks/email/generic/${secret}`, { json: { type: 'open', email: 'x@y.fr' } })).status, 400);

    await withSentEmail(api, ['spam@mail.fr', 'gone@mail.fr', 'fine@mail.fr']);
    // a pending campaign email for the complainer must be cancelled
    const camp = (await api.post('/api/campaigns', { name: 'C' })).body;
    await api.post(`/api/campaigns/${camp.id}/emails`, { subject: 'Later', delay_days: 3 });
    const spam0 = await contactOf(api, 'spam@mail.fr');
    await api.post(`/api/campaigns/${camp.id}/enroll`, { contact_id: spam0.id });

    const r = await jsonHook('generic', [{ type: 'complaint', email: 'SPAM@mail.fr' }, { type: 'bounce', email: 'gone@mail.fr' }, { type: 'complaint', email: 'nobody@mail.fr' }]);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.results, ['complaint', 'bounce', 'unknown']);
    const spam = await contactOf(api, 'spam@mail.fr');
    assert.equal(spam.unsubscribed, 1);
    assert.equal(spam.complained, 1);
    assert.ok(spam.events.some((e: { type: string; data: { source: string } }) => e.type === 'spam_complaint' && e.data.source === 'generic'));
    const pending = await db.selectFrom('email_sends').select(['status', 'error']).where('campaign_id', '=', camp.id).executeTakeFirstOrThrow();
    assert.equal(pending.status, 'failed');
    assert.equal(pending.error, 'unsubscribed');
    const complainedSend = await db.selectFrom('email_sends').select('complained_at').where('contact_id', '=', spam.id).where('status', '=', 'sent').executeTakeFirstOrThrow();
    assert.ok(complainedSend.complained_at, 'complaint attributed to the last email sent');
    const gone = await contactOf(api, 'gone@mail.fr');
    assert.equal(gone.bounced, 1);
    assert.ok(gone.events.some((e: { type: string }) => e.type === 'bounced'));
    // replay → duplicate, nothing twice
    assert.deepEqual((await jsonHook('generic', { type: 'complaint', email: 'spam@mail.fr' })).body.results, ['duplicate']);

    const q = (await api.get('/api/emails/queue')).body;
    assert.equal(q.complaints.complaints_30d, 1);
    assert.equal(q.complaints.sent_30d, 3);
    assert.ok(Math.abs(q.complaints.rate_30d - 1 / 3) < 1e-9);
    assert.equal(q.state, 'idle', 'no auto-pause under 100 sends');
  });

  test('Amazon SES via SNS: subscription confirmation (only amazonaws URLs), complaint, permanent bounce', async () => {
    const { api, rawHook } = await account();
    await withSentEmail(api, ['ses-spam@mail.fr', 'ses-bounce@mail.fr', 'ses-soft@mail.fr']);

    const bad = await rawHook('ses', JSON.stringify({ Type: 'SubscriptionConfirmation', SubscribeURL: 'https://evil.example.com/confirm?x=sns.amazonaws.com' }), 'text/plain; charset=UTF-8');
    assert.equal(bad.status, 400);
    const bad2 = await rawHook('ses', JSON.stringify({ Type: 'SubscriptionConfirmation', SubscribeURL: 'http://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription' }), 'text/plain');
    assert.equal(bad2.status, 400, 'http refused');
    const bad3 = await rawHook('ses', JSON.stringify({ Type: 'SubscriptionConfirmation', SubscribeURL: 'https://sns.eu-west-1.amazonaws.com.evil.io/' }), 'text/plain');
    assert.equal(bad3.status, 400);
    assert.equal(fetchCalls.length, 0, 'never fetched');
    const url = 'https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=arn:aws:sns:eu-west-1:123:ses&Token=abc';
    const ok = await rawHook('ses', JSON.stringify({ Type: 'SubscriptionConfirmation', SubscribeURL: url }), 'text/plain');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.subscribed, true);
    assert.deepEqual(fetchCalls, [url]);

    const notif = (message: unknown) => rawHook('ses', JSON.stringify({ Type: 'Notification', MessageId: 'x', Message: JSON.stringify(message) }), 'text/plain');
    const complaint = await notif({ notificationType: 'Complaint', complaint: { complainedRecipients: [{ emailAddress: 'ses-spam@mail.fr' }] }, mail: { messageId: 'ses-1' } });
    assert.deepEqual(complaint.body.results, ['complaint']);
    const bounce = await notif({ notificationType: 'Bounce', bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'ses-bounce@mail.fr' }] }, mail: {} });
    assert.deepEqual(bounce.body.results, ['bounce']);
    const soft = await notif({ notificationType: 'Bounce', bounce: { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: 'ses-soft@mail.fr' }] }, mail: {} });
    assert.deepEqual(soft.body.results, []);
    assert.equal((await contactOf(api, 'ses-spam@mail.fr')).complained, 1);
    assert.equal((await contactOf(api, 'ses-bounce@mail.fr')).bounced, 1);
    assert.equal((await contactOf(api, 'ses-soft@mail.fr')).bounced, 0);
    assert.equal((await rawHook('ses', 'not json', 'text/plain')).status, 400);
  });

  test('Postmark (matched by Message-ID), Mailgun, Brevo; Feedback-ID header', async () => {
    const { api, userId, jsonHook } = await account();
    await api.put('/api/settings', { smtp_host: '127.0.0.1', smtp_port: smtp.port, smtp_user: 'good', smtp_pass: 'pw', sender_email: 'me@mail.fr' });
    const bid = await withSentEmail(api, ['pm@mail.fr', 'pm-bounce@mail.fr', 'mg@mail.fr', 'br@mail.fr']);
    const msg = smtp.messages.find((m) => m.to.includes('pm@mail.fr'))!;
    assert.match(msg.data, new RegExp(`Feedback-ID: b${bid}:${userId}:broadcast:scalo`));
    assert.match(msg.data, /List-Unsubscribe:\s+</);
    const send = await db.selectFrom('email_sends').select(['id', 'message_id']).where('to_email', '=', 'pm@mail.fr').executeTakeFirstOrThrow();
    assert.ok(send.message_id, 'SMTP message id stored');

    // Postmark: the address in the payload differs, the Message-ID identifies the send
    const pm = await jsonHook('postmark', { RecordType: 'SpamComplaint', Type: 'SpamComplaint', Email: 'alias@other.fr', MessageID: `<${send.message_id}>` });
    assert.deepEqual(pm.body.results, ['complaint']);
    assert.ok((await db.selectFrom('email_sends').select('complained_at').where('id', '=', send.id).executeTakeFirstOrThrow()).complained_at);
    assert.equal((await contactOf(api, 'pm@mail.fr')).complained, 1);
    assert.deepEqual((await jsonHook('postmark', { RecordType: 'Bounce', Type: 'HardBounce', Email: 'pm-bounce@mail.fr' })).body.results, ['bounce']);
    assert.deepEqual((await jsonHook('postmark', { RecordType: 'Bounce', Type: 'SoftBounce', Email: 'mg@mail.fr' })).body.results, []);

    const mg = await jsonHook('mailgun', { signature: {}, 'event-data': { event: 'complained', recipient: 'mg@mail.fr', message: { headers: {} } } });
    assert.deepEqual(mg.body.results, ['complaint']);
    const br = await jsonHook('brevo', { event: 'hard_bounce', email: 'br@mail.fr', 'message-id': '<x@y>' });
    assert.deepEqual(br.body.results, ['bounce']);
  });

  test('auto-pause when complaints exceed 0.3 % of the last 1000 sends', async () => {
    const run = async (sends: number, complaints: number) => {
      const { api, userId, jsonHook } = await account();
      const emails = Array.from({ length: complaints }, (_, i) => `c${i}@mail.fr`);
      await withSentEmail(api, emails);
      // bulk history of delivered emails
      const now = new Date().toISOString();
      await db
        .insertInto('email_sends')
        .values(Array.from({ length: sends - complaints }, () => ({ user_id: userId, kind: 'campaign' as const, to_email: 'x@mail.fr', subject: 's', status: 'sent' as const, sent_at: now })))
        .execute();
      for (const e of emails) await jsonHook('generic', { type: 'complaint', email: e });
      return (await api.get('/api/emails/queue')).body;
    };
    const below = await run(400, 1); // 0.25 %
    assert.equal(below.state, 'idle');
    assert.equal(below.complaints.window_sends, 400);

    const above = await run(300, 1); // 0.33 %
    assert.equal(above.state, 'paused');
    assert.match(above.paused_reason, /plaintes pour spam.*0,33 %.*300 derniers envois/);
    assert.ok(above.complaints.window_rate > 0.003);
  });
});

describe('sender domain DNS check', () => {
  test('all good', async () => {
    const { api } = await account();
    zones.set('bon.fr', [['v=spf1 include:_spf.google.com ~all'], ['google-site-verification=xyz']]);
    zones.set('google._domainkey.bon.fr', [['v=DKIM1; k=rsa; ', 'p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA']]);
    zones.set('_dmarc.bon.fr', [['v=DMARC1; p=quarantine; rua=mailto:d@bon.fr']]);
    zones.set('mx:bon.fr', { mx: [{ exchange: 'aspmx.l.google.com', priority: 1 }] });
    await api.put('/api/settings', { sender_email: 'hello@bon.fr', smtp_host: 'smtp.gmail.com' });
    const r = await api.post('/api/settings/dns-check', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.domain, 'bon.fr');
    assert.equal(r.body.provider, 'google');
    assert.equal(r.body.ok, true);
    const by = Object.fromEntries(r.body.records.map((x: { kind: string }) => [x.kind, x]));
    assert.deepEqual([by.spf.status, by.dkim.status, by.dmarc.status, by.mx.status], ['ok', 'ok', 'ok', 'ok']);
    assert.equal(by.dkim.selector, 'google');
  });

  test('missing records → recommended values', async () => {
    const { api } = await account();
    await api.put('/api/settings', { smtp_host: 'smtp-relay.brevo.com' });
    const r = await api.post('/api/settings/dns-check', { domain: 'Vide.FR' });
    assert.equal(r.body.domain, 'vide.fr');
    assert.equal(r.body.provider, 'brevo');
    assert.equal(r.body.ok, false);
    const by = Object.fromEntries(r.body.records.map((x: { kind: string }) => [x.kind, x]));
    assert.equal(by.spf.status, 'missing');
    assert.equal(by.spf.recommended.value, 'v=spf1 include:spf.brevo.com ~all');
    assert.equal(by.dkim.status, 'missing');
    assert.equal(by.dmarc.status, 'missing');
    assert.match(by.dmarc.recommended.value, /^v=DMARC1; p=none/);
    assert.equal(by.mx.status, 'warning');
  });

  test('warnings: several SPF, +all, DMARC p=none, provider not in SPF, custom selector, DNS errors', async () => {
    const { api } = await account();
    zones.set('multi.fr', [['v=spf1 include:a.com ~all'], ['v=spf1 include:b.com -all']]);
    zones.set('_dmarc.multi.fr', [['v=DMARC1; p=none']]);
    zones.set('perso2024._domainkey.multi.fr', [['v=DKIM1; p=MIGf']]);
    let r = await api.post('/api/settings/dns-check', { domain: 'multi.fr', selectors: 'perso2024' });
    let by = Object.fromEntries(r.body.records.map((x: { kind: string }) => [x.kind, x]));
    assert.equal(by.spf.status, 'warning');
    assert.match(by.spf.message, /Plusieurs enregistrements SPF/);
    assert.equal(by.spf.recommended.value, 'v=spf1 include:a.com include:b.com -all');
    assert.equal(by.dmarc.status, 'warning');
    assert.match(by.dmarc.message, /p=none/);
    assert.equal(by.dkim.status, 'ok');
    assert.equal(by.dkim.selector, 'perso2024');
    assert.ok(r.body.selectors.includes('perso2024') && r.body.selectors.includes('selector1'));

    zones.set('open.fr', [['v=spf1 +all']]);
    zones.set('_dmarc.open.fr', 'ETIMEOUT');
    await api.put('/api/settings', { smtp_host: 'smtp.mailgun.org', dkim_selectors: 'mg, sel@ctor!, k1' });
    assert.equal((await api.get('/api/settings')).body.dkim_selectors, 'mg, k1');
    r = await api.post('/api/settings/dns-check', { domain: 'open.fr' });
    by = Object.fromEntries(r.body.records.map((x: { kind: string }) => [x.kind, x]));
    assert.match(by.spf.message, /\+all/);
    assert.equal(by.spf.recommended.value, 'v=spf1 ~all');
    assert.equal(by.dmarc.status, 'warning');
    assert.match(by.dmarc.message, /pas répondu à temps/);

    zones.set('nomg.fr', [['v=spf1 include:_spf.google.com ~all']]);
    r = await api.post('/api/settings/dns-check', { domain: 'nomg.fr' });
    by = Object.fromEntries(r.body.records.map((x: { kind: string }) => [x.kind, x]));
    assert.equal(by.spf.status, 'warning');
    assert.match(by.spf.message, /include:mailgun\.org/);
  });

  test('domain validation (no IPs, no junk) and missing sender', async () => {
    const { api } = await account();
    await api.put('/api/settings', { sender_email: '' });
    assert.equal((await api.post('/api/settings/dns-check', {})).status, 400);
    for (const d of ['127.0.0.1', 'localhost', 'http://exemple.fr', 'a..b.fr', '-x.fr', 'x'.repeat(64) + '.fr', 'exemple.fr/../x']) {
      const r = await api.post('/api/settings/dns-check', { domain: d });
      assert.equal(r.status, 400, d);
    }
  });
});

describe('settings', () => {
  test('webhook secret rotation', async () => {
    const { api, secret, jsonHook } = await account();
    const rotated = (await api.post('/api/settings/webhook-secret')).body;
    assert.notEqual(rotated.webhook_secret, secret);
    assert.match(rotated.webhook_base_url, /\/api\/webhooks\/email$/);
    assert.equal((await jsonHook('generic', { type: 'bounce', email: 'x@y.fr' })).status, 404, 'old URL stops working');
    assert.equal((await http(ctx, 'POST', `/api/webhooks/email/generic/${rotated.webhook_secret}`, { json: { type: 'bounce', email: 'x@y.fr' } })).status, 200);
  });
});
