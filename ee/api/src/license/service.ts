/**
 * Scalo Enterprise Edition — Copyright (c) 2026 Scalo. All rights reserved.
 * Licensed under the Scalo Enterprise License (see ee/LICENSE): source-available, NOT open source.
 * Production use requires a valid Scalo Enterprise subscription and license key.
 */
// License service: where the key comes from (SCALO_LICENSE_KEY, else the key saved from Paramètres → Licence),
// its state, and `license.has('feature')`.
//
// The state is kept in memory so `has()` is synchronous and free: verified once per key, re-evaluated against the
// clock on each call, reloaded from the database on write and every minute (other API instances).
//
// A missing, invalid or expired license only turns the Enterprise features off. It never blocks the core or the data.
import type { LicenseStatus, LicenseSummary } from '@scalo/shared';
import { db } from '../../../../api/src/db';
import '../../../../api/src/env';
import type { EnterpriseFeature, LicenseInfo, LicensePayload } from '../../../shared/types';
import { validity, verifyLicense, type VerifyResult } from './format';
import { trustedPublicKeys } from './keys';

let dbKey: string | null = null;
let cache: { key: string; keys: string; result: VerifyResult } | null = null;

const envKey = () => (process.env.SCALO_LICENSE_KEY ?? '').trim() || null;

/** Reads the key saved from the interface. Called at startup, after a write, and periodically. */
export async function refreshLicense() {
  const row = await db.selectFrom('instance_license').select('license_key').executeTakeFirst();
  dbKey = row?.license_key ?? null;
}

function current(): { key: string; source: 'env' | 'database' } | null {
  const e = envKey();
  if (e) return { key: e, source: 'env' };
  return dbKey ? { key: dbKey, source: 'database' } : null;
}

function verified(key: string): VerifyResult {
  const keys = trustedPublicKeys();
  const fp = keys.join(',');
  if (cache && cache.key === key && cache.keys === fp) return cache.result;
  const result = verifyLicense(key, keys);
  cache = { key, keys: fp, result };
  return result;
}

export interface LicenseState {
  status: LicenseStatus;
  source: 'env' | 'database' | null;
  payload: LicensePayload | null;
  graceUntil: string | null;
  daysLeft: number | null;
  error: string | null;
}

export function licenseState(now = Date.now()): LicenseState {
  const cur = current();
  if (!cur) return { status: 'none', source: null, payload: null, graceUntil: null, daysLeft: null, error: null };
  const res = verified(cur.key);
  if (!res.ok) return { status: 'invalid', source: cur.source, payload: null, graceUntil: null, daysLeft: null, error: res.error };
  const v = validity(res.payload, now);
  return { status: v.status, source: cur.source, payload: res.payload, graceUntil: v.graceUntil, daysLeft: v.daysLeft, error: null };
}

/** Features usable right now: license valid, or expired for less than the grace period. */
export function activeFeatures(): string[] {
  const s = licenseState();
  return s.payload && (s.status === 'valid' || s.status === 'grace') ? s.payload.features : [];
}

export const license = {
  has: (feature: EnterpriseFeature): boolean => activeFeatures().includes(feature),
  /** Seats per account (owner included); 0 without an active license. */
  seats: (): number => {
    const s = licenseState();
    return s.payload && (s.status === 'valid' || s.status === 'grace') ? s.payload.seats : 0;
  },
  state: licenseState,
};

export function licenseSummary(): LicenseSummary {
  const s = licenseState();
  return {
    status: s.status,
    plan: s.payload?.plan ?? null,
    features: s.payload?.features ?? [],
    seats: s.payload?.seats ?? null,
    expires_at: s.payload?.expires_at ?? null,
    grace_until: s.graceUntil,
  };
}

export function licenseInfo(canManage: boolean): LicenseInfo {
  const s = licenseState();
  return {
    status: s.status,
    source: s.source,
    id: s.payload?.id ?? null,
    customer: s.payload?.customer ?? null,
    plan: s.payload?.plan ?? null,
    features: s.payload?.features ?? [],
    seats: s.payload?.seats ?? null,
    issued_at: s.payload?.issued_at ?? null,
    expires_at: s.payload?.expires_at ?? null,
    grace_until: s.graceUntil,
    days_left: s.daysLeft,
    error: s.error,
    can_manage: canManage && s.source !== 'env',
  };
}

/** Checks a key without saving it. */
export const checkKey = (key: string) => verifyLicense(key, trustedPublicKeys());

export async function saveLicenseKey(key: string, userId: number) {
  await db
    .insertInto('instance_license')
    .values({ id: true, license_key: key, updated_by: userId, updated_at: new Date().toISOString() })
    .onConflict((oc) => oc.column('id').doUpdateSet({ license_key: key, updated_by: userId, updated_at: new Date().toISOString() }))
    .execute();
  dbKey = key;
}

export async function removeLicenseKey() {
  await db.deleteFrom('instance_license').execute();
  dbKey = null;
}
