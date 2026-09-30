// Editions (community / Enterprise): neutral types shared by the core API and the web app.
// The Enterprise code itself lives in `ee/` (commercial license); nothing here depends on it.

/** Role of the signed-in person on the account he works on. `owner` = the account itself (every solo account). */
export type AccountRole = 'owner' | 'admin' | 'editor' | 'viewer';

export const ACCOUNT_ROLE_LABELS: Record<AccountRole, string> = {
  owner: 'Propriétaire',
  admin: 'Administrateur',
  editor: 'Éditeur',
  viewer: 'Lecture seule',
};

/**
 * - `none`: no license key (community edition)
 * - `valid`: signed key, not expired
 * - `grace`: expired, still within the grace period (Enterprise features keep working, a banner is shown)
 * - `expired`: expired for longer than the grace period (Enterprise features off; the core and the data are untouched)
 * - `invalid`: malformed key or bad signature
 */
export type LicenseStatus = 'none' | 'valid' | 'grace' | 'expired' | 'invalid';

export interface LicenseSummary {
  status: LicenseStatus;
  plan: string | null;
  /** Features listed in the key (whatever the status). */
  features: string[];
  seats: number | null;
  expires_at: string | null;
  grace_until: string | null;
}

export interface EditionBranding {
  app_name: string;
  logo_url: string;
}

export interface EditionInfo {
  /** `enterprise` when the `ee/` directory is installed and loaded, whatever the license. */
  edition: 'community' | 'enterprise';
  license: LicenseSummary;
  /** Enterprise features usable right now (license valid or in its grace period). */
  features: string[];
  role: AccountRole;
  /** The signed-in person. */
  actor: { id: number; name: string; email: string };
  /** The account he works on (himself, unless he is a team member). */
  account: { id: number; name: string; email: string };
  /** White label of the admin interface (null = Scalo). */
  branding: EditionBranding | null;
}

export const NO_LICENSE: LicenseSummary = { status: 'none', plan: null, features: [], seats: null, expires_at: null, grace_until: null };
