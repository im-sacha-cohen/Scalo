// The pages, emails and insertable sections of a kit. One builder per page kind, shared by every kit: what changes
// from a kit to another is its tokens, its layout recipe and its copy (see compose.ts).
import type { Block, PageContent } from '../content';
import { after, benefits, cap, card, cta, faq, footer, header, heroShell, kitSettings, mk, offer, pairs, program, proof, row, sec, title, type Ctx, type Ui } from './compose';
import type { KitDefinition, KitEmailKind, KitPageKind, KitSectionKind } from './types';

const page = (kit: KitDefinition, seoTitle: string, blocks: Block[]): PageContent => ({ settings: kitSettings(kit, 'page', { seoTitle: cap(seoTitle.replace(/\*/g, '')) }), blocks });
const tag = (kit: KitDefinition, suffix: string) => `${kit.id}-${suffix}`;

/** Form card shared by the capture-like pages. */
const formSide = (formTitle: string, label: string, tagName: string, note: string, fields?: Parameters<Ui['form']>[2]) => (u: Ui): Block[] => [
  u.h3(formTitle, { align: 'left' }),
  u.form(label, tagName, fields),
  u.note(note, { align: 'left' }),
];

const PAGES: Record<KitPageKind, (x: Ctx) => PageContent> = {
  optin: (x) => {
    const c = x.kit.copy;
    const m = c.magnet;
    return page(x.kit, `${m.title} — ${c.brand}`, [
      header(x),
      ...heroShell(x, (u) => [u.eyebrow(m.eyebrow, 0), u.h1(m.title), u.lead(m.lead), u.list(m.bullets, 'check', { align: u.align })], formSide(m.formTitle, m.cta, tag(x.kit, 'inscrit'), m.note), { sideCard: true }),
      proof(x, after(x, 0), 1),
      footer(x),
    ]);
  },

  sales: (x) => {
    const c = x.kit.copy;
    const o = c.offer;
    return page(x.kit, `${o.name} — ${c.brand}`, [
      header(x, { cta: o.cta }),
      ...heroShell(x, (u) => [u.eyebrow(o.eyebrow, 0), u.h1(o.title), u.lead(o.lead), u.btn(o.cta)], (u) => [u.art('hero')]),
      sec(x, after(x, 0), (u) => [u.eyebrow('Le constat', 1), u.h2(o.story[0]), u.p(o.story[1], { align: u.align, size: x.kit.tokens.lead, color: u.muted, lineHeight: 1.7 })], { width: 760 }),
      benefits(x, after(x, 1)),
      program(x, after(x, 2)),
      proof(x, after(x, 3)),
      offer(x, after(x, 4)),
      faq(x, after(x, 5)),
      cta(x),
      footer(x),
    ]);
  },

  checkout: (x) => {
    const c = x.kit.copy;
    const o = c.offer;
    return page(x.kit, `Commande — ${o.name}`, [
      header(x),
      sec(x, 'bg', (u) => [
        row(
          [
            [u.eyebrow(cap(o.name), 1, { align: 'left' }), u.h1('Finalisez votre commande', { align: 'left', size: Math.round(x.kit.tokens.h1 * 0.72) }), u.lead('Vous recevez vos accès par email dès la confirmation du paiement.', { align: 'left' }), u.list(o.includes, 'check'), u.note(o.guarantee, { align: 'left' })],
            card(x, 'surface', (k) => [
              k.h3('Vos coordonnées'),
              mk('checkout', { submitLabel: 'Valider ma commande', askName: true, showSummary: true, secureNote: 'Paiement sécurisé par Stripe', buttonBg: x.kit.tokens.accent, buttonColor: x.kit.tokens.accentText, style: { paddingTop: 10, paddingBottom: 4 } }),
            ], 32),
          ],
          [54, 46],
          { gap: 56 },
        ),
      ]),
      proof(x, 'alt', 1),
      footer(x),
    ]);
  },

  upsell: (x) => {
    const c = x.kit.copy;
    const s = c.upsell;
    return page(x.kit, `${s.title} — ${c.brand}`, [
      header(x),
      sec(x, 'alt', (u) => [
        mk('progress', { value: 66, label: 'Commande confirmée — encore une étape', barColor: x.kit.tokens.accent, height: 10, style: { color: u.fg, paddingBottom: 24 } }),
        u.eyebrow('Une seule fois, juste pour vous'),
        u.h1(s.title, { size: Math.round(x.kit.tokens.h1 * 0.78) }),
        u.lead(s.text),
        u.gap(8),
        row([card(x, 'surface', (k) => [
          k.list(s.bullets, 'check'),
          mk('upsell', { acceptLabel: s.accept, declineLabel: s.decline, note: 'Un seul clic : votre moyen de paiement est déjà enregistré.', buttonBg: x.kit.tokens.accent, buttonColor: x.kit.tokens.accentText, style: { align: 'center', color: k.fg, paddingTop: 12 } }),
        ], 32)], [100]),
      ], { width: 720 }),
      footer(x),
    ]);
  },

  thankyou: (x) => {
    const c = x.kit.copy;
    const th = c.thanks;
    return page(x.kit, `Merci — ${c.brand}`, [
      header(x),
      ...heroShell(x, (u) => [u.eyebrow('C’est confirmé'), u.h1(th.title), u.lead(th.lead)], null),
      pairs(x, x.kit.layout.benefits === 'rows' ? 'grid' : x.kit.layout.benefits, after(x, 0), { eyebrow: 'Et maintenant', title: 'La suite, en trois temps', n: 2 }, th.steps),
      footer(x),
    ]);
  },

  webinar: (x) => {
    const c = x.kit.copy;
    const w = c.webinar;
    return page(x.kit, `${w.title} — ${c.brand}`, [
      header(x),
      ...heroShell(
        x,
        (u) => [u.eyebrow(w.eyebrow, 0), u.h1(w.title, { size: Math.round(x.kit.tokens.h1 * 0.86) }), u.lead(w.lead), u.p(`**${w.when}**`, { align: u.align, color: u.ink }), u.countdown(7)],
        formSide('Réservez votre place', w.cta, tag(x.kit, 'webinaire'), 'Gratuit. Le lien de connexion vous est envoyé par email.'),
        { sideCard: true },
      ),
      pairs(x, x.kit.layout.benefits, after(x, 0), { eyebrow: 'Au programme', title: 'Ce que nous verrons ensemble', n: 2 }, w.points),
      sec(x, after(x, 1), (u) => [
        mk('imageText', { src: (u.art('portrait') as { src: string }).src, alt: 'Emplacement pour votre photo', imagePosition: 'left', imageWidth: 36, radius: x.kit.tokens.radius, title: w.hostName, text: w.hostBio, style: { color: u.fg } }),
      ], { width: 900 }),
      cta(x, { title: 'Une place vous attend', text: w.when, label: w.cta }),
      footer(x),
    ]);
  },

  comingsoon: (x) => {
    const c = x.kit.copy;
    const s = c.soon;
    return page(x.kit, `${s.title} — ${c.brand}`, [
      header(x),
      ...heroShell(
        x,
        (u) => [u.eyebrow(s.eyebrow, 0), u.h1(s.title), u.lead(s.lead), u.countdown(21)],
        formSide('Être prévenu(e) en premier', s.cta, tag(x.kit, 'liste-attente'), 'Un seul email, le jour de l’ouverture.', [{ name: 'email', label: 'Votre adresse email', required: true }]),
        { sideCard: true, minHeight: 640 },
      ),
      footer(x),
    ]);
  },
};

export function buildKitPage(kit: KitDefinition, kind: KitPageKind): PageContent {
  return PAGES[kind]({ kit, email: false });
}

// ================= emails =================

const email = (kit: KitDefinition, preheader: string, blocks: Block[]): PageContent => ({ settings: kitSettings(kit, 'email', { preheader }), blocks });

const EMAILS: Record<KitEmailKind, (x: Ctx) => PageContent> = {
  welcome: (x) => {
    const c = x.kit.copy;
    const e = c.emails.welcome;
    return email(x.kit, e.preheader, [
      header(x),
      ...heroShell(x, (u) => [u.eyebrow('Bienvenue'), u.h1(e.title)], null),
      sec(x, 'bg', (u) => [u.p(e.body), u.h3('Pour bien commencer', { paddingTop: 14 }), u.list(e.steps, 'number'), u.btn(e.cta, { align: 'left' }), u.p(c.sign, { paddingTop: 18 })], { pt: 28, pb: 32 }),
      footer(x),
    ]);
  },
  newsletter: (x) => {
    const c = x.kit.copy;
    const e = c.emails.newsletter;
    return email(x.kit, e.preheader, [
      header(x),
      ...heroShell(x, (u) => [u.eyebrow(e.issue), u.h1(e.title)], null),
      sec(x, 'bg', (u) => [u.p(e.body), u.btn(e.cta, { align: 'left' })], { pt: 28, pb: 20 }),
      sec(x, 'bg', (u) => [
        u.rule({ py: 0 }),
        u.gap(20),
        row(e.shorts.map(([a, b]) => [u.h3(a), u.p(b, { color: u.muted, size: 15 })]), undefined, { gap: 24, style: { paddingX: 24 } }),
        u.gap(12),
        mk('quote', { text: e.quote, barColor: u.ink, style: { color: u.fg, fontSize: 18 } }),
        u.p(c.sign, { paddingTop: 18 }),
      ], { pt: 0, pb: 32 }),
      footer(x),
    ]);
  },
  promo: (x) => {
    const c = x.kit.copy;
    const e = c.emails.promo;
    return email(x.kit, e.preheader, [
      header(x),
      ...heroShell(x, (u) => [u.eyebrow(e.eyebrow), u.h1(e.title), u.btn(e.cta)], null),
      sec(x, 'bg', (u) => [u.p(e.body), u.list(e.points, 'check'), u.btn(e.cta, { full: true }), u.note(e.ps, { align: 'left', paddingTop: 16 })], { pt: 28, pb: 32 }),
      footer(x),
    ]);
  },
  reminder: (x) => {
    const c = x.kit.copy;
    const e = c.emails.reminder;
    return email(x.kit, e.preheader, [
      header(x),
      sec(x, 'bg', (u) => [u.p(e.body), u.btn(e.cta, { align: 'left' }), u.p(c.sign, { paddingTop: 18 }), u.rule({ py: 8 }), u.note(e.ps, { align: 'left' })], { pt: 28, pb: 32 }),
      footer(x),
    ]);
  },
  webinar: (x) => {
    const c = x.kit.copy;
    const e = c.emails.webinar;
    return email(x.kit, e.preheader, [
      header(x),
      ...heroShell(x, (u) => [u.eyebrow('Inscription confirmée'), u.h1(e.title)], null),
      sec(x, 'bg', (u) => [
        u.p(e.body),
        row([card(x, 'surface', (k) => [k.note('DATE ET HEURE', { align: 'left', fontWeight: 700, letterSpacing: 1.5 }), k.p(`**${c.webinar.when}**`, { paddingTop: 0 }), k.note('LIEN DE CONNEXION', { align: 'left', fontWeight: 700, letterSpacing: 1.5, paddingTop: 10 }), k.p('[Lien de connexion à ajouter]', { paddingTop: 0 })], 20)], [100], { style: { paddingX: 24, paddingTop: 10, paddingBottom: 10 } }),
        u.btn(e.cta, { align: 'left' }),
        u.h3('Pour en profiter pleinement', { paddingTop: 18 }),
        u.list(e.tips, 'check'),
        u.p(c.sign, { paddingTop: 18 }),
      ], { pt: 28, pb: 32 }),
      footer(x),
    ]);
  },
};

export function buildKitEmail(kit: KitDefinition, kind: KitEmailKind): PageContent {
  return EMAILS[kind]({ kit, email: true });
}

/** Subject proposed with an email template of a kit. */
export const kitEmailSubject = (kit: KitDefinition, kind: KitEmailKind) => kit.copy.emails[kind].subject;

// ================= sections (inserted one by one in the builder) =================

export function buildKitSection(kit: KitDefinition, kind: KitSectionKind, mode: 'page' | 'email' = 'page'): Block[] {
  const x: Ctx = { kit, email: mode === 'email' };
  const o = kit.copy.offer;
  switch (kind) {
    case 'header': return [header(x, mode === 'page' ? { cta: o.cta } : {})];
    case 'hero': return heroShell(x, (u) => [u.eyebrow(o.eyebrow), u.h1(o.title), u.lead(o.lead), u.btn(o.cta)], mode === 'page' ? (u) => [u.art('hero')] : null);
    case 'benefits': return [benefits(x, 'bg')];
    case 'program': return [program(x, 'alt')];
    case 'proof': return [proof(x, 'bg')];
    case 'offer': return [offer(x, 'alt')];
    case 'faq': return [mode === 'email' ? sec(x, 'bg', (u) => [...title(u, 'Questions fréquentes', 'Avant de vous décider'), u.faq(o.faq)]) : faq(x, 'bg')];
    case 'cta': return [cta(x)];
    case 'footer': return [footer(x)];
  }
}
