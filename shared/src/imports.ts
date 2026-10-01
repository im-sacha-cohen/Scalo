// Contact imports / migration from another tool (systeme.io API, CSV exports) and page import by URL.
import type { CustomFieldType } from './crm';
import type { PageContent } from './content';

export type ImportSource = 'csv' | 'systeme_io';
export type ImportStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/** What a source column becomes. `unsubscribed` / `bounced`: flag columns (any non-empty, non-negative value). */
export const IMPORT_TARGETS = ['ignore', 'email', 'first_name', 'last_name', 'phone', 'tags', 'status', 'unsubscribed', 'bounced', 'created_at', 'field'] as const;
export type ImportTarget = (typeof IMPORT_TARGETS)[number];

export const IMPORT_TARGET_LABELS: Record<ImportTarget, string> = {
  ignore: 'Ne pas importer',
  email: 'Email',
  first_name: 'Prénom',
  last_name: 'Nom',
  phone: 'Téléphone',
  tags: 'Tags',
  status: 'Statut d’abonnement',
  unsubscribed: 'Désinscrit (oui / non ou date)',
  bounced: 'Adresse invalide — bounce (oui / non ou date)',
  created_at: 'Date d’inscription',
  field: 'Champ personnalisé',
};

export interface ImportColumnMapping {
  /** Source column: CSV header (deduplicated) or systeme.io attribute (`email`, `tags`, `field:<slug>`…). */
  column: string;
  target: ImportTarget;
  /** target 'field': key of an existing custom field… */
  field_key?: string;
  /** …or a field to create when the import starts (confirmed by the user in the mapping step). `options`: list field. */
  create?: { label: string; type: CustomFieldType; options?: string[] };
}

export interface ImportOptions {
  /** Existing contacts keep their non-empty values (default: the imported values win). */
  keep_existing: boolean;
  /** Let the import start campaigns (tag triggers) and automations. Default false: an import never sends emails. */
  trigger: boolean;
  /** Tag added to every imported contact. */
  tag?: string | null;
  /** The user certifies that these contacts agreed to receive their emails. Required. */
  consent: boolean;
}

/** Types whose values can be invalid, checked on every value of a column by the analysis. */
export const IMPORT_CHECKED_TYPES = ['number', 'date', 'datetime', 'checkbox'] as const;
export type ImportCheckedType = (typeof IMPORT_CHECKED_TYPES)[number];

/** What the analysis read in a column (every row of a CSV file, the first page of the systeme.io API). */
export interface ImportColumnStats {
  /** Non-empty values. */
  filled: number;
  /** First distinct values (case-insensitive, 100 max): options of a list field, check against an existing list. */
  distinct: string[];
  /** More than 100 distinct values. */
  distinct_more: boolean;
  /** Values that a field of this type would reject: count + a few examples. */
  invalid: Record<ImportCheckedType, { count: number; examples: string[] }>;
  /** Type that fits every value (shown pre-selected when a field is created). */
  suggested_type: CustomFieldType;
}

export interface ImportColumn {
  column: string;
  label: string;
  samples: string[];
  stats?: ImportColumnStats;
}

export const IMPORT_PRESET_LABELS: Record<string, string> = {
  systeme_io: 'systeme.io',
  mailchimp: 'Mailchimp',
  brevo: 'Brevo',
  activecampaign: 'ActiveCampaign',
  kit: 'Kit (ConvertKit)',
  generic: 'CSV générique',
};

/** Result of reading a source: its columns, a few values and the suggested mapping. */
export interface ImportAnalysis {
  source: ImportSource;
  /** Detected CSV preset (`generic` when none matched); `systeme_io` for the API. */
  preset: string;
  preset_label: string;
  columns: ImportColumn[];
  mapping: ImportColumnMapping[];
  /** Number of data rows (null when unknown: API). */
  rows: number | null;
}

export interface ImportPreviewContact {
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  tags: string[];
  status: 'subscribed' | 'unsubscribed' | 'bounced' | 'pending';
  created_at: string | null;
  fields: Record<string, string>;
  exists: boolean;
}

export interface ImportPreview {
  /** true when only the first page of the source was read (API): the counters cover this sample only. */
  partial: boolean;
  total: number;
  valid: number;
  invalid: number;
  empty: number;
  duplicates: number;
  existing: number;
  unsubscribed: number;
  bounced: number;
  pending: number;
  tags: string[];
  /** Custom fields that will be created. */
  new_fields: string[];
  /** Custom field columns with values the field will reject (ignored at import, listed in the error journal). */
  invalid_values: { column: string; field: string; count: number; examples: string[] }[];
  sample: ImportPreviewContact[];
}

export interface ImportJob {
  id: number;
  source: ImportSource;
  status: ImportStatus;
  label: string;
  options: ImportOptions;
  total: number | null;
  processed: number;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  warnings: number;
  error: string | null;
  note: string | null;
  resume_at: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface PageImportResult {
  title: string;
  url: string;
  content: PageContent;
  stats: { headings: number; texts: number; lists: number; images: number; buttons: number; forms: number };
  warnings: string[];
}
