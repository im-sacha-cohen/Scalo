// Composition toolkit of the kits: token-bound block helpers (`ui`) and the reusable sections (header, hero, benefits,
// proof, offer, FAQ, call to action, footer). Every color, font, radius and spacing comes from the kit's tokens; the
// kit's layout recipe picks the composition. Pages (pages.ts) and emails (emails.ts) are assembled from these.
import type { Block, BlockStyle, BlockType, Column, ColumnsBlock, PageSettings, PageTheme, SectionBlock } from '../content';
import { uid } from '../templates';
import { kitArt, type ArtKind } from './art';
import type { KitDefinition } from './types';

type B<T extends BlockType> = Extract<Block, { type: T }>;
const mk = <T extends BlockType>(type: T, props: Omit<B<T>, 'id' | 'type'>): B<T> => ({ id: uid(), type, ...props }) as unknown as B<T>;

/** Where a block sits: decides its colors. `inverse` is the strong band of the kit. */
export type Tone = 'bg' | 'alt' | 'surface' | 'inverse';

export interface Ctx {
  kit: KitDefinition;
  email: boolean;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

export function kitTheme(kit: KitDefinition): PageTheme {
  const t = kit.tokens;
  return {
    kit: kit.id,
    surface: t.surface,
    surfaceText: t.text,
    border: t.border,
    accentText: t.accentText,
    accent2: t.accent2,
    radius: t.radius,
    buttonRadius: t.buttonRadius,
    ...(t.borderWidth !== undefined ? { borderWidth: t.borderWidth } : {}),
    shadow: t.shadow,
    headingWeight: t.headingWeight,
    headingSpacing: t.headingSpacing,
    ...(t.headingCase ? { headingCase: t.headingCase } : {}),
    ...(t.buttonWeight ? { buttonWeight: t.buttonWeight } : {}),
    ...(t.buttonSpacing ? { buttonSpacing: t.buttonSpacing } : {}),
    ...(t.buttonCase ? { buttonCase: t.buttonCase } : {}),
  };
}

/** Page / email settings of a kit: the single place where tokens become `PageSettings`. */
export function kitSettings(kit: KitDefinition, mode: 'page' | 'email' = 'page', extra: Partial<PageSettings> = {}): PageSettings {
  const t = kit.tokens;
  return {
    background: mode === 'email' ? t.alt : t.bg,
    contentBackground: t.bg,
    maxWidth: mode === 'email' ? 600 : 1120,
    fontFamily: t.fontBody,
    headingFont: t.fontHeading,
    textColor: t.text,
    accent: t.accent,
    contentPadding: 0,
    theme: kitTheme(kit),
    ...extra,
  };
}

const inDays = (d: number) => {
  const at = new Date(Date.now() + d * 86400_000);
  at.setHours(19, 0, 0, 0);
  return at.toISOString();
};

/** Token-bound block helpers for one tone. */
export function ui(x: Ctx, tone: Tone) {
  const t = x.kit.tokens;
  const l = x.kit.layout;
  const inv = tone === 'inverse';
  const fg = inv ? t.inverseText : t.text;
  const muted = inv ? t.inverseMuted : t.muted;
  const ink = inv ? t.inverseAccent : t.accentInk;
  const btnBg = inv ? t.inverseAccent : t.accent;
  const btnFg = inv ? t.inverse : t.accentText;
  const bg = tone === 'inverse' ? t.inverse : t[tone];
  const H1 = x.email ? clamp(t.h1 * 0.52, 26, 34) : t.h1;
  const H2 = x.email ? clamp(t.h2 * 0.62, 21, 25) : t.h2;
  const tight = t.headingCase === 'upper' ? 1.02 : 1.1;
  const align = l.align;
  type Opt = BlockStyle & { size?: number };
  const st = (base: BlockStyle, o: Opt = {}): BlockStyle => {
    const { size, ...rest } = o;
    return { color: fg, ...base, ...(size ? { fontSize: size } : {}), ...rest };
  };

  const u = {
    tone, fg, muted, ink, bg, align, t,
    h1: (text: string, o: Opt = {}) =>
      mk('heading', { text, level: 1, style: st({ align, fontSize: H1, mobileFontSize: x.email ? undefined : clamp(H1 * 0.58, 30, 42), lineHeight: tight, paddingTop: 6, paddingBottom: 10 }, o) }),
    h2: (text: string, o: Opt = {}) =>
      mk('heading', { text, level: 2, style: st({ align, fontSize: H2, mobileFontSize: x.email ? undefined : clamp(H2 * 0.74, 24, 30), lineHeight: tight + 0.06, paddingTop: 4, paddingBottom: 8 }, o) }),
    h3: (text: string, o: Opt = {}) => mk('heading', { text, level: 3, style: st({ align: 'left', fontSize: x.email ? 18 : 21, lineHeight: 1.25, paddingTop: 4, paddingBottom: 4 }, o) }),
    p: (text: string, o: Opt = {}) => mk('text', { text, style: st({ fontSize: x.email ? 16 : 17, lineHeight: 1.65, paddingTop: 6, paddingBottom: 6 }, o) }),
    lead: (text: string, o: Opt = {}) => mk('text', { text, style: st({ align, color: muted, fontSize: x.email ? 17 : t.lead, mobileFontSize: x.email ? undefined : Math.min(t.lead, 18), lineHeight: 1.6, paddingTop: 4, paddingBottom: 10 }, o) }),
    note: (text: string, o: Opt = {}) => mk('text', { text, style: st({ align, color: muted, fontSize: 13.5, lineHeight: 1.5, paddingTop: 4, paddingBottom: 4 }, o) }),
    /** Overline above a title, in the kit's manner. */
    eyebrow: (text: string, n = 1, o: Opt = {}) => {
      const up = text.toLocaleUpperCase('fr-FR');
      const base: BlockStyle = { align, color: ink, fontSize: 12.5, fontWeight: 700, letterSpacing: 2.2, paddingTop: 0, paddingBottom: 2 };
      if (l.eyebrow === 'rule') return mk('text', { text: `—— ${up}`, style: st({ ...base, color: muted, letterSpacing: 3 }, o) });
      if (l.eyebrow === 'index') return mk('text', { text: n > 0 ? `N° ${String(n).padStart(2, '0')} — ${text}` : text, style: st({ ...base, fontSize: 14, fontWeight: 500, letterSpacing: 0.3 }, o) });
      if (l.eyebrow === 'dot') return mk('text', { text: `<span style="color:${inv ? t.inverseAccent : t.accent2}">●</span> ${text}`, style: st({ ...base, color: fg, fontSize: 14, fontWeight: 600, letterSpacing: 0.2 }, o) });
      if (l.eyebrow === 'star') return mk('text', { text: `✦ ${up}`, style: st({ ...base, fontSize: 13, fontWeight: 800, letterSpacing: 1.4 }, o) });
      return mk('text', { text: up, style: st(base, o) });
    },
    btn: (label: string, o: { outline?: boolean; size?: 'sm' | 'md' | 'lg'; align?: BlockStyle['align']; url?: string; full?: boolean; top?: number } = {}) =>
      mk('button', {
        label,
        ...(x.email || o.url ? { action: 'url' as const, url: o.url ?? '#' } : { action: 'next' as const }),
        size: o.size ?? (x.email ? 'md' : 'lg'),
        ...(o.outline ? { variant: 'outline' as const, bg: fg } : { bg: btnBg, textColor: btnFg }),
        ...(o.full ? { fullWidth: true } : {}),
        style: { align: o.align ?? align, paddingTop: o.top ?? 16, paddingBottom: 8 },
      }),
    list: (items: string[], icon: B<'list'>['icon'] = 'check', o: Opt = {}) => mk('list', { items, icon, style: st({ fontSize: x.email ? 16 : 17, lineHeight: 1.5, paddingTop: 8, paddingBottom: 8 }, o) }),
    feature: (icon: string, title: string, text: string, layout: 'top' | 'left' = 'top', o: Opt = {}) =>
      mk('feature', { icon, title, text, layout, iconSize: 52, iconBg: tone === 'surface' || tone === 'bg' ? t.alt : inv ? t.inverseAccent : t.surface, style: st({ align: layout === 'left' ? 'left' : align }, o) }),
    rule: (o: { strong?: boolean; width?: number; py?: number } = {}) =>
      mk('divider', { color: o.strong ? fg : inv ? t.inverseMuted : t.border, thickness: o.strong ? 2 : 1, width: o.width ?? 100, style: { paddingTop: o.py ?? 12, paddingBottom: o.py ?? 12, align } }),
    gap: (height: number) => mk('spacer', { height }),
    form: (submitLabel: string, tagName: string, fields: B<'form'>['fields'] = [{ name: 'first_name', label: 'Votre prénom' }, { name: 'email', label: 'Votre adresse email', required: true }]) =>
      mk('form', { submitLabel, fields, tagName, buttonBg: btnBg, buttonColor: btnFg, style: { paddingTop: 10, paddingBottom: 6 } }),
    countdown: (days: number) =>
      mk('countdown', { mode: 'date', date: inDays(days), showLabels: true, boxBg: inv ? t.surface : t.inverse, boxColor: inv ? t.text : t.inverseText, expiredText: 'C’est parti !', style: { align, paddingTop: 12, paddingBottom: 12, fontSize: 30 } }),
    art: (kind: ArtKind = 'hero', o: { width?: number; alt?: string } = {}) =>
      mk('image', { src: kitArt(l.art, t, kind), alt: o.alt ?? (kind === 'portrait' ? 'Emplacement pour votre photo' : ''), width: o.width ?? 100, radius: t.radius, style: { align: 'center', paddingTop: 8, paddingBottom: 8 } }),
    voice: (v: { quote: string; name: string; role: string }, layout: 'card' | 'plain' = 'card', o: Opt = {}) =>
      mk('testimonial', { quote: v.quote, name: v.name, role: v.role, stars: 0, layout, style: layout === 'card' ? { fontSize: 16.5, ...o } : st({ fontSize: 17 }, o) }),
    faq: (items: { q: string; a: string }[]) => mk('faq', { items, openFirst: true, style: st({ fontSize: 17.5 }) }),
  };
  return u;
}
export type Ui = ReturnType<typeof ui>;

/** Tone of the hero of the kit, and the alternating tones of the sections that follow it. */
export const heroTone = (x: Ctx): Tone => (x.kit.layout.hero === 'split' || x.kit.layout.hero === 'editorial' ? 'bg' : x.kit.layout.hero === 'poster' ? 'inverse' : 'alt');
export const after = (x: Ctx, i: number): Tone => ((heroTone(x) === 'alt' ? i : i + 1) % 2 === 0 ? 'bg' : 'alt');

export interface SecOpts {
  width?: number;
  pt?: number;
  pb?: number;
  minHeight?: number;
  marginTop?: number;
  transparent?: boolean;
}

/** A full-width section in a tone (boxed in emails). */
export function sec(x: Ctx, tone: Tone, build: (u: Ui) => Block[], o: SecOpts = {}): SectionBlock {
  const t = x.kit.tokens;
  const u = ui(x, tone);
  const py = x.email ? Math.min(36, Math.round(t.space * 0.4)) : t.space;
  return mk('section', {
    children: build(u),
    fullWidth: !x.email,
    ...(x.email ? {} : { contentWidth: o.width ?? t.width }),
    ...(o.minHeight && !x.email ? { minHeight: o.minHeight, valign: 'center' as const } : {}),
    style: {
      ...(o.transparent ? {} : { background: u.bg }),
      color: u.fg,
      paddingTop: x.email && o.pt !== undefined ? Math.min(o.pt, 36) : (o.pt ?? py),
      paddingBottom: x.email && o.pb !== undefined ? Math.min(o.pb, 36) : (o.pb ?? py),
      ...(o.marginTop && !x.email ? { marginTop: o.marginTop } : {}),
    },
  });
}

/** A card: a column painted with a tone (the renderer adds the kit's border, radius and shadow). */
export const card = (x: Ctx, tone: Tone, build: (u: Ui) => Block[], padding = 32): Partial<Column> & { children: Block[] } => {
  const u = ui(x, tone);
  return { children: build(u), background: u.bg, padding: x.email ? Math.min(padding, 20) : padding };
};

type Col = Block[] | (Partial<Column> & { children: Block[] });
export function row(cols: Col[], widths?: number[], o: Partial<Omit<ColumnsBlock, 'id' | 'type' | 'columns'>> = {}): ColumnsBlock {
  const w = widths ?? cols.map(() => Math.round((100 / cols.length) * 100) / 100);
  return mk('columns', {
    columns: cols.map((c, i) => ({ id: uid(), width: w[i]!, ...(Array.isArray(c) ? { children: c } : c) })),
    gap: 32,
    stackOnMobile: true,
    ...o,
    style: { paddingTop: 0, paddingBottom: 0, ...o.style },
  });
}

/** Overline + title (+ intro) of a section, aligned as the kit wants. */
export const title = (u: Ui, eyebrow: string, text: string, lead?: string, n = 1): Block[] => [
  u.eyebrow(eyebrow, n),
  u.h2(text),
  ...(lead ? [u.lead(lead)] : []),
  u.gap(16),
];

const num = (i: number) => String(i + 1).padStart(2, '0');
/** « l’Atelier » → « L’Atelier » (offer names written to be used inside a sentence). */
export const cap = (s: string) => s.charAt(0).toLocaleUpperCase('fr-FR') + s.slice(1);

// ================= sections =================

export function header(x: Ctx, o: { cta?: string } = {}): SectionBlock {
  const { layout: l, copy: c, tokens: t } = x.kit;
  if (x.email) {
    if (l.emailHeader === 'band') return sec(x, 'inverse', (u) => [u.h3(c.brand, { align: 'center', size: 20 })], { pt: 20, pb: 20 });
    return sec(x, 'bg', (u) => [
      u.h3(c.brand, { align: l.emailHeader === 'center' ? 'center' : 'left', size: 20, paddingBottom: 10 }),
      u.rule({ strong: l.emailHeader === 'left', py: 0 }),
    ], { pt: 24, pb: 0 });
  }
  if (l.header === 'center') {
    return sec(x, 'bg', (u) => [u.h3(c.brand, { align: 'center', size: 22, paddingBottom: 12 }), u.rule({ width: 100, py: 0 })], { pt: 26, pb: 0 });
  }
  const tone: Tone = l.header === 'inverse' ? 'inverse' : 'bg';
  return sec(x, tone, (u) => [mk('navbar', { logoText: c.brand, links: [], ...(o.cta ? { ctaLabel: o.cta, ctaUrl: '#' } : {}), style: { paddingTop: 0, paddingBottom: 0, color: u.fg } })], {
    pt: 18,
    pb: 18,
    width: Math.max(t.width, 1040),
  });
}

/**
 * Hero shell: the same content (`main`, and a `side` that is a form card or an illustration) laid out in the kit's
 * manner — split, mirrored split, centered, framed card, dark poster, editorial column or color block with an
 * overlapping card.
 */
export function heroShell(x: Ctx, main: (u: Ui) => Block[], side: ((u: Ui) => Block[]) | null, o: { sideCard?: boolean; minHeight?: number } = {}): SectionBlock[] {
  const { layout: l, tokens: t } = x.kit;
  const sideCol = (u: Ui): Col => (!side ? [] : o.sideCard ? card(x, 'surface', side, 32) : side(u));
  if (x.email) return [sec(x, l.emailHero === 'band' ? 'inverse' : l.emailHero === 'card' ? 'alt' : 'bg', main)];
  const top = Math.round(t.space * 1.1);
  switch (l.hero) {
    case 'split':
      return [sec(x, 'bg', (u) => [side ? row([main(u), sideCol(u)], [56, 44], { gap: 56, valign: 'center' }) : row([main(u)], [100])], { pt: top, pb: top, minHeight: o.minHeight })];
    case 'poster':
      return [sec(x, 'inverse', (u) => [side ? row([main(u), sideCol(u)], [58, 42], { gap: 48, valign: 'center' }) : row([main(u)], [100])], { pt: top + 8, pb: top + 8, minHeight: o.minHeight })];
    case 'editorial':
      return [
        sec(x, 'bg', (u) => [u.rule({ strong: true, py: 0 }), u.gap(28), ...main(u), ...(side ? [u.gap(20), row([sideCol(u), []], [o.sideCard ? 52 : 64, o.sideCard ? 48 : 36], { gap: 40 })] : [])], {
          width: 880,
          pt: Math.round(top * 0.7),
          pb: top,
          minHeight: o.minHeight,
        }),
      ];
    case 'block':
      return [
        sec(x, 'alt', main, { width: 860, pt: top, pb: side ? top + 56 : top, minHeight: side ? undefined : o.minHeight }),
        ...(side ? [sec(x, 'bg', (u) => [row([sideCol(u)], [100])], { width: o.sideCard ? 560 : 720, pt: 0, pb: Math.round(t.space * 0.7), marginTop: -96, transparent: true })] : []),
      ];
    case 'mirror':
      return [sec(x, 'alt', (u) => [side ? row([sideCol(u), main(u)], [44, 56], { gap: 56, valign: 'center', reverseOnMobile: true }) : row([main(u)], [100])], { pt: top, pb: top, minHeight: o.minHeight })];
    case 'frame':
      return [
        sec(x, 'alt', () => [row([card(x, 'surface', (k) => [...main(k), ...(side ? [k.gap(8), k.rule({ py: 8 }), ...side(k)] : [])], 56)], [100])], {
          width: o.sideCard ? 680 : 820,
          pt: top,
          pb: top,
          minHeight: o.minHeight,
        }),
      ];
    default:
      return [sec(x, 'alt', (u) => [...main(u), ...(side ? [u.gap(16), row([sideCol(u)], [100])] : [])], { width: o.sideCard ? 600 : 820, pt: top, pb: top, minHeight: o.minHeight })];
  }
}

/** Titled pairs (benefits, program, steps) in one of four compositions. */
export function pairs(x: Ctx, variant: 'grid' | 'numbered' | 'cards' | 'rows', tone: Tone, head: { eyebrow: string; title: string; lead?: string; n?: number }, items: [string, string][]): SectionBlock {
  const t = x.kit.tokens;
  if (x.email) {
    return sec(x, tone, (u) => [u.h2(head.title, { align: 'left' }), ...items.flatMap(([a, b], i) => [u.h3(`${num(i)} — ${a}`, { color: u.fg }), u.p(b, { color: u.muted, paddingTop: 0 })])]);
  }
  switch (variant) {
    case 'numbered':
      return sec(x, tone, (u) => [
        ...title(u, head.eyebrow, head.title, head.lead, head.n),
        ...items.flatMap(([a, b], i) => [
          u.rule({ py: 0 }),
          row([[u.h2(num(i), { color: u.ink, align: 'left', paddingTop: 18, paddingBottom: 0 })], [u.h3(a, { paddingTop: 22 }), u.p(b, { color: u.muted, paddingTop: 2, paddingBottom: 22 })]], [16, 84], { gap: 24 }),
        ]),
        u.rule({ py: 0 }),
      ], { width: Math.min(t.width, 880) });
    case 'cards':
      return sec(x, tone, (u) => [
        ...title(u, head.eyebrow, head.title, head.lead, head.n),
        row(items.map(([a, b], i) => card(x, 'surface', (k) => [k.p(num(i), { color: k.ink, fontWeight: 800, size: 15, letterSpacing: 1, paddingBottom: 0 }), k.h3(a), k.p(b, { color: k.muted, size: 16 })], 28)), undefined, { gap: 24 }),
      ]);
    case 'rows':
      return sec(x, tone, (u) => [
        row(
          [
            [u.eyebrow(head.eyebrow, head.n, { align: 'left' }), u.h2(head.title, { align: 'left' }), ...(head.lead ? [u.lead(head.lead, { align: 'left' })] : [])],
            items.map(([a, b], i) => u.feature(num(i), a, b, 'left', { paddingTop: 14, paddingBottom: 14 })),
          ],
          [40, 60],
          { gap: 56 },
        ),
      ]);
    default:
      return sec(x, tone, (u) => [
        ...title(u, head.eyebrow, head.title, head.lead, head.n),
        row(items.map(([a, b], i) => [u.feature(num(i), a, b, 'top')]), undefined, { gap: 36 }),
      ]);
  }
}

export function benefits(x: Ctx, tone: Tone = 'bg'): SectionBlock {
  const o = x.kit.copy.offer;
  return pairs(x, x.kit.layout.benefits, tone, { eyebrow: 'Ce que vous y gagnez', title: o.benefitsTitle, n: 2 }, o.benefits);
}

/** The program uses a different composition than the benefits, so a long page keeps its rhythm. */
export function program(x: Ctx, tone: Tone = 'alt'): SectionBlock {
  const o = x.kit.copy.offer;
  const other = { grid: 'rows', numbered: 'cards', cards: 'numbered', rows: 'grid' } as const;
  return pairs(x, other[x.kit.layout.benefits], tone, { eyebrow: 'Le programme', title: o.programTitle, n: 3 }, o.program);
}

export function proof(x: Ctx, tone: Tone = 'bg', count = 3): SectionBlock {
  const { layout: l, copy: c, tokens: t } = x.kit;
  const v = c.voices.slice(0, count);
  if (x.email) return sec(x, tone, (u) => [u.voice(v[0]!, 'card')]);
  if (l.proof === 'quote' || v.length === 1) {
    return sec(x, tone, (u) => [
      u.eyebrow('Ils en parlent', 4),
      mk('quote', { text: v[0]!.quote, author: `${v[0]!.name}, ${v[0]!.role}`, barColor: u.ink, style: { color: u.fg, fontSize: x.kit.tokens.lead + 6, lineHeight: 1.45, paddingTop: 12, paddingBottom: 12 } }),
      ...(v.length > 2 ? [u.gap(20), row(v.slice(1).map((q) => [u.voice(q, 'plain')]), undefined, { gap: 40 })] : []),
    ], { width: Math.min(t.width, 860) });
  }
  if (l.proof === 'columns') {
    return sec(x, tone, (u) => [
      ...title(u, 'Ils en parlent', 'Ce qu’en disent celles et ceux qui l’ont vécu', undefined, 4),
      u.rule({ strong: true, py: 0 }),
      u.gap(16),
      row(v.slice(0, 2).map((q) => [u.voice(q, 'plain')]), undefined, { gap: 56 }),
    ], { width: Math.min(t.width, 960) });
  }
  return sec(x, tone, (u) => [...title(u, 'Ils en parlent', 'Ce qu’en disent celles et ceux qui l’ont vécu', undefined, 4), row(v.map((q) => [u.voice(q, 'card')]), undefined, { gap: 24 })]);
}

const priceCard = (x: Ctx, o: { title: string; features: string[]; highlighted: boolean; badge?: string }) => {
  const c = x.kit.copy.offer;
  return mk('pricing', {
    title: o.title,
    price: '000 €',
    period: c.priceNote,
    features: o.features,
    buttonLabel: c.cta,
    ...(x.email ? { action: 'url' as const, url: '#' } : { action: 'next' as const }),
    highlighted: o.highlighted,
    ...(o.badge ? { badge: o.badge } : {}),
    style: { paddingTop: 8, paddingBottom: 8 },
  });
};

export function offer(x: Ctx, tone: Tone = 'alt'): SectionBlock {
  const { layout: l, copy: c } = x.kit;
  const o = c.offer;
  if (l.offer === 'split' && !x.email) {
    return sec(x, tone, (u) => [
      row(
        [
          [u.eyebrow('L’offre', 5, { align: 'left' }), u.h2(`Tout ce que comprend ${o.name}`, { align: 'left' }), u.list(o.includes, 'check'), u.note(o.guarantee, { align: 'left' })],
          [priceCard(x, { title: cap(o.name), features: o.includes.slice(0, 3), highlighted: true })],
        ],
        [54, 46],
        { gap: 56, valign: 'center' },
      ),
    ]);
  }
  if (l.offer === 'two' && !x.email) {
    return sec(x, tone, (u) => [
      ...title(u, 'L’offre', `Deux façons de rejoindre ${o.name}`, undefined, 5),
      row(
        [
          [priceCard(x, { title: 'L’essentiel', features: o.includes.slice(0, 3), highlighted: false })],
          [priceCard(x, { title: 'La formule complète', features: o.includes, highlighted: true, badge: 'Le plus complet' })],
        ],
        undefined,
        { gap: 28, valign: 'center' },
      ),
      u.note(o.guarantee, { align: 'center', paddingTop: 20 }),
    ], { width: 900 });
  }
  return sec(x, tone, (u) => [
    ...title(u, 'L’offre', `${cap(o.name)}, en détail`, undefined, 5),
    priceCard(x, { title: cap(o.name), features: o.includes, highlighted: true }),
    u.note(o.guarantee, { align: 'center', paddingTop: 20 }),
  ], { width: 760 });
}

export function faq(x: Ctx, tone: Tone = 'bg'): SectionBlock {
  const { layout: l, copy: c, tokens: t } = x.kit;
  if (l.align === 'left' && !x.email) {
    return sec(x, tone, (u) => [
      row([[u.eyebrow('Questions fréquentes', 6), u.h2('Avant de vous décider'), u.p('Une autre question ? Répondez simplement à l’un de nos emails : une vraie personne vous lira.', { color: u.muted })], [u.faq(c.offer.faq)]], [38, 62], { gap: 56 }),
    ]);
  }
  return sec(x, tone, (u) => [...title(u, 'Questions fréquentes', 'Avant de vous décider', undefined, 6), u.faq(c.offer.faq)], { width: Math.min(t.width, 780) });
}

export function cta(x: Ctx, o: { title?: string; text?: string; label?: string } = {}): SectionBlock {
  const { layout: l, copy: c, tokens: t } = x.kit;
  const head = o.title ?? c.offer.finalTitle;
  const text = o.text ?? c.offer.finalText;
  const label = o.label ?? c.offer.cta;
  if (l.cta === 'boxed' && !x.email) {
    return sec(x, 'bg', () => [row([card(x, 'inverse', (k) => [k.h2(head, { align: 'center' }), k.lead(text, { align: 'center' }), k.btn(label, { align: 'center' })], 56)], [100])], { width: Math.min(t.width, 960) });
  }
  if (l.cta === 'line' && !x.email) {
    return sec(x, 'bg', (u) => [
      u.rule({ strong: true, py: 0 }),
      u.gap(28),
      row([[u.h2(head, { align: 'left' })], [u.p(text, { color: u.muted }), u.btn(label, { align: 'left', outline: true })]], [55, 45], { gap: 48 }),
    ], { width: Math.min(t.width, 960) });
  }
  return sec(x, 'inverse', (u) => [u.h2(head), u.lead(text), u.btn(label)], { width: Math.min(t.width, 820) });
}

export function footer(x: Ctx): SectionBlock {
  const { layout: l, copy: c } = x.kit;
  const year = new Date().getFullYear();
  if (x.email) {
    return sec(x, 'alt', (u) => [mk('footer', { text: `Vous recevez cet email parce que vous êtes inscrit(e) auprès de ${c.brand}.`, links: [], copyright: `© ${year} ${c.brand}`, style: { align: 'center', color: u.fg, fontSize: 13 } })], { pt: 24, pb: 24 });
  }
  const tone: Tone = l.footer === 'inverse' ? 'inverse' : 'bg';
  return sec(x, tone, (u) => [
    ...(tone === 'bg' ? [u.rule({ py: 0 }), u.gap(24)] : []),
    mk('footer', { text: `**${c.brand}** — ${c.tagline}`, links: [], copyright: `© ${year} ${c.brand}. Tous droits réservés.`, style: { align: l.align, color: u.fg, fontSize: 14, paddingTop: 0, paddingBottom: 0 } }),
  ], { pt: tone === 'bg' ? 0 : 40, pb: 40 });
}

export { mk };
