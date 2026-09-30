// Funnels growth: custom domains, A/B tests of pages, attribution stats, pixels, cookie banner, legal pages,
// import / export / share. Types shared by the API and the web app.
import type { PageContent } from './content';
import type { StepAccessMode, StepType } from './types';

// ---------- funnel settings (funnels.settings) ----------

/** Official integrations. IDs only (strict formats): the server renders the official snippets, never free code. */
export interface FunnelTracking {
  meta_pixel_id?: string; // Meta (Facebook) Pixel: digits
  ga4_id?: string;        // Google Analytics 4: G-XXXXXXX
  gtm_id?: string;        // Google Tag Manager: GTM-XXXXXX
}

export interface CookieBannerSettings {
  enabled: boolean;
  text?: string;
  accept_label?: string;
  decline_label?: string;
  /** Privacy policy: a step of the funnel (preferred) or an http(s) URL. */
  privacy_step_id?: number | null;
  privacy_url?: string;
}

/** Footer with links to the legal pages of the funnel (legal steps are skipped by "next step" links). */
export interface LegalSettings {
  footer: boolean;
  step_ids: number[];
}

export interface FunnelSettings {
  tracking?: FunnelTracking;
  cookie_banner?: CookieBannerSettings;
  legal?: LegalSettings;
}

export const TRACKING_ID_PATTERNS = {
  meta_pixel_id: /^\d{6,20}$/,
  ga4_id: /^G-[A-Z0-9]{4,16}$/,
  gtm_id: /^GTM-[A-Z0-9]{4,12}$/,
} as const;

export const COOKIE_BANNER_DEFAULTS = {
  text: 'Nous utilisons des cookies de mesure d’audience et de publicité pour améliorer ce site. Vous pouvez les accepter ou les refuser : votre choix est conservé 6 mois.',
  accept_label: 'Accepter',
  decline_label: 'Refuser',
} as const;

// ---------- custom domains ----------

export type CustomDomainStatus = 'pending' | 'verified' | 'error';
export interface DnsInstruction { type: 'CNAME' | 'TXT'; host: string; value: string; purpose: string }
export interface CustomDomain {
  id: number;
  funnel_id: number;
  domain: string;
  root_step_id: number | null;
  status: CustomDomainStatus;
  verified_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
  url: string;
  /** Records to create at the DNS provider (one of them is enough to verify the domain). */
  records: DnsInstruction[];
}

// ---------- A/B tests of pages ----------

export type AbStatus = 'off' | 'running' | 'paused';
export interface StepVariant {
  id: number;
  step_id: number;
  name: string;
  weight: number; // relative weight, 0–100
  active: boolean;
  created_at: string;
  content?: PageContent;
}
/** One arm of the test: variant_id 0 = the original page. */
export interface AbArmStats {
  variant_id: number;
  name: string;
  weight: number;
  active: boolean;
  visitors: number;
  optins: number;
  rate: number;        // 0..1
  lift: number | null; // relative difference with the original (0.12 = +12 %)
  p_value: number | null;
  /** Two-proportion z-test vs the original: p < 0.05, at least 100 visitors per arm and 10 optins in total. */
  significant: boolean;
}
export interface StepAbTest {
  step_id: number;
  status: AbStatus;
  control_weight: number;
  started_at: string | null;
  variants: StepVariant[];
  arms: AbArmStats[];
}

// ---------- attribution stats ----------

export type StatsPeriod = '7' | '30' | '90' | 'all';
export type StatsGroup = 'source' | 'medium' | 'campaign' | 'referrer' | 'variant';
export interface StatsCell { visitors: number; optins: number; rate: number }
export interface FunnelStatsRow extends StatsCell {
  key: string;
  label: string;
  steps: ({ step_id: number } & StatsCell)[];
}
export interface FunnelStats {
  period: StatsPeriod;
  group: StatsGroup;
  since: string | null;
  totals: StatsCell;
  steps: ({ step_id: number; name: string } & StatsCell)[];
  rows: FunnelStatsRow[];
  daily: { date: string; visitors: number; optins: number }[];
}

// ---------- import / export / share ----------

export const FUNNEL_EXPORT_FORMAT = 'scalo-funnel';
export const FUNNEL_EXPORT_VERSION = 1;

export interface FunnelExportStep {
  name: string;
  slug: string;
  type: StepType;
  content: PageContent;
  access: { mode: StepAccessMode; tag?: string | null; redirect?: 'first' | 'previous' | 'url'; redirect_url?: string };
  ab?: { status: AbStatus; control_weight: number; variants: { name: string; content: PageContent; weight: number; active: boolean }[] };
}
export interface FunnelExport {
  format: typeof FUNNEL_EXPORT_FORMAT;
  version: number;
  exported_at: string;
  funnel: {
    name: string;
    slug: string;
    /** Step references are indexes in `steps`. */
    settings: {
      tracking?: FunnelTracking;
      cookie_banner?: Omit<CookieBannerSettings, 'privacy_step_id'> & { privacy_step?: number | null };
      legal?: { footer: boolean; steps: number[] };
    };
  };
  steps: FunnelExportStep[];
}

export interface FunnelShareInfo { active: boolean; created_at: string | null; url?: string }
export interface SharedFunnelPreview {
  name: string;
  owner: string;
  steps: { name: string; type: StepType; content: PageContent; protected: boolean }[];
}
export interface FunnelImportResult { id: number; warnings: string[] }

// ---------- legal pages ----------

export type LegalPageKind = 'mentions' | 'privacy' | 'cgv';
