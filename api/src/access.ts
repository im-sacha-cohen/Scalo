// Role-based access control of the session-authenticated API (/api, after requireAuth).
//
// Neutral mechanism of the core: a solo account is always `owner` and is never restricted. Roles other than `owner`
// only exist when the Enterprise edition attaches team members to an account (see api/src/ee.ts).
//
// The rules are generic (HTTP method + first path segments), NOT a whitelist of routes: a route added tomorrow is
// covered by default — read-only members can only read, editors cannot reach the administration areas.
// Applied by requireAuth itself (util.ts), so it covers every authenticated route however it is mounted.
import type { AccountRole } from '@scalo/shared';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Areas (first path segment under /api) reserved to the owner and administrators for anything that writes. */
const ADMIN_AREAS = new Set([
  'settings', // sender, SMTP, webhooks
  'billing',
  'team',
  'license',
  'audit',
  'branding',
  'developer', // OAuth applications
  'oauth', // consent: grants a third-party app access to the whole account
  'account',
  'api-keys',
  'integrations',
]);
/** Administration areas whose content is not even readable by editors / read-only members. */
const ADMIN_READ_AREAS = new Set(['billing', 'team', 'audit', 'developer', 'oauth', 'api-keys']);
/** Second-level segments that are administration whatever the feature (`/payments/settings`, `/ai/key`…). */
const ADMIN_SUBAREAS = new Set(['settings', 'billing', 'api-keys', 'key', 'keys', 'credentials', 'connect', 'payouts']);
/** Money movements (`/orders/12/refund`): last path segment, whatever the resource. */
const ADMIN_ACTIONS = new Set(['refund', 'cancel-subscription']);
/** Writes reserved to the owner, even for administrators. */
const OWNER_AREAS = new Set(['account', 'license']);
/** POST routes that only read (the payload is too big for a query string): allowed to read-only members. */
const READ_ONLY_POSTS = [/^\/segments\/preview$/, /^\/contacts\/query$/, /^\/preview\/email$/];

/** Path relative to /api (`/contacts/12`), without query string. */
export function roleAllows(role: AccountRole, method: string, path: string): boolean {
  if (role === 'owner') return true;
  const m = method.toUpperCase();
  const safe = SAFE_METHODS.has(m);
  const segments = path.split('?')[0].split('/').filter(Boolean);
  const [area = '', sub = ''] = segments;
  if (role === 'admin') return safe || !OWNER_AREAS.has(area);
  // editor, viewer
  if (ADMIN_READ_AREAS.has(area)) return false;
  const adminArea = ADMIN_AREAS.has(area) || ADMIN_SUBAREAS.has(sub) || ADMIN_ACTIONS.has(segments[segments.length - 1] ?? '');
  if (role === 'editor') return safe || !adminArea;
  // viewer: reads only
  if (safe) return true;
  return m === 'POST' && READ_ONLY_POSTS.some((re) => re.test(path.split('?')[0]));
}

export const ROLE_DENIED: Record<AccountRole, string> = {
  owner: '',
  admin: 'Cette action est réservée au propriétaire du compte',
  editor: 'Votre rôle (éditeur) ne permet pas cette action : elle est réservée aux administrateurs du compte',
  viewer: 'Votre accès est en lecture seule : vous ne pouvez pas effectuer cette action',
};

/** Path of a request relative to /api, whatever the router it is mounted on. */
export const apiPath = (originalUrl: string) => originalUrl.split('?')[0].replace(/^\/api(?=\/|$)/, '') || '/';
