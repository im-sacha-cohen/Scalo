// Kits: a named visual identity (tokens) + a layout recipe + sample copy. Every page and email of a kit is composed
// from these three things by the functions of compose.ts / pages.ts / emails.ts — a kit file never builds blocks with
// hard-coded colors. See docs/funnels.md (« Ajouter un kit »).
import type { Block, PageContent } from '../content';
import type { StepType } from '../types';

/** Design tokens. Colors are plain hex values (contrast is checked by api/test/kits.test.ts). */
export interface KitTokens {
  bg: string;            // page background
  alt: string;           // alternate section background
  surface: string;       // cards, form fields
  text: string;          // main text (on bg, alt and surface)
  muted: string;         // secondary text (on bg, alt and surface)
  accent: string;        // buttons, markers
  accentText: string;    // text on `accent`
  accentInk: string;     // the accent as a text color on bg / alt / surface (may equal `accent`)
  accent2: string;       // secondary accent: decoration, stars, illustrations
  border: string;        // lines, card and field borders
  inverse: string;       // strong band background (header, call to action, footer…)
  inverseText: string;   // text on `inverse`
  inverseMuted: string;  // secondary text on `inverse`
  inverseAccent: string; // highlight on `inverse`: overlines, and the button background (its label is `inverse`)
  /** Font stacks: a font the renderer can load (GOOGLE_FONTS) first, then email-safe fallbacks. */
  fontHeading: string;
  fontBody: string;
  radius: number;        // cards, fields
  buttonRadius: number;
  borderWidth?: number;
  shadow: 'none' | 'soft' | 'hard';
  headingWeight: number;
  headingSpacing: number; // px
  headingCase?: 'upper';
  buttonWeight?: number;
  buttonSpacing?: number;
  buttonCase?: 'upper';
  h1: number;            // desktop size of the main title, px
  h2: number;
  lead: number;          // size of intro paragraphs, px
  space: number;         // vertical padding of sections, px (density)
  width: number;         // content width, px
}

/** How the kit lays sections out: each key picks one composition of compose.ts. */
export interface KitLayout {
  align: 'left' | 'center';
  eyebrow: 'caps' | 'rule' | 'index' | 'dot' | 'star';
  header: 'bar' | 'center' | 'inverse';
  hero: 'split' | 'mirror' | 'center' | 'frame' | 'poster' | 'editorial' | 'block';
  benefits: 'grid' | 'numbered' | 'cards' | 'rows';
  proof: 'cards' | 'quote' | 'columns';
  offer: 'card' | 'split' | 'two';
  cta: 'band' | 'boxed' | 'line';
  footer: 'inverse' | 'plain';
  /** Illustration style of the kit (inline SVG drawn with the tokens), see art.ts. */
  art: 'frames' | 'shapes' | 'mock' | 'figure' | 'blobs' | 'deco' | 'arch' | 'rays';
  /** Emails: header and hero treatment. */
  emailHeader: 'center' | 'left' | 'band';
  emailHero: 'band' | 'plain' | 'card';
}

type Pair = [title: string, text: string];

/** Sample copy (French). Placeholders to personalize are written between square brackets. */
export interface KitCopy {
  brand: string;
  tagline: string;
  sign: string; // signature of the emails
  magnet: { eyebrow: string; title: string; lead: string; bullets: string[]; formTitle: string; cta: string; note: string };
  offer: {
    name: string;
    eyebrow: string;
    title: string;
    lead: string;
    cta: string;
    story: Pair;
    benefitsTitle: string;
    benefits: Pair[];       // 3
    programTitle: string;
    program: Pair[];        // 3–4
    includes: string[];     // 4–5
    priceNote: string;
    guarantee: string;
    faq: { q: string; a: string }[];
    finalTitle: string;
    finalText: string;
  };
  upsell: { title: string; text: string; bullets: string[]; accept: string; decline: string };
  thanks: { title: string; lead: string; steps: Pair[] };
  webinar: { eyebrow: string; title: string; lead: string; when: string; points: Pair[]; hostName: string; hostBio: string; cta: string };
  soon: { eyebrow: string; title: string; lead: string; cta: string };
  /** Testimonials are always placeholders: never invent a customer. */
  voices: { quote: string; name: string; role: string }[];
  emails: {
    welcome: { subject: string; preheader: string; title: string; body: string; steps: string[]; cta: string };
    newsletter: { subject: string; preheader: string; issue: string; title: string; body: string; cta: string; shorts: Pair[]; quote: string };
    promo: { subject: string; preheader: string; eyebrow: string; title: string; body: string; points: string[]; cta: string; ps: string };
    reminder: { subject: string; preheader: string; body: string; cta: string; ps: string };
    webinar: { subject: string; preheader: string; title: string; body: string; tips: string[]; cta: string };
  };
}

export type KitGoal = 'capture' | 'vente' | 'webinaire' | 'lancement';

export interface KitDefinition {
  id: string;
  name: string;
  /** One line: the design stance of the kit. */
  pitch: string;
  /** Who it is for (gallery filter label). */
  universe: string;
  /** Goals the kit suits best (gallery filter, onboarding). */
  goals: KitGoal[];
  tokens: KitTokens;
  layout: KitLayout;
  copy: KitCopy;
}

export const KIT_PAGE_KINDS = ['optin', 'sales', 'checkout', 'upsell', 'thankyou', 'webinar', 'comingsoon'] as const;
export type KitPageKind = (typeof KIT_PAGE_KINDS)[number];
export const KIT_EMAIL_KINDS = ['welcome', 'newsletter', 'promo', 'reminder', 'webinar'] as const;
export type KitEmailKind = (typeof KIT_EMAIL_KINDS)[number];
export const KIT_SECTION_KINDS = ['header', 'hero', 'benefits', 'program', 'proof', 'offer', 'faq', 'cta', 'footer'] as const;
export type KitSectionKind = (typeof KIT_SECTION_KINDS)[number];

export const KIT_PAGES: Record<KitPageKind, { name: string; description: string; category: string; stepType: StepType; stepName: string }> = {
  optin: { name: 'Capture', description: 'Une promesse, un formulaire, de quoi rassurer.', category: 'Capture', stepType: 'optin', stepName: 'Inscription' },
  sales: { name: 'Vente longue', description: 'Histoire, bénéfices, programme, offre, FAQ et appel à l’action.', category: 'Vente', stepType: 'sales', stepName: 'Offre' },
  checkout: { name: 'Bon de commande', description: 'Récapitulatif de l’offre et bloc Paiement.', category: 'Vente', stepType: 'sales', stepName: 'Commande' },
  upsell: { name: 'Offre en un clic', description: 'Une offre complémentaire juste après le paiement.', category: 'Vente', stepType: 'sales', stepName: 'Offre complémentaire' },
  thankyou: { name: 'Remerciement', description: 'Confirmation et prochaines étapes.', category: 'Remerciement', stepType: 'thankyou', stepName: 'Merci' },
  webinar: { name: 'Inscription webinaire', description: 'Date, compte à rebours, programme, intervenant et formulaire.', category: 'Webinaire', stepType: 'optin', stepName: 'Inscription webinaire' },
  comingsoon: { name: 'Bientôt disponible', description: 'Une page d’attente avec compte à rebours et liste d’attente.', category: 'Lancement', stepType: 'optin', stepName: 'Bientôt disponible' },
};

export const KIT_EMAILS: Record<KitEmailKind, { name: string; description: string }> = {
  welcome: { name: 'Bienvenue', description: 'Accueillir un nouvel inscrit et annoncer la suite.' },
  newsletter: { name: 'Newsletter éditoriale', description: 'Un article principal et deux brèves.' },
  promo: { name: 'Annonce / promotion', description: 'Présenter une offre et son appel à l’action.' },
  reminder: { name: 'Relance', description: 'Un message court et personnel avant la fin d’une offre.' },
  webinar: { name: 'Confirmation webinaire', description: 'Date, lien de connexion et conseils pour en profiter.' },
};

export const KIT_SECTIONS: Record<KitSectionKind, { name: string; category: string }> = {
  header: { name: 'En-tête', category: 'En-tête' },
  hero: { name: 'Héros', category: 'Hero' },
  benefits: { name: 'Bénéfices', category: 'Contenu' },
  program: { name: 'Programme', category: 'Contenu' },
  proof: { name: 'Témoignages', category: 'Preuve sociale' },
  offer: { name: 'Offre / prix', category: 'Offre' },
  faq: { name: 'FAQ', category: 'Offre' },
  cta: { name: 'Appel à l’action', category: 'Conversion' },
  footer: { name: 'Pied de page', category: 'Pied de page' },
};

/** Funnel types a kit can create: every step uses a page of the kit. */
export const KIT_FLOWS: Record<KitGoal, { label: string; description: string; steps: KitPageKind[] }> = {
  capture: { label: 'Capture d’emails', description: 'Page de capture, puis remerciement.', steps: ['optin', 'thankyou'] },
  vente: { label: 'Tunnel de vente', description: 'Page de vente, bon de commande, offre en un clic, remerciement.', steps: ['sales', 'checkout', 'upsell', 'thankyou'] },
  webinaire: { label: 'Webinaire', description: 'Inscription au webinaire, puis confirmation.', steps: ['webinar', 'thankyou'] },
  lancement: { label: 'Lancement', description: 'Page d’attente, page de vente, bon de commande, remerciement.', steps: ['comingsoon', 'sales', 'checkout', 'thankyou'] },
};

export type KitBlocks = Block[];
export type KitContent = PageContent;
