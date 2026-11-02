// Editions: the mount points of the optional Enterprise extension (api/src/ee.ts) and `GET /api/edition`.
// Community edition (no `ee/` directory, or SCALO_DISABLE_EE=1): every hook is a no-op and /api/edition answers
// `community` with the role `owner`.
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { NO_LICENSE, type EditionInfo } from '@scalo/shared';
import { db } from '../db';
import { ee, loadEe } from '../ee';
import { accountInfo } from '../services/workspaces';
import { HttpError, uid } from '../util';

/** Mounted under /api before authentication: loads the extension once, then its public routes (if any). */
export function editionPublicGate(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const ext = await loadEe();
    if (ext) return ext.publicRouter(req, res, next);
    next();
  };
}

/** Mounted under /api after requireAuth (which resolves the actor and enforces the roles): /edition + extension routes. */
export function editionGate(): RequestHandler[] {
  const router = Router();

  router.get('/edition', async (req, res) => {
    const accountId = uid(req);
    const actorId = req.actorId ?? accountId;
    const [acc, actor] = await Promise.all([accountInfo(accountId), db.selectFrom('users').select(['id', 'name', 'email']).where('id', '=', actorId).executeTakeFirst()]);
    if (!acc || !actor) throw new HttpError(401, 'Session invalide');
    const account = { id: acc.id, name: acc.name, email: acc.email };
    const ext = ee();
    const info: EditionInfo = {
      edition: ext ? 'enterprise' : 'community',
      license: NO_LICENSE,
      features: [],
      branding: null,
      ...(ext ? ext.edition(accountId) : {}),
      role: req.role ?? 'owner',
      actor,
      account,
    };
    res.json(info);
  });

  return [
    router,
    (req, res, next) => {
      const ext = ee();
      if (ext) return ext.router(req, res, next);
      next();
    },
  ];
}
