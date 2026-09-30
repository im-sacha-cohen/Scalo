// DB-backed brute-force protection (fixed windows in `auth_attempts`), shared by every API instance.
// Each call is a single atomic upsert, so concurrent requests can never slip past a limit.
import type { Response } from 'express';
import { sql } from 'kysely';
import { db } from '../db';
import { HttpError } from '../util';

export interface Limit {
  /** Attempts allowed per window. */
  max: number;
  windowMs: number;
}

const MIN15 = 15 * 60_000;

/** Limits used by the auth routes, the protected-step password form, the OAuth endpoints and the public API. */
export const LIMITS = {
  /** failed password logins per email */
  loginEmail: { max: 5, windowMs: MIN15 },
  /** failed password logins per IP (all emails) */
  loginIp: { max: 20, windowMs: MIN15 },
  /** account creations (attempts) per IP */
  registerIp: { max: 20, windowMs: MIN15 },
  /** step password attempts per IP and step */
  stepPassword: { max: 10, windowMs: MIN15 },
  /** OAuth token / revocation endpoint calls per client_id and IP */
  oauthToken: { max: 60, windowMs: 60_000 },
  /** OAuth introspection calls per client_id and IP */
  oauthIntrospect: { max: 300, windowMs: 60_000 },
  /** public API (/api/v1) requests per authorization (application + account) */
  apiV1: { max: 120, windowMs: 60_000 },
} satisfies Record<string, Limit>;

export interface HitResult {
  count: number;
  blocked: boolean;
  /** Seconds until the window resets. */
  retryAfter: number;
}

/**
 * Counts one attempt for `key` and tells whether it exceeds the limit. The window starts at the first attempt and
 * resets once expired.
 */
export async function hit(key: string, limit: Limit): Promise<HitResult> {
  const secs = limit.windowMs / 1000;
  const expired = sql<boolean>`auth_attempts.window_start <= now() - make_interval(secs => ${secs})`;
  const row = await db
    .insertInto('auth_attempts')
    .values({ key, count: 1, window_start: sql`now()` })
    .onConflict((oc) =>
      oc.column('key').doUpdateSet({
        count: sql`CASE WHEN ${expired} THEN 1 ELSE auth_attempts.count + 1 END`,
        window_start: sql`CASE WHEN ${expired} THEN now() ELSE auth_attempts.window_start END`,
      }),
    )
    .returning(['count', sql<number>`GREATEST(1, CEIL(EXTRACT(EPOCH FROM (window_start + make_interval(secs => ${secs}) - now()))))::int`.as('retry_after')])
    .executeTakeFirstOrThrow();
  return { count: row.count, blocked: row.count > limit.max, retryAfter: row.retry_after };
}

/** Gives back one attempt (e.g. a successful login does not count against the IP). */
export async function refund(key: string) {
  await db.updateTable('auth_attempts').set({ count: sql`GREATEST(count - 1, 0)` }).where('key', '=', key).execute();
}

export async function clear(key: string) {
  await db.deleteFrom('auth_attempts').where('key', '=', key).execute();
}

export const TOO_MANY = 'Trop de tentatives. Réessayez dans quelques minutes.';

export function tooManyError(res: Response, retryAfter: number, message = TOO_MANY): HttpError {
  res.setHeader('Retry-After', String(retryAfter));
  const minutes = Math.max(1, Math.ceil(retryAfter / 60));
  return new HttpError(429, message.replace('quelques minutes', minutes > 1 ? `${minutes} minutes` : '1 minute'));
}

/** Counts the attempt and throws a 429 (with Retry-After) when any of the limits is exceeded. */
export async function enforce(res: Response, checks: [key: string, limit: Limit][]) {
  const results = await Promise.all(checks.map(([k, l]) => hit(k, l)));
  const blocked = results.filter((r) => r.blocked);
  if (blocked.length) throw tooManyError(res, Math.max(...blocked.map((r) => r.retryAfter)));
}

/** Removes expired counters (called periodically). */
export async function cleanupAttempts() {
  await db.deleteFrom('auth_attempts').where('window_start', '<', sql<string>`now() - interval '1 day'`).execute();
}
