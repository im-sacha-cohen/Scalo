/**
 * Scalo Enterprise Edition — Copyright (c) 2026 Scalo. All rights reserved.
 * Licensed under the Scalo Enterprise License (see ee/LICENSE): source-available, NOT open source.
 * Production use requires a valid Scalo Enterprise subscription and license key.
 */
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { client, http, registerUser, shutdown, startApp, type TestCtx } from '../../../api/test/helpers';
import { GRACE_DAYS } from '../src/license/format';
import { addMember, inDays, useLicense } from './ee-helpers';

let ctx: TestCtx;
before(async () => {
  ctx = await startApp();
});
after(() => shutdown(ctx));
beforeEach(() => useLicense());

const MENTION = 'Propulsé par Scalo';
const emailContent = { settings: {}, blocks: [{ id: 't1', type: 'text', text: 'Bonjour' }] };
const none = { hide_powered_by: false, powered_by_text: '', powered_by_url: '', app_name: '', logo_url: '' };

async function setup() {
  const o = await registerUser(ctx, 'Studio Blanc');
  const api = client(ctx, o.token);
  const f = await api.post('/api/funnels', { name: `Marque ${o.user.id}`, template: 'optin' });
  const pageUrl = `/p/${f.body.slug}/${f.body.steps[0].slug}`;
  const page = async () => (await http(ctx, 'GET', pageUrl)).text;
  const email = async () => (await api.post('/api/preview/email', { content: emailContent, subject: 'Test' })).text;
  return { o, api, page, email };
}

describe('white label', () => {
  test('the mention is on public pages and emails by default, and can be removed with the license', async () => {
    const { api, page, email } = await setup();
    assert.ok((await page()).includes(MENTION));
    assert.ok((await page()).includes('https://scalo.fr'));
    assert.ok((await email()).includes(MENTION));
    assert.deepEqual((await api.get('/api/branding')).body, { ...none, active: true });

    const put = await api.put('/api/branding', { ...none, hide_powered_by: true });
    assert.equal(put.status, 200, put.text);
    assert.ok(!(await page()).includes(MENTION));
    assert.ok(!(await page()).includes('data-scalo-powered'));
    assert.ok(!(await email()).includes(MENTION));
    // the rest of the legal footer is untouched
    assert.ok((await email()).includes('Se désinscrire'));

    // per account: another account keeps the mention
    const other = await setup();
    assert.ok((await other.page()).includes(MENTION));
    assert.ok((await other.email()).includes(MENTION));
  });

  test('the mention can be replaced by the agency’s own', async () => {
    const { api, page, email } = await setup();
    const put = await api.put('/api/branding', { ...none, powered_by_text: 'Réalisé par Studio <Blanc>', powered_by_url: 'https://studio-blanc.example' });
    assert.equal(put.status, 200, put.text);
    const html = await page();
    assert.ok(!html.includes(MENTION));
    assert.ok(html.includes('Réalisé par Studio &lt;Blanc&gt;'), 'escaped');
    assert.ok(html.includes('href="https://studio-blanc.example"'));
    const mail = await email();
    assert.ok(mail.includes('Réalisé par Studio &lt;Blanc&gt;'));
    assert.ok(!mail.includes(MENTION));
    assert.ok(!mail.includes('studio-blanc.example'), 'no link added to emails');
    // validation
    assert.equal((await api.put('/api/branding', { ...none, powered_by_url: 'javascript:alert(1)' })).status, 400);
    assert.equal((await api.put('/api/branding', { ...none, logo_url: 'http://insecure.example/logo.png' })).status, 400);
    assert.equal((await api.put('/api/branding', { ...none, app_name: 'x'.repeat(41) })).status, 400);
  });

  test('custom name and logo of the admin interface, for the whole team', async () => {
    const { api } = await setup();
    assert.equal((await api.get('/api/edition')).body.branding, null);
    await api.put('/api/branding', { ...none, app_name: 'Studio Blanc', logo_url: 'https://cdn.example/logo.png' });
    assert.deepEqual((await api.get('/api/edition')).body.branding, { app_name: 'Studio Blanc', logo_url: 'https://cdn.example/logo.png' });
    const viewer = await addMember(ctx, api, 'viewer');
    assert.deepEqual((await viewer.api.get('/api/edition')).body.branding, { app_name: 'Studio Blanc', logo_url: 'https://cdn.example/logo.png' });
    assert.equal((await viewer.api.get('/api/branding')).status, 200);
    assert.equal((await viewer.api.put('/api/branding', none)).status, 403);
  });

  test('without the feature (no license, other plan, expired): cannot be configured, and the mention comes back', async () => {
    const { api, page, email } = await setup();
    await api.put('/api/branding', { ...none, hide_powered_by: true, app_name: 'Studio' });
    assert.ok(!(await page()).includes(MENTION));

    for (const lic of [null, { features: ['team', 'audit_log'] }, { expires_at: inDays(-(GRACE_DAYS + 1)) }]) {
      useLicense(lic);
      assert.ok((await page()).includes(MENTION), JSON.stringify(lic));
      assert.ok((await email()).includes(MENTION));
      assert.equal((await api.get('/api/edition')).body.branding, null);
      const put = await api.put('/api/branding', { ...none, hide_powered_by: true });
      assert.equal(put.status, 402);
      assert.match(put.body.error, /édition Entreprise/);
      const get = await api.get('/api/branding');
      assert.equal(get.body.active, false);
      assert.equal(get.body.hide_powered_by, true, 'the saved preference is kept for when the license is back');
    }
    // grace period and renewed license: applied again
    useLicense({ expires_at: inDays(-1) });
    assert.ok(!(await page()).includes(MENTION));
    useLicense();
    assert.ok(!(await email()).includes(MENTION));
  });
});
