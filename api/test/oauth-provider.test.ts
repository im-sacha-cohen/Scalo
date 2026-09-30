// OAuth 2.0 authorization server: clients, authorize → consent → code → tokens, refresh rotation, revocation,
// introspection, public API /api/v1 (scopes, rate limit). Real app + PostgreSQL, driven with fetch.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sql } from 'kysely';
import { db } from '../src/db';
import { env } from '../src/env';
import { cleanupOAuth, sha256 } from '../src/services/oauth-server';
import { client, http, registerUser, shutdown, startApp, type Res, type TestCtx } from './helpers';

let ctx: TestCtx;
before(async () => {
  ctx = await startApp();
});
after(() => shutdown(ctx));
beforeEach(async () => {
  await db.deleteFrom('auth_attempts').execute();
});

const ISS = env.PUBLIC_URL;
const REDIRECT = 'https://app.example.com/callback';
const ALL_SCOPES = ['profile', 'contacts:read', 'contacts:write', 'tags:write', 'funnels:read', 'emails:read', 'campaigns:write', 'offline_access'];

type Api = ReturnType<typeof client>;
interface App {
  id: number;
  client_id: string;
  client_secret?: string;
  type: 'confidential' | 'public';
}

async function newUser(name = 'U') {
  const u = await registerUser(ctx, name);
  return { ...u, api: client(ctx, u.token) };
}

async function createClient(api: Api, over: Record<string, unknown> = {}): Promise<App> {
  const r = await api.post('/api/developer/apps', { name: 'Zapier-like', type: 'confidential', redirect_uris: [REDIRECT], scopes: ALL_SCOPES, ...over });
  assert.equal(r.status, 201, r.text);
  return r.body;
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

/** Raw POST (form by default) with optional Basic auth. */
async function post(path: string, params: Record<string, string>, opts: { basic?: [string, string]; json?: boolean; headers?: Record<string, string> } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.basic) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(opts.basic[0])}:${encodeURIComponent(opts.basic[1])}`).toString('base64')}`;
  headers['content-type'] = opts.json ? 'application/json' : 'application/x-www-form-urlencoded';
  const res = await fetch(ctx.base + path, { method: 'POST', headers, body: opts.json ? JSON.stringify(params) : new URLSearchParams(params).toString(), redirect: 'manual' });
  const text = await res.text();
  const body = res.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text;
  return { status: res.status, body, text, headers: res.headers, cookies: {} };
}

const authorize = (params: Record<string, string>) => http(ctx, 'GET', `/oauth/authorize?${new URLSearchParams(params)}`);

function requestIdOf(r: Res) {
  assert.equal(r.status, 302, r.text);
  const u = new URL(r.headers.get('location')!);
  assert.equal(u.origin + u.pathname, `${ISS}/oauth/consent`);
  return u.searchParams.get('request')!;
}

function redirectParams(location: string) {
  const u = new URL(location);
  return { base: u.origin + u.pathname, ...Object.fromEntries(u.searchParams) } as Record<string, string>;
}

/** authorize → consent (approve) → code. */
async function getCode(user: { api: Api }, app: App, o: { scope?: string; state?: string; challenge?: string; prompt?: string; redirect?: string } = {}) {
  const params: Record<string, string> = { response_type: 'code', client_id: app.client_id, redirect_uri: o.redirect ?? REDIRECT, scope: o.scope ?? 'profile contacts:read offline_access' };
  if (o.state !== undefined) params.state = o.state;
  if (o.challenge) Object.assign(params, { code_challenge: o.challenge, code_challenge_method: 'S256' });
  if (o.prompt) params.prompt = o.prompt;
  const requestId = requestIdOf(await authorize(params));
  const c = await user.api.post('/api/oauth/consent', { request_id: requestId, decision: 'approve' });
  assert.equal(c.status, 200, c.text);
  const p = redirectParams(c.body.redirect_to);
  assert.equal(p.base, o.redirect ?? REDIRECT);
  assert.equal(p.iss, ISS);
  return p;
}

const exchange = (app: App, code: string, extra: Record<string, string> = {}) =>
  post('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, ...extra }, app.client_secret ? { basic: [app.client_id, app.client_secret] } : {});

const refresh = (app: App, refreshToken: string, extra: Record<string, string> = {}) =>
  post('/oauth/token', { grant_type: 'refresh_token', refresh_token: refreshToken, ...extra }, app.client_secret ? { basic: [app.client_id, app.client_secret] } : {});

async function tokensFor(user: { api: Api }, app: App, scope?: string) {
  const { code } = await getCode(user, app, { scope });
  const r = await exchange(app, code);
  assert.equal(r.status, 200, r.text);
  return r.body as { access_token: string; refresh_token?: string; expires_in: number; scope: string; token_type: string };
}

const v1 = (token: string, method: string, path: string, json?: unknown) => http(ctx, method, `/api/v1${path}`, { token, json });

describe('metadata & client registration', () => {
  test('RFC 8414 metadata', async () => {
    const r = await http(ctx, 'GET', '/.well-known/oauth-authorization-server');
    assert.equal(r.status, 200);
    assert.equal(r.body.issuer, ISS);
    assert.equal(r.body.authorization_endpoint, `${ISS}/oauth/authorize`);
    assert.equal(r.body.token_endpoint, `${ISS}/oauth/token`);
    assert.deepEqual(r.body.grant_types_supported, ['authorization_code', 'refresh_token']);
    assert.deepEqual(r.body.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(r.body.response_types_supported, ['code']);
    assert.equal(r.body.authorization_response_iss_parameter_supported, true);
    assert.ok(r.body.scopes_supported.includes('offline_access'));
  });

  test('secret shown once, stored hashed; validation of redirect URIs, logo and scopes', async () => {
    const dev = await newUser();
    const app = await createClient(dev.api);
    assert.match(app.client_id, /^scalo_app_[0-9a-f]{24}$/);
    assert.match(app.client_secret!, /^scalo_cs_[\w-]{43}$/);
    const row = await db.selectFrom('oauth_clients').selectAll().where('id', '=', app.id).executeTakeFirstOrThrow();
    assert.equal(row.secret_hash, sha256(app.client_secret!));
    const got = await dev.api.get(`/api/developer/apps/${app.id}`);
    assert.equal(got.body.client_secret, undefined);
    assert.equal(got.body.secret_hint, app.client_secret!.slice(-4));
    // public client: no secret
    const pub = await createClient(dev.api, { type: 'public' });
    assert.equal(pub.client_secret, undefined);

    for (const bad of ['http://app.example.com/cb', 'https://app.example.com/cb#frag', 'javascript:alert(1)', 'https://*.example.com/cb', 'not a url', 'https://user:pw@x.fr/cb']) {
      const r = await dev.api.post('/api/developer/apps', { name: 'X', type: 'public', redirect_uris: [bad], scopes: ['profile'] });
      assert.equal(r.status, 400, `${bad}: ${r.text}`);
    }
    const ok = await dev.api.post('/api/developer/apps', {
      name: 'Native',
      type: 'public',
      redirect_uris: ['http://localhost:3000/cb', 'http://127.0.0.1:8080/cb', 'com.example.app:/oauth', 'https://x.fr/cb?a=1'],
      scopes: ['profile'],
    });
    assert.equal(ok.status, 201, ok.text);
    assert.equal((await dev.api.post('/api/developer/apps', { name: 'X', type: 'public', redirect_uris: [REDIRECT], scopes: ['admin'] })).status, 400);
    assert.equal((await dev.api.post('/api/developer/apps', { name: 'X', type: 'public', redirect_uris: [REDIRECT], scopes: ['profile'], logo_url: 'http://x.fr/l.png' })).status, 400);
    assert.equal((await dev.api.post('/api/developer/apps', { name: 'X', type: 'public', redirect_uris: [], scopes: ['profile'] })).status, 400);
  });

  test('apps of another user are invisible (404) and cannot be managed', async () => {
    const owner = await newUser();
    const other = await newUser();
    const app = await createClient(owner.api);
    assert.equal((await other.api.get(`/api/developer/apps/${app.id}`)).status, 404);
    assert.equal((await other.api.patch(`/api/developer/apps/${app.id}`, { name: 'pwn' })).status, 404);
    assert.equal((await other.api.post(`/api/developer/apps/${app.id}/rotate-secret`)).status, 404);
    assert.equal((await other.api.del(`/api/developer/apps/${app.id}`)).status, 404);
    assert.deepEqual((await other.api.get('/api/developer/apps')).body, []);
    assert.equal((await owner.api.get('/api/developer/apps')).body.length, 1);
    assert.equal((await http(ctx, 'GET', '/api/developer/apps')).status, 401);
  });

  test('secret rotation: the old secret stops working at once', async () => {
    const dev = await newUser();
    const user = await newUser();
    const app = await createClient(dev.api);
    const { code } = await getCode(user, app);
    const rot = await dev.api.post(`/api/developer/apps/${app.id}/rotate-secret`);
    assert.equal(rot.status, 200);
    assert.notEqual(rot.body.client_secret, app.client_secret);
    const old = await exchange(app, code);
    assert.equal(old.status, 401);
    assert.equal(old.body.error, 'invalid_client');
    assert.match(old.headers.get('www-authenticate')!, /^Basic/);
    const { code: code2 } = await getCode(user, app);
    assert.equal((await exchange({ ...app, client_secret: rot.body.client_secret }, code2)).status, 200);
    const pub = await createClient(dev.api, { type: 'public' });
    assert.equal((await dev.api.post(`/api/developer/apps/${pub.id}/rotate-secret`)).status, 409);
  });
});

describe('authorization endpoint', () => {
  test('unknown client / unregistered redirect_uri → error page, never a redirect (no framing)', async () => {
    const dev = await newUser();
    const app = await createClient(dev.api);
    const cases: Record<string, string>[] = [
      { client_id: 'scalo_app_unknown', redirect_uri: REDIRECT },
      { client_id: app.client_id, redirect_uri: 'https://evil.example.com/callback' },
      { client_id: app.client_id, redirect_uri: `${REDIRECT}/` }, // exact match only
      { client_id: app.client_id, redirect_uri: `${REDIRECT}?x=1` },
      { client_id: app.client_id },
      { redirect_uri: REDIRECT },
    ];
    for (const c of cases) {
      const r = await authorize({ response_type: 'code', scope: 'profile', state: 's', ...c });
      assert.equal(r.status, 400, JSON.stringify(c));
      assert.equal(r.headers.get('location'), null);
      assert.match(r.headers.get('content-type')!, /text\/html/);
      assert.match(r.text, /Autorisation impossible/);
      assert.equal(r.headers.get('x-frame-options'), 'DENY');
      assert.match(r.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    }
  });

  test('other errors are redirected to the application with error, state and iss', async () => {
    const dev = await newUser();
    const app = await createClient(dev.api, { scopes: ['profile', 'contacts:read'] });
    const pub = await createClient(dev.api, { type: 'public' });
    const base = { client_id: app.client_id, redirect_uri: REDIRECT, state: 'xyz', response_type: 'code', scope: 'profile' };
    const expectErr = async (params: Record<string, string>, error: string) => {
      const r = await authorize(params);
      assert.equal(r.status, 302, r.text);
      const p = redirectParams(r.headers.get('location')!);
      assert.equal(p.base, REDIRECT);
      assert.equal(p.error, error, JSON.stringify(params));
      assert.equal(p.state, 'xyz');
      assert.equal(p.iss, ISS);
      assert.equal(p.code, undefined);
    };
    await expectErr({ ...base, response_type: 'token' }, 'unsupported_response_type'); // no implicit grant
    await expectErr({ ...base, scope: 'contacts:write' }, 'invalid_scope'); // not allowed for this client
    await expectErr({ ...base, scope: 'profile admin' }, 'invalid_scope');
    await expectErr({ ...base, scope: '' }, 'invalid_scope');
    const { challenge } = pkce();
    await expectErr({ ...base, code_challenge: challenge, code_challenge_method: 'plain' }, 'invalid_request');
    await expectErr({ ...base, code_challenge: challenge }, 'invalid_request');
    await expectErr({ ...base, code_challenge: 'short', code_challenge_method: 'S256' }, 'invalid_request');
    // public client: PKCE is mandatory
    await expectErr({ ...base, client_id: pub.client_id }, 'invalid_request');
    // repeated parameter
    const r = await http(ctx, 'GET', `/oauth/authorize?${new URLSearchParams(base)}&scope=profile`);
    assert.equal(redirectParams(r.headers.get('location')!).error, 'invalid_request');
  });

  test('a valid request is stored server-side (hashed id, short TTL) and sent to the consent screen', async () => {
    const dev = await newUser();
    const user = await newUser('Alice');
    const app = await createClient(dev.api, { name: 'Mon CRM', logo_url: 'https://cdn.example.com/logo.png', website: 'https://example.com' });
    const id = requestIdOf(await authorize({ response_type: 'code', client_id: app.client_id, redirect_uri: REDIRECT, scope: 'contacts:read profile', state: 'abc' }));
    assert.match(id, /^scalo_ar_/);
    const row = await db.selectFrom('oauth_authorization_requests').selectAll().where('id_hash', '=', sha256(id)).executeTakeFirstOrThrow();
    assert.ok(new Date(row.expires_at).getTime() - Date.now() <= 10 * 60_000 + 1000);
    // consent screen data needs a session
    assert.equal((await http(ctx, 'GET', `/api/oauth/requests/${id}`)).status, 401);
    const r = await user.api.get(`/api/oauth/requests/${id}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.client.name, 'Mon CRM');
    assert.equal(r.body.client.owner_name, 'U');
    assert.equal(r.body.client.logo_url, 'https://cdn.example.com/logo.png');
    assert.deepEqual(r.body.scopes, ['profile', 'contacts:read']);
    assert.equal(r.body.remembered, false);
    assert.equal((await user.api.get('/api/oauth/requests/scalo_ar_nope')).status, 404);
  });

  test('deny → access_denied with state and iss; a request is single use', async () => {
    const dev = await newUser();
    const user = await newUser();
    const app = await createClient(dev.api);
    const id = requestIdOf(await authorize({ response_type: 'code', client_id: app.client_id, redirect_uri: REDIRECT, scope: 'profile', state: 'st4te' }));
    const r = await user.api.post('/api/oauth/consent', { request_id: id, decision: 'deny' });
    assert.equal(r.status, 200);
    const p = redirectParams(r.body.redirect_to);
    assert.deepEqual([p.base, p.error, p.state, p.iss, p.code], [REDIRECT, 'access_denied', 'st4te', ISS, undefined]);
    assert.equal((await user.api.post('/api/oauth/consent', { request_id: id, decision: 'approve' })).status, 410);
    assert.equal((await user.api.get(`/api/oauth/requests/${id}`)).status, 410);
    assert.equal((await user.api.get('/api/oauth/authorizations')).body.length, 0);
  });

  test('remembered consent skips the screen; prompt=consent forces it; broader grants cover narrower requests', async () => {
    const dev = await newUser();
    const user = await newUser();
    const app = await createClient(dev.api);
    await getCode(user, app, { scope: 'profile contacts:read' });
    const lookup = async (params: Record<string, string>) => {
      const id = requestIdOf(await authorize({ response_type: 'code', client_id: app.client_id, redirect_uri: REDIRECT, ...params }));
      return (await user.api.get(`/api/oauth/requests/${id}`)).body;
    };
    assert.equal((await lookup({ scope: 'profile contacts:read' })).remembered, true);
    assert.equal((await lookup({ scope: 'contacts:read' })).remembered, true);
    const forced = await lookup({ scope: 'contacts:read', prompt: 'consent' });
    assert.equal(forced.remembered, false);
    assert.equal(forced.prompt_consent, true);
    assert.equal((await lookup({ scope: 'contacts:write' })).remembered, false);
    // another user never inherits the consent
    const other = await newUser();
    const id = requestIdOf(await authorize({ response_type: 'code', client_id: app.client_id, redirect_uri: REDIRECT, scope: 'profile' }));
    assert.equal((await other.api.get(`/api/oauth/requests/${id}`)).body.remembered, false);
  });
});

describe('token endpoint', () => {
  test('confidential client, client_secret_basic: code → tokens → API → refresh rotation → reuse revokes the family', async () => {
    const dev = await newUser();
    const user = await newUser('Bob');
    const app = await createClient(dev.api);
    const { code, state } = await getCode(user, app, { state: 'opaque-state', scope: 'profile contacts:read offline_access' });
    assert.equal(state, 'opaque-state');
    assert.match(code, /^scalo_ac_/);
    const r = await exchange(app, code);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.body.token_type, 'Bearer');
    assert.equal(r.body.expires_in, 3600);
    assert.equal(r.body.scope, 'profile contacts:read offline_access');
    assert.match(r.body.access_token, /^scalo_at_[\w-]{43}$/);
    assert.match(r.body.refresh_token, /^scalo_rt_[\w-]{43}$/);
    // stored hashed only
    const rows = await db.selectFrom('oauth_tokens').select(['token_hash', 'type', 'expires_at']).where('user_id', '=', user.user.id).execute();
    assert.equal(rows.length, 2);
    assert.ok(rows.some((t) => t.token_hash === sha256(r.body.access_token)));
    const refreshRow = rows.find((t) => t.type === 'refresh')!;
    assert.ok(new Date(refreshRow.expires_at).getTime() - Date.now() > 29 * 86400_000);
    const leak = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM oauth_tokens WHERE token_hash LIKE 'scalo_%'`.execute(db);
    assert.equal(leak.rows[0].n, 0);

    const me = await v1(r.body.access_token, 'GET', '/me');
    assert.equal(me.status, 200, me.text);
    assert.equal(me.body.email, user.email);
    assert.equal((await v1(r.body.access_token, 'GET', '/contacts')).status, 200);
    // the app's user is Bob, not the developer
    assert.equal((await user.api.get('/api/oauth/authorizations')).body[0].client.client_id, app.client_id);

    // refresh: rotation
    const r2 = await refresh(app, r.body.refresh_token);
    assert.equal(r2.status, 200, r2.text);
    assert.notEqual(r2.body.refresh_token, r.body.refresh_token);
    assert.notEqual(r2.body.access_token, r.body.access_token);
    assert.equal((await v1(r2.body.access_token, 'GET', '/me')).status, 200);
    // the old refresh token presented again → reuse → whole family revoked
    const reuse = await refresh(app, r.body.refresh_token);
    assert.equal(reuse.status, 400);
    assert.equal(reuse.body.error, 'invalid_grant');
    assert.equal((await v1(r2.body.access_token, 'GET', '/me')).status, 401);
    assert.equal((await v1(r.body.access_token, 'GET', '/me')).status, 401);
    assert.equal((await refresh(app, r2.body.refresh_token)).body.error, 'invalid_grant');
  });

  test('client_secret_post, JSON body, PKCE with a confidential client; client authentication errors', async () => {
    const dev = await newUser();
    const user = await newUser();
    const app = await createClient(dev.api);
    const { verifier, challenge } = pkce();
    const { code } = await getCode(user, app, { challenge });
    const creds = { client_id: app.client_id, client_secret: app.client_secret! };
    // wrong secret / unknown client / no authentication / two methods
    const wrong = await post('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: app.client_id, client_secret: 'scalo_cs_wrong' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error, 'invalid_client');
    assert.ok(wrong.headers.get('www-authenticate'));
    assert.equal((await post('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: app.client_id })).body.error, 'invalid_client');
    assert.equal((await post('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT })).status, 401);
    assert.equal((await post('/oauth/token', { grant_type: 'authorization_code', code, client_secret: 'x' }, { basic: [app.client_id, app.client_secret!] })).body.error, 'invalid_request');
    // client authentication failed before the code was looked at: it is still usable
    const ok = await post('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, ...creds }, { json: true });
    assert.equal(ok.status, 200, ok.text);
    assert.ok(ok.body.access_token);
    // no implicit / password / client_credentials grants
    for (const g of ['password', 'client_credentials', 'implicit']) {
      assert.equal((await post('/oauth/token', { grant_type: g, username: 'a', password: 'b', ...creds })).body.error, 'unsupported_grant_type');
    }
    assert.equal((await post('/oauth/token', { ...creds })).body.error, 'invalid_request');
  });

  test('public client: PKCE mandatory, wrong / missing verifier rejected, no secret, CORS', async () => {
    const dev = await newUser();
    const user = await newUser();
    const app = await createClient(dev.api, { type: 'public' });
    const { verifier, challenge } = pkce();
    const { code } = await getCode(user, app, { challenge });
    assert.equal((await exchange(app, code, { client_id: app.client_id })).body.error, 'invalid_grant', 'missing verifier');
    const { code: code2 } = await getCode(user, app, { challenge });
    assert.equal((await exchange(app, code2, { client_id: app.client_id, code_verifier: pkce().verifier })).body.error, 'invalid_grant', 'wrong verifier');
    assert.equal((await exchange(app, code2, { client_id: app.client_id, code_verifier: verifier })).body.error, 'invalid_grant', 'code burnt');
    const { code: code3 } = await getCode(user, app, { challenge });
    assert.equal((await exchange(app, code3, { client_id: app.client_id, code_verifier: verifier, client_secret: 'x' })).body.error, 'invalid_client');
    const ok = await exchange(app, code3, { client_id: app.client_id, code_verifier: verifier });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.headers.get('access-control-allow-origin'), '*');
    assert.equal(ok.headers.get('access-control-allow-credentials'), null);
    // refresh with client_id only
    const r2 = await refresh(app, ok.body.refresh_token, { client_id: app.client_id });
    assert.equal(r2.status, 200, r2.text);
    // preflight
    const pre = await fetch(`${ctx.base}/oauth/token`, { method: 'OPTIONS', headers: { origin: 'https://spa.example.com', 'access-control-request-method': 'POST' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    // introspection is for confidential clients only
    assert.equal((await post('/oauth/introspect', { token: r2.body.access_token, client_id: app.client_id })).status, 401);
    // a public client can revoke its own tokens
    assert.equal((await post('/oauth/revoke', { token: r2.body.refresh_token, client_id: app.client_id })).status, 200);
    assert.equal((await v1(r2.body.access_token, 'GET', '/me')).status, 401);
  });

  test('code replay revokes the tokens issued from it; expired code; redirect_uri and client binding', async () => {
    const dev = await newUser();
    const user = await newUser();
    const app = await createClient(dev.api);
    const other = await createClient(dev.api);
    const { code } = await getCode(user, app);
    const first = await exchange(app, code);
    assert.equal(first.status, 200);
    const replay = await exchange(app, code);
    assert.equal(replay.body.error, 'invalid_grant');
    assert.equal((await v1(first.body.access_token, 'GET', '/me')).status, 401);
    assert.equal((await refresh(app, first.body.refresh_token)).body.error, 'invalid_grant');

    const { code: expired } = await getCode(user, app);
    await db.updateTable('oauth_codes').set({ expires_at: sql`now() - interval '1 second'` }).where('code_hash', '=', sha256(expired)).execute();
    assert.equal((await exchange(app, expired)).body.error, 'invalid_grant');

    const { code: c3 } = await getCode(user, app);
    assert.equal((await exchange(app, c3, { redirect_uri: 'https://app.example.com/other' })).body.error, 'invalid_grant');
    const { code: c4 } = await getCode(user, app);
    assert.equal((await exchange(other, c4)).body.error, 'invalid_grant', 'code of another client');
    assert.equal((await exchange(app, 'scalo_ac_unknown')).body.error, 'invalid_grant');
  });

  test('refresh: narrower scope allowed, broader scope rejected; no refresh token without offline_access', async () => {
    const dev = await newUser();
    const user = await newUser();
    const app = await createClient(dev.api);
    const t = await tokensFor(user, app, 'contacts:read offline_access');
    const up = await refresh(app, t.refresh_token!, { scope: 'contacts:read contacts:write offline_access' });
    assert.equal(up.status, 400);
    assert.equal(up.body.error, 'invalid_scope');
    const narrow = await refresh(app, t.refresh_token!, { scope: 'contacts:read' });
    assert.equal(narrow.status, 200, narrow.text);
    assert.equal(narrow.body.scope, 'contacts:read');
    assert.ok(narrow.body.refresh_token, 'the new refresh token keeps the original grant');
    const again = await refresh(app, narrow.body.refresh_token);
    assert.equal(again.body.scope, 'contacts:read offline_access');

    const noOffline = await tokensFor(user, app, 'profile');
    assert.equal(noOffline.refresh_token, undefined);
  });

  test('introspection (own tokens only) and revocation', async () => {
    const dev = await newUser();
    const user = await newUser();
    const app = await createClient(dev.api);
    const otherApp = await createClient(dev.api);
    const t = await tokensFor(user, app);
    const intro = await post('/oauth/introspect', { token: t.access_token }, { basic: [app.client_id, app.client_secret!] });
    assert.equal(intro.status, 200);
    assert.equal(intro.body.active, true);
    assert.equal(intro.body.client_id, app.client_id);
    assert.equal(intro.body.username, user.email);
    assert.equal(intro.body.sub, String(user.user.id));
    assert.equal(intro.body.token_type, 'access_token');
    assert.equal(intro.body.iss, ISS);
    assert.ok(intro.body.exp > Date.now() / 1000);
    // another client learns nothing about it
    assert.deepEqual((await post('/oauth/introspect', { token: t.access_token }, { basic: [otherApp.client_id, otherApp.client_secret!] })).body, { active: false });
    assert.deepEqual((await post('/oauth/introspect', { token: 'scalo_at_nope' }, { basic: [app.client_id, app.client_secret!] })).body, { active: false });
    // revoking someone else's token: 200, no effect
    assert.equal((await post('/oauth/revoke', { token: t.access_token }, { basic: [otherApp.client_id, otherApp.client_secret!] })).status, 200);
    assert.equal((await v1(t.access_token, 'GET', '/me')).status, 200);
    // revoke the access token only
    assert.equal((await post('/oauth/revoke', { token: t.access_token, token_type_hint: 'access_token' }, { basic: [app.client_id, app.client_secret!] })).status, 200);
    assert.equal((await v1(t.access_token, 'GET', '/me')).status, 401);
    assert.equal((await post('/oauth/introspect', { token: t.access_token }, { basic: [app.client_id, app.client_secret!] })).body.active, false);
    // revoking the refresh token revokes the grant (refresh + its access tokens)
    const r2 = await refresh(app, t.refresh_token!);
    assert.equal(r2.status, 200);
    assert.equal((await post('/oauth/revoke', { token: r2.body.refresh_token }, { basic: [app.client_id, app.client_secret!] })).status, 200);
    assert.equal((await v1(r2.body.access_token, 'GET', '/me')).status, 401);
    assert.equal((await refresh(app, r2.body.refresh_token)).body.error, 'invalid_grant');
    assert.equal((await post('/oauth/revoke', {}, { basic: [app.client_id, app.client_secret!] })).body.error, 'invalid_request');
  });

  test('token endpoint is rate limited per client and IP', async () => {
    const dev = await newUser();
    const app = await createClient(dev.api);
    const rs = await Promise.all(Array.from({ length: 61 }, () => post('/oauth/token', { grant_type: 'refresh_token', refresh_token: 'scalo_rt_x' }, { basic: [app.client_id, app.client_secret!] })));
    assert.equal(rs.filter((r) => r.status === 400).length, 60);
    const limited = rs.find((r) => r.status === 429)!;
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  });
});

describe('user side: connected applications', () => {
  test('revoking an app invalidates its tokens and forgets the consent', async () => {
    const dev = await newUser();
    const user = await newUser();
    const app = await createClient(dev.api, { name: 'Intégration' });
    const t = await tokensFor(user, app);
    await v1(t.access_token, 'GET', '/me');
    const list = await user.api.get('/api/oauth/authorizations');
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].client.name, 'Intégration');
    assert.deepEqual(list.body[0].scopes, ['profile', 'contacts:read', 'offline_access']);
    assert.ok(list.body[0].last_used_at);
    assert.equal((await dev.api.get(`/api/developer/apps/${app.id}`)).body.authorizations_count, 1);
    // someone else can't revoke it
    assert.equal((await dev.api.del(`/api/oauth/authorizations/${app.client_id}`)).status, 404);
    assert.equal((await user.api.del(`/api/oauth/authorizations/${app.client_id}`)).status, 200);
    assert.equal((await v1(t.access_token, 'GET', '/me')).status, 401);
    assert.equal((await refresh(app, t.refresh_token!)).body.error, 'invalid_grant');
    assert.equal((await user.api.get('/api/oauth/authorizations')).body.length, 0);
    // the consent screen is shown again
    const id = requestIdOf(await authorize({ response_type: 'code', client_id: app.client_id, redirect_uri: REDIRECT, scope: 'profile' }));
    assert.equal((await user.api.get(`/api/oauth/requests/${id}`)).body.remembered, false);
  });

  test('deleting a client revokes all its tokens; narrowing its scopes applies to existing tokens', async () => {
    const dev = await newUser();
    const user = await newUser();
    const app = await createClient(dev.api);
    const t = await tokensFor(user, app, 'profile contacts:read offline_access');
    assert.equal((await dev.api.patch(`/api/developer/apps/${app.id}`, { scopes: ['profile', 'offline_access'] })).status, 200);
    assert.equal((await v1(t.access_token, 'GET', '/contacts')).status, 403);
    assert.equal((await v1(t.access_token, 'GET', '/me')).status, 200);
    assert.equal((await dev.api.del(`/api/developer/apps/${app.id}`)).status, 200);
    assert.equal((await v1(t.access_token, 'GET', '/me')).status, 401);
    assert.equal((await refresh(app, t.refresh_token!)).body.error, 'invalid_client');
    assert.equal((await user.api.get('/api/oauth/authorizations')).body.length, 0);
  });
});

describe('public API /api/v1', () => {
  test('authentication errors: missing / invalid token, session JWT refused; insufficient_scope', async () => {
    const dev = await newUser();
    const user = await newUser();
    const app = await createClient(dev.api);
    const missing = await http(ctx, 'GET', '/api/v1/me');
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get('www-authenticate'), 'Bearer realm="scalo"');
    const bad = await v1('scalo_at_invalid', 'GET', '/me');
    assert.equal(bad.status, 401);
    assert.match(bad.headers.get('www-authenticate')!, /error="invalid_token"/);
    assert.equal((await v1(user.token, 'GET', '/me')).status, 401, 'a session JWT is not an access token');
    const t = await tokensFor(user, app, 'contacts:read');
    for (const [m, p, scope] of [
      ['GET', '/me', 'profile'],
      ['GET', '/funnels', 'funnels:read'],
      ['POST', '/contacts', 'contacts:write'],
      ['GET', '/broadcasts', 'emails:read'],
    ] as const) {
      const r = await v1(t.access_token, m, p, m === 'POST' ? { email: 'a@b.fr' } : undefined);
      assert.equal(r.status, 403, p);
      assert.equal(r.body.error, 'insufficient_scope');
      assert.equal(r.body.scope, scope);
      assert.match(r.headers.get('www-authenticate')!, new RegExp(`error="insufficient_scope".*scope="${scope}"`));
    }
    // expired token
    await db.updateTable('oauth_tokens').set({ expires_at: sql`now() - interval '1 second'` }).where('token_hash', '=', sha256(t.access_token)).execute();
    assert.equal((await v1(t.access_token, 'GET', '/contacts')).status, 401);
  });

  test('contacts, tags (trigger campaigns), funnels, emails, enroll — same rules as the app', async () => {
    const dev = await newUser();
    const user = await newUser();
    const app = await createClient(dev.api);
    const t = await tokensFor(user, app, ALL_SCOPES.join(' '));
    const tok = t.access_token;
    // a campaign triggered by the tag "client"
    const tag = await user.api.post('/api/tags', { name: 'client' });
    const camp = await user.api.post('/api/campaigns', { name: 'Onboarding', trigger_tag_id: tag.body.id });
    await user.api.post(`/api/campaigns/${camp.body.id}/emails`, { subject: 'Bienvenue', delay_days: 0 });

    const created = await v1(tok, 'POST', '/contacts', { email: 'Lea@Mail.fr', first_name: 'Léa' });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.body.email, 'lea@mail.fr');
    const upsert = await v1(tok, 'POST', '/contacts', { email: 'lea@mail.fr', last_name: 'Martin' });
    assert.equal(upsert.status, 200);
    assert.equal(upsert.body.id, created.body.id);
    assert.equal(upsert.body.first_name, 'Léa');
    assert.equal(upsert.body.last_name, 'Martin');

    const tagged = await v1(tok, 'POST', `/contacts/${created.body.id}/tags`, { name: 'Client' });
    assert.equal(tagged.status, 200);
    assert.deepEqual(tagged.body.tags.map((x: { name: string }) => x.name), ['client']);
    const subs = await user.api.get(`/api/campaigns/${camp.body.id}/subscribers`);
    assert.equal(subs.body.total, 1, 'tag added through the API enrolled the contact');

    const list = await v1(tok, 'GET', `/contacts?search=lea&tag_id=${tag.body.id}&limit=10`);
    assert.equal(list.body.total, 1);
    assert.equal(list.body.limit, 10);
    assert.equal((await v1(tok, 'GET', '/contacts?limit=500')).status, 400);
    assert.equal((await v1(tok, 'GET', `/contacts/${created.body.id}`)).body.email, 'lea@mail.fr');
    const patched = await v1(tok, 'PATCH', `/contacts/${created.body.id}`, { phone: '0600000000' });
    assert.equal(patched.body.phone, '0600000000');
    assert.equal((await v1(tok, 'DELETE', `/contacts/${created.body.id}/tags/${tag.body.id}`)).body.tags.length, 0);
    const tags = await v1(tok, 'GET', '/tags');
    assert.equal(tags.body[0].name, 'client');

    // another account's data is invisible
    const stranger = await newUser();
    const theirs = await stranger.api.post('/api/contacts', { email: 'secret@mail.fr' });
    assert.equal((await v1(tok, 'GET', `/contacts/${theirs.body.id}`)).status, 404);
    assert.equal((await v1(tok, 'DELETE', `/contacts/${theirs.body.id}`)).status, 404);

    // enroll
    const other = await v1(tok, 'POST', '/contacts', { email: 'paul@mail.fr' });
    const enr = await v1(tok, 'POST', `/campaigns/${camp.body.id}/enroll`, { contact_id: other.body.id });
    assert.equal(enr.status, 200, enr.text);
    assert.equal(enr.body.enrolled, true);
    assert.equal((await v1(tok, 'POST', `/campaigns/${camp.body.id}/enroll`, { contact_id: other.body.id })).body.enrolled, false);

    await user.api.post('/api/funnels', { name: 'Webinar', template: 'optin' });
    const funnels = await v1(tok, 'GET', '/funnels');
    assert.equal(funnels.status, 200);
    assert.equal(funnels.body[0].name, 'Webinar');
    assert.ok(funnels.body[0].steps.length > 0);
    assert.equal(funnels.body[0].steps[0].content, undefined);
    assert.equal(typeof funnels.body[0].steps[0].views, 'number');
    await user.api.post('/api/broadcasts', { subject: 'News' });
    const bc = await v1(tok, 'GET', '/broadcasts');
    assert.equal(bc.body[0].subject, 'News');
    assert.ok(bc.body[0].stats);
    assert.equal(bc.body[0].content, undefined);
    assert.equal((await v1(tok, 'GET', '/campaigns')).body[0].name, 'Onboarding');

    assert.equal((await v1(tok, 'DELETE', `/contacts/${created.body.id}`)).status, 200);
    assert.equal((await v1(tok, 'GET', '/nope')).status, 404);
  });

  test('rate limit per authorization: 120 requests / min, X-RateLimit-* headers, 429 + Retry-After', async () => {
    const dev = await newUser();
    const user = await newUser();
    const app = await createClient(dev.api);
    const t = await tokensFor(user, app);
    const first = await v1(t.access_token, 'GET', '/me');
    assert.equal(first.headers.get('x-ratelimit-limit'), '120');
    assert.equal(first.headers.get('x-ratelimit-remaining'), '119');
    for (let i = 0; i < 119; i += 20) {
      const batch = await Promise.all(Array.from({ length: Math.min(20, 119 - i) }, () => v1(t.access_token, 'GET', '/me')));
      assert.ok(batch.every((r) => r.status === 200));
    }
    const limited = await v1(t.access_token, 'GET', '/me');
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, 'rate_limited');
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal(limited.headers.get('x-ratelimit-remaining'), '0');
    // a refreshed token shares the same budget
    const r2 = await refresh(app, t.refresh_token!);
    assert.equal((await v1(r2.body.access_token, 'GET', '/me')).status, 429);
  });
});

test('cleanup removes expired requests, codes and tokens', async () => {
  const dev = await newUser();
  const user = await newUser();
  const app = await createClient(dev.api);
  await tokensFor(user, app);
  requestIdOf(await authorize({ response_type: 'code', client_id: app.client_id, redirect_uri: REDIRECT, scope: 'profile' }));
  await db.updateTable('oauth_tokens').set({ expires_at: sql`now() - interval '2 days'` }).where('client_id', '=', app.id).execute();
  await db.updateTable('oauth_codes').set({ expires_at: sql`now() - interval '2 days'` }).where('client_id', '=', app.id).execute();
  await db.updateTable('oauth_authorization_requests').set({ expires_at: sql`now() - interval '2 hours'` }).where('client_id', '=', app.id).execute();
  await cleanupOAuth();
  for (const t of ['oauth_tokens', 'oauth_codes', 'oauth_authorization_requests'] as const) {
    assert.equal((await db.selectFrom(t).select('client_id').where('client_id', '=', app.id).execute()).length, 0, t);
  }
});
