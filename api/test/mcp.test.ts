// MCP server: Streamable HTTP on POST /mcp, authenticated with the OAuth access tokens of the authorization server.
// End to end with the official MCP client against the real app + PostgreSQL.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { db } from '../src/db';
import { env } from '../src/env';
import { MCP_TOOLS } from '../src/routes/mcp';
import { client, http, registerUser, shutdown, startApp, type TestCtx } from './helpers';

let ctx: TestCtx;
before(async () => {
  ctx = await startApp();
});
after(() => shutdown(ctx));
beforeEach(async () => {
  await db.deleteFrom('auth_attempts').execute();
});

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const ALL = ['profile', 'contacts:read', 'contacts:write', 'tags:write', 'funnels:read', 'emails:read', 'campaigns:write', 'purchases:write'];
const METADATA = `${env.PUBLIC_URL}/.well-known/oauth-protected-resource`;

/** New account + application + access token with `scopes` (authorize → consent → code → token). */
async function connect(scopes: string[] = ALL) {
  const u = await registerUser(ctx);
  const api = client(ctx, u.token);
  const app = await api.post('/api/developer/apps', { name: 'Claude', type: 'confidential', redirect_uris: [REDIRECT], scopes });
  assert.equal(app.status, 201, app.text);
  // `resource` (RFC 8707, sent by MCP clients) must not break the authorization request
  const q = new URLSearchParams({ response_type: 'code', client_id: app.body.client_id, redirect_uri: REDIRECT, scope: scopes.join(' '), resource: `${env.PUBLIC_URL}/mcp` });
  const a = await http(ctx, 'GET', `/oauth/authorize?${q}`);
  assert.equal(a.status, 302, a.text);
  const requestId = new URL(a.headers.get('location')!).searchParams.get('request')!;
  const consent = await api.post('/api/oauth/consent', { request_id: requestId, decision: 'approve' });
  assert.equal(consent.status, 200, consent.text);
  const code = new URL(consent.body.redirect_to).searchParams.get('code')!;
  const tok = await http(ctx, 'POST', '/oauth/token', {
    form: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: app.body.client_id, client_secret: app.body.client_secret },
  });
  assert.equal(tok.status, 200, tok.text);
  return { ...u, api, token: tok.body.access_token as string };
}

async function mcp(token: string) {
  const c = new Client({ name: 'test', version: '1.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${ctx.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
}

/** Calls a tool; returns the parsed JSON result, or `{ error }` for a tool error. */
async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await c.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  const text = r.content[0].text;
  return r.isError ? { error: text } : JSON.parse(text);
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
const rawPost = (headers: Record<string, string>) =>
  fetch(`${ctx.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(INIT) });

test('protected resource metadata (RFC 9728) points to the authorization server', async () => {
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const r = await http(ctx, 'GET', path);
    assert.equal(r.status, 200);
    assert.equal(r.body.resource, `${env.PUBLIC_URL}/mcp`);
    assert.deepEqual(r.body.authorization_servers, [env.PUBLIC_URL]);
    assert.ok(r.body.scopes_supported.includes('contacts:read'));
    assert.deepEqual(r.body.bearer_methods_supported, ['header']);
  }
  const as = await http(ctx, 'GET', '/.well-known/oauth-authorization-server');
  assert.equal(as.body.issuer, env.PUBLIC_URL);
});

test('no token / bad token → 401 with a WWW-Authenticate challenge carrying resource_metadata', async () => {
  const none = await rawPost({});
  assert.equal(none.status, 401);
  assert.equal(none.headers.get('www-authenticate'), `Bearer realm="scalo", resource_metadata="${METADATA}"`);
  assert.equal(none.headers.get('cache-control'), 'no-store');

  for (const bad of ['Bearer scalo_at_doesnotexist', `Bearer ${(await registerUser(ctx)).token}`]) {
    const r = await rawPost({ authorization: bad });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('www-authenticate'), `Bearer realm="scalo", error="invalid_token", resource_metadata="${METADATA}"`);
  }
  const malformed = await rawPost({ authorization: 'Basic abc' });
  assert.equal(malformed.status, 401);
  assert.match(malformed.headers.get('www-authenticate')!, /error="invalid_request"/);

  // GET (server-to-client stream) also needs a token; with one, the stateless server only accepts POST
  assert.equal((await fetch(`${ctx.base}/mcp`)).status, 401);
  const { token } = await connect(['profile']);
  assert.equal((await fetch(`${ctx.base}/mcp`, { headers: { authorization: `Bearer ${token}` } })).status, 405);
});

test('a revoked token is refused', async () => {
  const u = await connect(['profile']);
  const c = await mcp(u.token);
  assert.equal((await call(c, 'get_account')).email, u.email);
  await db.updateTable('oauth_tokens').set({ revoked_at: new Date() }).execute();
  assert.equal((await rawPost({ authorization: `Bearer ${u.token}` })).status, 401);
});

test('tools are listed with their schemas', async () => {
  const c = await mcp((await connect()).token);
  const { tools } = await c.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), MCP_TOOLS.map((t) => t.name).sort());
  for (const name of ['list_contacts', 'create_contact', 'update_contact', 'list_tags', 'list_segments', 'list_funnels', 'list_newsletters', 'list_campaigns', 'enroll_in_campaign', 'record_purchase']) {
    assert.ok(tools.some((t) => t.name === name), name);
  }
  const create = tools.find((t) => t.name === 'create_contact')!;
  assert.deepEqual(create.inputSchema.required, ['email']);
  assert.equal(create.annotations?.readOnlyHint, false);
  assert.equal(tools.find((t) => t.name === 'list_contacts')!.annotations?.readOnlyHint, true);
});

test('end to end: contacts, tags, funnels, campaigns, purchases through the API v1 services', async () => {
  const u = await connect();
  const c = await mcp(u.token);

  const created = await call(c, 'create_contact', { email: 'Ada@Example.com', first_name: 'Ada', tags: ['vip'] });
  assert.equal(created.email, 'ada@example.com');
  assert.deepEqual(created.tags.map((t: any) => t.name), ['vip']);
  // upsert by email, like POST /api/v1/contacts
  assert.equal((await call(c, 'create_contact', { email: 'ada@example.com', last_name: 'Lovelace' })).id, created.id);

  const updated = await call(c, 'update_contact', { contact_id: created.id, phone: '0102030405' });
  assert.deepEqual([updated.last_name, updated.phone], ['Lovelace', '0102030405']);
  assert.equal((await call(c, 'get_contact', { contact_id: created.id })).first_name, 'Ada');

  await call(c, 'create_contact', { email: 'bob@example.com' });
  const found = await call(c, 'list_contacts', { search: 'ada' });
  assert.deepEqual([found.total, found.items.length, found.items[0].email], [1, 1, 'ada@example.com']);
  assert.equal((await call(c, 'list_contacts', { limit: 1 })).items.length, 1);

  const tagged = await call(c, 'add_tag_to_contact', { contact_id: created.id, name: 'client' });
  assert.deepEqual(tagged.tags.map((t: any) => t.name).sort(), ['client', 'vip']);
  const tags = await call(c, 'list_tags');
  assert.deepEqual(tags.map((t: any) => [t.name, t.contacts_count]), [['client', 1], ['vip', 1]]);
  const vip = tags.find((t: any) => t.name === 'vip');
  assert.deepEqual((await call(c, 'remove_tag_from_contact', { contact_id: created.id, tag_id: vip.id })).tags.map((t: any) => t.name), ['client']);

  // data created in the app is visible through the tools
  const funnel = await u.api.post('/api/funnels', { name: 'Mon tunnel', template: 'optin' });
  assert.equal(funnel.status, 201, funnel.text);
  const funnels = await call(c, 'list_funnels');
  assert.deepEqual([funnels.length, funnels[0].name, funnels[0].steps.length, funnels[0].views], [1, 'Mon tunnel', 2, 0]);

  const campaign = await u.api.post('/api/campaigns', { name: 'Bienvenue' });
  assert.equal(campaign.status, 201, campaign.text);
  assert.deepEqual((await call(c, 'list_campaigns')).map((x: any) => x.name), ['Bienvenue']);
  assert.deepEqual(await call(c, 'enroll_in_campaign', { campaign_id: campaign.body.id, contact_id: created.id }), { ok: true, enrolled: true });
  assert.equal((await db.selectFrom('campaign_subscriptions').select('contact_id').where('campaign_id', '=', campaign.body.id).execute()).length, 1);

  await u.api.post('/api/broadcasts', { subject: 'Hello' });
  assert.deepEqual((await call(c, 'list_newsletters')).map((b: any) => [b.subject, b.status]), [['Hello', 'draft']]);
  assert.deepEqual(await call(c, 'list_segments'), []);

  const purchase = await call(c, 'record_purchase', { contact_id: created.id, product: 'Formation', amount: 97, currency: 'EUR', external_id: 'cmd-1' });
  assert.equal(purchase.purchase.product, 'Formation');
  assert.equal((await call(c, 'record_purchase', { contact_id: created.id, product: 'Formation', external_id: 'cmd-1' })).purchase.id, purchase.purchase.id, 'idempotent');

  // errors of the API come back as tool errors (validation, not found)
  assert.match((await call(c, 'create_contact', { email: 'pas-un-email' })).error, /Erreur 400/);
  assert.match((await call(c, 'get_contact', { contact_id: 999999 })).error, /Erreur 404 : Contact introuvable/);
  // arguments outside the tool schema never reach the API
  const invalid = (await c.callTool({ name: 'get_contact', arguments: { contact_id: 'abc' } }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }))) as { isError?: boolean };
  assert.equal(invalid.isError, true);
});

test('insufficient scope: the tool refuses, nothing is written', async () => {
  const u = await connect(['profile', 'contacts:read']);
  const c = await mcp(u.token);
  assert.deepEqual(await call(c, 'list_contacts'), { items: [], total: 0, page: 1, limit: 50 });
  for (const [name, args, scope] of [
    ['create_contact', { email: 'x@example.com' }, 'contacts:write'],
    ['list_funnels', {}, 'funnels:read'],
    ['list_campaigns', {}, 'emails:read'],
    ['record_purchase', { email: 'x@example.com', product: 'P' }, 'purchases:write'],
  ] as const) {
    const r = await call(c, name, args);
    assert.match(r.error, new RegExp(`Scope « ${scope} » requis`), name);
  }
  assert.equal((await u.api.get('/api/contacts')).body.total, 0);

  // a scope required by the API for one argument only (tags need tags:write) is enforced by the API itself
  const w = await connect(['contacts:read', 'contacts:write']);
  const r = await call(await mcp(w.token), 'create_contact', { email: 'y@example.com', tags: ['vip'] });
  assert.match(r.error, /Erreur 403 : .*tags:write/);
  assert.equal((await w.api.get('/api/contacts')).body.total, 0);
});

test('isolation between accounts', async () => {
  const a = await connect();
  const b = await connect();
  const ca = await mcp(a.token);
  const cb = await mcp(b.token);
  const contact = await call(ca, 'create_contact', { email: 'secret@a.com', tags: ['a-only'] });
  const campaign = await a.api.post('/api/campaigns', { name: 'Campagne A' });

  assert.equal((await call(cb, 'list_contacts')).total, 0);
  assert.deepEqual(await call(cb, 'list_tags'), []);
  assert.deepEqual(await call(cb, 'list_campaigns'), []);
  assert.match((await call(cb, 'get_contact', { contact_id: contact.id })).error, /Erreur 404/);
  assert.match((await call(cb, 'update_contact', { contact_id: contact.id, first_name: 'Hacked' })).error, /Erreur 404/);
  assert.match((await call(cb, 'add_tag_to_contact', { contact_id: contact.id, name: 'x' })).error, /Erreur 404/);
  assert.match((await call(cb, 'record_purchase', { contact_id: contact.id, product: 'P' })).error, /Erreur 404/);
  const own = await call(cb, 'create_contact', { email: 'b@b.com' });
  assert.match((await call(cb, 'enroll_in_campaign', { campaign_id: campaign.body.id, contact_id: own.id })).error, /Erreur 404/);

  assert.equal((await call(ca, 'get_contact', { contact_id: contact.id })).first_name, null);
  assert.equal((await call(ca, 'get_account')).email, a.email);
  assert.equal((await call(cb, 'get_account')).email, b.email);
});
