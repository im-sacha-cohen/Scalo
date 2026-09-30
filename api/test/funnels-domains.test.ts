import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import nodeHttp from 'node:http';
import { env } from '../src/env';
import type { DnsResolver } from '../src/services/dns';
import { normalizeCustomDomain } from '../src/services/domains';
import { client, registerUser, shutdown, startApp, type TestCtx } from './helpers';

// Fake DNS zone: host → CNAME targets / TXT records (anything else: ENOTFOUND; 'SERVFAIL' → server error)
const zone: Record<string, { cname?: string[]; txt?: string[][] } | 'SERVFAIL'> = {};
const dnsError = (code: string) => Object.assign(new Error(code), { code });
const fakeDns: DnsResolver = {
  resolveTxt: async (h) => {
    const z = zone[h];
    if (z === 'SERVFAIL') throw dnsError('ESERVFAIL');
    if (!z?.txt) throw dnsError('ENOTFOUND');
    return z.txt;
  },
  resolveMx: async () => {
    throw dnsError('ENODATA');
  },
  resolveCname: async (h) => {
    const z = zone[h];
    if (z === 'SERVFAIL') throw dnsError('ESERVFAIL');
    if (!z?.cname) throw dnsError('ENODATA');
    return z.cname;
  },
};

let ctx: TestCtx;
before(async () => {
  env.CUSTOM_DOMAIN_TARGET = 'pages.scalo.test';
  ctx = await startApp({ dns: fakeDns });
});
after(() => shutdown(ctx));

interface HostRes { status: number; text: string; headers: nodeHttp.IncomingHttpHeaders; cookies: Record<string, string>; location?: string }

/** Request with an arbitrary Host header (fetch does not allow overriding it). */
function hostReq(host: string, method: string, path: string, opts: { form?: Record<string, string>; cookies?: Record<string, string>; json?: unknown } = {}): Promise<HostRes> {
  const url = new URL(ctx.base);
  const headers: Record<string, string> = { host };
  let body: string | undefined;
  if (opts.form) {
    body = new URLSearchParams(opts.form).toString();
    headers['content-type'] = 'application/x-www-form-urlencoded';
  }
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers['content-type'] = 'application/json';
  }
  if (body) headers['content-length'] = String(Buffer.byteLength(body));
  if (opts.cookies) headers.cookie = Object.entries(opts.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  return new Promise((resolve, reject) => {
    const req = nodeHttp.request({ hostname: url.hostname, port: url.port, method, path, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        const cookies: Record<string, string> = {};
        for (const c of res.headers['set-cookie'] ?? []) {
          const [pair] = c.split(';');
          const i = pair.indexOf('=');
          cookies[pair.slice(0, i)] = pair.slice(i + 1);
        }
        resolve({ status: res.statusCode ?? 0, text, headers: res.headers, cookies, location: res.headers.location });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const formPage = (title: string) => ({
  settings: {},
  blocks: [
    { id: 'h', type: 'heading', level: 1, text: title },
    { id: 'img', type: 'image', src: '/uploads/1/aaaaaaaaaaaaaaaaaaaaaaaa.png' },
    { id: 'f1', type: 'form', fields: [{ name: 'email', label: 'Email', required: true }], submitLabel: 'Go', tagName: 'lead-domaine' },
  ],
});

async function setupFunnel() {
  const user = await registerUser(ctx);
  const api = client(ctx, user.token);
  const f = (await api.post('/api/funnels', { name: 'Offre domaine', template: 'sales' })).body;
  const [s1, s2, s3] = f.steps;
  await api.patch(`/api/steps/${s1.id}`, { content: formPage('Accueil domaine') });
  await api.patch(`/api/steps/${s2.id}`, { content: { settings: {}, blocks: [{ id: 'h2', type: 'heading', level: 1, text: 'Offre privée' }] } });
  return { api, user, f, s1, s2, s3 };
}

describe('custom domains: normalization', () => {
  test('lower case, IDN → punycode, URL pasted, IPs and app host refused', () => {
    assert.deepEqual(normalizeCustomDomain('  Offre.MonDomaine.FR. '), { domain: 'offre.mondomaine.fr' });
    assert.deepEqual(normalizeCustomDomain('https://offre.mondomaine.fr/page?x=1'), { domain: 'offre.mondomaine.fr' });
    assert.deepEqual(normalizeCustomDomain('café.fr'), { domain: 'xn--caf-dma.fr' });
    assert.deepEqual(normalizeCustomDomain('boutique.xn--p1ai'), { domain: 'boutique.xn--p1ai' });
    for (const bad of ['', '1.2.3.4', '[::1]', 'localhost', 'intranet', 'a..b.fr', '-x.fr', 'x_y.fr', 'pages.scalo.test', 'sub.pages.scalo.test', 'x.localhost']) {
      assert.ok('error' in normalizeCustomDomain(bad), bad);
    }
  });
});

describe('custom domains: API + DNS verification', () => {
  test('add (unique globally), DNS records, verify by TXT / CNAME, errors, root step, delete', async () => {
    const { api, f, s2 } = await setupFunnel();
    const add = await api.post(`/api/funnels/${f.id}/domains`, { domain: 'Offre.Exemple.fr' });
    assert.equal(add.status, 201);
    const d = add.body;
    assert.equal(d.domain, 'offre.exemple.fr');
    assert.equal(d.status, 'pending');
    assert.deepEqual(d.records.map((r: { type: string }) => r.type), ['CNAME', 'TXT']);
    assert.equal(d.records[0].value, 'pages.scalo.test');
    assert.equal(d.records[1].host, '_scalo.offre.exemple.fr');
    assert.match(d.records[1].value, /^scalo-verify=[0-9a-f]{32}$/);

    assert.equal((await api.post(`/api/funnels/${f.id}/domains`, { domain: 'offre.exemple.fr' })).status, 409);
    const other = client(ctx, (await registerUser(ctx)).token);
    const otherF = (await other.post('/api/funnels', { name: 'X', template: 'blank' })).body;
    assert.equal((await other.post(`/api/funnels/${otherF.id}/domains`, { domain: 'OFFRE.exemple.fr' })).status, 409, 'unique across accounts');
    assert.equal((await other.post(`/api/domains/${d.id}/verify`)).status, 404, 'tenant isolation');
    assert.equal((await api.post(`/api/funnels/${f.id}/domains`, { domain: '10.0.0.1' })).status, 400);
    assert.equal((await api.post(`/api/funnels/${f.id}/domains`, { domain: 'localhost' })).status, 400);

    // nothing published yet
    let v = await api.post(`/api/domains/${d.id}/verify`);
    assert.equal(v.body.status, 'error');
    assert.match(v.body.last_error, /Aucun enregistrement/);
    // wrong CNAME
    zone['offre.exemple.fr'] = { cname: ['ailleurs.example.net.'] };
    v = await api.post(`/api/domains/${d.id}/verify`);
    assert.equal(v.body.status, 'error');
    assert.match(v.body.last_error, /ailleurs\.example\.net/);
    // right CNAME (trailing dot, case)
    zone['offre.exemple.fr'] = { cname: ['Pages.Scalo.Test.'] };
    v = await api.post(`/api/domains/${d.id}/verify`);
    assert.equal(v.body.status, 'verified');
    assert.ok(v.body.verified_at);

    // TXT verification (apex domain)
    const apex = (await api.post(`/api/funnels/${f.id}/domains`, { domain: 'exemple-apex.fr', root_step_id: s2.id })).body;
    assert.equal(apex.root_step_id, s2.id);
    zone['_scalo.exemple-apex.fr'] = { txt: [['scalo-verify=nope']] };
    assert.equal((await api.post(`/api/domains/${apex.id}/verify`)).body.status, 'error');
    zone['_scalo.exemple-apex.fr'] = { txt: [['v=spf1 -all'], [apex.records[1].value]] };
    assert.equal((await api.post(`/api/domains/${apex.id}/verify`)).body.status, 'verified');
    // a DNS server failure keeps a verified domain online
    zone['_scalo.exemple-apex.fr'] = 'SERVFAIL';
    zone['exemple-apex.fr'] = 'SERVFAIL';
    const kept = await api.post(`/api/domains/${apex.id}/verify`);
    assert.equal(kept.body.status, 'verified');
    assert.match(kept.body.last_error, /DNS/);

    // root step must belong to the funnel
    assert.equal((await other.patch(`/api/domains/${apex.id}`, { root_step_id: null })).status, 404);
    const foreignStep = otherF.steps[0].id;
    assert.equal((await api.patch(`/api/domains/${apex.id}`, { root_step_id: foreignStep })).status, 404);

    const list = await api.get(`/api/funnels/${f.id}/domains`);
    assert.deepEqual(list.body.map((x: { domain: string }) => x.domain), ['offre.exemple.fr', 'exemple-apex.fr']);
    assert.equal((await api.del(`/api/domains/${apex.id}`)).status, 200);
    assert.equal((await api.get(`/api/funnels/${f.id}/domains`)).body.length, 1);
  });

  test('GET /api/domains/allowed (Caddy on-demand TLS)', async () => {
    const { api, f } = await setupFunnel();
    const d = (await api.post(`/api/funnels/${f.id}/domains`, { domain: 'tls.exemple.fr' })).body;
    const allowed = (q: string) => fetch(`${ctx.base}/api/domains/allowed?domain=${encodeURIComponent(q)}`).then((r) => r.status);
    assert.equal(await allowed('tls.exemple.fr'), 404, 'pending');
    zone['tls.exemple.fr'] = { cname: ['pages.scalo.test'] };
    await api.post(`/api/domains/${d.id}/verify`);
    assert.equal(await allowed('tls.exemple.fr'), 200);
    assert.equal(await allowed('TLS.Exemple.FR'), 200);
    assert.equal(await allowed('inconnu.exemple.fr'), 404);
    assert.equal(await allowed(''), 404);
    assert.equal(await allowed('127.0.0.1'), 404);
  });
});

describe('custom domains: Host routing', () => {
  test('verified domain serves the funnel at / and /<step>; forms, protected steps, uploads; API never exposed', async () => {
    const { api, f, s1, s2, s3 } = await setupFunnel();
    const d = (await api.post(`/api/funnels/${f.id}/domains`, { domain: 'www.route.fr' })).body;
    const host = 'www.route.fr';

    // pending → not served (and never the app)
    let r = await hostReq(host, 'GET', '/');
    assert.equal(r.status, 404);
    assert.doesNotMatch(r.text, /Accueil domaine/);

    zone['www.route.fr'] = { cname: ['pages.scalo.test'] };
    await api.post(`/api/domains/${d.id}/verify`);

    // root = first step, rendered in place; URLs are relative to the domain root
    r = await hostReq(`${host}:443`, 'GET', '/');
    assert.equal(r.status, 200);
    assert.match(r.text, /Accueil domaine/);
    assert.match(r.text, new RegExp(`action="/${s1.slug}/submit"`));
    assert.doesNotMatch(r.text, /\/p\//);
    assert.ok(r.cookies.scalo_vid);
    r = await hostReq(host, 'GET', `/${s2.slug}`);
    assert.equal(r.status, 200);
    assert.match(r.text, /Offre privée/);
    assert.equal((await hostReq(host, 'GET', '/nope')).status, 404);
    // images of the media library are served on the domain too (404 here: no such file, but routed)
    const img = await hostReq(host, 'GET', '/uploads/1/aaaaaaaaaaaaaaaaaaaaaaaa.png');
    assert.equal(img.status, 404);
    assert.equal(img.text, 'Introuvable');

    // submit → contact + optin + redirect to the next step on the domain
    const sub = await hostReq(host, 'POST', `/${s1.slug}/submit`, { form: { email: 'Domaine@Exemple.fr', _block: 'f1' }, cookies: { scalo_vid: r.cookies.scalo_vid ?? 'visitor-123' } });
    assert.equal(sub.status, 303);
    assert.equal(sub.location, `/${s2.slug}`);
    assert.ok(sub.cookies.scalo_cid);
    assert.match(sub.headers['set-cookie']!.find((c) => c.startsWith('scalo_lead='))!, /Path=\//);
    const contacts = await api.get('/api/contacts?search=domaine@exemple.fr');
    assert.equal(contacts.body.items.length, 1);
    assert.deepEqual(contacts.body.items[0].tags.map((t: { name: string }) => t.name), ['lead-domaine']);
    const bad = await hostReq(host, 'POST', `/${s1.slug}/submit`, { form: { email: 'nope' } });
    assert.equal(bad.location, `/${s1.slug}?error=email`);

    // password-protected step: form + cookie scoped to the domain root
    await api.patch(`/api/steps/${s3.id}`, { access: { mode: 'password', password: 'secret1' } });
    const locked = await hostReq(host, 'GET', `/${s3.slug}`);
    assert.equal(locked.status, 401);
    assert.match(locked.text, new RegExp(`action="/${s3.slug}/unlock"`));
    const wrong = await hostReq(host, 'POST', `/${s3.slug}/unlock`, { form: { password: 'x' } });
    assert.equal(wrong.location, `/${s3.slug}?error=pw`);
    const ok = await hostReq(host, 'POST', `/${s3.slug}/unlock`, { form: { password: 'secret1' } });
    assert.equal(ok.location, `/${s3.slug}`);
    const pw = ok.headers['set-cookie']!.find((c) => c.startsWith(`scalo_pw_${s3.id}=`))!;
    assert.match(pw, /Path=\/(;|$)/);
    const opened = await hostReq(host, 'GET', `/${s3.slug}`, { cookies: { [`scalo_pw_${s3.id}`]: ok.cookies[`scalo_pw_${s3.id}`]! } });
    assert.equal(opened.status, 200);

    // funnel-restricted step: redirect to the first public step on the domain
    await api.patch(`/api/steps/${s2.id}`, { access: { mode: 'funnel', redirect: 'first' } });
    const denied = await hostReq(host, 'GET', `/${s2.slug}`);
    assert.equal(denied.status, 302);
    assert.equal(denied.location, `/${s1.slug}`);

    // root step setting
    await api.patch(`/api/domains/${d.id}`, { root_step_id: s3.id });
    assert.equal((await hostReq(host, 'GET', '/')).status, 401);

    // the API, the app and other funnels are never reachable through a custom domain
    for (const p of ['/api/health', '/api/funnels', '/api/domains/allowed?domain=www.route.fr', `/p/${f.slug}/${s1.slug}`, '/oauth/authorize', '/.well-known/oauth-authorization-server', '/t/o/1.gif']) {
      const x = await hostReq(host, 'GET', p);
      assert.equal(x.status, 404, p);
      assert.doesNotMatch(String(x.headers['content-type']), /json/, p);
    }
    assert.equal((await hostReq(host, 'POST', '/api/auth/login', { json: { email: 'a@b.fr', password: 'x' } })).status, 404);

    // the /p/ URL keeps working on the app host
    const legacy = await hostReq(new URL(ctx.base).host, 'GET', `/p/${f.slug}/${s1.slug}`);
    assert.equal(legacy.status, 200);
    assert.match(legacy.text, new RegExp(`action="/p/${f.slug}/${s1.slug}/submit"`));
  });

  test('unknown hosts: 404 page for everything; app hosts and IPs keep the app', async () => {
    for (const p of ['/', '/api/health', '/login', '/p/x/y', '/uploads/1/aaaaaaaaaaaaaaaaaaaaaaaa.png']) {
      const r = await hostReq('evil.example.com', 'GET', p);
      assert.equal(r.status, 404, p);
      assert.match(r.text, /Page introuvable/);
    }
    assert.equal((await hostReq('localhost:4000', 'GET', '/api/health')).status, 200);
    assert.equal((await hostReq('127.0.0.1', 'GET', '/api/health')).status, 200);
    assert.equal((await hostReq('localhost', 'GET', '/api/health')).status, 200);
    // a domain removed from the account stops being served
    const { api, f } = await setupFunnel();
    const d = (await api.post(`/api/funnels/${f.id}/domains`, { domain: 'bientot-supprime.fr' })).body;
    zone['_scalo.bientot-supprime.fr'] = { txt: [[d.records[1].value]] };
    await api.post(`/api/domains/${d.id}/verify`);
    assert.equal((await hostReq('bientot-supprime.fr', 'GET', '/')).status, 200);
    await api.del(`/api/domains/${d.id}`);
    assert.equal((await hostReq('bientot-supprime.fr', 'GET', '/')).status, 404);
  });
});
