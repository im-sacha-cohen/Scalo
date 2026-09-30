// Kits: named visual identities shared by a full set of pages and emails (shared/src/kits).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  EMAIL_BLOCK_TYPES,
  EMAIL_TEMPLATES,
  FUNNEL_TEMPLATES,
  GOOGLE_FONTS,
  KITS,
  KIT_EMAIL_KINDS,
  KIT_FLOWS,
  KIT_PAGES,
  KIT_PAGE_KINDS,
  KIT_PREVIEW_OFFERS,
  KIT_SECTION_KINDS,
  ONBOARDING_KITS,
  PAGE_BLOCK_TYPES,
  PAGE_TEMPLATES,
  applyKitSettings,
  flattenBlocks,
  getKit,
  kitEmail,
  kitPage,
  kitPageForStep,
  kitSection,
  legalPageTemplate,
  renderEmailDocument,
  renderPageDocument,
  safeSrc,
  stepTemplate,
  withPreviewOffers,
  type Block,
  type KitGoal,
  type KitTokens,
  type PageContent,
} from '@scalo/shared';
import { pageContentSchema } from '../src/util';
import { normalizeContent } from '../src/services/funnel-transfer';
import { buildEmail, buildFunnel, funnelBriefSchema } from '../src/services/ai-content';
import { client, registerUser, shutdown, startApp, type TestCtx } from './helpers';

let ctx: TestCtx;
before(async () => {
  ctx = await startApp();
});
after(() => shutdown(ctx));

// ---------- WCAG contrast ----------
const lum = (hex: string) => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  assert.ok(m, `couleur hexadécimale attendue : ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};
/** Every text / background pair the compositions can produce. */
const pairs = (t: KitTokens): [string, string, string][] => [
  ['text / bg', t.text, t.bg],
  ['text / alt', t.text, t.alt],
  ['text / surface', t.text, t.surface],
  ['muted / bg', t.muted, t.bg],
  ['muted / alt', t.muted, t.alt],
  ['muted / surface', t.muted, t.surface],
  ['accentInk / bg', t.accentInk, t.bg],
  ['accentInk / alt', t.accentInk, t.alt],
  ['accentInk / surface', t.accentInk, t.surface],
  ['accentText / accent', t.accentText, t.accent],
  ['inverseText / inverse', t.inverseText, t.inverse],
  ['inverseMuted / inverse', t.inverseMuted, t.inverse],
  ['inverseAccent / inverse', t.inverseAccent, t.inverse],
];

const allStrings = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => allStrings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => allStrings(x, out));
  return out;
};
const ids = (blocks: Block[]) => {
  const out: string[] = [];
  for (const b of flattenBlocks(blocks)) {
    out.push(b.id);
    if (b.type === 'columns') for (const c of b.columns) out.push(c.id);
  }
  return out;
};

/** Checks shared by every template of a kit (page or email). */
function checkTemplate(where: string, content: PageContent, mode: 'page' | 'email', kitId: string) {
  // API validation: the loose schema of the routes and the strict walker of the import
  pageContentSchema.parse(content);
  const normalized = normalizeContent(content, where);
  assert.equal(flattenBlocks(normalized.blocks).length, flattenBlocks(content.blocks).length, `${where} : blocs conservés`);
  const flat = flattenBlocks(content.blocks);
  assert.ok(flat.length >= 3, `${where} : contenu non vide`);
  // unique ids (blocks and columns), all kept by the strict normalizer
  const all = ids(content.blocks);
  assert.equal(new Set(all).size, all.length, `${where} : ids uniques`);
  assert.deepEqual(ids(normalized.blocks), all, `${where} : ids valides (non régénérés)`);
  // no custom code
  const allowed = new Set<string>(mode === 'email' ? EMAIL_BLOCK_TYPES : PAGE_BLOCK_TYPES);
  for (const b of flat) {
    assert.notEqual(b.type, 'html', `${where} : aucun bloc html`);
    assert.ok(allowed.has(b.type), `${where} : bloc ${b.type} autorisé en mode ${mode}`);
  }
  assert.equal(content.settings.headCode, undefined, `${where} : pas de code d’en-tête`);
  const strings = allStrings(content);
  for (const s of strings) {
    assert.ok(!/<script|javascript:|on\w+\s*=/i.test(s), `${where} : aucun script (${s.slice(0, 60)})`);
    // no external URL: images are inline SVGs (their XML namespace is not a link), links are « # »
    const decoded = s.startsWith('data:image/svg+xml,') ? decodeURIComponent(s.slice(19)).replace('xmlns="http://www.w3.org/2000/svg"', '') : s;
    assert.ok(!/(https?:)?\/\/[a-z0-9]/i.test(decoded), `${where} : aucune URL externe (${s.slice(0, 80)})`);
    assert.ok(!/lorem ipsum/i.test(s), `${where} : pas de lorem ipsum`);
  }
  for (const b of flat) {
    if (b.type === 'image' || b.type === 'imageText') assert.ok(b.src.startsWith('data:image/svg+xml,') && safeSrc(b.src) === b.src, `${where} : image intégrée acceptée par le renderer`);
    if (b.type === 'testimonial') assert.ok(b.quote.startsWith('[Témoignage à remplacer]') && !b.photo && !b.stars, `${where} : témoignage marqué comme emplacement`);
    if (b.type === 'pricing') assert.equal(b.price, '000 €', `${where} : prix à personnaliser`);
  }
  // the kit's tokens are on the settings
  assert.equal(content.settings.theme?.kit, kitId, `${where} : kit dans les réglages`);
  const kit = getKit(kitId)!;
  assert.equal(content.settings.accent, kit.tokens.accent);
  assert.equal(content.settings.fontFamily, kit.tokens.fontBody);
  assert.equal(content.settings.headingFont, kit.tokens.fontHeading);
  // renders without error
  const html =
    mode === 'email'
      ? renderEmailDocument(content, { subject: where, vars: { first_name: 'Marie' } })
      : renderPageDocument(withPreviewOffers(content), { title: where, nextUrl: '#', formAction: '#', vars: { first_name: 'Marie' }, offers: KIT_PREVIEW_OFFERS });
  assert.ok(html.length > 1500 && html.includes('</html>'), `${where} : rendu`);
  assert.ok(!html.includes('undefined') && !html.includes('NaN') && !html.includes('[object'), `${where} : rendu propre`);
  assert.ok(!html.includes('{{first_name}}'), `${where} : variables remplacées`);
  if (mode === 'email') assert.ok(!/<form|<script|data:image/i.test(html), `${where} : email sans formulaire, script ni image intégrée`);
  return html;
}

describe('kits: definitions', () => {
  test('at least 8 distinct kits with complete tokens, layout and copy', () => {
    assert.ok(KITS.length >= 8);
    assert.equal(new Set(KITS.map((k) => k.id)).size, KITS.length);
    assert.equal(new Set(KITS.map((k) => k.name)).size, KITS.length);
    // distinct identities: no two kits share the same fonts, palette or layout recipe
    for (const key of ['fontHeading', 'accent', 'bg'] as const) assert.equal(new Set(KITS.map((k) => k.tokens[key])).size, KITS.length, `${key} distinct`);
    const recipe = (k: (typeof KITS)[number]) => [k.layout.align, k.layout.hero, k.layout.benefits, k.layout.proof, k.layout.offer, k.layout.cta, k.layout.header].join('/');
    assert.equal(new Set(KITS.map(recipe)).size, KITS.length, 'compositions distinctes');
    assert.equal(new Set(KITS.map((k) => k.layout.hero)).size >= 6, true, 'au moins 6 héros différents');
    assert.equal(new Set(KITS.map((k) => k.layout.art)).size, KITS.length, 'illustrations distinctes');
    assert.equal(new Set(KITS.map((k) => k.copy.brand)).size, KITS.length, 'textes distincts');
    for (const k of KITS) {
      assert.match(k.id, /^[a-z][a-z0-9-]{1,39}$/);
      assert.ok(k.pitch.length > 20 && k.universe && k.goals.length >= 1);
      // fonts: a loadable Google font first, then email-safe fallbacks
      for (const stack of [k.tokens.fontHeading, k.tokens.fontBody]) {
        const first = stack.split(',')[0]!.trim().replace(/^'|'$/g, '');
        assert.ok(GOOGLE_FONTS.includes(first), `${k.id} : police ${first} chargeable`);
        assert.match(stack, /(Georgia|Arial|Helvetica)/, `${k.id} : police de repli email`);
        assert.match(stack, /(serif|sans-serif)$/);
      }
      assert.equal(k.copy.voices.length, 3);
      assert.equal(k.copy.offer.benefits.length, 3);
      assert.ok(k.copy.offer.faq.length >= 3 && k.copy.offer.includes.length >= 4);
    }
    // onboarding proposes 3–4 existing kits per goal
    for (const [goal, list] of Object.entries(ONBOARDING_KITS)) {
      assert.ok(list.length >= 3 && list.length <= 4, goal);
      for (const id of list) assert.ok(getKit(id), `${goal} : ${id}`);
    }
  });

  test('token contrast ≥ 4.5 (WCAG AA) for every text / background pair', () => {
    assert.ok(Math.abs(contrast('#000000', '#ffffff') - 21) < 0.01);
    for (const k of KITS) {
      for (const [name, fg, bg] of pairs(k.tokens)) {
        const c = contrast(fg, bg);
        assert.ok(c >= 4.5, `${k.id} : ${name} = ${c.toFixed(2)} (${fg} sur ${bg})`);
      }
    }
  });
});

describe('kits: templates', () => {
  test('every kit has every page: valid, renders, no custom code, no external URL', () => {
    for (const k of KITS) {
      for (const kind of KIT_PAGE_KINDS) {
        const content = kitPage(k.id, kind);
        assert.ok(content, `${k.id}/${kind}`);
        const html = checkTemplate(`${k.id}/page/${kind}`, content, 'page', k.id);
        const types = new Set(flattenBlocks(content.blocks).map((b) => b.type));
        if (kind === 'checkout') assert.ok(types.has('checkout') && html.includes('name="_block"'), `${k.id} : bloc Paiement`);
        if (kind === 'upsell') assert.ok(types.has('upsell'));
        if (kind === 'optin' || kind === 'webinar' || kind === 'comingsoon') assert.ok(types.has('form'), `${k.id}/${kind} : formulaire`);
        if (kind === 'webinar' || kind === 'comingsoon') assert.ok(types.has('countdown'));
        if (kind === 'sales') for (const t of ['pricing', 'faq', 'testimonial', 'button']) assert.ok(types.has(t as Block['type']), `${k.id}/sales : ${t}`);
        if (kind === 'thankyou') assert.ok(!types.has('form') && !types.has('pricing'));
        // two builds never share ids
        assert.equal(new Set([...ids(content.blocks), ...ids(kitPage(k.id, kind)!.blocks)]).size, ids(content.blocks).length * 2);
      }
    }
    assert.equal(kitPage('inconnu', 'optin'), null);
  });

  test('every kit has every email: email-safe blocks, tables, fallback fonts', () => {
    for (const k of KITS) {
      for (const kind of KIT_EMAIL_KINDS) {
        const e = kitEmail(k.id, kind);
        assert.ok(e, `${k.id}/${kind}`);
        assert.ok(e.subject.length > 5 && e.subject.length <= 70, `${k.id}/${kind} : objet`);
        const html = checkTemplate(`${k.id}/email/${kind}`, e.content, 'email', k.id);
        assert.equal(e.content.settings.maxWidth, 600);
        assert.ok(e.content.settings.preheader, 'preheader');
        assert.ok(html.includes('role="presentation"') && html.includes(`max-width:600px`), 'mise en page en tables, largeur 600');
        assert.ok(html.includes(k.tokens.accent), `${k.id}/${kind} : accent du kit`);
        // no « next step » button in an email
        for (const b of flattenBlocks(e.content.blocks)) if (b.type === 'button' || b.type === 'pricing') assert.equal(b.action, 'url');
      }
    }
    assert.equal(kitEmail('inconnu', 'welcome'), null);
  });

  test('sections of a kit can be inserted one by one (page and email)', () => {
    for (const k of KITS) {
      for (const kind of KIT_SECTION_KINDS) {
        for (const mode of ['page', 'email'] as const) {
          const blocks = kitSection(k.id, kind, mode);
          assert.ok(blocks.length >= 1 && blocks.every((b) => b.type === 'section'), `${k.id}/${kind}/${mode}`);
          const content = { settings: applyKitSettings(null, k.id, mode)!, blocks };
          normalizeContent(content, 'section');
          const html = mode === 'email' ? renderEmailDocument(content, { subject: 's' }) : renderPageDocument(content, { title: 's' });
          assert.ok(html.length > 800);
          if (mode === 'email') for (const b of flattenBlocks(blocks)) assert.ok(EMAIL_BLOCK_TYPES.includes(b.type), `${k.id}/${kind} : ${b.type} en email`);
        }
      }
    }
    assert.deepEqual(kitSection('inconnu', 'hero'), []);
  });

  test('legal pages and empty pages take the kit of the funnel; applying a kit keeps the page’s own settings', () => {
    const plain = legalPageTemplate('mentions', { company: 'ACME' });
    assert.deepEqual(plain.settings, { ...DEFAULT_SETTINGS, maxWidth: 760 }, 'sans kit : inchangé');
    for (const k of KITS) {
      const legal = legalPageTemplate('cgv', { company: 'ACME' }, k.id);
      assert.equal(legal.settings.theme?.kit, k.id);
      assert.equal(legal.settings.headingFont, k.tokens.fontHeading);
      assert.equal(legal.settings.maxWidth, 760);
      assert.equal(legal.blocks.length, legalPageTemplate('cgv', { company: 'ACME' }).blocks.length, 'même texte');
      assert.ok(renderPageDocument(legal, { title: 'CGV' }).includes(k.tokens.bg));
      const empty = kitPageForStep(k.id, 'custom')!;
      assert.deepEqual(empty.blocks, []);
      assert.equal(empty.settings.theme?.kit, k.id);
    }
    assert.deepEqual(legalPageTemplate('mentions', { company: 'ACME' }, 'inconnu').settings, plain.settings);
    const applied = applyKitSettings({ ...DEFAULT_SETTINGS, seoTitle: 'Mon titre', headCode: '<!-- x -->' }, 'revue')!;
    assert.equal(applied.seoTitle, 'Mon titre');
    assert.equal(applied.headCode, '<!-- x -->');
    assert.equal(applied.theme?.kit, 'revue');
    assert.equal(applyKitSettings({}, 'inconnu'), null);
  });
});

describe('kits: backward compatibility of the renderer and of the existing templates', () => {
  test('existing templates are unchanged and carry no theme', () => {
    assert.deepEqual(Object.keys(FUNNEL_TEMPLATES), ['optin', 'sales', 'blank']);
    assert.deepEqual(PAGE_TEMPLATES.map((t) => t.id), ['optin-split', 'optin-minimal', 'webinar', 'sales', 'thankyou', 'lead-magnet', 'coming-soon']);
    assert.deepEqual(EMAIL_TEMPLATES.map((t) => t.id), ['newsletter', 'welcome', 'promo', 'simple']);
    for (const t of PAGE_TEMPLATES) assert.equal(t.build().settings.theme, undefined);
    for (const type of ['optin', 'sales', 'thankyou', 'custom'] as const) assert.equal(stepTemplate(type).settings.theme, undefined);
  });

  test('content without a theme renders with the historical defaults; a theme only changes defaults', () => {
    const blocks: Block[] = [
      { id: 'b1', type: 'button', label: 'Go', action: 'url', url: '#' },
      { id: 't1', type: 'testimonial', quote: 'Bien', name: 'A', stars: 4, layout: 'card' },
      { id: 'p1', type: 'pricing', title: 'Pro', price: '10 €', features: ['x'], buttonLabel: 'Ok', action: 'url', url: '#', highlighted: true },
      { id: 'f1', type: 'form', submitLabel: 'Envoyer', fields: [{ name: 'email', label: 'Email', required: true }] },
      { id: 'h1', type: 'heading', level: 1, text: 'Titre' },
      { id: 's1', type: 'section', children: [{ id: 'h2', type: 'heading', level: 2, text: 'Dans une section' }], style: { paddingTop: 120, paddingBottom: 120 } },
    ];
    const plain = renderPageDocument({ settings: { ...DEFAULT_SETTINGS }, blocks }, { title: 't' });
    // historical values, exactly
    assert.ok(plain.includes('border-radius:8px;font-weight:700;font-size:18px'), 'bouton : rayon 8, graisse 700');
    assert.ok(plain.includes('color:#ffffff') && plain.includes('border:1px solid #e2e8f0;border-radius:16px'), 'témoignage : carte blanche');
    assert.ok(plain.includes('border:2px solid #2563eb;border-radius:18px'), 'prix : carte');
    assert.ok(plain.includes('border:1px solid #cbd5e1;border-radius:8px'), 'formulaire : champs');
    assert.ok(plain.includes('font-weight:800') && !plain.includes('text-transform'), 'titres');
    assert.ok(!plain.includes('class="scalo-sec scalo-mpy"') && !plain.includes('--scalo-mpt:'), 'aucun attribut de thème');

    const kit = getKit('scene')!;
    const themed = renderPageDocument({ settings: applyKitSettings(null, 'scene')!, blocks }, { title: 't' });
    assert.ok(themed.includes('text-transform:uppercase'), 'titres en capitales');
    assert.ok(themed.includes(`border-radius:${kit.tokens.buttonRadius}px`));
    assert.ok(themed.includes(`border:1px solid ${kit.tokens.border}`), 'bordures du kit');
    assert.ok(themed.includes('scalo-mpy') && themed.includes('--scalo-mpt:72px'), 'espacements resserrés sur mobile');
    // a block's own value always wins over the theme
    const own = renderPageDocument(
      { settings: applyKitSettings(null, 'scene')!, blocks: [{ id: 'b', type: 'button', label: 'Go', action: 'url', url: '#', radius: 33, textColor: '#123456', style: { fontWeight: 500 } }] },
      { title: 't' },
    );
    assert.ok(own.includes('border-radius:33px') && own.includes('color:#123456') && own.includes('font-weight:500'));
    // a malformed theme is ignored, never trusted
    const bad = renderPageDocument({ settings: { ...DEFAULT_SETTINGS, theme: { surface: 'url(javascript:1)', radius: 'x', shadow: 'big' } as never }, blocks }, { title: 't' });
    assert.ok(!bad.includes('javascript') && bad.includes('</html>'));
  });

  test('inline SVG images are accepted on pages only; other data URIs are refused', () => {
    const svg = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E';
    assert.equal(safeSrc(svg), svg);
    assert.equal(safeSrc(svg, { mode: 'email' }), '');
    assert.equal(safeSrc('data:text/html,<script>alert(1)</script>'), '');
    assert.equal(safeSrc('data:image/svg+xml,<svg onload="x">'), '', 'non encodé : refusé');
    assert.equal(safeSrc('javascript:alert(1)'), '');
    assert.equal(safeSrc('https://exemple.fr/a.png'), 'https://exemple.fr/a.png');
    assert.equal(safeSrc('/uploads/a.png'), '/uploads/a.png');
  });
});

describe('kits: API', () => {
  test('POST /api/funnels stays backward compatible', async () => {
    const api = client(ctx, (await registerUser(ctx)).token);
    const optin = (await api.post('/api/funnels', { name: 'Classique', template: 'optin' })).body;
    assert.deepEqual(optin.steps.map((s: { type: string }) => s.type), ['optin', 'thankyou']);
    assert.equal(optin.settings.kit, undefined);
    assert.equal(optin.steps[0].content.settings.theme, undefined);
    const blank = (await api.post('/api/funnels', { name: 'Vide' })).body;
    assert.equal(blank.steps.length, 1);
    assert.equal((await api.post('/api/funnels', { name: 'X', template: 'autre' })).status, 400);
    const list = (await api.get('/api/funnels')).body;
    assert.ok(list.every((f: { kit: string | null }) => f.kit === null));
  });

  test('a funnel per kit and per type: every step carries the kit, and the funnel remembers it', async () => {
    const api = client(ctx, (await registerUser(ctx)).token);
    for (const k of KITS) {
      for (const flow of Object.keys(KIT_FLOWS) as KitGoal[]) {
        const res = await api.post('/api/funnels', { name: `${k.name} ${flow}`, kit: k.id, flow });
        assert.equal(res.status, 201, `${k.id}/${flow}`);
        const f = res.body;
        assert.equal(f.settings.kit, k.id);
        assert.deepEqual(f.steps.map((s: { name: string }) => s.name), KIT_FLOWS[flow].steps.map((kind) => KIT_PAGES[kind].stepName));
        assert.deepEqual(f.steps.map((s: { type: string }) => s.type), KIT_FLOWS[flow].steps.map((kind) => KIT_PAGES[kind].stepType));
        for (const s of f.steps) assert.equal(s.content.settings.theme.kit, k.id, `${k.id}/${flow}/${s.name}`);
        assert.equal(new Set(f.steps.map((s: { slug: string }) => s.slug)).size, f.steps.length);
      }
    }
    const list = (await api.get('/api/funnels')).body;
    assert.equal(list.length, KITS.length * Object.keys(KIT_FLOWS).length);
    assert.ok(list.every((f: { kit: string }) => getKit(f.kit)));

    // legacy template + kit: the template's steps, in the kit (onboarding)
    const f = (await api.post('/api/funnels', { name: 'Vente douce', template: 'sales', kit: 'douceur' })).body;
    assert.deepEqual(f.steps.map((s: { type: string }) => s.type), ['optin', 'sales', 'thankyou']);
    assert.ok(f.steps.every((s: { content: PageContent }) => s.content.settings.theme?.kit === 'douceur'));

    // validation
    assert.equal((await api.post('/api/funnels', { name: 'X', kit: 'inconnu' })).status, 400);
    assert.equal((await api.post('/api/funnels', { name: 'X', flow: 'vente' })).status, 400);
    assert.equal((await api.post('/api/funnels', { name: 'X', kit: 'studio', flow: 'autre' })).status, 400);

    // the public page of a kit funnel is served
    const pub = await fetch(`${ctx.base}/p/${f.slug}`);
    assert.equal(pub.status, 200);
    const html = await pub.text();
    assert.ok(html.includes(getKit('douceur')!.tokens.bg) && html.includes('Cormorant+Garamond'));
  });

  test('new steps and legal pages follow the kit of the funnel; duplicate keeps it', async () => {
    const api = client(ctx, (await registerUser(ctx)).token);
    const f = (await api.post('/api/funnels', { name: 'Kit nocturne', kit: 'nocturne', flow: 'capture' })).body;
    // no content chosen → the kit's page for the type
    const sales = (await api.post(`/api/funnels/${f.id}/steps`, { name: 'Vente', type: 'sales' })).body;
    assert.equal(sales.content.settings.theme.kit, 'nocturne');
    assert.ok(flattenBlocks(sales.content.blocks).some((b) => b.type === 'pricing'));
    const custom = (await api.post(`/api/funnels/${f.id}/steps`, { name: 'Libre', type: 'custom' })).body;
    assert.equal(custom.content.settings.theme.kit, 'nocturne');
    assert.deepEqual(custom.content.blocks, []);
    // a chosen page is kept as is (another kit, or a classic template)
    const other = (await api.post(`/api/funnels/${f.id}/steps`, { name: 'Autre', type: 'optin', content: kitPage('studio', 'webinar') })).body;
    assert.equal(other.content.settings.theme.kit, 'studio');
    // legal page
    const legal = (await api.post(`/api/funnels/${f.id}/legal-pages`, { kind: 'mentions' })).body;
    assert.equal(legal.step.content.settings.theme.kit, 'nocturne');
    assert.equal(legal.funnel.settings.kit, 'nocturne', 'le kit survit à la mise à jour des réglages');
    // saving the other settings does not lose the kit
    const saved = await api.put(`/api/funnels/${f.id}/settings`, { tracking: { ga4_id: 'G-ABCDE12345' } });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.kit, 'nocturne');
    assert.equal(saved.body.tracking.ga4_id, 'G-ABCDE12345');
    // duplicate
    const copy = (await api.post(`/api/funnels/${f.id}/duplicate`)).body;
    assert.equal(copy.settings.kit, 'nocturne');
    // a funnel without kit is unchanged
    const plain = (await api.post('/api/funnels', { name: 'Sans kit', template: 'optin' })).body;
    const step = (await api.post(`/api/funnels/${plain.id}/steps`, { name: 'Vente', type: 'sales' })).body;
    assert.equal(step.content.settings.theme, undefined);
    const plainLegal = (await api.post(`/api/funnels/${plain.id}/legal-pages`, { kind: 'mentions' })).body;
    assert.equal(plainLegal.step.content.settings.theme, undefined);
  });

  test('export / import keeps the kit (settings and pages); an unknown kit is dropped', async () => {
    const api = client(ctx, (await registerUser(ctx)).token);
    const f = (await api.post('/api/funnels', { name: 'À exporter', kit: 'marche', flow: 'vente' })).body;
    const exp = await api.get(`/api/funnels/${f.id}/export`);
    assert.equal(exp.status, 200);
    assert.equal(exp.body.funnel.settings.kit, 'marche');
    const api2 = client(ctx, (await registerUser(ctx)).token);
    const imp = await api2.post('/api/funnels/import', exp.body);
    assert.equal(imp.status, 201, JSON.stringify(imp.body));
    const copy = (await api2.get(`/api/funnels/${imp.body.id}`)).body;
    assert.equal(copy.settings.kit, 'marche');
    assert.equal(copy.steps.length, 4);
    for (const s of copy.steps) assert.equal(s.content.settings.theme.kit, 'marche');
    assert.ok(flattenBlocks(copy.steps[1].content.blocks).some((b) => b.type === 'checkout'));
    // the imported funnel behaves like a kit funnel
    const added = (await api2.post(`/api/funnels/${copy.id}/steps`, { name: 'Plus', type: 'thankyou' })).body;
    assert.equal(added.content.settings.theme.kit, 'marche');
    // unknown kit (newer version, removed kit): import succeeds without kit
    const imp2 = await api2.post('/api/funnels/import', { ...exp.body, funnel: { ...exp.body.funnel, settings: { kit: 'kit-du-futur' } } });
    assert.equal(imp2.status, 201);
    assert.equal((await api2.get(`/api/funnels/${imp2.body.id}`)).body.settings.kit, undefined);
  });

  test('newsletters and campaign emails can be created from a kit email', async () => {
    const api = client(ctx, (await registerUser(ctx)).token);
    const e = kitEmail('orbit', 'promo')!;
    const b = await api.post('/api/broadcasts', { subject: e.subject, content: e.content });
    assert.equal(b.status, 201);
    assert.equal(b.body.content.settings.theme.kit, 'orbit');
    assert.equal(b.body.content.blocks.length, e.content.blocks.length);
    // without content: the plain default, as before
    const plain = (await api.post('/api/broadcasts', { subject: 'Simple' })).body;
    assert.equal(plain.content.settings.theme, undefined);
    assert.equal(plain.content.blocks.length, 3);
    const c = (await api.post('/api/campaigns', { name: 'Séquence' })).body;
    const ce = await api.post(`/api/campaigns/${c.id}/emails`, { subject: 'Bienvenue', delay_days: 0, content: kitEmail('orbit', 'welcome')!.content });
    assert.equal(ce.status, 201);
    assert.equal(ce.body.content.settings.theme.kit, 'orbit');
  });

  test('AI generation accepts a kit and applies its tokens to the server-built blocks', () => {
    const out = {
      name: 'Tunnel',
      palette: 'rose' as const,
      tag: 'lead',
      pages: [
        { type: 'optin' as const, name: 'Inscription', seo_title: 'SEO', seo_description: '', sections: [{ kind: 'hero' as const, eyebrow: 'Guide', title: 'Titre', subtitle: 'Sous-titre' }, { kind: 'form' as const, title: '', submit_label: 'Go' }] },
        { type: 'thankyou' as const, name: 'Merci', seo_title: '', seo_description: '', sections: [{ kind: 'hero' as const, eyebrow: '', title: 'Merci', subtitle: '' }] },
      ],
    };
    const plain = buildFunnel(out, 'capture')!;
    assert.equal(plain.steps[0]!.content.settings.theme, undefined);
    assert.equal(plain.steps[0]!.content.settings.accent, '#e11d48');
    const kit = getKit('cabinet')!;
    const themed = buildFunnel(out, 'capture', 'cabinet')!;
    for (const s of themed.steps) {
      assert.equal(s.content.settings.theme?.kit, 'cabinet');
      assert.equal(s.content.settings.accent, kit.tokens.accent);
      normalizeContent(s.content, s.name);
      assert.ok(renderPageDocument(s.content, { title: s.name }).includes(kit.tokens.bg));
    }
    assert.equal(themed.steps[0]!.content.settings.seoTitle, 'SEO');
    assert.deepEqual(plain.steps.map((s) => flattenBlocks(s.content.blocks).map((b) => b.type)), themed.steps.map((s) => flattenBlocks(s.content.blocks).map((b) => b.type)), 'mêmes blocs');
    const email = buildEmail({ subject: 'Objet', preheader: 'Aperçu', paragraphs: ['Bonjour'], button_label: 'Voir' }, 'https://exemple.fr', 'cabinet')!;
    assert.equal(email.content.settings.theme?.kit, 'cabinet');
    assert.equal(email.content.settings.preheader, 'Aperçu');
    assert.equal(buildEmail({ subject: 'Objet', preheader: '', paragraphs: ['Bonjour'], button_label: '' }, undefined)!.content.settings.theme, undefined);
    // brief validation
    assert.equal(funnelBriefSchema.parse({ offer: 'Une offre de test', kit: 'studio' }).kit, 'studio');
    assert.equal(funnelBriefSchema.parse({ offer: 'Une offre de test' }).kit, undefined);
    assert.equal(funnelBriefSchema.safeParse({ offer: 'Une offre de test', kit: 'inconnu' }).success, false);
  });
});
