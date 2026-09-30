/**
 * Scalo Enterprise Edition — Copyright (c) 2026 Scalo. All rights reserved.
 * Licensed under the Scalo Enterprise License (see ee/LICENSE): source-available, NOT open source.
 * Production use requires a valid Scalo Enterprise subscription and license key.
 */
// Public keys trusted to verify license keys (Ed25519, offline). The matching private keys NEVER live in this
// repository: they are generated and kept by Scalo (`npx tsx ee/scripts/issue-license.ts keygen`).

/**
 * TODO(production): paste here the public key printed by `issue-license.ts keygen` (base64url, 43 characters)
 * before the first commercial release. Several keys = key rotation (a license is accepted if ANY key verifies it).
 * While this list is empty, no license key can be valid in production.
 */
export const PRODUCTION_PUBLIC_KEYS: string[] = [
  // 'REPLACE_WITH_PRODUCTION_PUBLIC_KEY',
];

let testKeys: string[] | null = null;

/** Tests only: trust a key pair generated on the fly. Ignored in production. */
export function setTestPublicKeys(keys: string[] | null) {
  if (process.env.NODE_ENV === 'production') return;
  testKeys = keys;
}

/**
 * Keys used for verification. Outside production (development, tests — the uses allowed without a subscription by
 * ee/LICENSE), `SCALO_LICENSE_PUBLIC_KEY` adds a development key so a locally issued license can be tried.
 * In production only the embedded keys count: the variable is ignored.
 */
export function trustedPublicKeys(): string[] {
  if (process.env.NODE_ENV === 'production') return PRODUCTION_PUBLIC_KEYS;
  const dev = (process.env.SCALO_LICENSE_PUBLIC_KEY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return [...PRODUCTION_PUBLIC_KEYS, ...dev, ...(testKeys ?? [])];
}
