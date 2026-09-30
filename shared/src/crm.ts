// CRM & automations: custom fields, segments (multi-criteria filters), bulk actions, automation rules.

// ---------- custom fields ----------

export const CUSTOM_FIELD_TYPES = ['text', 'number', 'date', 'select', 'checkbox'] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const CUSTOM_FIELD_TYPE_LABELS: Record<CustomFieldType, string> = {
  text: 'Texte',
  number: 'Nombre',
  date: 'Date',
  select: 'Liste de choix',
  checkbox: 'Case à cocher',
};

/** Stable key: lowercase letter, then letters / digits / underscores (40 max). Used as `{{field.key}}`. */
export const CUSTOM_FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** Definition of a custom field of the account. `key` and `type` cannot change once created. */
export interface CustomField {
  id: number;
  key: string;
  label: string;
  type: CustomFieldType;
  /** Choices of a `select` field. */
  options: string[];
  position: number;
  created_at: string;
}

/** Stored value: text / select → string, number → number, date → 'YYYY-MM-DD', checkbox → boolean. */
export type CustomFieldValue = string | number | boolean;
export type ContactFields = Record<string, CustomFieldValue>;

/** Builtin contact columns usable in segment conditions like custom fields (text semantics). */
export const BUILTIN_FIELDS = ['email', 'first_name', 'last_name', 'phone'] as const;
export type BuiltinField = (typeof BUILTIN_FIELDS)[number];

// ---------- segments ----------

export type FieldOperator = 'eq' | 'neq' | 'contains' | 'not_contains' | 'gt' | 'lt' | 'empty' | 'not_empty';
export type SegmentStatus = 'confirmed' | 'pending_confirmation' | 'unsubscribed' | 'bounced';

export type SegmentCondition =
  | { type: 'tag'; op: 'has' | 'not_has'; tag_id: number }
  /** `key`: a custom field key or a builtin field (email, first_name, last_name, phone). */
  | { type: 'field'; key: string; op: FieldOperator; value?: string | number | boolean | null }
  | { type: 'status'; op: 'is' | 'is_not'; value: SegmentStatus }
  /** before / after: date 'YYYY-MM-DD' (start of day, UTC) ; within_days / older_than_days: number of days. */
  | { type: 'created'; op: 'before' | 'after' | 'within_days' | 'older_than_days'; value: string | number }
  /** Email activity in the last `days` days (any email: newsletter or campaign). */
  | { type: 'email_activity'; op: 'opened' | 'clicked' | 'not_opened' | 'not_clicked'; days: number }
  /** Opted in through funnel `funnel_id` (null = any funnel). */
  | { type: 'optin'; op: 'did' | 'did_not'; funnel_id: number | null }
  /** enrolled = subscription active or completed; completed = sequence finished. */
  | { type: 'campaign'; op: 'enrolled' | 'not_enrolled' | 'completed'; campaign_id: number }
  /** Recorded purchase (optionally of a product, case-insensitive exact name). */
  | { type: 'purchase'; op: 'did' | 'did_not'; product?: string | null };

export type SegmentConditionType = SegmentCondition['type'];

/** Conditions combined with ET (`all`) or OU (`any`); a condition may be a nested group (max depth 3). */
export interface SegmentFilter {
  match: 'all' | 'any';
  conditions: (SegmentCondition | SegmentFilter)[];
}

export const isFilterGroup = (c: SegmentCondition | SegmentFilter): c is SegmentFilter => (c as SegmentFilter).conditions !== undefined;

export const emptyFilter = (): SegmentFilter => ({ match: 'all', conditions: [] });

export interface Segment {
  id: number;
  name: string;
  filter: SegmentFilter;
  /** Contacts currently matching. */
  contacts_count?: number;
  created_at: string;
  updated_at: string;
}

// ---------- bulk actions ----------

export type BulkAction =
  | { type: 'add_tag'; tag_name: string }
  | { type: 'remove_tag'; tag_id: number }
  | { type: 'enroll'; campaign_id: number }
  | { type: 'unenroll'; campaign_id: number }
  | { type: 'unsubscribe' }
  | { type: 'delete' }
  | { type: 'set_field'; key: string; value: CustomFieldValue | null };

/** Either explicit ids, or every contact matching the list filters (search, tag, status, segment, ad hoc filter). */
export type BulkSelection =
  | { ids: number[] }
  | { all: true; search?: string; tag_id?: number | null; status?: SegmentStatus | null; segment_id?: number | null; filter?: SegmentFilter | null };

export interface BulkResult {
  /** Contacts selected. */
  matched: number;
  /** Contacts actually changed (a tag already present, an enrollment refused… are not counted). */
  processed: number;
}

// ---------- automations ----------

export type AutomationTrigger =
  | { type: 'optin'; funnel_id?: number | null; step_id?: number | null }
  | { type: 'contact_created' }
  | { type: 'tag_added'; tag_id: number }
  | { type: 'tag_removed'; tag_id: number }
  | { type: 'link_clicked'; url_contains?: string | null; broadcast_id?: number | null; campaign_id?: number | null }
  | { type: 'purchase'; product?: string | null }
  | { type: 'campaign_completed'; campaign_id?: number | null }
  | { type: 'course_completed'; course_id?: number | null }
  | { type: 'affiliate_approved' }
  | { type: 'webhook' };

export type AutomationTriggerType = AutomationTrigger['type'];

export const AUTOMATION_TRIGGER_LABELS: Record<AutomationTriggerType, string> = {
  optin: 'Inscription via un formulaire',
  contact_created: 'Nouveau contact',
  tag_added: 'Tag ajouté',
  tag_removed: 'Tag retiré',
  link_clicked: 'Clic sur un lien d’email',
  purchase: 'Achat',
  campaign_completed: 'Campagne terminée',
  course_completed: 'Formation terminée',
  affiliate_approved: 'Nouvel affilié approuvé',
  webhook: 'Webhook entrant',
};

export type WaitUnit = 'minutes' | 'hours' | 'days';

export type AutomationAction =
  | { type: 'add_tag'; tag_id: number }
  | { type: 'remove_tag'; tag_id: number }
  | { type: 'enroll'; campaign_id: number }
  | { type: 'unenroll'; campaign_id: number }
  | { type: 'set_field'; key: string; value: CustomFieldValue | null }
  | { type: 'unsubscribe' }
  | { type: 'webhook'; url: string }
  | { type: 'wait'; amount: number; unit: WaitUnit };

export type AutomationActionType = AutomationAction['type'];

export const AUTOMATION_ACTION_LABELS: Record<AutomationActionType, string> = {
  add_tag: 'Ajouter un tag',
  remove_tag: 'Retirer un tag',
  enroll: 'Inscrire à une campagne',
  unenroll: 'Retirer d’une campagne',
  set_field: 'Définir un champ',
  unsubscribe: 'Désinscrire des emails',
  webhook: 'Appeler un webhook',
  wait: 'Attendre',
};

export interface Automation {
  id: number;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  /** The contact must match this filter when the run starts (null = no condition). */
  conditions: SegmentFilter | null;
  actions: AutomationAction[];
  /** Run at most once per contact. */
  run_once: boolean;
  /** Incoming webhook URL (trigger `webhook`). */
  webhook_url: string | null;
  /** Secret used to sign outgoing webhooks (HMAC-SHA256). */
  signing_secret: string;
  stats?: { runs_30d: number; completed_30d: number; failed_30d: number; waiting: number };
  created_at: string;
  updated_at: string;
}

export type AutomationRunStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'skipped';

export interface AutomationRunLogEntry {
  step: number;
  action: AutomationActionType;
  ok: boolean;
  message: string;
  at: string;
}

export interface AutomationRun {
  id: number;
  automation_id: number;
  automation_name?: string;
  contact_id: number | null;
  contact_email: string | null;
  status: AutomationRunStatus;
  /** Index of the next action to execute. */
  step: number;
  depth: number;
  trigger_data: Record<string, unknown>;
  log: AutomationRunLogEntry[];
  error: string | null;
  resume_at: string | null;
  created_at: string;
  finished_at: string | null;
}

/** Recorded purchase (API v1 / incoming webhook): there is no payment in the app. */
export interface PurchaseInput {
  product: string;
  amount?: number | null;
  currency?: string | null;
  external_id?: string | null;
}
