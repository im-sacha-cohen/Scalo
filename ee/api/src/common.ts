/**
 * Scalo Enterprise Edition — Copyright (c) 2026 Scalo. All rights reserved.
 * Licensed under the Scalo Enterprise License (see ee/LICENSE): source-available, NOT open source.
 * Production use requires a valid Scalo Enterprise subscription and license key.
 */
import type { Request } from 'express';
import type { AccountRole } from '@scalo/shared';
import { HttpError } from '../../../api/src/util';
import { FEATURE_LABELS, type EnterpriseFeature } from '../../shared/types';
import { license } from './license/service';

/** 402: the feature exists but the instance has no (valid) license for it. The web app shows the Enterprise screen. */
export function requireFeature(feature: EnterpriseFeature) {
  if (!license.has(feature)) {
    throw new HttpError(402, `« ${FEATURE_LABELS[feature]} » est une fonction de l’édition Entreprise : une licence valide est nécessaire`);
  }
}

export const roleOf = (req: Request): AccountRole => req.role ?? 'owner';

/** Owner or administrator of the account. */
export function requireAdmin(req: Request) {
  const role = roleOf(req);
  if (role !== 'owner' && role !== 'admin') throw new HttpError(403, 'Action réservée au propriétaire et aux administrateurs du compte');
}

export const actorOf = (req: Request): number => req.actorId ?? req.userId ?? 0;
