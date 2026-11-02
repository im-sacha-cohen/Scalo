// Workspaces: several separate businesses per person (accounts table, X-Scalo-Workspace header), and MCP connections
// bound to one workspace (resource = /mcp/<id>, consent screen, endpoint check).
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { db } from '../src/db';
import { env } from '../src/env';
import { client, http, registerUser, shutdown, startApp, type TestCtx } from './helpers';

let ctx: TestCtx;
before(async () => {
  ctx = await startApp();
});
after(() => shutdown(ctx));
beforeEach(async () => {
  await db.deleteFrom('auth_attempts').execute();
});

const PASSWORD = 'secret123';

async function person(name = 'Camille') {
  const u = await registerUser(ctx, name);
  return { ...u, api: client(ctx, u.token) };
}

async function newWorkspace(p: Awaited<ReturnType<typeof person>>, name: string) {
  const r = await p.api.post('/api/workspaces', { name });
  assert.equal(r.status, 201, r.text);
  return { id: r.body.id as number, api: client(ctx, p.token, r.body.id) };
}

describe('espaces de travail', () => {
  test('le compte de départ est le premier espace ; un nouvel espace a ses propres données', async () => {
    const p = await person('Camille');
    const list = await p.api.get('/api/workspaces');
    assert.equal(list.status, 200, list.text);
    assert.equal(list.body.current, p.user.id);
    assert.deepEqual(
      list.body.workspaces.map((w: any) => [w.id, w.name, w.role, w.personal]),
      [[p.user.id, 'Camille', 'owner', true]],
    );
    assert.equal(list.body.can_create, true);

    const agence = await newWorkspace(p, 'Agence Nova');
    assert.notEqual(agence.id, p.user.id);
    assert.equal((await agence.api.get('/api/workspaces')).body.current, agence.id);

    assert.equal((await p.api.post('/api/contacts', { email: 'perso@mail.fr' })).status, 201);
    assert.equal((await agence.api.post('/api/contacts', { email: 'client@mail.fr' })).status, 201);
    assert.deepEqual((await p.api.get('/api/contacts')).body.items.map((c: any) => c.email), ['perso@mail.fr']);
    assert.deepEqual((await agence.api.get('/api/contacts')).body.items.map((c: any) => c.email), ['client@mail.fr']);
    // same email, other business: allowed (unique per account)
    assert.equal((await agence.api.post('/api/contacts', { email: 'perso@mail.fr' })).status, 201);

    // settings: sender defaults to the name of the workspace and the address of its owner
    const settings = await agence.api.get('/api/settings');
    assert.equal(settings.body.sender_name, 'Agence Nova');
    assert.equal(settings.body.sender_email, p.email);

    // the signed-in person stays the same; the account is the workspace
    const edition = await agence.api.get('/api/edition');
    assert.equal(edition.body.actor.id, p.user.id);
    assert.deepEqual(edition.body.account, { id: agence.id, name: 'Agence Nova', email: p.email });
    assert.equal(edition.body.role, 'owner');

    const renamed = await p.api.patch(`/api/workspaces/${agence.id}`, { name: 'Agence Nova Paris' });
    assert.equal(renamed.status, 200, renamed.text);
    assert.deepEqual(
      (await p.api.get('/api/workspaces')).body.workspaces.map((w: any) => w.name),
      ['Camille', 'Agence Nova Paris'],
    );
  });

  test('impossible de travailler dans l’espace de quelqu’un d’autre', async () => {
    const a = await person();
    const b = await person();
    const ws = await newWorkspace(a, 'Privé');
    await ws.api.post('/api/contacts', { email: 'secret@mail.fr' });

    const intruder = client(ctx, b.token, ws.id);
    const r = await intruder.get('/api/contacts');
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'workspace_unavailable');
    assert.equal((await client(ctx, b.token, a.user.id).get('/api/contacts')).status, 403, 'compte de départ de A');
    assert.equal((await b.api.patch(`/api/workspaces/${ws.id}`, { name: 'Volé' })).status, 404);
    assert.equal((await http(ctx, 'GET', '/api/contacts', { token: b.token, headers: { 'x-scalo-workspace': 'abc' } })).status, 400);
    assert.deepEqual(
      (await b.api.get('/api/workspaces')).body.workspaces.map((w: any) => w.id),
      [b.user.id],
    );
  });

  test('supprimer un espace ne supprime que lui ; supprimer le compte de départ supprime tout', async () => {
    const p = await person();
    const ws = await newWorkspace(p, 'Boutique');
    const other = await newWorkspace(p, 'Coaching');
    await p.api.post('/api/contacts', { email: 'reste@mail.fr' });
    await ws.api.post('/api/contacts', { email: 'part@mail.fr' });
    await other.api.post('/api/contacts', { email: 'part-aussi@mail.fr' });

    const summary = await ws.api.get('/api/account/summary');
    assert.equal(summary.status, 200, summary.text);
    assert.deepEqual(summary.body.workspace, { name: 'Boutique', personal: false, others: 0 });
    assert.equal(summary.body.email, p.email);

    const del = await ws.api.post('/api/account/delete', { password: PASSWORD, confirm: p.email });
    assert.equal(del.status, 200, del.text);
    assert.equal(del.body.deleted.contacts, 1);
    assert.equal((await ws.api.get('/api/contacts')).body.code, 'workspace_unavailable');
    assert.equal((await p.api.get('/api/auth/me')).status, 200, 'la personne reste connectée');
    assert.deepEqual((await p.api.get('/api/contacts')).body.items.map((c: any) => c.email), ['reste@mail.fr']);

    const all = await p.api.get('/api/account/summary');
    assert.deepEqual(all.body.workspace, { name: 'Camille', personal: true, others: 1 });
    const gone = await p.api.post('/api/account/delete', { password: PASSWORD, confirm: p.email });
    assert.equal(gone.status, 200, gone.text);
    assert.equal(gone.body.deleted.contacts, 2, 'compte de départ + Coaching');
    assert.equal((await db.selectFrom('accounts').select('id').where('owner_id', '=', p.user.id).execute()).length, 0);
    assert.equal((await db.selectFrom('contacts').select('id').where('user_id', '=', other.id).execute()).length, 0);
    assert.equal((await p.api.get('/api/auth/me')).status, 401);
  });
});

// ---------- MCP ----------

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const SCOPES = ['profile', 'contacts:read', 'contacts:write'];

async function app(p: Awaited<ReturnType<typeof person>>) {
  const r = await p.api.post('/api/developer/apps', { name: 'Claude', type: 'confidential', redirect_uris: [REDIRECT], scopes: SCOPES });
  assert.equal(r.status, 201, r.text);
  return r.body as { client_id: string; client_secret: string };
}

async function authorize(clientId: string, resource?: string) {
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: SCOPES.join(' '), ...(resource ? { resource } : {}) });
  const a = await http(ctx, 'GET', `/oauth/authorize?${q}`);
  assert.equal(a.status, 302, a.text);
  return new URL(a.headers.get('location')!);
}

async function exchange(c: { client_id: string; client_secret: string }, redirectTo: string) {
  const code = new URL(redirectTo).searchParams.get('code')!;
  const tok = await http(ctx, 'POST', '/oauth/token', { form: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: c.client_id, client_secret: c.client_secret } });
  assert.equal(tok.status, 200, tok.text);
  return tok.body.access_token as string;
}

async function mcp(token: string, path = '/mcp') {
  const c = new Client({ name: 'test', version: '1.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${ctx.base}${path}`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await c.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  return r.isError ? { error: r.content[0].text } : JSON.parse(r.content[0].text);
}

/** Last content block (several workspaces: the first one names the workspace). */
async function callLast(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await c.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  return r.isError ? { error: r.content.at(-1)!.text } : JSON.parse(r.content.at(-1)!.text);
}

describe('MCP par espace de travail', () => {
  test('/mcp/<id> : la connexion est liée à cet espace, imposé sur l’écran de consentement', async () => {
    const p = await person('Camille');
    const ws = await newWorkspace(p, 'Agence');
    await ws.api.post('/api/contacts', { email: 'client@mail.fr' });
    await p.api.post('/api/contacts', { email: 'perso@mail.fr' });

    const meta = await http(ctx, 'GET', `/.well-known/oauth-protected-resource/mcp/${ws.id}`);
    assert.equal(meta.body.resource, `${env.PUBLIC_URL}/mcp/${ws.id}`);
    const challenge = await http(ctx, 'POST', `/mcp/${ws.id}`, { json: {} });
    assert.equal(challenge.status, 401);
    assert.match(challenge.headers.get('www-authenticate')!, new RegExp(`oauth-protected-resource/mcp/${ws.id}"`));

    const c = await app(p);
    const requestId = (await authorize(c.client_id, `${env.PUBLIC_URL}/mcp/${ws.id}`)).searchParams.get('request')!;
    // shown while working in the first account: the workspace is still imposed
    const shown = await p.api.get(`/api/oauth/requests/${encodeURIComponent(requestId)}`);
    assert.equal(shown.status, 200, shown.text);
    assert.deepEqual(shown.body.workspace, { id: ws.id, name: 'Agence', locked: true });
    // someone else cannot grant it
    const b = await person();
    assert.equal((await b.api.get(`/api/oauth/requests/${encodeURIComponent(requestId)}`)).status, 403);
    assert.equal((await b.api.post('/api/oauth/consent', { request_id: requestId, decision: 'approve' })).status, 403);
    // picking another workspace is ignored when the client imposed one
    const ok = await p.api.post('/api/oauth/consent', { request_id: requestId, decision: 'approve', workspace_id: p.user.id });
    assert.equal(ok.status, 200, ok.text);
    const token = await exchange(c, ok.body.redirect_to);

    const m = await mcp(token, `/mcp/${ws.id}`);
    assert.match(m.getInstructions() ?? '', /« Agence »/);
    assert.deepEqual(await call(m, 'get_account').then((a) => [a.id, a.name]), [ws.id, 'Agence']);
    assert.deepEqual((await call(m, 'list_contacts')).items.map((x: any) => x.email), ['client@mail.fr']);
    // the token of a workspace is refused on the endpoint of another one
    const wrong = await http(ctx, 'POST', `/mcp/${p.user.id}`, { token, json: {} });
    assert.equal(wrong.status, 401);
    assert.match(wrong.text, /autre espace/);
    assert.equal((await http(ctx, 'POST', '/mcp/abc', { token, json: {} })).status, 404);
    // the authorization appears in the connected apps of that workspace only
    assert.equal((await ws.api.get('/api/oauth/authorizations')).body.length, 1);
    assert.equal((await p.api.get('/api/oauth/authorizations')).body.length, 0);
  });

  test('/mcp sans espace : la personne choisit l’espace (jamais d’approbation silencieuse s’il y en a plusieurs)', async () => {
    const p = await person('Camille');
    const c = await app(p);
    // single workspace: remembered consent skips the screen, as before
    let requestId = (await authorize(c.client_id, `${env.PUBLIC_URL}/mcp`)).searchParams.get('request')!;
    await p.api.post('/api/oauth/consent', { request_id: requestId, decision: 'approve' });
    requestId = (await authorize(c.client_id)).searchParams.get('request')!;
    assert.equal((await p.api.get(`/api/oauth/requests/${encodeURIComponent(requestId)}`)).body.remembered, true);

    const ws = await newWorkspace(p, 'Boutique');
    await ws.api.post('/api/contacts', { email: 'boutique@mail.fr' });
    const shown = await p.api.get(`/api/oauth/requests/${encodeURIComponent(requestId)}`);
    assert.equal(shown.body.remembered, false);
    assert.deepEqual(shown.body.workspace, { id: p.user.id, name: 'Camille', locked: false });
    assert.deepEqual(shown.body.workspaces.map((w: any) => w.name), ['Camille', 'Boutique']);

    const other = await person();
    assert.equal((await p.api.post('/api/oauth/consent', { request_id: requestId, decision: 'approve', workspace_id: other.user.id })).status, 403);
    const ok = await p.api.post('/api/oauth/consent', { request_id: requestId, decision: 'approve', workspace_id: ws.id });
    assert.equal(ok.status, 200, ok.text);
    const m = await mcp(await exchange(c, ok.body.redirect_to));
    assert.equal((await call(m, 'get_account')).name, 'Boutique');
    assert.deepEqual((await call(m, 'list_contacts')).items.map((x: any) => x.email), ['boutique@mail.fr']);
  });

  test('« Tous mes espaces » : un seul connecteur, l’espace est indiqué à chaque appel', async () => {
    const p = await person('Camille');
    const ws = await newWorkspace(p, 'Boutique');
    await p.api.post('/api/contacts', { email: 'perso@mail.fr' });
    await ws.api.post('/api/contacts', { email: 'boutique@mail.fr' });
    const c = await app(p);

    const requestId = (await authorize(c.client_id, `${env.PUBLIC_URL}/mcp`)).searchParams.get('request')!;
    assert.equal((await p.api.get(`/api/oauth/requests/${encodeURIComponent(requestId)}`)).body.can_grant_all, true);
    const ok = await p.api.post('/api/oauth/consent', { request_id: requestId, decision: 'approve', all_workspaces: true });
    assert.equal(ok.status, 200, ok.text);
    const token = await exchange(c, ok.body.redirect_to);

    const m = await mcp(token);
    assert.match(m.getInstructions() ?? '', /« Camille » \(workspace_id \d+\), « Boutique »/);
    const tools = (await m.listTools()).tools;
    assert.ok(tools.some((t) => t.name === 'list_workspaces'));
    assert.ok((tools.find((t) => t.name === 'list_contacts')!.inputSchema.required ?? []).includes('workspace_id'));
    assert.deepEqual((await call(m, 'list_workspaces')).workspaces, [
      { workspace_id: p.user.id, name: 'Camille' },
      { workspace_id: ws.id, name: 'Boutique' },
    ]);

    const raw = (await m.callTool({ name: 'list_contacts', arguments: { workspace_id: ws.id } })) as { content: { text: string }[] };
    assert.equal(raw.content[0].text, `Espace de travail : « Boutique » (workspace_id ${ws.id})`);
    assert.deepEqual(JSON.parse(raw.content[1].text).items.map((x: any) => x.email), ['boutique@mail.fr']);
    assert.deepEqual((await callLast(m, 'list_contacts', { workspace_id: p.user.id })).items.map((x: any) => x.email), ['perso@mail.fr']);
    assert.equal((await callLast(m, 'create_contact', { workspace_id: ws.id, email: 'nouveau@mail.fr' })).email, 'nouveau@mail.fr');
    assert.deepEqual(
      (await ws.api.get('/api/contacts')).body.items.map((x: any) => x.email).sort(),
      ['boutique@mail.fr', 'nouveau@mail.fr'],
    );
    assert.equal((await p.api.get('/api/contacts')).body.items.length, 1);

    // a workspace the person cannot authorize is refused (MCP and public API)
    const other = await person();
    assert.match((await call(m, 'list_contacts', { workspace_id: other.user.id })).error, /inconnu ou inaccessible/);
    assert.equal((await http(ctx, 'GET', '/api/v1/contacts', { token, headers: { 'x-scalo-workspace': String(other.user.id) } })).status, 403);
    assert.equal((await http(ctx, 'GET', '/api/v1/contacts', { token, headers: { 'x-scalo-workspace': String(ws.id) } })).body.items.length, 2);
    // a workspace created later is reachable too
    const later = await newWorkspace(p, 'Coaching');
    assert.equal((await call(m, 'list_workspaces')).workspaces.at(-1).workspace_id, later.id);
    // /mcp/<id> with this token: bound to that workspace
    assert.equal((await call(await mcp(token, `/mcp/${ws.id}`), 'get_account')).name, 'Boutique');

    // shown in the connected apps of every workspace, revoked from any of them
    const listed = await ws.api.get('/api/oauth/authorizations');
    assert.deepEqual(listed.body.map((a: any) => a.all_workspaces), [true]);
    assert.equal((await ws.api.del(`/api/oauth/authorizations/${c.client_id}`)).status, 200);
    assert.equal((await http(ctx, 'POST', '/mcp', { token, json: {} })).status, 401);
    assert.equal((await p.api.get('/api/oauth/authorizations')).body.length, 0);
  });

  test('« Tous mes espaces » refusé quand l’application demande un espace précis', async () => {
    const p = await person();
    const ws = await newWorkspace(p, 'Agence');
    const c = await app(p);
    const requestId = (await authorize(c.client_id, `${env.PUBLIC_URL}/mcp/${ws.id}`)).searchParams.get('request')!;
    assert.equal((await p.api.get(`/api/oauth/requests/${encodeURIComponent(requestId)}`)).body.can_grant_all, false);
    assert.equal((await p.api.post('/api/oauth/consent', { request_id: requestId, decision: 'approve', all_workspaces: true })).status, 400);
  });

  test('resource vers un espace inconnu : erreur invalid_target renvoyée à l’application', async () => {
    const p = await person();
    const c = await app(p);
    const back = await authorize(c.client_id, `${env.PUBLIC_URL}/mcp/999999999`);
    assert.equal(back.origin + back.pathname, REDIRECT);
    assert.equal(back.searchParams.get('error'), 'invalid_target');
  });
});
