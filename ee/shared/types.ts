/**
 * Scalo Enterprise Edition — Copyright (c) 2026 Scalo. All rights reserved.
 * Licensed under the Scalo Enterprise License (see ee/LICENSE): source-available, NOT open source.
 * Production use requires a valid Scalo Enterprise subscription and license key.
 */
// Wire types of the Enterprise API, shared by ee/api and ee/web.
import type { LicenseStatus } from '@scalo/shared';

export type MemberRole = 'admin' | 'editor' | 'viewer';
export const MEMBER_ROLES: MemberRole[] = ['admin', 'editor', 'viewer'];

/** Features a license key can enable. */
export const ENTERPRISE_FEATURES = ['team', 'audit_log', 'white_label'] as const;
export type EnterpriseFeature = (typeof ENTERPRISE_FEATURES)[number];

export const FEATURE_LABELS: Record<EnterpriseFeature, string> = {
  team: 'Équipe et rôles',
  audit_log: 'Journal d’audit',
  white_label: 'Marque blanche',
};

/** Signed payload of a license key. */
export interface LicensePayload {
  v: 1;
  /** Unique id of the key (support, revocation lists). */
  id: string;
  customer: string;
  plan: string;
  features: string[];
  /** People per account, owner included. */
  seats: number;
  issued_at: string;
  expires_at: string;
}

/** `GET /api/license` */
export interface LicenseInfo {
  status: LicenseStatus;
  /** Where the key comes from: SCALO_LICENSE_KEY or Paramètres → Licence. */
  source: 'env' | 'database' | null;
  id: string | null;
  customer: string | null;
  plan: string | null;
  features: string[];
  seats: number | null;
  issued_at: string | null;
  expires_at: string | null;
  grace_until: string | null;
  /** Days before expiration (negative once expired). */
  days_left: number | null;
  /** Why the key is refused (status `invalid`). */
  error: string | null;
  /** The signed-in person may enter / remove the key from the interface. */
  can_manage: boolean;
}

export interface TeamMember {
  id: number;
  user_id: number;
  name: string;
  email: string;
  role: MemberRole;
  created_at: string;
}

export interface TeamInvitation {
  id: number;
  email: string;
  role: MemberRole;
  expires_at: string;
  expired: boolean;
  created_at: string;
}

/** `GET /api/team` */
export interface Team {
  owner: { id: number; name: string; email: string };
  members: TeamMember[];
  invitations: TeamInvitation[];
  seats: { used: number; limit: number };
}

/** `POST /api/team/invitations` — the link is only returned here (the token is stored hashed). */
export interface InvitationCreated {
  invitation: TeamInvitation;
  invite_url: string;
  email_sent: boolean;
}

/** `GET /api/invitations/:token` (public) */
export interface InvitationPreview {
  email: string;
  role: MemberRole;
  account_name: string;
  expires_at: string;
}

export interface AuditLogEntry {
  id: number;
  actor_id: number | null;
  actor_email: string;
  actor_role: string;
  action: string;
  method: string;
  path: string;
  resource_type: string;
  resource_id: string | null;
  status: number;
  ip: string;
  created_at: string;
}

/** `GET/PUT /api/branding` */
export interface Branding {
  hide_powered_by: boolean;
  powered_by_text: string;
  powered_by_url: string;
  app_name: string;
  logo_url: string;
  /** false: the values are stored but not applied (no `white_label` license). */
  active: boolean;
}
