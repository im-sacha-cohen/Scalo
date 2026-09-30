import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db';
import { pickArm, twoProportionPValue } from '../src/services/ab';
import { client, http, registerUser, shutdown, startApp, type TestCtx } from './helpers';

let ctx: TestCtx;
before(async () => {
  ctx = await startApp();
});
after(() => shutdown(ctx));

const page = (title: string, form?: { id: string; tagName?: string }) => ({
  settings: {},
  blocks: [
    { id: 'h', type: 'heading', level: 1, text: title },
    ...(form ? [{ id: form.id, type: 'form', fields: [{ name: 'email', label: 'Email', required: true }], submitLabel: 'Go', tagName: form.tagName }] : []),
  ],
});

async function setup(template: 'optin' | 'sales' = 'optin') {
  const user = await registerUser(ctx);
  const api = client(ctx, user.token);
  const f = (await api.post('/api/funnels', { name: `Growth ${Math.random().toString(36).slice(2, 7)}`, template })).body;
  await api.patch(`/api/steps/${f.steps[0].id}`, { content: page('Original', { id: 'fa', tagName: 'tag-a' }) });
  return { api, user, f, s1: f.steps[0], s2: f.steps[1] };
}

const view = (path: string, cookies?: Record<string, string>) => http(ctx, 'GET', path, { cookies });
const submit = (path: string, form: Record<string, string>, cookies?: Record<string, string>) => http(ctx, 'POST', `${path}/submit`, { form, cookies });

describe('A/B tests of pages', () => {
  test('pickArm / z-test helpers', () => {
    assert.equal(pickArm([{ id: 0, weight: 100 }, { id: 5, weight: 0 }], () => 0.99), 0);
    assert.equal(pickArm([{ id: 0, weight: 0 }, { id: 5, weight: 100 }], () => 0.01), 5);
    assert.equal(pickArm([{ id: 0, weight: 50 }, { id: 5, weight: 50 }], () => 0.75), 5);
    assert.equal(pickArm([{ id: 0, weight: 0 }, { id: 5, weight: 0 }], () => 0.6), 5, 'all zero: even split');
    assert.equal(twoProportionPValue(0, 0, 1, 10), null);
    const p = twoProportionPValue(100, 1000, 150, 1000)!;
    assert.ok(p > 0 && p < 0.01, String(p));
    assert.ok(twoProportionPValue(10, 100, 11, 100)! > 0.5);
  });

  test('variants, split, sticky assignment, attribution of views and optins, owner preview, winner', async () => {
    const { api, f, s1 } = await setup();
    const path = `/p/${f.slug}/${s1.slug}`;
    const v = await api.post(`/api/steps/${s1.id}/variants`, {});
    assert.equal(v.status, 201);
    assert.equal(v.body.name, 'Variante B');
    assert.deepEqual(v.body.content, page('Original', { id: 'fa', tagName: 'tag-a' }), 'copy of the page');
    await api.patch(`/api/variants/${v.body.id}`, { content: page('Variante B', { id: 'fb', tagName: 'tag-b' }), weight: 50 });
    assert.equal((await api.get(`/api/variants/${v.body.id}`)).body.content.blocks[0].text, 'Variante B');
    // other accounts cannot touch it
    const other = client(ctx, (await registerUser(ctx)).token);
    assert.equal((await other.get(`/api/variants/${v.body.id}`)).status, 404);
    assert.equal((await other.patch(`/api/steps/${s1.id}/ab`, { status: 'running' })).status, 404);

    // not running: everyone sees the original, nothing attributed
    let r = await view(path);
    assert.match(r.text, /Original/);
    assert.equal(r.cookies[`scalo_ab_${s1.id}`], undefined);

    const started = await api.patch(`/api/steps/${s1.id}/ab`, { status: 'running', control_weight: 50 });
    assert.equal(started.body.status, 'running');
    assert.ok(started.body.started_at);

    // 40 new visitors: both arms served, cookie sticky
    const seen = { orig: 0, b: 0 };
    let bVisitor: Record<string, string> | null = null;
    let oVisitor: Record<string, string> | null = null;
    for (let i = 0; i < 40; i++) {
      r = await view(path);
      const arm = r.cookies[`scalo_ab_${s1.id}`];
      assert.ok(arm === '0' || arm === String(v.body.id));
      const isB = arm !== '0';
      assert.match(r.text, isB ? /Variante B/ : /Original/);
      if (isB) seen.b++;
      else seen.orig++;
      const cookies = { scalo_vid: r.cookies.scalo_vid!, [`scalo_ab_${s1.id}`]: arm! };
      if (isB && !bVisitor) bVisitor = cookies;
      if (!isB && !oVisitor) oVisitor = cookies;
    }
    assert.ok(seen.orig > 3 && seen.b > 3, JSON.stringify(seen));
    // sticky: same visitor sees the same arm again, counted once
    const again = await view(path, bVisitor!);
    assert.match(again.text, /Variante B/);
    assert.equal(again.cookies[`scalo_ab_${s1.id}`], undefined);

    // optins attributed to the arm; the form config (tag) is the variant's
    await submit(path, { email: 'b@ab.fr', _block: 'fb' }, bVisitor!);
    await submit(path, { email: 'o@ab.fr', _block: 'fa' }, oVisitor!);
    const cb = (await api.get('/api/contacts?search=b@ab.fr')).body.items[0];
    assert.deepEqual(cb.tags.map((t: { name: string }) => t.name), ['tag-b']);
    const co = (await api.get('/api/contacts?search=o@ab.fr')).body.items[0];
    assert.deepEqual(co.tags.map((t: { name: string }) => t.name), ['tag-a']);

    const stats = (await api.get(`/api/steps/${s1.id}/ab`)).body;
    const orig = stats.arms.find((a: { variant_id: number }) => a.variant_id === 0);
    const armB = stats.arms.find((a: { variant_id: number }) => a.variant_id === v.body.id);
    assert.equal(orig.visitors, seen.orig);
    assert.equal(armB.visitors, seen.b);
    assert.equal(orig.optins, 1);
    assert.equal(armB.optins, 1);
    assert.ok(Math.abs(armB.rate - 1 / seen.b) < 1e-9);
    assert.equal(armB.significant, false, 'too few visitors: never significant');
    assert.equal(typeof armB.lift, 'number');

    // owner preview can force an arm; ?variant= without the signed token is ignored
    const previewUrl = (await api.get(`/api/steps/${s1.id}`)).body.preview_url as string;
    assert.match((await view(`${previewUrl}&variant=${v.body.id}`)).text, /Variante B/);
    assert.match((await view(`${previewUrl}&variant=0`, bVisitor!)).text, /Original/);
    assert.match((await view(`${path}?variant=0`, bVisitor!)).text, /Variante B/);

    // pause: everyone sees the original, nothing attributed
    await api.patch(`/api/steps/${s1.id}/ab`, { status: 'paused' });
    assert.match((await view(path, bVisitor!)).text, /Original/);

    // declare the winner: content copied, test over
    const w = await api.post(`/api/steps/${s1.id}/ab/winner`, { variant_id: v.body.id });
    assert.equal(w.body.status, 'off');
    assert.ok(w.body.variants.every((x: { active: boolean }) => !x.active));
    assert.match((await view(path)).text, /Variante B/);
    assert.equal((await api.get(`/api/steps/${s1.id}`)).body.content.blocks[0].text, 'Variante B');
    // starting requires an active variant
    assert.equal((await api.patch(`/api/steps/${s1.id}/ab`, { status: 'running' })).status, 409);
    // 4 variants max
    for (let i = 0; i < 3; i++) assert.equal((await api.post(`/api/steps/${s1.id}/variants`, {})).status, 201);
    assert.equal((await api.post(`/api/steps/${s1.id}/variants`, {})).status, 409);
  });
});

describe('attribution: UTM, referrer, stats', () => {
  test('first-touch attribution on views, optin events and contacts; stats by source / campaign / variant', async () => {
    const { api, f, s1, s2 } = await setup();
    const p1 = `/p/${f.slug}/${s1.slug}`;
    const p2 = `/p/${f.slug}/${s2.slug}`;
    // visitor A: facebook ads; visitor B: google.com referrer; visitor C: direct
    const a = await view(`${p1}?utm_source=facebook&utm_medium=cpc&utm_campaign=lancement&utm_content=video&utm_term=formation`);
    const aCookies = { scalo_vid: a.cookies.scalo_vid!, scalo_src: a.cookies.scalo_src! };
    assert.ok(a.cookies.scalo_src);
    const b = await http(ctx, 'GET', p1, {});
    await fetch(ctx.base + p1, { headers: { referer: 'https://www.google.com/search?q=x' } });
    const c = await view(p1);
    // A comes back with other UTMs: first touch kept
    await view(`${p2}?utm_source=newsletter`, aCookies);
    await submit(p1, { email: 'a@utm.fr', _block: 'fa' }, aCookies);
    await submit(p1, { email: 'c@utm.fr', _block: 'fa' }, { scalo_vid: c.cookies.scalo_vid!, scalo_src: c.cookies.scalo_src! });
    assert.ok(b.status === 200);

    const views = await db.selectFrom('page_views').selectAll().where('funnel_id', '=', f.id).orderBy('id').execute();
    const va = views.filter((x) => x.visitor_id === a.cookies.scalo_vid);
    assert.equal(va.length, 2);
    for (const x of va) {
      assert.equal(x.utm_source, 'facebook');
      assert.equal(x.utm_campaign, 'lancement');
      assert.equal(x.utm_term, 'formation');
    }
    assert.ok(views.some((x) => x.referrer_host === 'google.com'));

    const ev = await db.selectFrom('contact_events').select(['attribution', 'contact_id']).where('funnel_id', '=', f.id).where('type', '=', 'optin').execute();
    assert.equal(ev.length, 2);
    assert.ok(ev.some((e) => e.attribution?.utm_source === 'facebook' && e.attribution?.utm_medium === 'cpc'));
    const ca = await db.selectFrom('contacts').select('source').where('email', '=', 'a@utm.fr').executeTakeFirstOrThrow();
    assert.equal(ca.source?.utm_campaign, 'lancement');
    const cc = await db.selectFrom('contacts').select('source').where('email', '=', 'c@utm.fr').executeTakeFirstOrThrow();
    assert.deepEqual(cc.source, {}, 'direct');
    // existing source is never overwritten
    await submit(p1, { email: 'c@utm.fr', _block: 'fa' }, aCookies);
    assert.deepEqual((await db.selectFrom('contacts').select('source').where('email', '=', 'c@utm.fr').executeTakeFirstOrThrow()).source, {});

    const st = (await api.get(`/api/funnels/${f.id}/stats?period=30&group=source`)).body;
    assert.equal(st.totals.visitors, 4);
    assert.equal(st.totals.optins, 3);
    const fb = st.rows.find((r: { key: string }) => r.key === 'facebook');
    assert.equal(fb.visitors, 1);
    assert.equal(fb.optins, 2);
    assert.deepEqual(fb.steps.map((x: { step_id: number }) => x.step_id), [s1.id, s2.id]);
    assert.equal(st.rows.find((r: { key: string }) => r.key === 'google.com').visitors, 1);
    const direct = st.rows.find((r: { key: string }) => r.key === '(direct)');
    assert.equal(direct.visitors, 2);
    assert.equal(direct.optins, 1);
    assert.equal(st.steps.find((x: { step_id: number }) => x.step_id === s1.id).visitors, 4);
    assert.equal(st.daily.length, 30);
    assert.equal(st.daily.at(-1).visitors, 4);

    const camp = (await api.get(`/api/funnels/${f.id}/stats?period=all&group=campaign`)).body;
    assert.deepEqual(camp.rows.map((r: { key: string }) => r.key).sort(), ['(aucun)', 'lancement']);
    const med = (await api.get(`/api/funnels/${f.id}/stats?period=7&group=medium`)).body;
    assert.ok(med.rows.some((r: { key: string }) => r.key === 'referral'));
    assert.equal((await api.get(`/api/funnels/${f.id}/stats?period=12`)).status, 400);
    assert.equal((await api.get(`/api/funnels/${f.id}/stats?group=ip`)).status, 400);
    const other = client(ctx, (await registerUser(ctx)).token);
    assert.equal((await other.get(`/api/funnels/${f.id}/stats`)).status, 404);

    // variant grouping
    const v = (await api.post(`/api/steps/${s1.id}/variants`, { name: 'Titre court' })).body;
    await api.patch(`/api/steps/${s1.id}/ab`, { status: 'running', control_weight: 0 });
    await view(p1);
    const byVariant = (await api.get(`/api/funnels/${f.id}/stats?group=variant`)).body;
    assert.equal(byVariant.rows.length, 1);
    assert.equal(byVariant.rows[0].key, `${s1.id}:${v.id}`);
    assert.match(byVariant.rows[0].label, /Titre court/);
  });
});

describe('pixels, cookie banner, legal pages', () => {
  test('strict ID validation', async () => {
    const { api, f } = await setup();
    const put = (tracking: Record<string, string | undefined>) => api.put(`/api/funnels/${f.id}/settings`, { tracking });
    for (const bad of [{ meta_pixel_id: '12ab34' }, { meta_pixel_id: "1');alert(1)//" }, { ga4_id: 'UA-1234-1' }, { ga4_id: 'G-12"><script>' }, { gtm_id: 'GTM_123' }, { gtm_id: 'GTM-12345678901234' }]) {
      assert.equal((await put(bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await api.put(`/api/funnels/${f.id}/settings`, { tracking: { html: '<script>' } })).status, 400, 'no arbitrary field');
    const ok = await put({ meta_pixel_id: '123456789012345', ga4_id: 'g-abc123xyz', gtm_id: 'gtm-k7x9p2' });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.tracking, { meta_pixel_id: '123456789012345', ga4_id: 'G-ABC123XYZ', gtm_id: 'GTM-K7X9P2' });
    // empty value removes an integration
    const removed = await put({ meta_pixel_id: '', ga4_id: 'G-ABC123XYZ', gtm_id: '' });
    assert.deepEqual(removed.body.tracking, { ga4_id: 'G-ABC123XYZ' });
    assert.equal((await api.put(`/api/funnels/${f.id}/settings`, { cookie_banner: { enabled: true, privacy_url: 'javascript:alert(1)' } })).status, 400);
    assert.equal((await api.put(`/api/funnels/${f.id}/settings`, { cookie_banner: { enabled: true, privacy_step_id: 999999 } })).status, 404);
  });

  test('snippets rendered server-side, Lead after optin, conditioned on consent when the banner is on', async () => {
    const { api, f, s1, s2 } = await setup();
    const p1 = `/p/${f.slug}/${s1.slug}`;
    const p2 = `/p/${f.slug}/${s2.slug}`;
    await api.put(`/api/funnels/${f.id}/settings`, { tracking: { meta_pixel_id: '123456789012345', ga4_id: 'G-TEST1234', gtm_id: 'GTM-ABCD12' } });

    // no banner: snippets everywhere, PageView
    let r = await view(p1);
    assert.match(r.text, /fbq\('init',"123456789012345"\);fbq\('track','PageView'\)/);
    assert.match(r.text, /googletagmanager\.com\/gtag\/js\?id=G-TEST1234/);
    assert.match(r.text, /gtm\.js\?id='\+i\+dl.*"GTM-ABCD12"/s);
    assert.match(r.text, /ns\.html\?id=GTM-ABCD12/);
    assert.doesNotMatch(r.text, /track','Lead'/);
    assert.doesNotMatch(r.text, /scalo-cookie-banner/);

    // Lead on the page after the optin, once
    const sub = await submit(p1, { email: 'lead@px.fr', _block: 'fa' }, { scalo_vid: r.cookies.scalo_vid! });
    assert.equal(sub.status, 303);
    const lead = sub.cookies.scalo_lead!;
    r = await view(p2, { scalo_lead: lead });
    assert.match(r.text, /fbq\('track','Lead'\)/);
    assert.match(r.text, /gtag\('event','generate_lead'\)/);
    assert.match(r.text, /event:'generate_lead'/);
    assert.match(r.headers.get('set-cookie') ?? '', /scalo_lead=;/);
    assert.doesNotMatch((await view(p2)).text, /generate_lead/);

    // banner on: nothing loads before consent, accessible banner with both choices
    await api.put(`/api/funnels/${f.id}/settings`, { cookie_banner: { enabled: true, text: 'Cookies <b>ok</b> ?', accept_label: 'J’accepte', decline_label: 'Non merci', privacy_url: 'https://exemple.fr/confidentialite' } });
    r = await view(p1);
    assert.doesNotMatch(r.text, /fbevents\.js|gtag\/js|gtm\.js/);
    assert.match(r.text, /id="scalo-cookie-banner" role="region" aria-label="Gestion des cookies"/);
    assert.match(r.text, /Cookies &lt;b&gt;ok&lt;\/b&gt; \?/, 'text escaped');
    assert.match(r.text, new RegExp(`action="/p/${f.slug}/${s1.slug}/consent"`));
    assert.match(r.text, /value="denied"[^>]*>Non merci/);
    assert.match(r.text, /value="granted"[^>]*>J’accepte/);
    assert.match(r.text, /href="https:\/\/exemple\.fr\/confidentialite"/);
    assert.match(r.text, /window\.scaloConsent="unknown"/);
    assert.match(r.text, /scalo:consent/);

    // accept → cookie scoped to the funnel, back to the same page, snippets loaded, no banner
    const acc = await http(ctx, 'POST', `${p1}/consent`, { form: { choice: 'granted' } });
    assert.equal(acc.status, 303);
    assert.equal(acc.headers.get('location'), p1);
    assert.equal(acc.cookies.scalo_consent, 'granted');
    assert.match(acc.headers.get('set-cookie')!, new RegExp(`Path=/p/${f.slug}`));
    r = await view(p1, { scalo_consent: 'granted' });
    assert.match(r.text, /fbevents\.js/);
    assert.match(r.text, /window\.scaloConsent="granted"/);
    assert.doesNotMatch(r.text, /scalo-cookie-banner/);
    // decline → nothing, no banner
    const dec = await http(ctx, 'POST', `${p1}/consent`, { form: { choice: 'denied' } });
    assert.equal(dec.cookies.scalo_consent, 'denied');
    r = await view(p1, { scalo_consent: 'denied' });
    assert.doesNotMatch(r.text, /fbevents\.js|gtag\/js|gtm\.js|scalo-cookie-banner/);
    assert.match(r.text, /window\.scaloConsent="denied"/);
    // junk choice: no cookie, no open redirect
    const junk = await http(ctx, 'POST', `${p1}/consent?next=https://evil.example`, { form: { choice: 'x' } });
    assert.equal(junk.headers.get('location'), p1);
    assert.equal(junk.cookies.scalo_consent, undefined);
  });

  test('legal pages: templates pre-filled from settings, footer links, skipped by next-step links', async () => {
    const { api, f, s1, s2 } = await setup();
    await api.put('/api/settings', { sender_name: 'Atelier Lumière', company_address: '12 rue des Lilas\n75011 Paris', sender_email: 'bonjour@atelier.fr' });
    const add = await api.post(`/api/funnels/${f.id}/legal-pages`, { kind: 'mentions' });
    assert.equal(add.status, 201);
    const mentions = add.body.step;
    assert.equal(mentions.name, 'Mentions légales');
    assert.equal(mentions.slug, 'mentions-legales');
    const text = JSON.stringify(mentions.content);
    assert.match(text, /Atelier Lumière/);
    assert.match(text, /12 rue des Lilas, 75011 Paris/);
    assert.match(text, /bonjour@atelier\.fr/);
    assert.match(text, /\[À compléter/);
    await api.put(`/api/funnels/${f.id}/settings`, { cookie_banner: { enabled: true } });
    const privacy = (await api.post(`/api/funnels/${f.id}/legal-pages`, { kind: 'privacy' })).body;
    const cgv = (await api.post(`/api/funnels/${f.id}/legal-pages`, { kind: 'cgv' })).body;
    assert.match(JSON.stringify(cgv.step.content), /Conditions générales de vente/);
    assert.deepEqual(cgv.funnel.settings.legal, { footer: true, step_ids: [mentions.id, privacy.step.id, cgv.step.id] });
    assert.equal(cgv.funnel.settings.cookie_banner.privacy_step_id, privacy.step.id);
    assert.equal((await api.post(`/api/funnels/${f.id}/legal-pages`, { kind: 'mentions' })).body.step.slug, 'mentions-legales-2');
    assert.equal((await api.post(`/api/funnels/${f.id}/legal-pages`, { kind: 'autre' })).status, 400);

    // "Merci" (last real step) no longer links to a legal page; footer on every page
    const merci = await view(`/p/${f.slug}/${s2.slug}`);
    assert.match(merci.text, /<footer[^>]*>.*Mentions légales.*Confidentialité.*CGV/s);
    assert.match(merci.text, new RegExp(`href="/p/${f.slug}/mentions-legales"`));
    const optin = await view(`/p/${f.slug}/${s1.slug}`);
    const sub = await submit(`/p/${f.slug}/${s1.slug}`, { email: 'legal@x.fr', _block: 'fa' }, { scalo_vid: optin.cookies.scalo_vid! });
    assert.equal(sub.headers.get('location'), `/p/${f.slug}/${s2.slug}`);
    // the banner links to the privacy step
    assert.match(optin.text, new RegExp(`href="/p/${f.slug}/confidentialite"[^>]*>Politique de confidentialité`));
    // footer can be turned off
    await api.put(`/api/funnels/${f.id}/settings`, { legal: { footer: false, step_ids: [mentions.id] } });
    assert.doesNotMatch((await view(`/p/${f.slug}/${s2.slug}`)).text, /<footer/);
  });
});

describe('export, import, share', () => {
  test('export → import round trip: contents, access (no hash), variants, settings; strict validation', async () => {
    const { api, user, f, s1, s2 } = await setup('sales');
    const tag = (await api.post('/api/tags', { name: 'Client VIP' })).body;
    const s3 = f.steps[2];
    await api.patch(`/api/steps/${s2.id}`, { access: { mode: 'tag', tag_id: tag.id, redirect: 'previous' } });
    await api.patch(`/api/steps/${s3.id}`, { access: { mode: 'password', password: 'motdepasse' } });
    const content = page('Avec campagne', { id: 'dup', tagName: 'x' });
    (content.blocks[1] as Record<string, unknown>).campaignId = 42;
    content.blocks.push({ id: 'dup', type: 'heading', level: 2, text: 'même id' } as never);
    await api.patch(`/api/steps/${s1.id}`, { content });
    const v = (await api.post(`/api/steps/${s1.id}/variants`, { name: 'Variante courte' })).body;
    await api.patch(`/api/steps/${s1.id}/ab`, { status: 'running', control_weight: 30 });
    const legal = (await api.post(`/api/funnels/${f.id}/legal-pages`, { kind: 'privacy' })).body.step;
    await api.put(`/api/funnels/${f.id}/settings`, {
      tracking: { ga4_id: 'G-EXPORT12' },
      cookie_banner: { enabled: true, text: 'Texte', privacy_step_id: legal.id },
    });

    const exp = await api.get(`/api/funnels/${f.id}/export`);
    assert.equal(exp.status, 200);
    assert.match(exp.headers.get('content-disposition') ?? '', /attachment; filename="tunnel-/);
    const data = exp.body;
    assert.equal(data.format, 'scalo-funnel');
    assert.equal(data.version, 1);
    assert.equal(data.steps.length, 4);
    assert.doesNotMatch(JSON.stringify(data), /password_hash|\$2[aby]\$/);
    assert.deepEqual(data.steps[1].access, { mode: 'tag', tag: 'Client VIP', redirect: 'previous' });
    assert.equal(data.steps[2].access.mode, 'password');
    assert.equal(data.steps[0].ab.variants[0].name, 'Variante courte');
    assert.equal(data.steps[0].content.blocks[1].campaignId, undefined, 'campaign detached');
    const ids = data.steps[0].content.blocks.map((b: { id: string }) => b.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate block ids regenerated');
    assert.deepEqual(data.funnel.settings.legal, { footer: true, steps: [3] });
    assert.equal(data.funnel.settings.cookie_banner.privacy_step, 3);
    assert.equal(v.name, 'Variante courte');

    // import into another account
    const other = await registerUser(ctx);
    const api2 = client(ctx, other.token);
    const imp = await api2.post('/api/funnels/import', data);
    assert.equal(imp.status, 201);
    assert.ok(imp.body.warnings.some((w: string) => /mot de passe/.test(w)));
    assert.ok(imp.body.warnings.some((w: string) => /test A\/B importé est arrêté/.test(w)));
    const g = (await api2.get(`/api/funnels/${imp.body.id}`)).body;
    assert.notEqual(g.slug, f.slug);
    assert.deepEqual(g.steps.map((s: { name: string }) => s.name), data.steps.map((s: { name: string }) => s.name));
    assert.equal(g.steps[1].access.mode, 'tag');
    const tags2 = (await api2.get('/api/tags')).body;
    assert.equal(g.steps[1].access.tag_id, tags2.find((t: { name: string }) => t.name === 'Client VIP').id);
    assert.equal(g.steps[2].access.mode, 'password');
    assert.equal(g.steps[2].access.password_set, false);
    assert.equal(g.steps[0].ab_status, 'off');
    assert.equal(g.steps[0].variants_count, 1);
    assert.deepEqual(g.settings.tracking, { ga4_id: 'G-EXPORT12' });
    assert.equal(g.settings.cookie_banner.privacy_step_id, g.steps[3].id);
    assert.deepEqual(g.settings.legal, { footer: true, step_ids: [g.steps[3].id] });
    // round trip: same export (modulo date / slug / ab status)
    const exp2 = (await api2.get(`/api/funnels/${imp.body.id}/export`)).body;
    assert.deepEqual(exp2.steps.map((s: { content: unknown }) => s.content), data.steps.map((s: { content: unknown }) => s.content));
    // the password step stays closed until a new password is set
    const locked = await view(`/p/${g.slug}/${g.steps[2].slug}`);
    assert.equal(locked.status, 401);
    // nothing was touched in the source account
    assert.equal((await client(ctx, user.token).get('/api/funnels')).body.length, 1);

    // strict validation
    const bad = async (body: unknown, re?: RegExp) => {
      const r = await api2.post('/api/funnels/import', body);
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
      if (re) assert.match(r.body.error, re);
    };
    await bad({ ...data, format: 'autre' }, /export de tunnel Scalo/);
    await bad({ ...data, version: 99 });
    await bad({ ...data, steps: [] });
    await bad({ ...data, extra: 1 });
    await bad({ ...data, steps: [{ ...data.steps[0], content: { settings: {}, blocks: [{ id: 'x', type: 'script' }] } }] }, /type de bloc inconnu/);
    await bad({ ...data, funnel: { ...data.funnel, settings: { tracking: { meta_pixel_id: '<script>' } } } });
    const huge = { ...data, funnel: { ...data.funnel, name: 'x'.repeat(10) }, pad: 'y'.repeat(2.2 * 1024 * 1024) };
    assert.equal((await api2.post('/api/funnels/import', huge)).status, 413);
  });

  test('share link: preview, import into the visitor account, revocation', async () => {
    const { api, f, s1 } = await setup();
    assert.deepEqual((await api.get(`/api/funnels/${f.id}/share`)).body, { active: false, created_at: null });
    const sh = await api.post(`/api/funnels/${f.id}/share`);
    assert.equal(sh.status, 201);
    const url: string = sh.body.url;
    const token = url.split('/share/')[1]!;
    assert.match(token, /^scalo_sh_[\w-]{43}$/);
    const row = await db.selectFrom('funnels').select('share_token_hash').where('id', '=', f.id).executeTakeFirstOrThrow();
    assert.notEqual(row.share_token_hash, token, 'stored hashed');
    assert.equal((await api.get(`/api/funnels/${f.id}/share`)).body.active, true);

    // public preview (no session)
    const pv = await http(ctx, 'GET', `/api/share/${token}`);
    assert.equal(pv.status, 200);
    assert.equal(pv.body.name, f.name);
    assert.equal(pv.body.steps.length, 2);
    assert.equal(pv.body.steps[0].content.blocks[0].text, 'Original');
    assert.equal(pv.body.steps[0].protected, false);
    assert.equal((await http(ctx, 'GET', `/api/share/scalo_sh_${'a'.repeat(43)}`)).status, 404);
    assert.equal((await http(ctx, 'GET', '/api/share/nimportequoi')).status, 404);

    // import requires a session
    assert.equal((await http(ctx, 'POST', `/api/share/${token}/import`)).status, 401);
    const visitor = client(ctx, (await registerUser(ctx)).token);
    const imp = await visitor.post(`/api/share/${token}/import`);
    assert.equal(imp.status, 201);
    const g = (await visitor.get(`/api/funnels/${imp.body.id}`)).body;
    assert.equal(g.steps[0].content.blocks[0].text, 'Original');
    assert.equal(g.steps[0].slug, s1.slug);

    // regenerate: the old link dies; revoke: 404
    const sh2 = await api.post(`/api/funnels/${f.id}/share`);
    assert.equal((await http(ctx, 'GET', `/api/share/${token}`)).status, 404);
    const token2 = (sh2.body.url as string).split('/share/')[1]!;
    assert.equal((await http(ctx, 'GET', `/api/share/${token2}`)).status, 200);
    assert.equal((await api.del(`/api/funnels/${f.id}/share`)).status, 200);
    assert.equal((await http(ctx, 'GET', `/api/share/${token2}`)).status, 404);
    assert.equal((await visitor.post(`/api/share/${token2}/import`)).status, 404);
    // only the owner manages the link
    assert.equal((await visitor.post(`/api/funnels/${f.id}/share`)).status, 404);
  });
});
