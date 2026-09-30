// Content model shared by the page builder, the email builder and the public renderer.

export * from './content';
import type { PageContent } from './content';
import type { AbStatus, FunnelSettings } from './growth';

export type StepType = 'optin' | 'sales' | 'thankyou' | 'custom';

// ---------- API entities ----------

export interface User {
  id: number;
  email: string;
  name: string;
  created_at: string;
}

export interface Tag { id: number; name: string; contacts_count?: number }

export interface Contact {
  id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  unsubscribed: 0 | 1;
  bounced?: 0 | 1; // hard bounce: the address is excluded from all sends
  complained?: 0 | 1; // marked an email as spam (provider feedback loop): unsubscribed for good
  /** 'pending_confirmation': double opt-in not confirmed yet — excluded from newsletters and campaigns. */
  status?: ContactStatus;
  confirmed_at?: string | null;
  confirmation_sent_at?: string | null;
  created_at: string;
  tags: Tag[];
  /** Custom field values by key (see CustomField). */
  fields?: Record<string, string | number | boolean>;
}

export type ContactStatus = 'active' | 'pending_confirmation';

export interface ContactEvent { id: number; type: string; data: Record<string, unknown>; created_at: string }

export interface Funnel {
  id: number;
  name: string;
  slug: string;
  created_at: string;
  steps_count?: number;
  views?: number;
  optins?: number;
  steps?: Step[];
  /** Pixels, cookie banner, legal pages footer (see growth.ts). */
  settings?: FunnelSettings;
  /** Kit of the funnel (list endpoint; the detail has it in `settings.kit`). */
  kit?: string | null;
}

export interface Step {
  id: number;
  funnel_id: number;
  name: string;
  slug: string;
  type: StepType;
  position: number;
  content: PageContent;
  access?: StepAccess;
  preview_url?: string; // owner-only link that bypasses access rules (valid 24 h)
  views?: number;
  optins?: number;
  /** A/B test of the page and number of variants (see growth.ts). */
  ab_status?: AbStatus;
  variants_count?: number;
}

/**
 * Who may open a funnel step by its public URL.
 * - public:   anyone
 * - funnel:   visitors who already opted in through this funnel (signed contact cookie)
 * - tag:      identified contacts having `tag_id` (e.g. "client" after a purchase)
 * - password: anyone who enters the password (remembered 30 days in this browser)
 * Denied visitors are sent to `redirect` (first step, previous step or a custom URL); password mode shows a form.
 */
export type StepAccessMode = 'public' | 'funnel' | 'tag' | 'password';
export interface StepAccess {
  mode: StepAccessMode;
  tag_id?: number | null;
  redirect?: 'first' | 'previous' | 'url';
  redirect_url?: string;
  password_set?: boolean; // read-only: a password is configured
}

export interface Broadcast {
  id: number;
  subject: string;
  content: PageContent;
  tag_id: number | null;         // null = all subscribed contacts
  /** Saved segment the recipients must match (combined with `tag_id`); computed when the send starts. */
  segment_id?: number | null;
  /** 'scheduled': sent automatically at `scheduled_at` (recipients computed at that time; editable until then). */
  status: 'draft' | 'scheduled' | 'sent';
  sent_at: string | null;
  scheduled_at?: string | null;
  created_at: string;
  stats?: EmailStats;
  /** A/B test of the subject (null = disabled). */
  ab_test?: AbTestConfig | null;
  /** A/B test progress and per-variant stats (once the send has started). */
  ab?: AbTestResult | null;
}

/**
 * A/B test of a newsletter subject. Variant 0 is the newsletter subject, `subjects` are the other variants (1–2).
 * Each variant goes to `test_percent` % of the recipients; after `wait_hours` the variant with the best open rate
 * (then click rate) is sent to the remaining recipients. Under 100 recipients: even split, no winner phase.
 */
export interface AbTestConfig { subjects: string[]; test_percent: number; wait_hours: number }
export interface AbVariantStats {
  index: number;
  subject: string;
  sent: number;
  opened: number;
  clicked: number;
  pending: number;
  test_recipients: number; // sends of the test phase (or of the even split)
  open_rate: number;       // 0..1
  click_rate: number;      // 0..1
}
export interface AbTestResult {
  phase: 'testing' | 'done' | null;
  winner: number | null;
  decide_at: string | null;
  split_only: boolean; // small list: even split, no winner phase
  variants: AbVariantStats[];
}

export interface Campaign {
  id: number;
  name: string;
  trigger_tag_id: number | null; // contacts receiving this tag are enrolled
  /** Contacts receiving this tag leave the sequence (e.g. "client" after a purchase). */
  stop_tag_id?: number | null;
  created_at: string;
  subscribers?: number;
  emails?: CampaignEmail[];
}

/**
 * Rule evaluated when a campaign email is due. When false: `skip` moves on to the next email, `stop` ends the
 * sequence for that contact. "previous" = the last email of this campaign actually sent to the contact.
 */
export type CampaignConditionType = 'has_tag' | 'not_has_tag' | 'opened_previous' | 'clicked_previous' | 'not_opened_previous';
export interface CampaignCondition { type: CampaignConditionType; tag_id?: number | null; action: 'skip' | 'stop' }

export type SubscriptionStatus = 'active' | 'completed' | 'stopped' | 'unsubscribed';
export interface CampaignSubscriber {
  contact_id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
  status: SubscriptionStatus;
  enrolled_at: string;
  sent: number;          // campaign emails delivered to this contact
  skipped: number;       // skipped by a condition
  total: number;         // emails in the campaign
  next_send_at: string | null;
  stopped_reason: string | null;
}

export interface CampaignEmail {
  id: number;
  campaign_id: number;
  subject: string;
  content: PageContent;
  delay_days: number; // delay after the previous email (or after enrollment for the first)
  position: number;
  condition?: CampaignCondition | null;
  stats?: EmailStats;
}

export interface EmailStats { sent: number; opened: number; clicked: number; pending: number; sending?: number; failed: number; skipped?: number }

export interface EmailSend {
  id: number;
  to_email: string;
  subject: string;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'skipped'; // skipped: campaign condition / sequence stopped
  kind?: 'broadcast' | 'campaign' | 'test' | 'confirmation' | 'order';
  variant?: number | null; // A/B test subject variant
  attempts?: number;       // delivery attempts so far
  send_at: string;         // for pending retries: time of the next attempt
  sent_at: string | null;
  opened_at: string | null;
  clicked_at: string | null;
  error: string | null;
  source: string; // "broadcast:<id>" | "campaign:<id>" | "test" | "confirmation" | "deleted"
}

export interface Settings {
  sender_name: string;
  sender_email: string;
  company_address: string;
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  smtp_pass: string;   // write-only: API returns "" if set, plus smtp_configured
  smtp_secure: boolean;
  smtp_configured?: boolean;
  rate_per_minute: number; // sending throttle (default 60)
  daily_limit: number;     // max emails per rolling 24h, 0 = unlimited
  double_optin_default?: boolean; // default of forms without an explicit double opt-in setting
  dkim_selectors?: string;        // extra DKIM selectors checked by the DNS check (comma separated)
  webhook_secret?: string;        // read-only: secret of the provider webhook URL (rotate via the API)
  webhook_base_url?: string;      // read-only: `${PUBLIC_URL}/api/webhooks/email`
}

export type DnsRecordStatus = 'ok' | 'warning' | 'missing';
export interface DnsRecordCheck {
  kind: 'spf' | 'dkim' | 'dmarc' | 'mx';
  status: DnsRecordStatus;
  host: string;            // name queried (e.g. _dmarc.exemple.fr)
  found: string[];         // records found
  message: string;         // French explanation
  selector?: string;       // DKIM: selector found
  recommended?: { type: 'TXT' | 'MX' | 'CNAME'; host: string; value: string } | null;
}
export interface DnsCheckResult {
  domain: string;
  checked_at: string;
  provider: 'brevo' | 'mailgun' | 'ses' | 'google' | 'ovh' | 'postmark' | 'other' | null; // guessed from SMTP host / records
  selectors: string[];     // DKIM selectors tried
  records: DnsRecordCheck[];
  ok: boolean;             // SPF and DKIM ok
}

export type QueueState =
  | 'idle'        // nothing to send
  | 'sending'     // actively sending
  | 'paused'      // paused manually or automatically (see paused_reason)
  | 'backoff'     // temporary pause after SMTP connection errors, resumes by itself
  | 'daily_limit';// daily quota reached, resumes when the 24h window frees up

export interface QueueJob {
  broadcast_id: number;
  subject: string;
  started_at: string;
  total: number;
  sent: number;
  failed: number;
  pending: number;
  sending: number;
  opened: number;
  clicked: number;
  eta_seconds: number;
  done: boolean;
  ab_phase?: 'testing' | 'done' | null; // A/B test: waiting for the winner while 'testing'
  ab_decide_at?: string | null;
}

export interface UpcomingBroadcast { broadcast_id: number; subject: string; scheduled_at: string; tag_id: number | null; ab: boolean }

export interface ComplaintStats {
  sent_30d: number;
  complaints_30d: number;
  rate_30d: number;         // 0..1 — warning above 0.1 %
  window_sends: number;     // last 1000 sends
  window_complaints: number;
  window_rate: number;      // sending is paused automatically above 0.3 %
}

export interface QueueStatus {
  state: QueueState;
  paused_reason: string | null;
  resume_at: string | null;   // for backoff / daily_limit
  dev_mode: boolean;          // no SMTP: emails are not really delivered
  rate_per_minute: number;
  daily_limit: number;
  sent_24h: number;
  sent_last_minute: number;
  due: number;                // pending and due now
  scheduled: number;          // pending in the future (campaign delays, retries)
  retrying: number;           // pending after at least one failed attempt
  sending: number;
  failed_24h: number;
  eta_seconds: number;        // time to drain `due` at the current rate/limit
  jobs: QueueJob[];           // newsletters in progress or finished in the last 24h
  recent_errors: { error: string; count: number }[];
  upcoming?: UpcomingBroadcast[]; // scheduled newsletters
  complaints?: ComplaintStats;
}

export interface DashboardStats {
  contacts: number;
  new_contacts_7d: number;
  funnels: number;
  views_30d: number;
  optins_30d: number;
  emails_sent_30d: number;
  open_rate: number; // 0..1
  daily: { date: string; views: number; optins: number; contacts: number }[]; // last 30 days
}
