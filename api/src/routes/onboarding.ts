// Onboarding of a new account (session-authenticated, mounted under /api):
//   GET /onboarding   state of the welcome flow + "Bien démarrer" checklist computed from the account's data
//   PUT /onboarding   goal, current step, funnel created, finish, skip, hide / reopen the checklist
import { Router } from 'express';
import { z } from 'zod';
import { ONBOARDING_GOALS, ONBOARDING_STEPS } from '@scalo/shared';
import { onboardingState, updateOnboarding } from '../services/onboarding';
import { HttpError, uid } from '../util';

const updateSchema = z.strictObject({
  goal: z.enum(ONBOARDING_GOALS).optional(),
  step: z.enum(ONBOARDING_STEPS).optional(),
  funnel_id: z.number().int().positive().optional(),
  complete: z.literal(true).optional(),
  skip: z.literal(true).optional(),
  checklist_hidden: z.boolean().optional(),
});

export const onboardingRouter = Router();

onboardingRouter.get('/onboarding', async (req, res) => {
  const accountId = uid(req);
  res.json(await onboardingState(accountId, { actorId: req.actorId ?? accountId, role: req.role ?? 'owner' }));
});

onboardingRouter.put('/onboarding', async (req, res) => {
  const accountId = uid(req);
  const actor = { actorId: req.actorId ?? accountId, role: req.role ?? 'owner' };
  const body = updateSchema.parse(req.body);
  // The welcome flow belongs to the account owner; a team member can only hide / reopen the checklist
  // (read-only members are already stopped by the generic role rule, see access.ts).
  if (actor.actorId !== accountId && Object.keys(body).some((k) => k !== 'checklist_hidden')) {
    throw new HttpError(403, 'Le parcours de bienvenue est réservé au propriétaire du compte');
  }
  await updateOnboarding(accountId, body);
  res.json(await onboardingState(accountId, actor));
});
