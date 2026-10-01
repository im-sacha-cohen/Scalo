// Account data (Paramètres → Données et compte): GDPR export, deletion of all the data, deletion of the account.

/** What the account contains, shown before a deletion is confirmed (GET /api/account/summary). */
export interface AccountDataSummary {
  /** Email of the account: the confirmation word of the deletions. */
  email: string;
  counts: {
    contacts: number;
    tags: number;
    custom_fields: number;
    segments: number;
    funnels: number;
    steps: number;
    domains: number;
    broadcasts: number;
    campaigns: number;
    /** Emails waiting in the sending queue (pending or being sent). */
    queued_emails: number;
    automations: number;
    /** Automation runs pending / waiting / running. */
    active_runs: number;
    imports: number;
    products: number;
    orders: number;
    courses: number;
    lessons: number;
    /** Manual course accesses + lesson progress rows. */
    students: number;
    affiliates: number;
    media_files: number;
    lesson_files: number;
    /** Size of the media library and the lesson files on disk (bytes). */
    files_bytes: number;
    /** Enterprise edition: team members and pending invitations (deleted with the account). */
    team_members: number;
    invitations: number;
    oauth_apps: number;
  };
  /** Stripe keys saved: customers' subscriptions keep running in the Stripe account (Scalo does not cancel them). */
  stripe_connected: boolean;
  /** Orders whose Stripe subscription is still active. */
  active_subscriptions: number;
}

/** Body of POST /api/account/reset and POST /api/account/delete. */
export interface AccountDeletionInput {
  password: string;
  /** Must be the email of the account. */
  confirm: string;
}
