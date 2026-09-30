/**
 * Scalo Enterprise Edition — Copyright (c) 2026 Scalo. All rights reserved.
 * Licensed under the Scalo Enterprise License (see ee/LICENSE): source-available, NOT open source.
 * Production use requires a valid Scalo Enterprise subscription and license key.
 */
// Entry point of the Enterprise web screens. Loaded by the core registry (web/src/lib/ee.ts) when this directory
// exists; nothing else in the core imports `ee/`.
import { BadgeCheck, ScrollText, Stamp, Users } from 'lucide-react';
import type { EeWebModule } from '../../../web/src/lib/ee';
import { AuditSection } from './AuditSection';
import { Banner } from './Banner';
import { BrandingSection } from './BrandingSection';
import { InvitePage } from './InvitePage';
import { LicenseSection } from './LicenseSection';
import { TeamSection } from './TeamSection';

const ee: EeWebModule = {
  publicRoutes: [{ path: '/invite/:token', element: <InvitePage /> }],
  settingsSections: [
    { id: 'equipe', label: 'Équipe', icon: Users, Component: TeamSection },
    { id: 'audit', label: 'Journal d’audit', icon: ScrollText, Component: AuditSection },
    { id: 'marque', label: 'Marque blanche', icon: Stamp, Component: BrandingSection },
    { id: 'licence', label: 'Licence', icon: BadgeCheck, Component: LicenseSection },
  ],
  Banner,
};

export default ee;
