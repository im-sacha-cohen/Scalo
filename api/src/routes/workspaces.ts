// Workspaces of the signed-in person (session JWT, under /api): list for the switcher, creation, renaming.
// The web app picks the workspace of each request with the X-Scalo-Workspace header (see workspace-access.ts);
// deleting a workspace is Paramètres → Données et compte, done while working in it (routes/account.ts).
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { WorkspaceList } from '@scalo/shared';
import { createWorkspace, listWorkspaces, renameWorkspace } from '../services/workspaces';
import { HttpError, paramId, uid } from '../util';

export const workspacesRouter = Router();

const nameSchema = z.object({ name: z.string().trim().min(1, 'Donnez un nom à l’espace').max(80) });
const person = (req: Request) => req.actorId ?? uid(req);

workspacesRouter.get('/workspaces', async (req, res) => {
  const current = { accountId: uid(req), role: req.role ?? 'owner' };
  const workspaces = await listWorkspaces(person(req), current);
  const out: WorkspaceList = { current: current.accountId, workspaces, can_create: workspaces.some((w) => w.personal) };
  res.setHeader('Cache-Control', 'no-store');
  res.json(out);
});

workspacesRouter.post('/workspaces', async (req, res) => {
  const { name } = nameSchema.parse(req.body);
  res.status(201).json(await createWorkspace(person(req), name));
});

workspacesRouter.patch('/workspaces/:id', async (req, res) => {
  const { name } = nameSchema.parse(req.body);
  const id = paramId(req.params.id, 'Espace de travail');
  if (req.role !== 'owner' && id === uid(req)) throw new HttpError(403, 'Seul le propriétaire peut renommer cet espace');
  res.json(await renameWorkspace(person(req), id, name));
});
