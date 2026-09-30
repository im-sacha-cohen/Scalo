/**
 * Scalo Enterprise Edition — Copyright (c) 2026 Scalo. All rights reserved.
 * Licensed under the Scalo Enterprise License (see ee/LICENSE): source-available, NOT open source.
 * Production use requires a valid Scalo Enterprise subscription and license key.
 */
// Entry point of the Enterprise API. Loaded dynamically by the core (api/src/ee.ts) when this directory exists;
// nothing else in the core imports `ee/`.
import { Router } from 'express';
import type { EeApi } from '../../../api/src/ee';
import { auditIdle, auditRequest, auditRouter, purgeAuditLogs } from './audit';
import { adminBranding, brandingRouter, poweredBy, refreshBranding } from './branding';
import { licenseRouter } from './license/routes';
import { activeFeatures, licenseSummary, refreshLicense } from './license/service';
import { purgeInvitations, resolveActor, teamPublicRouter, teamRouter } from './team';

/** Reloads what is kept in memory (license key saved from the interface, white label). */
export async function refreshEe() {
  await Promise.all([refreshLicense(), refreshBranding()]);
}

export async function register(): Promise<EeApi> {
  await refreshEe();
  // other API instances may have changed the key / the branding: eventual consistency within a minute
  setInterval(() => void refreshEe().catch(() => undefined), 60_000).unref();

  const router = Router();
  router.use(licenseRouter, teamRouter, auditRouter, brandingRouter);

  return {
    resolveActor,
    publicRouter: teamPublicRouter,
    router,
    onRequest: auditRequest,
    poweredBy,
    edition: (accountId) => ({ license: licenseSummary(), features: activeFeatures(), branding: adminBranding(accountId) }),
    cleanup: async () => {
      await auditIdle();
      await Promise.all([purgeAuditLogs(), purgeInvitations()]);
    },
  };
}
