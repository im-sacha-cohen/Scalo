/**
 * Scalo Enterprise Edition — Copyright (c) 2026 Scalo. All rights reserved.
 * Licensed under the Scalo Enterprise License (see ee/LICENSE): source-available, NOT open source.
 * Production use requires a valid Scalo Enterprise subscription and license key.
 */
// Test harness of the Enterprise edition: a key pair generated on the fly (never the production key), licenses
// signed with it and provided through SCALO_LICENSE_KEY (read at each check, so a test can switch license instantly).
import assert from 'node:assert/strict';
import { client, http, type TestCtx } from '../../../api/test/helpers';
import type { LicensePayload } from '../../shared/types';
import { generateKeyPair, signLicense } from '../src/license/format';
import { setTestPublicKeys } from '../src/license/keys';

delete process.env.SCALO_LICENSE_KEY; // never inherit a developer's key
delete process.env.SCALO_LICENSE_PUBLIC_KEY;
delete process.env.SCALO_DISABLE_EE;

export const testKeys = generateKeyPair();
setTestPublicKeys([testKeys.publicKey]);

const DAY = 86_400_000;
export const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();

export function issue(over: Partial<LicensePayload> = {}, privateKeyPem = testKeys.privateKeyPem): string {
  return signLicense(
    { v: 1, id: 'lic_test', customer: 'ACME Test', plan: 'enterprise', features: ['team', 'audit_log', 'white_label'], seats: 5, issued_at: inDays(-1), expires_at: inDays(365), ...over },
    privateKeyPem,
  );
}

/** Sets (or removes, with null) the instance license for the rest of the test. */
export function useLicense(over: Partial<LicensePayload> | null = {}) {
  if (over === null) delete process.env.SCALO_LICENSE_KEY;
  else process.env.SCALO_LICENSE_KEY = issue(over);
}

export type Api = ReturnType<typeof client>;

/** Invites `email` on the owner's account and accepts the invitation: returns the member's session. */
export async function addMember(ctx: TestCtx, owner: Api, role: 'admin' | 'editor' | 'viewer', email = `m${Date.now()}${Math.random().toString(36).slice(2, 8)}@team.test`) {
  const inv = await owner.post('/api/team/invitations', { email, role });
  assert.equal(inv.status, 201, inv.text);
  const token = String(inv.body.invite_url).split('/invite/')[1];
  const acc = await http(ctx, 'POST', `/api/invitations/${token}/accept`, { json: { name: `Membre ${role}`, password: 'motdepasse123' } });
  assert.equal(acc.status, 201, acc.text);
  return { email, token: acc.body.token as string, userId: acc.body.user.id as number, api: client(ctx, acc.body.token), inviteToken: token };
}
