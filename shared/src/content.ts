// Content model shared by the page builder, the email builder and the public renderer.
// A page / email is a `PageContent` = `{ settings, blocks }`. Blocks form a tree:
// `section` blocks contain `children`, `columns` blocks contain `columns[].children`.
// Old content (flat list of leaf blocks) is a valid tree and renders unchanged.

export type Align = 'left' | 'center' | 'right';
export type VAlign = 'top' | 'center' | 'bottom';
export type ShadowPreset = 'none' | 'sm' | 'md' | 'lg' | 'xl';

export interface BlockStyle {
  align?: Align;
  color?: string;          // text color
  background?: string;     // block background
  paddingY?: number;       // legacy: vertical padding when paddingTop/paddingBottom are unset (default 12)
  paddingTop?: number;
  paddingBottom?: number;
  paddingX?: number;       // horizontal padding (default 24, 0 inside columns)
  marginTop?: number;
  marginBottom?: number;
  fontSize?: number;       // px
  mobileFontSize?: number; // px, applied under 640px (headings, texts, buttons)
  fontWeight?: number;     // 300..900
  lineHeight?: number;     // unitless, e.g. 1.5
  letterSpacing?: number;  // px
  borderWidth?: number;
  borderColor?: string;
  borderRadius?: number;
  shadow?: ShadowPreset;
  hideOnMobile?: boolean;
  hideOnDesktop?: boolean;
}

interface Base<T extends string> {
  id: string;
  type: T;
  style?: BlockStyle;
}

/**
 * Rich text fields (heading/text/list items/labels...) accept either the legacy markdown-lite
 * (**bold**, *italic*, [link](url), newlines) or a strictly sanitized HTML subset:
 * b/strong/i/em/u/s/br/a[href]/span[style=color]. See `sanitizeRich` in render.ts.
 */
export type RichText = string;

// ---------- basic blocks ----------
export type HeadingBlock = Base<'heading'> & { text: RichText; level: 1 | 2 | 3 };
export type TextBlock = Base<'text'> & { text: RichText };
export type ImageBlock = Base<'image'> & { src: string; alt?: string; width?: number /* % */; href?: string; radius?: number };
export type ButtonBlock = Base<'button'> & {
  label: RichText;
  action: 'next' | 'url';
  url?: string;
  bg?: string;
  textColor?: string;
  radius?: number;
  fullWidth?: boolean;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'solid' | 'outline';
  newTab?: boolean;
};
export type ContactField = 'email' | 'first_name' | 'last_name' | 'phone';
/** Custom field of the contact (`field.<key>`, see CustomField); `input`/`options` are copied from its definition. */
export type CustomFormField = `field.${string}`;
export type FormFieldInput = 'text' | 'number' | 'date' | 'datetime' | 'select' | 'checkbox';
export type FormBlock = Base<'form'> & {
  fields: { name: ContactField | CustomFormField; label: string; required?: boolean; input?: FormFieldInput; options?: string[] }[];
  submitLabel: string;
  buttonBg?: string;
  buttonColor?: string;
  tagName?: string;      // tag applied to the contact on submit
  campaignId?: number;   // email campaign the contact gets enrolled in
  inputRadius?: number;
  /**
   * Double opt-in: the contact must click a link in a confirmation email before the tag / campaign are applied and
   * before receiving newsletters. undefined = account default (Settings → double_optin_default).
   */
  doubleOptin?: boolean;
  doubleOptinSubject?: string;  // confirmation email subject (default: French template)
  doubleOptinText?: string;     // confirmation email text, one paragraph per line, merge tags allowed
  doubleOptinRedirect?: string; // page shown after confirming (http(s) URL); default: a success page
};
export type VideoBlock = Base<'video'> & { url: string };
export type SpacerBlock = Base<'spacer'> & { height: number };
export type DividerBlock = Base<'divider'> & { color?: string; thickness?: number; lineStyle?: 'solid' | 'dashed' | 'dotted'; width?: number /* % */ };
export type ListBlock = Base<'list'> & { items: RichText[]; icon?: 'check' | 'dot' | 'number' | 'arrow' | 'star' };

// ---------- layout ----------
export type SectionBlock = Base<'section'> & {
  children: Block[];
  fullWidth?: boolean;       // background spans the whole window (top-level sections of pages)
  contentWidth?: number;     // max width of the inner content, px (default: page width)
  bgImage?: string;
  bgSize?: 'cover' | 'contain';
  bgPosition?: 'center' | 'top' | 'bottom';
  gradient?: { from: string; to: string; angle: number };
  overlayColor?: string;
  overlayOpacity?: number;   // 0..100
  minHeight?: number;        // px
  valign?: VAlign;           // with minHeight
};

export interface Column {
  id: string;
  width: number;             // relative weight, presets sum to 100
  children: Block[];
  background?: string;
  padding?: number;          // px, all sides
}

export type ColumnsBlock = Base<'columns'> & {
  columns: Column[];         // 1..4
  gap?: number;              // px (default 24)
  valign?: VAlign;
  stackOnMobile?: boolean;   // default true
  reverseOnMobile?: boolean;
};

// ---------- marketing blocks ----------
export type CountdownBlock = Base<'countdown'> & {
  mode: 'date' | 'evergreen';
  date?: string;             // ISO date (mode date)
  minutes?: number;          // duration from first visit (mode evergreen)
  expiredText?: string;
  showLabels?: boolean;
  boxBg?: string;
  boxColor?: string;
};
export type TestimonialBlock = Base<'testimonial'> & {
  quote: RichText;
  name: string;
  role?: string;
  photo?: string;
  stars?: number;            // 0..5
  layout?: 'card' | 'plain';
  cardBg?: string;
};
export type PricingBlock = Base<'pricing'> & {
  title: string;
  price: string;
  period?: string;
  description?: RichText;
  features: RichText[];
  buttonLabel: string;
  action: 'next' | 'url';
  url?: string;
  highlighted?: boolean;
  badge?: string;
  accent?: string;
  cardBg?: string;
};
export type FaqBlock = Base<'faq'> & { items: { q: string; a: RichText }[]; openFirst?: boolean };
export type FeatureBlock = Base<'feature'> & {
  icon: string;              // emoji
  title: string;
  text: RichText;
  layout?: 'top' | 'left';
  iconBg?: string;
  iconSize?: number;
};
export type SocialNetwork = 'facebook' | 'instagram' | 'x' | 'linkedin' | 'youtube' | 'tiktok' | 'website' | 'email';
export type SocialBlock = Base<'social'> & {
  links: { network: SocialNetwork; url: string }[];
  size?: number;             // icon diameter px
  variant?: 'brand' | 'accent' | 'dark' | 'outline';
};
export type ImageTextBlock = Base<'imageText'> & {
  src: string;
  alt?: string;
  title?: string;
  text: RichText;
  imagePosition: 'left' | 'right';
  imageWidth?: number;       // % of the row (default 45)
  buttonLabel?: string;
  buttonUrl?: string;
  buttonAction?: 'next' | 'url';
  radius?: number;
};
export type ProgressBlock = Base<'progress'> & {
  value: number;             // 0..100
  label?: string;
  barColor?: string;
  trackColor?: string;
  height?: number;
  striped?: boolean;
};
export type NavbarBlock = Base<'navbar'> & {
  logoText?: string;
  logoSrc?: string;
  logoWidth?: number;
  links: { label: string; url: string }[];
  ctaLabel?: string;
  ctaUrl?: string;
  sticky?: boolean;
};
export type FooterBlock = Base<'footer'> & {
  text: RichText;
  links: { label: string; url: string }[];
  copyright?: string;
};
export type HtmlBlock = Base<'html'> & { html: string };
export type RatingBlock = Base<'rating'> & { value: number; max?: number; size?: number; starColor?: string; caption?: string };
export type QuoteBlock = Base<'quote'> & { text: RichText; author?: string; barColor?: string };

// ---------- payments (see payments.ts) ----------
/**
 * Order form: name / email, then the buyer pays the offer on Stripe Checkout. `offerId` / `bumpOfferId` are price ids;
 * names and amounts always come from the database at render time (`*Label` fields are only the editor's preview).
 */
export type CheckoutBlock = Base<'checkout'> & {
  offerId?: number;
  offerLabel?: string;
  submitLabel: string;
  askName?: boolean;          // first name field (default true)
  askLastName?: boolean;
  showSummary?: boolean;      // product name and price above the form (default true)
  buttonBg?: string;
  buttonColor?: string;
  inputRadius?: number;
  secureNote?: string;        // small text under the button
  /** Order bump: an extra offer added to the order when the box is ticked. */
  bumpOfferId?: number;
  bumpOfferLabel?: string;
  bumpTitle?: string;
  bumpText?: string;
};
/**
 * One-click offer shown after a payment (upsell / downsell): accepting charges the card saved by the order the visitor
 * just paid; declining goes to the next step.
 */
export type UpsellBlock = Base<'upsell'> & {
  offerId?: number;
  offerLabel?: string;
  acceptLabel: string;
  declineLabel?: string;
  note?: string;
  /** Accepting skips the next step (typically the downsell). */
  skipNextOnAccept?: boolean;
  buttonBg?: string;
  buttonColor?: string;
};

export type Block =
  | HeadingBlock
  | TextBlock
  | ImageBlock
  | ButtonBlock
  | FormBlock
  | VideoBlock
  | SpacerBlock
  | DividerBlock
  | ListBlock
  | SectionBlock
  | ColumnsBlock
  | CountdownBlock
  | TestimonialBlock
  | PricingBlock
  | FaqBlock
  | FeatureBlock
  | SocialBlock
  | ImageTextBlock
  | ProgressBlock
  | NavbarBlock
  | FooterBlock
  | HtmlBlock
  | RatingBlock
  | QuoteBlock
  | CheckoutBlock
  | UpsellBlock;

export type BlockType = Block['type'];

/**
 * Design tokens of a page / email (optional, set by the kits of `kits/`). They are only *defaults*: the renderer uses
 * them where a block does not carry its own value (card background, borders, radii, button text…), so content
 * without a theme renders exactly as before.
 */
export interface PageTheme {
  /** Id of the kit the tokens come from (see kits/index.ts). */
  kit?: string;
  surface?: string;        // cards, form fields
  surfaceText?: string;    // text on `surface`
  border?: string;         // card / field borders, dividers, tracks
  accentText?: string;     // text on the accent color (buttons, badges)
  accent2?: string;        // secondary accent (stars, markers)
  radius?: number;         // cards and fields, px
  buttonRadius?: number;   // px
  borderWidth?: number;    // cards and fields, px (default 1)
  /** Card / button depth: none, soft drop shadow, or hard offset shadow with a solid outline. */
  shadow?: 'none' | 'soft' | 'hard';
  headingWeight?: number;  // 300..900
  headingSpacing?: number; // letter-spacing of headings, px
  headingCase?: 'upper';
  buttonWeight?: number;
  buttonSpacing?: number;  // px
  buttonCase?: 'upper';
}

export interface PageSettings {
  background: string;
  contentBackground: string;
  maxWidth: number;
  fontFamily: string;
  textColor: string;
  accent: string;
  headingFont?: string;      // font stack for headings (defaults to fontFamily)
  contentPadding?: number;   // vertical padding of the page body, px (default 24 / 16 for emails)
  theme?: PageTheme;         // design tokens (kits); optional
  // page only
  seoTitle?: string;
  seoDescription?: string;
  ogImage?: string;
  favicon?: string;
  headCode?: string;         // custom tracking code injected in <head> (owner's public page only)
  // email only
  preheader?: string;        // hidden preview text shown by mail clients
}

export interface PageContent {
  settings: PageSettings;
  blocks: Block[];
}
