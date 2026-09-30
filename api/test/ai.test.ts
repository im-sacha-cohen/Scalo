// Native AI: the Claude API transport is injected (AppOptions.ai.transport) — no network call.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { flattenBlocks, renderPageDocument, type PageContent } from '@scalo/shared';
import { db } from '../src/db';
import { aiIdle } from '../src/services/ai';
import { AiError, outputJsonSchema, type AiRequest, type AiResponse } from '../src/services/ai-client';
import { decryptSecret, encryptSecret } from '../src/services/secretbox';
import { createApp, type AppOptions } from '../src/app';
import { client, registerUser, shutdown, sleep, startApp, type TestCtx } from './helpers';

const KEY = 'sk-ant-api03-TESTKEYTESTKEYTESTKEYTESTKEY-abcd';

/** Fake Claude: records the requests, answers with `next` (a JSON value, raw text, or an error to throw). */
const fake = {
  calls: [] as AiRequest[],
  next: null as unknown,
  transport: async (req: AiRequest): Promise<AiResponse> => {
    fake.calls.push(req);
    if (fake.next instanceof Error) throw fake.next;
    return { text: typeof fake.next === 'string' ? fake.next : JSON.stringify(fake.next), model: 'claude-test', inputTokens: 1200, outputTokens: 800 };
  },
};

let ctx: TestCtx;
before(async () => {
  ctx = await startApp({ ai: { transport: fake.transport, instanceKey: null, rateLimit: { max: 1000, windowMs: 3600_000 } } });
});
after(async () => {
  await aiIdle();
  await shutdown(ctx);
});
beforeEach(() => {
  fake.calls = [];
  fake.next = null;
});

async function account() {
  const u = await registerUser(ctx);
  const api = client(ctx, u.token);
  assert.equal((await api.put('/api/ai/key', { api_key: KEY })).status, 200);
  return { ...u, api };
}

async function waitFor(api: ReturnType<typeof client>, id: number) {
  for (let i = 0; i < 100; i++) {
    const g = await api.get(`/api/ai/generations/${id}`);
    assert.equal(g.status, 200, g.text);
    if (g.body.status !== 'running') return g.body;
    await sleep(20);
  }
  throw new Error('generation still running');
}

const BRIEF = { offer: 'Formation en ligne pour apprendre le jardinage urbain', audience: 'Citadins débutants', tone: 'chaleureux', language: 'fr', goal: 'vente' };

const page = (type: string, sections: unknown[]) => ({ type, name: type, seo_title: `Titre ${type}`, seo_description: 'Description', sections });
const validFunnel = () => ({
  name: 'Jardin urbain',
  palette: 'emerald',
  tag: 'jardin-urbain',
  pages: [
    page('optin', [
      { kind: 'hero', eyebrow: 'Guide gratuit', title: 'Cultivez votre balcon', subtitle: 'Recevez le guide' },
      { kind: 'bullets', title: 'Au programme', items: ['Choisir ses pots', 'Arroser juste'] },
      { kind: 'form', title: 'Recevoir le guide', submit_label: 'Je le veux' },
    ]),
    page('sales', [
      { kind: 'hero', eyebrow: '', title: 'La méthode complète', subtitle: '' },
      { kind: 'features', title: 'Pourquoi', items: [{ icon: '🌱', title: 'Simple', text: 'Pas à pas' }] },
      { kind: 'testimonial', quote: '[Témoignage client à remplacer]', name: '', role: '' },
      { kind: 'pricing', title: 'Formation', price: '[Votre prix]', period: '', description: '', features: ['Accès à vie'], button_label: 'Je commence' },
      { kind: 'faq', title: 'Questions', items: [{ q: 'Pour qui ?', a: 'Les débutants.' }] },
      { kind: 'cta', title: '', button_label: 'Je rejoins la formation' },
    ]),
    page('thankyou', [{ kind: 'hero', eyebrow: '', title: 'Merci !', subtitle: 'Vérifiez votre boîte mail' }]),
  ],
});

// ---------- key storage ----------

test('secretbox: AES-256-GCM round trip, random IV, tamper and purpose detection', () => {
  const a = encryptSecret(KEY, 'p1');
  const b = encryptSecret(KEY, 'p1');
  assert.notEqual(a, b, 'random IV');
  assert.ok(!a.includes(KEY) && a.startsWith('v1.'));
  assert.equal(decryptSecret(a, 'p1'), KEY);
  assert.equal(decryptSecret(a, 'p2'), null, 'other purpose = other key');
  const parts = a.split('.');
  parts[3] = Buffer.from('tampered').toString('base64url');
  assert.equal(decryptSecret(parts.join('.'), 'p1'), null);
  assert.equal(decryptSecret('garbage', 'p1'), null);
});

test('API key: stored encrypted, never returned, validated, removable', async () => {
  const u = await registerUser(ctx);
  const api = client(ctx, u.token);
  const before = await api.get('/api/ai/status');
  assert.deepEqual([before.body.configured, before.body.source, before.body.key_hint], [false, null, null]);

  assert.equal((await api.put('/api/ai/key', { api_key: 'nope' })).status, 400);
  const put = await api.put('/api/ai/key', { api_key: KEY });
  assert.equal(put.status, 200);
  assert.deepEqual([put.body.configured, put.body.source, put.body.key_hint], [true, 'account', 'abcd']);
  assert.ok(!put.text.includes(KEY));
  assert.ok(!(await api.get('/api/ai/status')).text.includes(KEY));
  assert.ok(!(await api.get('/api/settings')).text.includes(KEY));

  const row = await db.selectFrom('ai_settings').selectAll().where('user_id', '=', u.user.id).executeTakeFirstOrThrow();
  assert.ok(!row.api_key_enc.includes(KEY) && !row.api_key_enc.includes('TESTKEY'));
  assert.equal(decryptSecret(row.api_key_enc, 'ai.anthropic_api_key'), KEY);

  const del = await api.del('/api/ai/key');
  assert.equal(del.body.configured, false);
});

test('no key: AI routes explain how to configure one, nothing is called', async () => {
  const api = client(ctx, (await registerUser(ctx)).token);
  for (const [path, body] of [
    ['/api/ai/funnels', BRIEF],
    ['/api/ai/rewrite', { text: 'Bonjour', action: 'shorten' }],
  ] as const) {
    const r = await api.post(path, body);
    assert.equal(r.status, 409, r.text);
    assert.match(r.body.error, /Paramètres → IA/);
  }
  assert.equal(fake.calls.length, 0);
  assert.equal((await http401()).status, 401);
});
const http401 = () => fetch(`${ctx.base}/api/ai/status`);

test('instance key (ANTHROPIC_API_KEY) is used when the account has none; the account key wins', async () => {
  const ctx2 = await startAppKeepData({ ai: { transport: fake.transport, instanceKey: 'sk-ant-instance-key' } });
  try {
    const u = await registerUserOn(ctx2);
    fake.next = { text: 'Court' };
    assert.equal((await u.post('/api/ai/rewrite', { text: 'Un texte long', action: 'shorten' })).status, 200);
    assert.equal(fake.calls.at(-1)!.apiKey, 'sk-ant-instance-key');
    assert.equal((await u.get('/api/ai/status')).body.source, 'instance');
    await u.put('/api/ai/key', { api_key: KEY });
    await u.post('/api/ai/rewrite', { text: 'Un texte long', action: 'shorten' });
    assert.equal(fake.calls.at(-1)!.apiKey, KEY);
  } finally {
    await ctx2.close();
  }
});

// a second app on the same database (other AI options), without truncating
async function startAppKeepData(opts: AppOptions): Promise<TestCtx> {
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = createApp(opts).listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
const registerUserOn = async (c: TestCtx) => client(c, (await registerUser(c)).token);

// ---------- funnel generation ----------

test('valid output → funnel and steps created from known blocks only', async () => {
  const { api, user } = await account();
  fake.next = validFunnel();
  const start = await api.post('/api/ai/funnels', BRIEF);
  assert.equal(start.status, 202, start.text);
  const g = await waitFor(api, start.body.id);
  assert.equal(g.status, 'done', g.error);
  assert.deepEqual([g.input_tokens, g.output_tokens, g.model, g.key_source], [1200, 800, 'claude-test', 'account']);

  // the request: key passed to the client only, brief delimited as data, schema provided
  const req = fake.calls[0];
  assert.equal(req.apiKey, KEY);
  assert.ok(!req.prompt.includes(KEY) && !req.system.includes(KEY));
  assert.match(req.prompt, /<brief>[\s\S]*jardinage urbain[\s\S]*<\/brief>/);
  assert.ok(req.maxTokens > 1000);
  // JSON schema sent to structured outputs: closed objects, closed list of section kinds, no `html`
  const js = JSON.stringify(outputJsonSchema(req.schema));
  assert.ok(js.includes('"additionalProperties":false') && js.includes('"anyOf"') && !/oneOf|minimum|html/.test(js));

  const funnel = (await api.get(`/api/funnels/${g.result.funnel_id}`)).body;
  assert.equal(funnel.name, 'Jardin urbain');
  assert.deepEqual(funnel.steps.map((s: any) => s.type), ['optin', 'sales', 'thankyou']);
  const owner = await db.selectFrom('funnels').select('user_id').where('id', '=', funnel.id).executeTakeFirstOrThrow();
  assert.equal(owner.user_id, user.id);

  const types = new Set<string>();
  for (const s of funnel.steps) for (const b of flattenBlocks((s.content as PageContent).blocks)) types.add(b.type);
  assert.ok(!types.has('html'));
  for (const t of types) assert.ok(['section', 'columns', 'heading', 'text', 'list', 'feature', 'testimonial', 'pricing', 'faq', 'form', 'button'].includes(t), t);

  const optin = flattenBlocks(funnel.steps[0].content.blocks);
  const forms = optin.filter((b) => b.type === 'form');
  assert.equal(forms.length, 1);
  assert.equal((forms[0] as any).tagName, 'jardin-urbain');
  assert.equal(funnel.steps[0].content.settings.accent, '#059669');
  assert.equal(funnel.steps[0].content.settings.headCode, undefined);
  // thank-you page: no form / button
  assert.ok(!flattenBlocks(funnel.steps[2].content.blocks).some((b) => ['form', 'button', 'pricing'].includes(b.type)));
});

test('capture goal: only the requested pages are kept; a missing form is added', async () => {
  const { api } = await account();
  const out = validFunnel();
  out.pages[0].sections = out.pages[0].sections.filter((s: any) => s.kind !== 'form');
  fake.next = out;
  const g = await waitFor(api, (await api.post('/api/ai/funnels', { ...BRIEF, goal: 'capture' })).body.id);
  assert.equal(g.status, 'done', g.error);
  const funnel = (await api.get(`/api/funnels/${g.result.funnel_id}`)).body;
  assert.deepEqual(funnel.steps.map((s: any) => s.type), ['optin', 'thankyou']);
  assert.equal(flattenBlocks(funnel.steps[0].content.blocks).filter((b) => b.type === 'form').length, 1);
});

test('malicious / invalid output is rejected: unknown block types, extra fields, bad JSON, missing page', async () => {
  const { api } = await account();
  const count = async () => Number((await db.selectFrom('funnels').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
  const n0 = await count();

  const htmlBlock = validFunnel();
  (htmlBlock.pages[0].sections as any[]).push({ kind: 'html', html: '<script>alert(1)</script>' });
  const extraField = validFunnel();
  (extraField.pages[0].sections[0] as any).headCode = '<script src="https://evil.example/x.js"></script>';
  const extraTop = { ...validFunnel(), settings: { headCode: '<script>1</script>' } };
  const rawBlocks = { ...validFunnel(), pages: [{ type: 'optin', name: 'x', seo_title: '', seo_description: '', sections: [{ id: 'a', type: 'html', html: '<script>1</script>' }] }] };
  const missingPage = validFunnel();
  missingPage.pages = missingPage.pages.filter((p) => p.type !== 'sales');

  for (const bad of [htmlBlock, extraField, extraTop, rawBlocks, missingPage, 'not json at all', '{"name":']) {
    fake.next = bad;
    const g = await waitFor(api, (await api.post('/api/ai/funnels', BRIEF)).body.id);
    assert.equal(g.status, 'failed');
    assert.match(g.error, /format attendu/);
    assert.equal(g.result, null);
  }
  assert.equal(await count(), n0, 'nothing created');
  // tokens of rejected answers are still logged
  const u = await api.get('/api/ai/usage');
  assert.equal(u.body.last_30_days.calls, 7);
  assert.equal(u.body.last_30_days.output_tokens, 7 * 800);
});

test('markup inside texts is cleaned, and the renderer never emits it', async () => {
  const { api } = await account();
  const out = validFunnel();
  out.name = '<b>Tunnel</b> <script>alert(1)</script>';
  out.tag = '<img src=x onerror=alert(1)>tag';
  out.pages[0].sections[0] = { kind: 'hero', eyebrow: '', title: 'Titre <script>alert("xss")</script><img src=x onerror=alert(2)>', subtitle: '[clic](javascript:alert(3)) <a href="javascript:alert(4)">ici</a>' };
  fake.next = out;
  const g = await waitFor(api, (await api.post('/api/ai/funnels', BRIEF)).body.id);
  assert.equal(g.status, 'done', g.error);
  const funnel = (await api.get(`/api/funnels/${g.result.funnel_id}`)).body;
  assert.equal(funnel.name, 'Tunnel alert(1)');
  const stored = JSON.stringify(funnel.steps.map((s: any) => s.content));
  for (const needle of ['<script', '<img', 'onerror', 'javascript:', '<a ']) assert.ok(!stored.includes(needle), needle);
  const html = renderPageDocument(funnel.steps[0].content, { title: 't' });
  assert.ok(!/<script>alert|onerror=|javascript:/.test(html));
});

test('readable errors: invalid key, quota, refusal, timeout — the key never leaks', async () => {
  const { api } = await account();
  const cases: [AiError, RegExp][] = [
    [new AiError('invalid_key'), /invalide ou a été révoquée/],
    [new AiError('quota'), /crédit/],
    [new AiError('refused', { inputTokens: 50, outputTokens: 0 }), /refusé/],
    [new AiError('timeout'), /trop de temps/],
    [new Error(`boom ${KEY}`) as AiError, /indisponible/],
  ];
  for (const [err, re] of cases) {
    fake.next = err;
    const g = await waitFor(api, (await api.post('/api/ai/funnels', BRIEF)).body.id);
    assert.equal(g.status, 'failed');
    assert.match(g.error, re);
    assert.ok(!JSON.stringify(g).includes(KEY));
  }
  fake.next = new AiError('invalid_key');
  const sync = await api.post('/api/ai/rewrite', { text: 'Bonjour', action: 'rephrase' });
  assert.equal(sync.status, 409);
  assert.match(sync.body.error, /Paramètres → IA/);
  assert.ok(!(await api.get('/api/ai/usage')).text.includes(KEY));
});

test('brief validation and account isolation', async () => {
  const a = await account();
  const b = await account();
  assert.equal((await a.api.post('/api/ai/funnels', { offer: 'court' })).status, 400);
  assert.equal((await a.api.post('/api/ai/funnels', { ...BRIEF, goal: 'autre' })).status, 400);
  assert.equal((await a.api.post('/api/ai/funnels', { ...BRIEF, extra: 1 })).status, 400);
  assert.equal(fake.calls.length, 0);
  fake.next = validFunnel();
  const id = (await a.api.post('/api/ai/funnels', BRIEF)).body.id;
  await waitFor(a.api, id);
  assert.equal((await b.api.get(`/api/ai/generations/${id}`)).status, 404);
  assert.equal((await b.api.get('/api/ai/usage')).body.items.length, 0);
});

// ---------- rate limit ----------

test('rate limit per account', async () => {
  const ctx2 = await startAppKeepData({ ai: { transport: fake.transport, instanceKey: 'sk-ant-instance-key', rateLimit: { max: 2, windowMs: 3600_000 } } });
  try {
    const a = await registerUserOn(ctx2);
    const b = await registerUserOn(ctx2);
    fake.next = { text: 'ok' };
    const body = { text: 'Un texte', action: 'rephrase' };
    assert.equal((await a.post('/api/ai/rewrite', body)).status, 200);
    assert.equal((await a.post('/api/ai/rewrite', body)).status, 200);
    const blocked = await a.post('/api/ai/rewrite', body);
    assert.equal(blocked.status, 429);
    assert.match(blocked.body.error, /Limite de 2 générations/);
    assert.equal((await a.post('/api/ai/funnels', BRIEF)).status, 429);
    assert.equal(fake.calls.length, 2, 'blocked calls never reach the API');
    assert.equal((await b.post('/api/ai/rewrite', body)).status, 200, 'other accounts are not affected');
  } finally {
    await ctx2.close();
  }
});

// ---------- emails ----------

const email = (subject: string, delay_days: number, button_label = 'Découvrir') => ({ subject, preheader: 'Aperçu', paragraphs: ['Bonjour {{first_name}},', 'Un <b>paragraphe</b>.'], button_label, delay_days });

test('campaign: N emails with delays, draft content, optional button to the user link only', async () => {
  const { api } = await account();
  fake.next = { name: 'Bienvenue', emails: [email('Bienvenue', 5), email('Jour 2', 2), email('Jour 3', 900), email('En trop', 1)] };
  const start = await api.post('/api/ai/campaigns', { ...BRIEF, goal: undefined, emails: 3, link_url: 'https://exemple.fr/offre' });
  assert.equal(start.status, 202, start.text);
  const g = await waitFor(api, start.body.id);
  assert.equal(g.status, 'done', g.error);
  assert.match(fake.calls[0].prompt, /exactement 3/);
  const c = (await api.get(`/api/campaigns/${g.result.campaign_id}`)).body;
  assert.equal(c.name, 'Bienvenue');
  assert.equal(c.trigger_tag_id, null);
  assert.deepEqual(c.emails.map((e: any) => [e.subject, e.delay_days]), [['Bienvenue', 0], ['Jour 2', 2], ['Jour 3', 60]]);
  const blocks = c.emails[0].content.blocks;
  assert.deepEqual(blocks.map((b: any) => b.type), ['text', 'text', 'button']);
  assert.equal(blocks[1].text, 'Un paragraphe.');
  assert.deepEqual([blocks[2].action, blocks[2].url], ['url', 'https://exemple.fr/offre']);
  assert.equal(c.emails[0].content.settings.preheader, 'Aperçu');

  assert.equal((await api.post('/api/ai/campaigns', { ...BRIEF, goal: undefined, link_url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await api.post('/api/ai/campaigns', { ...BRIEF, goal: undefined, emails: 50 })).status, 400);
});

test('newsletter: draft created, no button without a link', async () => {
  const { api } = await account();
  const { delay_days: _d, ...nl } = email('Les nouveautés du mois', 0);
  fake.next = nl;
  const g = await waitFor(api, (await api.post('/api/ai/newsletters', { offer: 'Les nouveautés du mois de mai', language: 'fr' })).body.id);
  assert.equal(g.status, 'done', g.error);
  const b = (await api.get(`/api/broadcasts/${g.result.broadcast_id}`)).body;
  assert.deepEqual([b.subject, b.status], ['Les nouveautés du mois', 'draft']);
  assert.ok(b.content.blocks.every((x: any) => x.type === 'text'));
});

test('rewrite: plain text in and out; subjects: cleaned, deduplicated, capped', async () => {
  const { api } = await account();
  fake.next = { text: 'Version <script>x</script>courte' };
  const r = await api.post('/api/ai/rewrite', { text: '<b>Un texte</b> riche<br>sur deux lignes', action: 'translate', language: 'en' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.text, 'Version xcourte');
  assert.ok(!fake.calls[0].prompt.includes('<b>'));
  assert.match(fake.calls[0].system, /anglais/);
  assert.equal((await api.post('/api/ai/rewrite', { text: 'x', action: 'hack' })).status, 400);

  fake.next = { subjects: ['Objet A', 'Objet A', '<i>Objet B</i>', 'Objet C', 'Objet D'] };
  const s = await api.post('/api/ai/subjects', { subject: 'Mon objet', content: 'Le contenu', count: 3 });
  assert.deepEqual(s.body.subjects, ['Objet A', 'Objet B', 'Objet C']);

  fake.next = { subjects: 'nope' };
  const bad = await api.post('/api/ai/subjects', { subject: 'Mon objet' });
  assert.equal(bad.status, 502);
  assert.match(bad.body.error, /format attendu/);

  const u = (await api.get('/api/ai/usage')).body;
  assert.deepEqual(u.items.map((i: any) => [i.kind, i.status]), [['subjects', 'failed'], ['subjects', 'done'], ['rewrite', 'done']]);
  assert.equal(u.last_30_days.input_tokens, 3600);
});
