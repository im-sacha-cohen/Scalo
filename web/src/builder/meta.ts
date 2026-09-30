import {
  BadgeDollarSign,
  ChartNoAxesColumn,
  CircleQuestionMark,
  Code,
  Columns3,
  CreditCard,
  Heading,
  Image,
  List,
  Minus,
  MousePointerClick,
  MoveVertical,
  PanelBottom,
  PanelTop,
  MessageSquareQuote,
  PanelLeft,
  Quote,
  RectangleHorizontal,
  Share2,
  Sparkles,
  Square,
  Star,
  TextCursorInput,
  Timer,
  Type,
  Video,
  type LucideIcon,
} from 'lucide-react';
import { BLOCK_LABELS, richToPlain, type Block, type BlockType } from '@scalo/shared';

export const BLOCK_ICONS: Record<BlockType, LucideIcon> = {
  heading: Heading,
  text: Type,
  list: List,
  image: Image,
  button: RectangleHorizontal,
  form: TextCursorInput,
  video: Video,
  spacer: MoveVertical,
  divider: Minus,
  section: Square,
  columns: Columns3,
  countdown: Timer,
  testimonial: MessageSquareQuote,
  pricing: BadgeDollarSign,
  faq: CircleQuestionMark,
  feature: Sparkles,
  social: Share2,
  imageText: PanelLeft,
  progress: ChartNoAxesColumn,
  navbar: PanelTop,
  footer: PanelBottom,
  html: Code,
  rating: Star,
  quote: Quote,
  checkout: CreditCard,
  upsell: MousePointerClick,
};

export const BLOCK_DESCRIPTIONS: Record<BlockType, string> = {
  heading: 'Titre H1, H2 ou H3',
  text: 'Paragraphe avec mise en forme',
  list: 'Liste à puces ou numérotée',
  image: 'Image importée ou depuis une URL',
  button: 'Appel à l’action',
  form: 'Capture d’emails',
  video: 'YouTube ou Vimeo',
  spacer: 'Espace vertical',
  divider: 'Ligne horizontale',
  section: 'Conteneur avec fond, image, marges',
  columns: '2 à 4 colonnes côte à côte',
  countdown: 'Date fixe ou minuterie evergreen',
  testimonial: 'Avis client avec photo',
  pricing: 'Offre, prix et avantages',
  faq: 'Questions / réponses dépliables',
  feature: 'Icône, titre et texte',
  social: 'Liens vers vos réseaux',
  imageText: 'Image à côté d’un texte',
  progress: 'Jauge de progression',
  navbar: 'Logo, liens et bouton',
  footer: 'Mentions, liens, copyright',
  html: 'Code HTML/JS (page publique)',
  rating: 'Note en étoiles',
  quote: 'Citation mise en avant',
  checkout: 'Bon de commande + paiement Stripe',
  upsell: 'Upsell payé en un clic',
};

export const PALETTE_GROUPS: { title: string; types: BlockType[] }[] = [
  { title: 'Mise en page', types: ['section', 'columns', 'spacer', 'divider'] },
  { title: 'Contenu', types: ['heading', 'text', 'list', 'image', 'button', 'video', 'imageText', 'quote'] },
  { title: 'Conversion', types: ['form', 'countdown', 'pricing', 'testimonial', 'rating', 'faq', 'feature', 'progress'] },
  { title: 'Vente', types: ['checkout', 'upsell'] },
  { title: 'En-tête & pied', types: ['navbar', 'footer', 'social', 'html'] },
];

/** Short text used in the layers list. */
export function blockSummary(b: Block): string {
  switch (b.type) {
    case 'heading':
    case 'text':
    case 'quote':
      return richToPlain(b.text);
    case 'list':
      return (b.items ?? []).map(richToPlain).join(' · ');
    case 'button':
      return richToPlain(b.label);
    case 'form':
      return `${b.fields?.length ?? 0} champ${(b.fields?.length ?? 0) > 1 ? 's' : ''} · ${b.submitLabel}`;
    case 'image':
      return b.src ? b.src.replace(/^https?:\/\//, '') : 'Aucune image';
    case 'video':
      return b.url ? b.url.replace(/^https?:\/\//, '') : 'Aucune vidéo';
    case 'spacer':
      return `${b.height}px`;
    case 'section':
      return `${b.children?.length ?? 0} élément${(b.children?.length ?? 0) > 1 ? 's' : ''}`;
    case 'columns':
      return (b.columns ?? []).map((c) => `${Math.round(c.width)}%`).join(' · ');
    case 'testimonial':
      return b.name;
    case 'pricing':
      return `${b.title} · ${b.price}`;
    case 'feature':
      return `${b.icon} ${b.title}`;
    case 'imageText':
      return b.title || richToPlain(b.text);
    case 'navbar':
      return b.logoText || 'Logo';
    case 'faq':
      return `${b.items?.length ?? 0} questions`;
    case 'countdown':
      return b.mode === 'evergreen' ? `Evergreen · ${b.minutes ?? 0} min` : (b.date ?? '').slice(0, 10);
    default:
      return BLOCK_LABELS[b.type] ?? b.type;
  }
}

/** Fields rendered with `data-edit` that accept rich text (others are plain text). */
export function isRichField(type: BlockType, field: string): boolean {
  switch (type) {
    case 'heading':
    case 'text':
    case 'quote':
    case 'feature':
    case 'imageText':
    case 'footer':
      return field === 'text';
    case 'list':
      return /^items\.\d+$/.test(field);
    case 'button':
      return field === 'label';
    case 'testimonial':
      return field === 'quote';
    case 'pricing':
      return field === 'description' || /^features\.\d+$/.test(field);
    case 'faq':
      return /^items\.\d+\.a$/.test(field);
    default:
      return false;
  }
}

const SYSTEM_FONTS: { label: string; value: string }[] = [
  { label: 'Arial', value: 'Arial, Helvetica, sans-serif' },
  { label: 'Helvetica', value: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
  { label: 'Verdana', value: 'Verdana, Geneva, sans-serif' },
  { label: 'Trebuchet MS', value: "'Trebuchet MS', Tahoma, sans-serif" },
  { label: 'Tahoma', value: 'Tahoma, Geneva, sans-serif' },
  { label: 'Système', value: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Times New Roman', value: "'Times New Roman', Times, serif" },
  { label: 'Courier New', value: "'Courier New', Courier, monospace" },
];

const SERIF_GOOGLE = new Set(['Playfair Display', 'Merriweather', 'Lora', 'DM Serif Display']);
export const googleFontValue = (name: string) =>
  name === 'Inter' ? "Inter, 'Helvetica Neue', Arial, sans-serif" : `'${name}', ${SERIF_GOOGLE.has(name) ? 'Georgia, serif' : "'Helvetica Neue', Arial, sans-serif"}`;

/** Font options: Google Fonts (pages; loaded with a <link>) + email-safe system fonts. */
export function fontOptions(googleFonts: string[], mode: 'page' | 'email'): { group: string; label: string; value: string }[] {
  const sys = SYSTEM_FONTS.map((f) => ({ ...f, group: 'Polices système' }));
  if (mode === 'email') return sys;
  return [...googleFonts.map((n) => ({ group: 'Google Fonts', label: n, value: googleFontValue(n) })), ...sys];
}

export const fontLabel = (stack: string | undefined) => (stack ?? '').split(',')[0]?.trim().replace(/^['"]|['"]$/g, '') || 'Par défaut';

export const MERGE_TAGS: { tag: string; label: string }[] = [
  { tag: '{{first_name}}', label: 'Prénom' },
  { tag: '{{last_name}}', label: 'Nom' },
  { tag: '{{email}}', label: 'Email' },
  { tag: '{{phone}}', label: 'Téléphone' },
];
