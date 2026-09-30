/**
 * Scalo Enterprise Edition — Copyright (c) 2026 Scalo. All rights reserved.
 * Licensed under the Scalo Enterprise License (see ee/LICENSE): source-available, NOT open source.
 * Production use requires a valid Scalo Enterprise subscription and license key.
 */
// License key format — pure functions (no database, no environment), shared by the API and the issuing CLI.
//
//   scalo_lic_<base64url(JSON payload)>.<base64url(Ed25519 signature)>
//
// The signature covers `scalo-license-v1:` + the base64url payload segment (exact bytes of the key: no JSON
// canonicalization issue). Verification is offline: only the public key is needed.
import crypto from 'node:crypto';
import type { LicensePayload } from '../../../shared/types';

export const LICENSE_PREFIX = 'scalo_lic_';
const SIGN_CONTEXT = 'scalo-license-v1:';
/** Days the Enterprise features keep working after `expires_at`. */
export const GRACE_DAYS = 14;
const DAY = 86_400_000;

// DER prefixes of a raw 32-byte Ed25519 key (RFC 8410)
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Public key: base64url of the 32 raw bytes (what `issue-license.ts keygen` prints), or a PEM. */
export function importPublicKey(key: string): crypto.KeyObject {
  const k = key.trim();
  if (k.includes('BEGIN')) return crypto.createPublicKey(k);
  const raw = Buffer.from(k, 'base64url');
  if (raw.length !== 32) throw new Error('Clé publique Ed25519 invalide (32 octets attendus)');
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

export function exportPublicKey(key: crypto.KeyObject): string {
  const der = key.export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32).toString('base64url');
}

export function generateKeyPair(): { publicKey: string; privateKeyPem: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { publicKey: exportPublicKey(publicKey), privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() };
}

export function signLicense(payload: LicensePayload, privateKeyPem: string | crypto.KeyObject): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const key = typeof privateKeyPem === 'string' ? crypto.createPrivateKey(privateKeyPem) : privateKeyPem;
  const sig = crypto.sign(null, Buffer.from(SIGN_CONTEXT + body), key).toString('base64url');
  return `${LICENSE_PREFIX}${body}.${sig}`;
}

export type VerifyResult = { ok: true; payload: LicensePayload } | { ok: false; error: string };

const isIsoDate = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));

function parsePayload(json: string): LicensePayload | null {
  let p: unknown;
  try {
    p = JSON.parse(json);
  } catch {
    return null;
  }
  const o = p as Partial<LicensePayload> | null;
  if (!o || typeof o !== 'object' || o.v !== 1) return null;
  if (typeof o.id !== 'string' || typeof o.customer !== 'string' || typeof o.plan !== 'string') return null;
  if (!Array.isArray(o.features) || !o.features.every((f) => typeof f === 'string')) return null;
  if (typeof o.seats !== 'number' || !Number.isSafeInteger(o.seats) || o.seats < 1) return null;
  if (!isIsoDate(o.issued_at) || !isIsoDate(o.expires_at)) return null;
  return { v: 1, id: o.id, customer: o.customer, plan: o.plan, features: o.features, seats: o.seats, issued_at: o.issued_at, expires_at: o.expires_at };
}

/** Checks the format and the signature against any of the trusted public keys. Expiration is NOT checked here. */
export function verifyLicense(key: string, publicKeys: string[]): VerifyResult {
  const k = key.trim();
  if (!k.startsWith(LICENSE_PREFIX)) return { ok: false, error: 'Format de clé inconnu' };
  const parts = k.slice(LICENSE_PREFIX.length).split('.');
  if (parts.length !== 2 || !/^[\w-]+$/.test(parts[0]) || !/^[\w-]+$/.test(parts[1])) return { ok: false, error: 'Clé de licence mal formée' };
  const [body, sig] = parts;
  const signature = Buffer.from(sig, 'base64url');
  if (signature.length !== 64) return { ok: false, error: 'Signature invalide' };
  if (!publicKeys.length) return { ok: false, error: 'Aucune clé publique de vérification n’est configurée sur cette instance' };
  const data = Buffer.from(SIGN_CONTEXT + body);
  const trusted = publicKeys.some((pk) => {
    try {
      return crypto.verify(null, data, importPublicKey(pk), signature);
    } catch {
      return false;
    }
  });
  if (!trusted) return { ok: false, error: 'Signature invalide : cette clé n’a pas été émise par Scalo ou a été modifiée' };
  const payload = parsePayload(Buffer.from(body, 'base64url').toString('utf8'));
  if (!payload) return { ok: false, error: 'Contenu de la licence illisible' };
  return { ok: true, payload };
}

export type Validity = 'valid' | 'grace' | 'expired';

/** Where a (signed) license stands at `now`. */
export function validity(payload: Pick<LicensePayload, 'expires_at'>, now = Date.now()): { status: Validity; graceUntil: string; daysLeft: number } {
  const exp = Date.parse(payload.expires_at);
  const graceEnd = exp + GRACE_DAYS * DAY;
  const status: Validity = now < exp ? 'valid' : now < graceEnd ? 'grace' : 'expired';
  return { status, graceUntil: new Date(graceEnd).toISOString(), daysLeft: Math.ceil((exp - now) / DAY) };
}
