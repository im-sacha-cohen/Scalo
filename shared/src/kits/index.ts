// Kits: named visual identities shared by a full set of pages and emails.
// To add one: copy a kit file, change its tokens / layout / copy, and register it in KITS below (docs/funnels.md).
import type { Block, PageContent, PageSettings } from '../content';
import type { StepType } from '../types';
import { kitSettings } from './compose';
import { buildKitEmail, buildKitPage, buildKitSection, kitEmailSubject } from './pages';
import { KIT_EMAIL_KINDS, KIT_FLOWS, KIT_PAGE_KINDS, KIT_PAGES, KIT_SECTION_KINDS, type KitDefinition, type KitEmailKind, type KitGoal, type KitPageKind, type KitSectionKind } from './types';
import { cabinet } from './cabinet';
import { studio } from './studio';
import { orbit } from './orbit';
import { revue } from './revue';
import { douceur } from './douceur';
import { nocturne } from './nocturne';
import { marche } from './marche';
import { scene } from './scene';

export * from './types';
export { kitSettings, kitTheme } from './compose';
export { kitArt } from './art';

export const KITS: KitDefinition[] = [cabinet, studio, orbit, revue, douceur, nocturne, marche, scene];

export const KIT_ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
export const getKit = (id: unknown): KitDefinition | undefined => (typeof id === 'string' ? KITS.find((k) => k.id === id) : undefined);
export const isKitPageKind = (v: unknown): v is KitPageKind => (KIT_PAGE_KINDS as readonly unknown[]).includes(v);
export const isKitEmailKind = (v: unknown): v is KitEmailKind => (KIT_EMAIL_KINDS as readonly unknown[]).includes(v);
export const isKitGoal = (v: unknown): v is KitGoal => typeof v === 'string' && v in KIT_FLOWS;

/** A page of a kit (fresh block ids at each call). */
export function kitPage(kitId: string, kind: KitPageKind): PageContent | null {
  const kit = getKit(kitId);
  return kit ? buildKitPage(kit, kind) : null;
}

/** An email of a kit, with the subject proposed for it. */
export function kitEmail(kitId: string, kind: KitEmailKind): { subject: string; content: PageContent } | null {
  const kit = getKit(kitId);
  return kit ? { subject: kitEmailSubject(kit, kind), content: buildKitEmail(kit, kind) } : null;
}

/** One section of a kit (header, hero, testimonials…), to insert in a page or an email. */
export function kitSection(kitId: string, kind: KitSectionKind, mode: 'page' | 'email' = 'page'): Block[] {
  const kit = getKit(kitId);
  return kit ? buildKitSection(kit, kind, mode) : [];
}

/** Page of the kit used for a step type when no page kind is chosen (« Ajouter une étape », legacy funnel templates). */
export const KIT_PAGE_FOR_STEP: Record<StepType, KitPageKind | null> = { optin: 'optin', sales: 'sales', thankyou: 'thankyou', custom: null };

/** Default page of a step in a kit: the kit's page for that type, or an empty page carrying the kit's tokens. */
export function kitPageForStep(kitId: string, type: StepType): PageContent | null {
  const kit = getKit(kitId);
  if (!kit) return null;
  const kind = KIT_PAGE_FOR_STEP[type];
  return kind ? buildKitPage(kit, kind) : { settings: kitSettings(kit, 'page'), blocks: [] };
}

/** Steps (name, type, content) of a funnel created from a kit. */
export function kitFunnelSteps(kitId: string, goal: KitGoal): { name: string; type: StepType; kind: KitPageKind; content: PageContent }[] | null {
  const kit = getKit(kitId);
  if (!kit) return null;
  return KIT_FLOWS[goal].steps.map((kind) => ({ name: KIT_PAGES[kind].stepName, type: KIT_PAGES[kind].stepType, kind, content: buildKitPage(kit, kind) }));
}

/** Kit of a page / email (from its settings), if any. */
export const kitOf = (settings: Partial<PageSettings> | null | undefined): KitDefinition | undefined => getKit(settings?.theme?.kit);

/**
 * Applies the identity of a kit to existing settings (fonts, colors, tokens) and keeps what belongs to the page
 * (SEO, tracking code, preheader, width of an email). Used to restyle a page whose blocks carry no color of their own.
 */
export function applyKitSettings(settings: Partial<PageSettings> | null | undefined, kitId: string, mode: 'page' | 'email' = 'page'): PageSettings | null {
  const kit = getKit(kitId);
  if (!kit) return null;
  const { seoTitle, seoDescription, ogImage, favicon, headCode, preheader } = settings ?? {};
  const keep = { seoTitle, seoDescription, ogImage, favicon, headCode, preheader };
  return { ...kitSettings(kit, mode), ...(Object.fromEntries(Object.entries(keep).filter(([, v]) => v !== undefined)) as Partial<PageSettings>) };
}

/** Every template of every kit, flat (galleries, tests). */
export const kitPageList = () => KITS.flatMap((kit) => KIT_PAGE_KINDS.map((kind) => ({ kit, kind, meta: KIT_PAGES[kind], build: () => buildKitPage(kit, kind) })));
export const kitEmailList = () => KITS.flatMap((kit) => KIT_EMAIL_KINDS.map((kind) => ({ kit, kind, build: () => buildKitEmail(kit, kind) })));
export const kitSectionList = (kitId: string) => (getKit(kitId) ? KIT_SECTION_KINDS.map((kind) => ({ kind, id: `kit:${kitId}:${kind}` })) : []);
/** `kit:<kitId>:<section>` (drag & drop id of a kit section in the builder) → its parts. */
export function parseKitSectionId(id: string): { kit: string; kind: KitSectionKind } | null {
  const m = /^kit:([a-z0-9-]+):([a-z]+)$/.exec(id);
  return m && getKit(m[1]) && (KIT_SECTION_KINDS as readonly string[]).includes(m[2]!) ? { kit: m[1]!, kind: m[2] as KitSectionKind } : null;
}

/** Offer shown by payment blocks in previews (a template has no offer of the account yet). */
export const KIT_PREVIEW_OFFER_ID = -1;
export const KIT_PREVIEW_OFFERS = { [KIT_PREVIEW_OFFER_ID]: { name: 'Votre offre', price: '000 €' } };
/** Copy of a content whose unconfigured payment blocks point to the preview offer (thumbnails only, never saved). */
export function withPreviewOffers(content: PageContent): PageContent {
  const fix = (blocks: Block[]): Block[] =>
    blocks.map((b) => {
      if ((b.type === 'checkout' || b.type === 'upsell') && b.offerId === undefined) return { ...b, offerId: KIT_PREVIEW_OFFER_ID };
      if (b.type === 'section') return { ...b, children: fix(b.children ?? []) };
      if (b.type === 'columns') return { ...b, columns: (b.columns ?? []).map((c) => ({ ...c, children: fix(c.children ?? []) })) };
      return b;
    });
  return { settings: content.settings, blocks: fix(content.blocks ?? []) };
}
