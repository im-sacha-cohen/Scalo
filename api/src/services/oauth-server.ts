// OAuth 2.0 authorization server — shared logic (RFC 6749, RFC 7636 PKCE, RFC 9700 security BCP).
//
// - Every secret (client secret, authorization request id, code, access / refresh token) is a random value of
//   32 bytes with a greppable prefix; only its SHA-256 is stored.
// - A "family" groups the tokens of one authorization (the code and every token obtained from it by refresh).
//   Replaying a used code or a rotated refresh token revokes the whole family.
import crypto from 'node:crypto';
import { sql } from 'kysely';
import { OAUTH_SCOPES, isOAuthScope, type OAuthScope } from '@scalo/shared';
import { db, inTx, type Db, type OAuthClientRow } from '../db';
import { env } from '../env';

export const ISSUER = env.PUBLIC_URL;

export const ACCESS_TOKEN_TTL_S = 3600;
export const REFRESH_TOKEN_TTL_S = 30 * 86400;
export const CODE_TTL_S = 60;
export const REQUEST_TTL_S = 10 * 60;

export const PREFIX = {
  clientId: 'scalo_app_',
  clientSecret: 'scalo_cs_',
  request: 'scalo_ar_',
  code: 'scalo_ac_',
  access: 'scalo_at_',
  refresh: 'scalo_rt_',
} as const;

export const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

/** Random secret with its prefix, and the hash stored in the database. */
export function newSecret(prefix: string) {
  const value = prefix + crypto.randomBytes(32).toString('base64url');
  return { value, hash: sha256(value) };
}

export const newClientId = () => PREFIX.clientId + crypto.randomBytes(12).toString('hex');

/** Constant-time comparison of a presented secret with a stored SHA-256 (hex). */
export function secretMatches(presented: string, storedHash: string | null): boolean {
  const a = Buffer.from(sha256(presented), 'hex');
  const b = Buffer.from(storedHash ?? '0'.repeat(64), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b) && storedHash !== null;
}

/** PKCE S256: BASE64URL(SHA256(verifier)) === challenge (constant time). */
export function pkceMatches(verifier: string, challenge: string): boolean {
  const computed = Buffer.from(crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url'));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && crypto.timingSafeEqual(computed, expected);
}

/** RFC 7636 §4.1: 43–128 characters of [A-Z a-z 0-9 - . _ ~]. */
export const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
/** S256 challenge = base64url of a SHA-256 → exactly 43 characters. */
export const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

// ---------- scopes ----------

/** Parses a space-delimited scope string. Returns null if a scope is unknown or the string is malformed. */
export function parseScopes(raw: string): OAuthScope[] | null {
  const parts = raw.split(' ').filter(Boolean);
  if (!parts.length || raw.length > 500 || !parts.every(isOAuthScope)) return null;
  // canonical order, no duplicates
  return OAUTH_SCOPES.filter((s) => parts.includes(s));
}

export const scopeString = (scopes: readonly string[]) => scopes.join(' ');
export const isSubset = (a: readonly string[], b: readonly string[]) => a.every((s) => b.includes(s));
export const intersect = (a: readonly string[], b: readonly string[]) => a.filter((s) => b.includes(s)) as OAuthScope[];

// ---------- redirect URIs ----------

const FORBIDDEN_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'about:', 'blob:', 'ftp:', 'ws:', 'wss:']);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Validates a redirect URI at registration. https everywhere; http only for loopback hosts (development);
 * custom schemes for native apps (`com.exemple.app:/callback`). No fragment, no wildcard, no credentials.
 * Returns an error message (French) or null.
 */
export function redirectUriError(raw: string): string | null {
  if (!raw || raw.length > 500) return 'URL trop longue ou vide';
  if (/[\s*]/.test(raw)) return 'Les espaces et les jokers (*) sont interdits';
  if (raw.includes('#')) return 'Le fragment (#…) est interdit';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'URL invalide';
  }
  if (u.username || u.password) return 'Les identifiants dans l’URL sont interdits';
  if (FORBIDDEN_SCHEMES.has(u.protocol)) return `Le schéma ${u.protocol} est interdit`;
  if (u.protocol === 'https:') return u.hostname ? null : 'Hôte manquant';
  if (u.protocol === 'http:') return LOOPBACK.has(u.hostname) ? null : 'http:// n’est autorisé que pour localhost / 127.0.0.1 (développement) : utilisez https://';
  // custom scheme (native app): RFC 8252 recommends a reverse domain name
  if (!/^[a-z][a-z0-9+.-]*:$/.test(u.protocol)) return 'Schéma invalide';
  return null;
}

/** Appends parameters to a (validated, registered) redirect URI, keeping its own query string. */
export function withParams(redirectUri: string, params: Record<string, string | null | undefined>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
  return u.toString();
}

// ---------- tokens ----------

export interface IssuedTokens {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

const inSeconds = (s: number) => new Date(Date.now() + s * 1000).toISOString();

/**
 * Issues an access token, plus a refresh token when `offline_access` is part of `refreshScopes`.
 * `scopes`: scopes of the access token; `refreshScopes`: scopes of the (new) refresh token (the original grant: a
 * refresh request with a narrower scope does not narrow the refresh token, RFC 6749 §6).
 */
export async function issueTokens(
  ex: Db,
  g: { clientId: number; userId: number; familyId: string; scopes: OAuthScope[]; refreshScopes?: OAuthScope[]; parentId?: number | null },
): Promise<IssuedTokens> {
  const access = newSecret(PREFIX.access);
  const refreshScopes = g.refreshScopes ?? g.scopes;
  const refresh = refreshScopes.includes('offline_access') ? newSecret(PREFIX.refresh) : null;
  const common = { family_id: g.familyId, client_id: g.clientId, user_id: g.userId, parent_id: g.parentId ?? null };
  await ex
    .insertInto('oauth_tokens')
    .values([
      { ...common, token_hash: access.hash, type: 'access', scopes: g.scopes, expires_at: inSeconds(ACCESS_TOKEN_TTL_S) },
      ...(refresh ? [{ ...common, token_hash: refresh.hash, type: 'refresh' as const, scopes: refreshScopes, expires_at: inSeconds(REFRESH_TOKEN_TTL_S) }] : []),
    ])
    .execute();
  return {
    access_token: access.value,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_S,
    ...(refresh ? { refresh_token: refresh.value } : {}),
    scope: scopeString(g.scopes),
  };
}

export async function revokeFamily(ex: Db, familyId: string) {
  await ex.updateTable('oauth_tokens').set({ revoked_at: sql`now()` }).where('family_id', '=', familyId).where('revoked_at', 'is', null).execute();
}

/** Revokes everything a user granted to a client: tokens, pending codes and the remembered consent. */
export function revokeGrant(userId: number, clientId: number, ex: Db = db) {
  return inTx(ex, async (trx) => {
    await trx
      .updateTable('oauth_tokens')
      .set({ revoked_at: sql`now()` })
      .where('user_id', '=', userId)
      .where('client_id', '=', clientId)
      .where('revoked_at', 'is', null)
      .execute();
    await trx.deleteFrom('oauth_codes').where('user_id', '=', userId).where('client_id', '=', clientId).execute();
    const r = await trx.deleteFrom('oauth_consents').where('user_id', '=', userId).where('client_id', '=', clientId).executeTakeFirst();
    return Number(r.numDeletedRows) > 0;
  });
}

/** Valid (not expired, not revoked) access token → grant. Effective scopes = token scopes ∩ client's current scopes. */
export async function findAccessToken(token: string) {
  if (!token.startsWith(PREFIX.access) || token.length > 200) return null;
  const row = await db
    .selectFrom('oauth_tokens as t')
    .innerJoin('oauth_clients as c', 'c.id', 't.client_id')
    .select(['t.id', 't.user_id', 't.client_id', 't.scopes', 't.expires_at', 't.last_used_at', 't.family_id', 'c.client_id as public_client_id', 'c.scopes as client_scopes'])
    .where('t.token_hash', '=', sha256(token))
    .where('t.type', '=', 'access')
    .where('t.revoked_at', 'is', null)
    .where('t.expires_at', '>', sql<string>`now()`)
    .executeTakeFirst();
  if (!row) return null;
  return { ...row, scopes: intersect(row.scopes, row.client_scopes) };
}

/** Records API usage (at most once a minute per token, so it doesn't write on every request). */
export async function touchToken(tokenId: number, userId: number, clientId: number) {
  const stale = sql<boolean>`last_used_at IS NULL OR last_used_at < now() - interval '1 minute'`;
  const r = await db.updateTable('oauth_tokens').set({ last_used_at: sql`now()` }).where('id', '=', tokenId).where(stale).executeTakeFirst();
  if (Number(r.numUpdatedRows)) {
    await db.updateTable('oauth_consents').set({ last_used_at: sql`now()` }).where('user_id', '=', userId).where('client_id', '=', clientId).execute();
  }
}

export const clientIsPublic = (c: Pick<OAuthClientRow, 'type'>) => c.type === 'public';

/** Removes expired authorization requests, codes and tokens (called periodically). */
export async function cleanupOAuth() {
  const hourAgo = sql<string>`now() - interval '1 hour'`;
  const dayAgo = sql<string>`now() - interval '1 day'`;
  await db.deleteFrom('oauth_authorization_requests').where('expires_at', '<', hourAgo).execute();
  // used codes are kept a day so a late replay is still detected (and revokes the tokens)
  await db.deleteFrom('oauth_codes').where('expires_at', '<', dayAgo).execute();
  // rotated refresh tokens are kept until they expire: presenting one again is detected as a reuse
  await db.deleteFrom('oauth_tokens').where('expires_at', '<', dayAgo).execute();
}
