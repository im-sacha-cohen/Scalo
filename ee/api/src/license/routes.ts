/**
 * Scalo Enterprise Edition — Copyright (c) 2026 Scalo. All rights reserved.
 * Licensed under the Scalo Enterprise License (see ee/LICENSE): source-available, NOT open source.
 * Production use requires a valid Scalo Enterprise subscription and license key.
 */
// Paramètres → Licence: state of the license, and entering / removing the key from the interface.
// The license is per instance: only the instance administrator (the owner of the first account created) may change
// it from the interface; SCALO_LICENSE_KEY, when set, always wins and cannot be changed from here.
import { Router, type Request } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { db } from '../../../../api/src/db';
import { HttpError } from '../../../../api/src/util';
import { actorOf, roleOf } from '../common';
import { checkKey, licenseInfo, licenseState, removeLicenseKey, saveLicenseKey } from './service';

async function isInstanceAdmin(req: Request): Promise<boolean> {
  if (roleOf(req) !== 'owner') return false;
  const { rows } = await sql<{ id: number | null }>`
    SELECT min(u.id) AS id FROM users u WHERE NOT EXISTS (SELECT 1 FROM account_members m WHERE m.user_id = u.id)`.execute(db);
  return rows[0]?.id === actorOf(req);
}

async function requireManage(req: Request) {
  if (!(await isInstanceAdmin(req))) throw new HttpError(403, 'Seul l’administrateur de l’instance (le premier compte créé) peut modifier la licence');
  if (licenseState().source === 'env') throw new HttpError(409, 'La licence est fournie par la variable d’environnement SCALO_LICENSE_KEY : modifiez-la côté serveur');
}

export const licenseRouter = Router();

licenseRouter.get('/license', async (req, res) => {
  res.json(licenseInfo(await isInstanceAdmin(req)));
});

licenseRouter.put('/license', async (req, res) => {
  await requireManage(req);
  const { key } = z.object({ key: z.string().trim().min(1).max(4000) }).parse(req.body);
  const check = checkKey(key);
  if (!check.ok) throw new HttpError(400, `Clé de licence refusée : ${check.error}`);
  await saveLicenseKey(key, actorOf(req));
  res.json(licenseInfo(true));
});

licenseRouter.delete('/license', async (req, res) => {
  await requireManage(req);
  await removeLicenseKey();
  res.json(licenseInfo(true));
});
