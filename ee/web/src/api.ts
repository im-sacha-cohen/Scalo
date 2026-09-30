/**
 * Scalo Enterprise Edition — Copyright (c) 2026 Scalo. All rights reserved.
 * Licensed under the Scalo Enterprise License (see ee/LICENSE): source-available, NOT open source.
 * Production use requires a valid Scalo Enterprise subscription and license key.
 */
// Client of the Enterprise API (same fetch wrapper and session as the core).
import { rawRequest, request } from '../../../web/src/lib/api';
import type { AuditLogEntry, Branding, InvitationCreated, InvitationPreview, LicenseInfo, MemberRole, Team } from '../../shared/types';

type Ok = { ok: true };
const qs = (p: Record<string, string | number | undefined>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
};

export const eeApi = {
  license: () => request<LicenseInfo>('GET', '/license'),
  saveLicense: (key: string) => request<LicenseInfo>('PUT', '/license', { key }),
  removeLicense: () => request<LicenseInfo>('DELETE', '/license'),

  team: () => request<Team>('GET', '/team'),
  invite: (email: string, role: MemberRole) => request<InvitationCreated>('POST', '/team/invitations', { email, role }),
  resendInvitation: (id: number) => request<InvitationCreated>('POST', `/team/invitations/${id}/resend`),
  revokeInvitation: (id: number) => request<Ok>('DELETE', `/team/invitations/${id}`),
  setMemberRole: (id: number, role: MemberRole) => request<Ok>('PATCH', `/team/members/${id}`, { role }),
  removeMember: (id: number) => request<Ok>('DELETE', `/team/members/${id}`),
  invitation: (token: string) => request<InvitationPreview>('GET', `/invitations/${encodeURIComponent(token)}`),
  acceptInvitation: (token: string, b: { name: string; password: string }) =>
    request<{ token: string }>('POST', `/invitations/${encodeURIComponent(token)}/accept`, b),

  audit: (p: { page?: number; limit?: number; search?: string }) => request<{ items: AuditLogEntry[]; total: number; retention_days: number }>('GET', `/audit${qs(p)}`),
  exportAudit: async (search?: string) => (await rawRequest('GET', `/audit/export${qs({ search })}`)).blob(),
  saveAuditRetention: (retention_days: number) => request<{ retention_days: number; purged: number }>('PUT', '/audit/settings', { retention_days }),

  branding: () => request<Branding>('GET', '/branding'),
  saveBranding: (b: Omit<Branding, 'active'>) => request<Branding>('PUT', '/branding', b),
};
