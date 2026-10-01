// Typed view of the PostgreSQL schema (see migrations/). Kept in sync by hand with the migrations.
//
// Conventions:
// - ids are `bigint generated always as identity`; int8 is parsed as a JS number (db/index.ts), so ids stay numbers.
// - timestamptz columns are parsed as ISO-8601 strings (db/index.ts), so rows can be returned to the API as is.
// - jsonb columns are read as parsed values and written as JSON text (`JSON.stringify(...)`).
import type { ColumnType, Generated, Insertable, Selectable } from 'kysely';
import type {
  AutomationAction,
  AutomationRunLogEntry,
  AutomationRunStatus,
  AutomationTrigger,
  AutomationTriggerType,
  ContactFields,
  CustomFieldType,
  SegmentFilter,
} from '@scalo/shared';
import type { AbTestConfig, CampaignCondition, FunnelSettings, PageContent, StepAccess, StepType } from '@scalo/shared';

/** timestamptz: read as ISO string; written as ISO string / Date; defaulted where the column has a default. */
type Timestamp = ColumnType<string, string | Date | undefined, string | Date>;
type NullableTimestamp = ColumnType<string | null, string | Date | null | undefined, string | Date | null>;
type Json<T> = ColumnType<T, string, string>;
type JsonDefault<T> = ColumnType<T, string | undefined, string>;
type Id = Generated<number>;
/** Column with a server default: optional on insert. */
type Default<T> = ColumnType<T, T | undefined, T>;

export type SendStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';
export type SendKind = 'broadcast' | 'campaign' | 'test' | 'confirmation' | 'order';

export interface UsersTable {
  id: Id;
  email: string;
  password_hash: string;
  name: string;
  created_at: Timestamp;
}

export interface SettingsTable {
  user_id: number;
  sender_name: Default<string>;
  sender_email: Default<string>;
  company_address: Default<string>;
  smtp_host: Default<string>;
  smtp_port: Default<number>;
  smtp_user: Default<string>;
  smtp_pass: Default<string>;
  smtp_secure: Default<boolean>;
  rate_per_minute: Default<number>;
  daily_limit: Default<number>;
  sending_paused: Default<boolean>;
  paused_reason: Default<string>;
  double_optin_default: Default<boolean>;
  /** Secret part of the provider webhook URL (complaints / bounces). Generated on first read. */
  webhook_secret: string | null;
  /** Extra DKIM selectors to check (comma separated). */
  dkim_selectors: Default<string>;
}

export interface ContactsTable {
  id: Id;
  user_id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  unsubscribed: Default<boolean>;
  bounced: Default<boolean>;
  /** NULL = double opt-in not confirmed yet (excluded from newsletters and campaigns). */
  confirmed_at: NullableTimestamp;
  confirmation_sent_at: NullableTimestamp;
  /** Marked the email as spam (provider feedback loop). */
  complained: Default<boolean>;
  /** 0005: custom field values by key (validated against custom_fields by the API). */
  fields: ColumnType<ContactFields, string | undefined, string>;
  /** 0006: first-touch attribution of the first optin (UTM + referrer), never overwritten. */
  source: ColumnType<Record<string, string> | null, string | null | undefined, string | null>;
  created_at: Timestamp;
}

export interface TagsTable {
  id: Id;
  user_id: number;
  name: string;
  created_at: Timestamp;
}

export interface ContactTagsTable {
  contact_id: number;
  tag_id: number;
  created_at: Timestamp;
}

export interface FunnelsTable {
  id: Id;
  user_id: number;
  name: string;
  slug: string;
  /** 0006: pixels, cookie banner, legal pages footer (see FunnelSettings). */
  settings: JsonDefault<FunnelSettings>;
  share_token_hash: string | null;
  share_created_at: NullableTimestamp;
  created_at: Timestamp;
}

export interface StepsTable {
  id: Id;
  funnel_id: number;
  name: string;
  slug: string;
  type: StepType;
  position: Default<number>;
  content: Json<PageContent>;
  access: JsonDefault<StepAccess>;
  password_hash: string | null;
  /** 0006: A/B test of the page ('running': visitors split between the original and the active variants). */
  ab_status: Default<'off' | 'running' | 'paused'>;
  ab_control_weight: Default<number>;
  ab_started_at: NullableTimestamp;
  created_at: Timestamp;
}

export interface ContactEventsTable {
  id: Id;
  user_id: number;
  contact_id: number;
  type: string;
  data: JsonDefault<Record<string, unknown>>;
  funnel_id: number | null;
  step_id: number | null;
  /** 0006 (optin events): A/B arm (0 = original) and first-touch attribution of the visitor. */
  variant_id: ColumnType<number | null, number | null | undefined, number | null>;
  attribution: ColumnType<Record<string, string> | null, string | null | undefined, string | null>;
  created_at: Timestamp;
}

export interface PageViewsTable {
  id: Id;
  user_id: number;
  funnel_id: number;
  step_id: number;
  visitor_id: string;
  /** 0006: A/B arm shown (0 = original, NULL = no test running) and first-touch attribution of the visitor. */
  variant_id: ColumnType<number | null, number | null | undefined, number | null>;
  utm_source: ColumnType<string | null, string | null | undefined, string | null>;
  utm_medium: ColumnType<string | null, string | null | undefined, string | null>;
  utm_campaign: ColumnType<string | null, string | null | undefined, string | null>;
  utm_content: ColumnType<string | null, string | null | undefined, string | null>;
  utm_term: ColumnType<string | null, string | null | undefined, string | null>;
  referrer_host: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: Timestamp;
}

export interface BroadcastsTable {
  id: Id;
  user_id: number;
  subject: string;
  content: Json<PageContent>;
  tag_id: number | null;
  /** 0005: recipients must also match this saved segment. */
  segment_id: Default<number | null>;
  status: Default<'draft' | 'scheduled' | 'sent'>;
  sent_at: NullableTimestamp;
  scheduled_at: NullableTimestamp;
  ab_test: ColumnType<AbTestConfig | null, string | null | undefined, string | null>;
  ab_phase: 'testing' | 'done' | null;
  ab_winner: number | null;
  ab_decide_at: NullableTimestamp;
  created_at: Timestamp;
}

export interface CampaignsTable {
  id: Id;
  user_id: number;
  name: string;
  trigger_tag_id: number | null;
  stop_tag_id: number | null;
  created_at: Timestamp;
}

export interface CampaignEmailsTable {
  id: Id;
  campaign_id: number;
  subject: string;
  content: Json<PageContent>;
  delay_days: Default<number>;
  position: Default<number>;
  condition: ColumnType<CampaignCondition | null, string | null | undefined, string | null>;
}

export interface CampaignSubscriptionsTable {
  id: Id;
  campaign_id: number;
  contact_id: number;
  status: Default<'active' | 'completed' | 'stopped' | 'unsubscribed'>;
  stopped_at: NullableTimestamp;
  stopped_reason: string | null;
  created_at: Timestamp;
}

export interface EmailSendsTable {
  id: Id;
  user_id: number;
  contact_id: number | null;
  broadcast_id: number | null;
  campaign_id: number | null;
  campaign_email_id: number | null;
  is_test: Default<boolean>;
  kind: Default<SendKind>;
  /** A/B test: index of the subject variant (0 = main subject). */
  variant: number | null;
  /** Message-ID returned by the SMTP server (matches provider webhooks). */
  message_id: string | null;
  complained_at: NullableTimestamp;
  to_email: string;
  subject: string;
  html: string | null;
  status: Default<SendStatus>;
  attempts: Default<number>;
  send_at: Timestamp;
  sent_at: NullableTimestamp;
  opened_at: NullableTimestamp;
  clicked_at: NullableTimestamp;
  last_attempt_at: NullableTimestamp;
  claimed_by: string | null;
  error: string | null;
  created_at: Timestamp;
}

/** Live API processes running the email worker (heartbeat), used to recover sends of crashed instances. */
export interface WorkerInstancesTable {
  id: string;
  hostname: string;
  pid: number;
  started_at: Timestamp;
  heartbeat_at: Timestamp;
}

/** Fixed-window attempt counters (brute-force protection shared by all API instances). */
export interface AuthAttemptsTable {
  key: string;
  count: Default<number>;
  window_start: Timestamp;
}

// ---------- OAuth 2.0 authorization server (0004) ----------

export type OAuthClientType = 'confidential' | 'public';

/** Third-party application registered by a user ("Développeurs"). */
export interface OAuthClientsTable {
  id: Id;
  /** Public identifier (`scalo_app_…`). */
  client_id: string;
  /** Owner (developer) of the application. */
  user_id: number;
  name: string;
  description: Default<string>;
  website: string | null;
  logo_url: string | null;
  type: OAuthClientType;
  /** SHA-256 of the client secret (confidential clients only). */
  secret_hash: string | null;
  /** Last 4 characters of the secret (shown in the UI). */
  secret_hint: string | null;
  secret_rotated_at: NullableTimestamp;
  /** Exact-match list. */
  redirect_uris: string[];
  /** Scopes the application may request. */
  scopes: string[];
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** A validated /oauth/authorize request waiting for the user's decision (id = SHA-256 of the random request id). */
export interface OAuthAuthorizationRequestsTable {
  id_hash: string;
  client_id: number;
  redirect_uri: string;
  scopes: string[];
  state: string | null;
  code_challenge: string | null;
  code_challenge_method: 'S256' | null;
  prompt_consent: Default<boolean>;
  expires_at: Timestamp;
  consumed_at: NullableTimestamp;
  created_at: Timestamp;
}

export interface OAuthCodesTable {
  code_hash: string;
  client_id: number;
  user_id: number;
  redirect_uri: string;
  scopes: string[];
  code_challenge: string | null;
  family_id: string;
  expires_at: Timestamp;
  used_at: NullableTimestamp;
  created_at: Timestamp;
}

export interface OAuthTokensTable {
  id: Id;
  token_hash: string;
  type: 'access' | 'refresh';
  family_id: string;
  parent_id: number | null;
  client_id: number;
  user_id: number;
  scopes: string[];
  expires_at: Timestamp;
  rotated_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
  last_used_at: NullableTimestamp;
  created_at: Timestamp;
}

/** Remembered consent of a user for an application (= a "connected application"). */
export interface OAuthConsentsTable {
  user_id: number;
  client_id: number;
  scopes: string[];
  created_at: Timestamp;
  updated_at: Timestamp;
  last_used_at: NullableTimestamp;
}

/** Double opt-in request: actions applied once the contact clicks the confirmation link. */
export interface PendingOptinsTable {
  id: Id;
  user_id: number;
  contact_id: number;
  token_hash: string;
  tag_name: string | null;
  campaign_id: number | null;
  funnel_id: number | null;
  step_id: number | null;
  redirect_url: string | null;
  send_id: number | null;
  expires_at: Timestamp;
  confirmed_at: NullableTimestamp;
  created_at: Timestamp;
}

// ---------- 0005 automations & CRM ----------

/** Custom contact field definition (values live in contacts.fields). `key` / `type` are immutable. */
export interface CustomFieldsTable {
  id: Id;
  user_id: number;
  key: string;
  label: string;
  type: CustomFieldType;
  options: Default<string[]>;
  position: Default<number>;
  created_at: Timestamp;
}

/** Saved multi-criteria filter (compiled to a parameterized query by services/segments.ts). */
export interface SegmentsTable {
  id: Id;
  user_id: number;
  name: string;
  filter: Json<SegmentFilter>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** Automation rule: trigger → conditions (segment filter) → actions. */
export interface AutomationsTable {
  id: Id;
  user_id: number;
  name: string;
  enabled: Default<boolean>;
  trigger_type: AutomationTriggerType;
  trigger: Json<AutomationTrigger>;
  conditions: ColumnType<SegmentFilter | null, string | null | undefined, string | null>;
  actions: JsonDefault<AutomationAction[]>;
  run_once: Default<boolean>;
  webhook_token: string | null;
  signing_secret: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** One execution of an automation for a contact (executed by the worker, resumable after a crash). */
export interface AutomationRunsTable {
  id: Id;
  user_id: number;
  automation_id: number;
  contact_id: number | null;
  status: Default<AutomationRunStatus>;
  step: Default<number>;
  chain: Default<number[]>;
  depth: Default<number>;
  trigger_data: JsonDefault<Record<string, unknown>>;
  log: JsonDefault<AutomationRunLogEntry[]>;
  error: string | null;
  resume_at: NullableTimestamp;
  claimed_by: string | null;
  claimed_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
  finished_at: NullableTimestamp;
}

// ---------- 0006 funnels growth ----------

/** Custom domain serving one funnel (Host routing), verified by DNS (CNAME to the app host or TXT _scalo.<domain>). */
export interface CustomDomainsTable {
  id: Id;
  user_id: number;
  funnel_id: number;
  domain: string;
  root_step_id: number | null;
  verify_token: string;
  status: Default<'pending' | 'verified' | 'error'>;
  verified_at: NullableTimestamp;
  last_checked_at: NullableTimestamp;
  last_error: string | null;
  created_at: Timestamp;
}

/** A/B test variant of a step (the step's own content is the original, variant id 0 in stats). */
export interface StepVariantsTable {
  id: Id;
  step_id: number;
  name: string;
  content: Json<PageContent>;
  weight: Default<number>;
  active: Default<boolean>;
  created_at: Timestamp;
}

// ---------- 0007 payments ----------

/** Stripe connection of an account. The secret key and the webhook signing secret are encrypted (services/secretbox.ts). */
export interface PaymentSettingsTable {
  user_id: number;
  stripe_secret_key: string | null;
  stripe_secret_hint: string | null;
  stripe_publishable_key: string | null;
  stripe_webhook_secret: string | null;
  stripe_webhook_hint: string | null;
  mode: 'test' | 'live' | null;
  /** Secret part of the webhook URL. */
  webhook_token: string;
  account_name: string | null;
  verified_at: NullableTimestamp;
  /** SEPA Direct Debit offered next to cards (0015; must be activated in the Stripe dashboard). */
  sepa_debit: Default<boolean>;
  /** Hosts already registered as Stripe payment method domains (Apple Pay / Google Pay), reset with the keys. */
  payment_domains: JsonDefault<string[]>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** Stripe Product of a Scalo product, per mode (subscriptions need a product id). */
export interface StripeProductsTable {
  user_id: number;
  product_id: number;
  livemode: boolean;
  stripe_product_id: string;
  created_at: Timestamp;
}

export interface ProductsTable {
  id: Id;
  user_id: number;
  name: string;
  description: Default<string>;
  image_url: string | null;
  tag_id: number | null;
  campaign_id: number | null;
  revoke_on_refund: Default<boolean>;
  archived: Default<boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** Offer of a product. `amount`: minor units, tax included when `tax_inclusive`. */
export interface ProductPricesTable {
  id: Id;
  user_id: number;
  product_id: number;
  name: Default<string>;
  type: 'one_time' | 'subscription' | 'installments';
  amount: number;
  currency: string;
  interval: 'week' | 'month' | 'year' | null;
  interval_count: Default<number>;
  /** Installments offers: range the buyer chooses from (1 = may pay in one go). */
  installments_min: number | null;
  installments_max: number | null;
  /** Surcharge in percent per number of installments: `{ "3": 5 }`. */
  installment_fees: JsonDefault<Record<string, number>>;
  tax_rate: Default<number>;
  tax_inclusive: Default<boolean>;
  active: Default<boolean>;
  created_at: Timestamp;
}

export interface OrdersTable {
  id: Id;
  user_id: number;
  contact_id: number | null;
  email: string;
  first_name: string | null;
  last_name: string | null;
  funnel_id: number | null;
  step_id: number | null;
  variant_id: number | null;
  parent_order_id: number | null;
  kind: Default<'checkout' | 'upsell'>;
  status: Default<'pending' | 'paid' | 'failed' | 'refunded' | 'canceled'>;
  subscription_status: 'active' | 'past_due' | 'canceled' | 'completed' | null;
  livemode: Default<boolean>;
  currency: string;
  amount_subtotal: number;
  amount_tax: Default<number>;
  amount_total: number;
  amount_paid: Default<number>;
  amount_refunded: Default<number>;
  stripe_session_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_customer_id: string | null;
  stripe_payment_method_id: string | null;
  stripe_subscription_id: string | null;
  attribution: ColumnType<Record<string, string> | null, string | null | undefined, string | null>;
  /** Visitor context kept for extensions: `{ visitor_id, cookies: { scalo_aff…: value } }`. */
  visitor: JsonDefault<Record<string, unknown>>;
  failure_message: string | null;
  paid_at: NullableTimestamp;
  refunded_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface OrderItemsTable {
  id: Id;
  order_id: number;
  product_id: number | null;
  price_id: number | null;
  kind: Default<'main' | 'bump' | 'upsell'>;
  product_name: string;
  price_name: Default<string>;
  type: 'one_time' | 'subscription' | 'installments';
  interval: string | null;
  interval_count: Default<number>;
  /** Installments: number chosen by the buyer, and the regular installment (tax included). `amount_*` = whole plan. */
  installments: number | null;
  installment_amount: number | null;
  tax_rate: Default<number>;
  tax_inclusive: Default<boolean>;
  amount_subtotal: number;
  amount_tax: Default<number>;
  amount_total: number;
  tag_id: number | null;
  campaign_id: number | null;
  revoke_on_refund: Default<boolean>;
}

/** A payment collected for an order or a refund given back (refunds: cumulative amount per Stripe charge). */
export interface OrderTransactionsTable {
  id: Id;
  user_id: number;
  order_id: number;
  type: 'payment' | 'refund';
  amount: number;
  currency: string;
  stripe_id: string;
  stripe_payment_intent_id: string | null;
  created_at: Timestamp;
}

/** Stripe webhook events already applied (idempotency). */
export interface StripeEventsTable {
  user_id: number;
  event_id: string;
  type: string;
  created_at: Timestamp;
}

// ---------- 0008 courses ----------

/** Members area of an account: address (`/m/<slug>`) and branding. */
export interface MemberAreasTable {
  user_id: number;
  slug: string;
  name: string;
  logo_url: string | null;
  color: Default<string>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface CoursesTable {
  id: Id;
  user_id: number;
  title: string;
  slug: string;
  description: Default<string>;
  image_url: string | null;
  status: Default<'draft' | 'published'>;
  /** Contacts having this tag have access to the course. */
  access_tag_id: number | null;
  access_days: number | null;
  purchase_url: string | null;
  position: Default<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface CourseModulesTable {
  id: Id;
  course_id: number;
  title: string;
  position: Default<number>;
  created_at: Timestamp;
}

export interface CourseLessonsTable {
  id: Id;
  course_id: number;
  module_id: number;
  title: string;
  position: Default<number>;
  content: Json<import('@scalo/shared').PageContent>;
  video_url: string | null;
  status: Default<'draft' | 'published'>;
  free_preview: Default<boolean>;
  /** Drip: available N days after the member got access. */
  drip_days: Default<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** Downloadable file of a lesson (stored outside the public media library). */
export interface CourseFilesTable {
  id: Id;
  user_id: number;
  lesson_id: number;
  name: string;
  stored: string;
  size: number;
  created_at: Timestamp;
}

/** Manual access to a course (tag access is computed from contact_tags). */
export interface CourseEnrollmentsTable {
  id: Id;
  user_id: number;
  course_id: number;
  contact_id: number;
  access_at: Timestamp;
  expires_at: NullableTimestamp;
  created_at: Timestamp;
}

export interface LessonProgressTable {
  contact_id: number;
  lesson_id: number;
  course_id: number;
  completed_at: Timestamp;
}

export interface CourseCompletionsTable {
  course_id: number;
  contact_id: number;
  completed_at: Timestamp;
}

/** One-time magic link of a member (SHA-256 of the token). */
export interface MemberLoginTokensTable {
  id: Id;
  user_id: number;
  contact_id: number;
  token_hash: string;
  redirect_path: string | null;
  expires_at: Timestamp;
  used_at: NullableTimestamp;
  created_at: Timestamp;
}

// ---------- 0009 ai ----------

/** Per-account Anthropic API key, encrypted (services/secretbox.ts). */
export interface AiSettingsTable {
  user_id: number;
  api_key_enc: string;
  key_hint: string;
  updated_at: Timestamp;
}

export type AiGenerationKind = 'funnel' | 'campaign' | 'newsletter' | 'rewrite' | 'subjects';
export type AiGenerationStatus = 'running' | 'done' | 'failed';

/** One AI call: state of the asynchronous generations + usage log (tokens). */
export interface AiGenerationsTable {
  id: Id;
  user_id: number;
  kind: AiGenerationKind;
  status: Default<AiGenerationStatus>;
  label: Default<string>;
  result: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null>;
  error: string | null;
  model: string | null;
  key_source: Default<'account' | 'instance'>;
  input_tokens: Default<number>;
  output_tokens: Default<number>;
  created_at: Timestamp;
  finished_at: NullableTimestamp;
}

// ---------- 0010 imports ----------

/** Contact import processed in batches by the worker (services/imports.ts). */
export interface ImportJobsTable {
  id: Id;
  user_id: number;
  source: import('@scalo/shared').ImportSource;
  status: Default<import('@scalo/shared').ImportStatus>;
  label: Default<string>;
  options: JsonDefault<import('@scalo/shared').ImportOptions>;
  /** Resolved mapping (fields to create already created). */
  mapping: JsonDefault<import('@scalo/shared').ImportColumnMapping[]>;
  /** CSV text; erased when the job ends. */
  payload: string | null;
  /** Encrypted API key of the source; erased when the job ends. */
  secret_enc: string | null;
  cursor: JsonDefault<{ row?: number; after?: string | null; n?: number }>;
  total: number | null;
  processed: Default<number>;
  created_count: Default<number>;
  updated_count: Default<number>;
  skipped_count: Default<number>;
  error_count: Default<number>;
  warning_count: Default<number>;
  attempts: Default<number>;
  error: string | null;
  note: string | null;
  resume_at: Timestamp;
  claimed_by: string | null;
  claimed_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
  finished_at: NullableTimestamp;
}
export type ImportJobRow = Selectable<ImportJobsTable>;

export interface ImportJobErrorsTable {
  id: Id;
  job_id: number;
  line: number;
  email: Default<string>;
  level: Default<'error' | 'warning'>;
  message: string;
  created_at: Timestamp;
}

// ---------- 0011 ee ----------
// Tables of the Enterprise edition (used by the code in `ee/`; empty in the community edition).

export type MemberRole = 'admin' | 'editor' | 'viewer';

/** A team member: a regular user acting on behalf of `account_id` with a role. */
export interface AccountMembersTable {
  id: Id;
  account_id: number;
  user_id: number;
  role: MemberRole;
  invited_by: number | null;
  created_at: Timestamp;
}

export interface AccountInvitationsTable {
  id: Id;
  account_id: number;
  email: string;
  role: MemberRole;
  token_hash: string; // SHA-256 of the one-time token
  invited_by: number | null;
  expires_at: ColumnType<string, string | Date, string | Date>;
  accepted_at: NullableTimestamp;
  created_at: Timestamp;
}

export interface AuditLogsTable {
  id: Id;
  account_id: number;
  actor_id: number | null;
  actor_email: Default<string>;
  actor_role: Default<string>;
  action: string;
  method: string;
  path: string;
  resource_type: Default<string>;
  resource_id: string | null;
  status: number;
  ip: Default<string>;
  created_at: Timestamp;
}

export interface AccountEeSettingsTable {
  account_id: number;
  hide_powered_by: Default<boolean>;
  powered_by_text: Default<string>;
  powered_by_url: Default<string>;
  app_name: Default<string>;
  logo_url: Default<string>;
  audit_retention_days: Default<number>;
  updated_at: Timestamp;
}

export interface InstanceLicenseTable {
  id: Default<boolean>;
  license_key: string;
  updated_by: number | null;
  updated_at: Timestamp;
}

// ---------- 0012 affiliates ----------

export type CommissionRateType = 'percent' | 'fixed';
export type AffiliateStatus = 'pending' | 'approved' | 'rejected' | 'suspended';
export type CommissionStatus = 'pending' | 'approved' | 'paid' | 'cancelled';

export interface AffiliateProgramsTable {
  user_id: number;
  enabled: Default<boolean>;
  slug: string;
  name: string;
  commission_type: Default<CommissionRateType>;
  /** percent: 0–100 ; fixed: minor units per line sold. */
  commission_value: Default<number>;
  recurring: Default<boolean>;
  recurring_months: number | null;
  cookie_days: Default<number>;
  attribution: Default<'last_click' | 'first_click'>;
  validation_days: Default<number>;
  min_payout: Default<number>;
  signup_mode: Default<'open' | 'approval'>;
  terms: Default<string>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AffiliatesTable {
  id: Id;
  user_id: number;
  contact_id: number;
  code: string;
  status: Default<AffiliateStatus>;
  commission_type: CommissionRateType | null;
  commission_value: number | null;
  /** Encrypted (secretbox): never returned as is. */
  payout_details_enc: string | null;
  created_at: Timestamp;
  approved_at: NullableTimestamp;
  updated_at: Timestamp;
}

export interface AffiliateCommissionRulesTable {
  id: Id;
  user_id: number;
  product_id: number;
  price_id: number | null;
  commission_type: CommissionRateType;
  commission_value: number;
  created_at: Timestamp;
}

export interface AffiliateClicksTable {
  id: Id;
  user_id: number;
  affiliate_id: number;
  visitor_id: string;
  day: string;
  funnel_id: number | null;
  step_id: number | null;
  created_at: Timestamp;
}

export interface AffiliateReferralsTable {
  id: Id;
  user_id: number;
  affiliate_id: number;
  kind: 'lead' | 'sale';
  contact_id: number | null;
  order_id: number | null;
  created_at: Timestamp;
}

export interface AffiliatePayoutsTable {
  id: Id;
  user_id: number;
  affiliate_id: number;
  currency: string;
  amount: number;
  method: Default<string>;
  reference: Default<string>;
  note: Default<string>;
  created_at: Timestamp;
}

export interface AffiliateCommissionsTable {
  id: Id;
  user_id: number;
  affiliate_id: number;
  order_id: number | null;
  order_item_id: number | null;
  kind: 'sale' | 'recurring' | 'clawback';
  source_key: string;
  reverses_id: number | null;
  product_name: Default<string>;
  currency: string;
  base_amount: Default<number>;
  rate_type: CommissionRateType;
  rate_value: number;
  amount_initial: number;
  amount: number;
  status: Default<CommissionStatus>;
  approve_at: Timestamp;
  approved_at: NullableTimestamp;
  payout_id: number | null;
  paid_at: NullableTimestamp;
  cancelled_at: NullableTimestamp;
  cancel_reason: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

// ---------- 0013 onboarding ----------

/** Welcome flow of a new account (no row = never started). The checklist is computed, not stored. */
export interface AccountOnboardingTable {
  user_id: number;
  goal: import('@scalo/shared').OnboardingGoal | null;
  step: Default<import('@scalo/shared').OnboardingStep>;
  funnel_id: number | null;
  completed_at: NullableTimestamp;
  skipped_at: NullableTimestamp;
  checklist_hidden_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface Database {
  payment_settings: PaymentSettingsTable;
  products: ProductsTable;
  product_prices: ProductPricesTable;
  orders: OrdersTable;
  order_items: OrderItemsTable;
  order_transactions: OrderTransactionsTable;
  stripe_events: StripeEventsTable;
  stripe_products: StripeProductsTable;
  member_areas: MemberAreasTable;
  courses: CoursesTable;
  course_modules: CourseModulesTable;
  course_lessons: CourseLessonsTable;
  course_files: CourseFilesTable;
  course_enrollments: CourseEnrollmentsTable;
  lesson_progress: LessonProgressTable;
  course_completions: CourseCompletionsTable;
  member_login_tokens: MemberLoginTokensTable;
  ai_settings: AiSettingsTable;
  ai_generations: AiGenerationsTable;
  import_jobs: ImportJobsTable;
  import_job_errors: ImportJobErrorsTable;
  // 0011 tables
  account_members: AccountMembersTable;
  account_invitations: AccountInvitationsTable;
  audit_logs: AuditLogsTable;
  account_ee_settings: AccountEeSettingsTable;
  instance_license: InstanceLicenseTable;
  // 0012 tables
  affiliate_programs: AffiliateProgramsTable;
  affiliates: AffiliatesTable;
  affiliate_commission_rules: AffiliateCommissionRulesTable;
  affiliate_clicks: AffiliateClicksTable;
  affiliate_referrals: AffiliateReferralsTable;
  affiliate_payouts: AffiliatePayoutsTable;
  affiliate_commissions: AffiliateCommissionsTable;
  // 0013 tables
  account_onboarding: AccountOnboardingTable;
  users: UsersTable;
  settings: SettingsTable;
  contacts: ContactsTable;
  tags: TagsTable;
  contact_tags: ContactTagsTable;
  funnels: FunnelsTable;
  steps: StepsTable;
  contact_events: ContactEventsTable;
  page_views: PageViewsTable;
  broadcasts: BroadcastsTable;
  campaigns: CampaignsTable;
  campaign_emails: CampaignEmailsTable;
  campaign_subscriptions: CampaignSubscriptionsTable;
  email_sends: EmailSendsTable;
  worker_instances: WorkerInstancesTable;
  auth_attempts: AuthAttemptsTable;
  oauth_clients: OAuthClientsTable;
  oauth_authorization_requests: OAuthAuthorizationRequestsTable;
  oauth_codes: OAuthCodesTable;
  oauth_tokens: OAuthTokensTable;
  oauth_consents: OAuthConsentsTable;
  pending_optins: PendingOptinsTable;
  // 0005 tables
  custom_fields: CustomFieldsTable;
  segments: SegmentsTable;
  automations: AutomationsTable;
  automation_runs: AutomationRunsTable;
  // 0006 tables
  custom_domains: CustomDomainsTable;
  step_variants: StepVariantsTable;
}

export type ContactRow = Selectable<ContactsTable>;
export type SettingsRow = Selectable<SettingsTable>;
export type FunnelRow = Selectable<FunnelsTable>;
export type StepRow = Selectable<StepsTable>;
export type BroadcastRow = Selectable<BroadcastsTable>;
export type CampaignRow = Selectable<CampaignsTable>;
export type CampaignEmailRow = Selectable<CampaignEmailsTable>;
export type EmailSendRow = Selectable<EmailSendsTable>;
export type NewEmailSend = Insertable<EmailSendsTable>;
export type OAuthClientRow = Selectable<OAuthClientsTable>;
export type OAuthTokenRow = Selectable<OAuthTokensTable>;
