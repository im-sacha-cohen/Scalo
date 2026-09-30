import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db';
import { client, http, registerUser, shutdown, startApp, type TestCtx } from './helpers';

let ctx: TestCtx;
before(async () => {
  ctx = await startApp();
});
after(() => shutdown(ctx));

const formPage = (opts: { tagName?: string; campaignId?: number } = {}) => ({
  settings: {},
  blocks: [
    { id: 'h1', type: 'heading', level: 1, text: 'Bonjour {{first_name}}' },
    {
      id: 'form1',
      type: 'form',
      fields: [{ name: 'email', label: 'Email', required: true }, { name: 'first_name', label: 'Prénom' }],
      submitLabel: 'Go',
      ...opts,
    },
  ],
});

describe('funnels & steps', () => {
  test('CRUD, templates, slugs, reorder, duplicate', async () => {
    const api = client(ctx, (await registerUser(ctx)).token);
    const f = await api.post('/api/funnels', { name: 'Mon Funnel', template: 'sales' });
    assert.equal(f.status, 201);
    assert.equal(f.body.slug, 'mon-funnel');
    assert.equal(f.body.steps.length, 3);
    assert.deepEqual(f.body.steps.map((s: { position: number }) => s.position), [0, 1, 2]);
    assert.equal(f.body.steps[0].access.mode, 'public');
    assert.equal(typeof f.body.steps[0].content.blocks, 'object');
    assert.match(f.body.steps[0].preview_url, /^\/p\/mon-funnel\/inscription\?preview=/);

    const f2 = await api.post('/api/funnels', { name: 'Mon funnel', template: 'blank' });
    assert.equal(f2.body.slug, 'mon-funnel-2');
    assert.equal((await api.patch(`/api/funnels/${f2.body.id}`, { slug: 'mon-funnel' })).status, 409);
    const renamed = await api.patch(`/api/funnels/${f2.body.id}`, { slug: 'Autre Slug', name: 'Autre' });
    assert.equal(renamed.body.slug, 'autre-slug');

    const list = await api.get('/api/funnels');
    assert.equal(list.body.length, 2);
    assert.equal(list.body.find((x: { id: number }) => x.id === f.body.id).steps_count, 3);

    const added = await api.post(`/api/funnels/${f.body.id}/steps`, { name: 'Bonus', type: 'custom' });
    assert.equal(added.status, 201);
    assert.equal(added.body.position, 3);
    assert.equal(added.body.views, 0);

    const ids = [...f.body.steps.map((s: { id: number }) => s.id), added.body.id].reverse();
    const re = await api.post(`/api/funnels/${f.body.id}/steps/reorder`, { ids });
    assert.deepEqual(re.body.map((s: { id: number }) => s.id), ids);
    assert.equal((await api.post(`/api/funnels/${f.body.id}/steps/reorder`, { ids: ids.slice(1) })).status, 400);

    // step slug unique within the funnel
    const [s0, s1] = re.body;
    assert.equal((await api.patch(`/api/steps/${s0.id}`, { slug: s1.slug })).status, 409);
    const content = formPage();
    const saved = await api.patch(`/api/steps/${s0.id}`, { name: 'Première', content });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.name, 'Première');
    assert.deepEqual((await api.get(`/api/steps/${s0.id}`)).body.content, content);

    const del = await api.del(`/api/steps/${s1.id}`);
    assert.equal(del.status, 200);
    const after = await api.get(`/api/funnels/${f.body.id}`);
    assert.deepEqual(after.body.steps.map((s: { position: number }) => s.position), [0, 1, 2]);

    const dup = await api.post(`/api/funnels/${f.body.id}/duplicate`);
    assert.equal(dup.status, 201);
    assert.equal(dup.body.slug, 'mon-funnel-copie');
    assert.equal(dup.body.steps.length, 3);
    assert.deepEqual(dup.body.steps[0].content, content);

    // tenant isolation
    const other = client(ctx, (await registerUser(ctx)).token);
    assert.equal((await other.get(`/api/funnels/${f.body.id}`)).status, 404);
    assert.equal((await other.patch(`/api/steps/${s0.id}`, { name: 'x' })).status, 404);

    assert.equal((await api.del(`/api/funnels/${dup.body.id}`)).status, 200);
    assert.equal((await api.get(`/api/funnels/${dup.body.id}`)).status, 404);
  });
});

describe('public pages', () => {
  test('render, unique views, form submit → contact + tag + campaign + 303', async () => {
    const api = client(ctx, (await registerUser(ctx)).token);
    const tag = (await api.post('/api/tags', { name: 'lead' })).body;
    const camp = (await api.post('/api/campaigns', { name: 'Welcome' })).body;
    await api.post(`/api/campaigns/${camp.id}/emails`, { subject: 'Hi {{first_name}}', delay_days: 0 });
    await api.post(`/api/campaigns/${camp.id}/emails`, { subject: 'Day 2', delay_days: 2 });
    const f = (await api.post('/api/funnels', { name: 'Guide gratuit', template: 'optin' })).body;
    const [optin, merci] = f.steps;
    await api.patch(`/api/steps/${optin.id}`, { content: formPage({ tagName: 'lead', campaignId: camp.id }) });

    const redirect = await http(ctx, 'GET', '/p/guide-gratuit');
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), '/p/guide-gratuit/inscription');

    const page = await http(ctx, 'GET', '/p/guide-gratuit/inscription');
    assert.equal(page.status, 200);
    assert.match(page.text, /action="\/p\/guide-gratuit\/inscription\/submit"/);
    const vid = page.cookies.scalo_vid;
    assert.ok(vid);
    await http(ctx, 'GET', '/p/guide-gratuit/inscription', { cookies: { scalo_vid: vid } }); // same visitor: 1 view
    await http(ctx, 'GET', '/p/guide-gratuit/inscription?preview=1'); // preview: not counted
    assert.equal((await api.get(`/api/steps/${optin.id}`)).body.views, 1);
    assert.equal((await http(ctx, 'GET', '/p/guide-gratuit/nope')).status, 404);

    const bad = await http(ctx, 'POST', '/p/guide-gratuit/inscription/submit', { form: { email: 'nope' } });
    assert.equal(bad.status, 303);
    assert.equal(bad.headers.get('location'), '/p/guide-gratuit/inscription?error=email');

    const sub = await http(ctx, 'POST', '/p/guide-gratuit/inscription/submit', {
      form: { email: 'Visitor@Mail.fr', first_name: 'Vic', _block: 'form1' },
    });
    assert.equal(sub.status, 303);
    assert.equal(sub.headers.get('location'), '/p/guide-gratuit/merci');
    assert.ok(sub.cookies.scalo_cid);

    const contacts = await api.get('/api/contacts');
    assert.equal(contacts.body.total, 1);
    const c = contacts.body.items[0];
    assert.equal(c.email, 'visitor@mail.fr');
    assert.deepEqual(c.tags.map((t: { id: number }) => t.id), [tag.id]);
    const campaign = (await api.get(`/api/campaigns/${camp.id}`)).body;
    assert.equal(campaign.subscribers, 1);
    const sends = await db.selectFrom('email_sends').select(['send_at', 'created_at']).where('contact_id', '=', c.id).orderBy('send_at').execute();
    assert.equal(sends.length, 2);
    assert.equal(new Date(sends[1].send_at).getTime() - new Date(sends[0].send_at).getTime(), 2 * 86400_000);
    const optinStats = (await api.get(`/api/steps/${optin.id}`)).body;
    assert.equal(optinStats.optins, 1);
    assert.equal((await api.get(`/api/funnels/${f.id}`)).body.optins, 1);

    // personalised with the contact cookie
    const thanks = await http(ctx, 'GET', '/p/guide-gratuit/inscription?preview=1', { cookies: { scalo_cid: sub.cookies.scalo_cid } });
    assert.match(thanks.text, /Bonjour Vic/);

    // resubmitting: same contact, no second enrollment
    await http(ctx, 'POST', '/p/guide-gratuit/inscription/submit', { form: { email: 'visitor@mail.fr', _block: 'form1' } });
    assert.equal((await api.get('/api/contacts')).body.total, 1);
    assert.equal((await db.selectFrom('email_sends').select('id').where('contact_id', '=', c.id).execute()).length, 2);
    assert.equal(merci.slug, 'merci');
  });

  test('step access: funnel / tag / password, owner preview token, fake preview denied', async () => {
    const api = client(ctx, (await registerUser(ctx)).token);
    const f = (await api.post('/api/funnels', { name: 'Acces', template: 'sales' })).body;
    const [s1, s2, s3] = f.steps; // inscription, offre, merci
    await api.patch(`/api/steps/${s1.id}`, { content: formPage() });
    const vip = (await api.post('/api/tags', { name: 'vip' })).body;

    // --- funnel mode
    const p2 = await api.patch(`/api/steps/${s2.id}`, { access: { mode: 'funnel' } });
    assert.equal(p2.body.access.mode, 'funnel');
    const denied = await http(ctx, 'GET', `/p/acces/${s2.slug}`);
    assert.equal(denied.status, 302);
    assert.equal(denied.headers.get('location'), `/p/acces/${s1.slug}`);
    assert.equal(denied.headers.get('x-robots-tag'), 'noindex, nofollow');
    const fake = await http(ctx, 'GET', `/p/acces/${s2.slug}?preview=1`);
    assert.equal(fake.status, 302, '?preview=1 must not bypass access rules');
    const owner = await http(ctx, 'GET', p2.body.preview_url);
    assert.equal(owner.status, 200, 'signed owner preview bypasses access rules');
    const tampered = await http(ctx, 'GET', p2.body.preview_url.replace(/.$/, (ch: string) => (ch === 'a' ? 'b' : 'a')));
    assert.equal(tampered.status, 302);

    const sub = await http(ctx, 'POST', `/p/acces/${s1.slug}/submit`, { form: { email: 'fan@mail.fr' } });
    const cid = sub.cookies.scalo_cid;
    assert.equal((await http(ctx, 'GET', `/p/acces/${s2.slug}`, { cookies: { scalo_cid: cid } })).status, 200);
    assert.equal((await http(ctx, 'GET', `/p/acces/${s2.slug}`, { cookies: { scalo_cid: `${cid}x` } })).status, 302);

    // --- tag mode (redirect: previous public step)
    await api.patch(`/api/steps/${s3.id}`, { access: { mode: 'tag', tag_id: vip.id, redirect: 'previous' } });
    const noTag = await http(ctx, 'GET', `/p/acces/${s3.slug}`, { cookies: { scalo_cid: cid } });
    assert.equal(noTag.status, 302);
    assert.equal(noTag.headers.get('location'), `/p/acces/${s1.slug}`); // s2 is protected, so s1
    const contact = (await api.get('/api/contacts')).body.items[0];
    await api.post(`/api/contacts/${contact.id}/tags`, { name: 'vip' });
    assert.equal((await http(ctx, 'GET', `/p/acces/${s3.slug}`, { cookies: { scalo_cid: cid } })).status, 200);
    assert.equal((await api.patch(`/api/steps/${s3.id}`, { access: { mode: 'tag' } })).status, 400);

    // --- password mode
    assert.equal((await api.patch(`/api/steps/${s2.id}`, { access: { mode: 'password' } })).status, 400);
    const pw = await api.patch(`/api/steps/${s2.id}`, { access: { mode: 'password', password: 'sesame' } });
    assert.equal(pw.body.access.password_set, true);
    assert.equal((await http(ctx, 'GET', `/p/acces/${s2.slug}`)).status, 401);
    const wrong = await http(ctx, 'POST', `/p/acces/${s2.slug}/unlock`, { form: { password: 'nope' } });
    assert.equal(wrong.status, 303);
    assert.match(wrong.headers.get('location') ?? '', /error=pw/);
    const right = await http(ctx, 'POST', `/p/acces/${s2.slug}/unlock`, { form: { password: 'sesame' } });
    assert.equal(right.status, 303);
    const pwCookie = Object.entries(right.cookies).find(([k]) => k.startsWith('scalo_pw_'));
    assert.ok(pwCookie);
    assert.equal((await http(ctx, 'GET', `/p/acces/${s2.slug}`, { cookies: { [pwCookie[0]]: pwCookie[1] } })).status, 200);

    // brute-force protection (DB-backed): 10 attempts / 15 min per IP and step, then 429 + Retry-After
    for (let i = 0; i < 8; i++) assert.equal((await http(ctx, 'POST', `/p/acces/${s2.slug}/unlock`, { form: { password: `guess${i}` } })).status, 303);
    const limited = await http(ctx, 'POST', `/p/acces/${s2.slug}/unlock`, { form: { password: 'sesame' } });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    const counter = await db.selectFrom('auth_attempts').selectAll().where('key', 'like', `step:${s2.id}:%`).executeTakeFirstOrThrow();
    assert.equal(counter.count, 11);

    // protected form refuses unauthorized submissions
    await api.patch(`/api/steps/${s2.id}`, { content: formPage() });
    const blocked = await http(ctx, 'POST', `/p/acces/${s2.slug}/submit`, { form: { email: 'intruder@mail.fr' } });
    assert.equal(blocked.status, 303);
    assert.equal(blocked.headers.get('location'), `/p/acces/${s2.slug}`);
    assert.equal((await api.get('/api/contacts?search=intruder')).body.total, 0);
  });
});
