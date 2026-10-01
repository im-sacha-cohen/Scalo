// Host routing for custom domains. Mounted first in app.ts: requests for the app's own hosts go on to the app; a
// verified custom domain serves its funnel (`/`, `/<step>`, form posts, media library images) and nothing else;
// any other host gets a 404 page — never the app, the API or another funnel.
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { db } from '../db';
import { isAppHost } from '../services/domains';
import { readFunnelSettings } from '../services/tracking';
import { consentStep, notFoundPage, resolveIn, sendSimple, submitStep, unlockStep, viewStep, type FunnelRow } from './public';
import { serveUpload } from './uploads';
import { checkoutStep, paidStep, payPage, payStep, upsellStep } from './payments-public';

interface Served { funnel: FunnelRow; rootStepId: number | null }

async function servedDomain(host: string): Promise<Served | null> {
  const row = await db
    .selectFrom('custom_domains as d')
    .innerJoin('funnels as f', 'f.id', 'd.funnel_id')
    .select(['f.id', 'f.user_id', 'f.name', 'f.slug', 'f.settings', 'd.root_step_id'])
    .where('d.domain', '=', host)
    .where('d.status', '=', 'verified')
    .executeTakeFirst();
  if (!row) return null;
  const { root_step_id, ...f } = row;
  return { funnel: { ...f, settings: readFunnelSettings(f.settings), base: '' }, rootStepId: root_step_id };
}

const unknownHost = (res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  sendSimple(res, notFoundPage());
};

const served = (res: Response) => res.locals.customDomain as Served;

/** Routes of a custom domain (the funnel is at the root of the domain). */
const domainRouter = Router();
domainRouter.get('/uploads/:userId/:file', serveUpload);
domainRouter.get('/', async (req, res) => {
  const d = served(res);
  const r = await resolveIn(d.funnel, null, d.rootStepId);
  if (!r) return unknownHost(res);
  await viewStep(req, res, r);
});
domainRouter.get('/:stepSlug', async (req, res) => {
  const r = await resolveIn(served(res).funnel, String(req.params.stepSlug));
  if (!r) return unknownHost(res);
  await viewStep(req, res, r);
});
domainRouter.post('/:stepSlug/submit', async (req, res) => {
  const r = await resolveIn(served(res).funnel, String(req.params.stepSlug));
  if (!r) return unknownHost(res);
  await submitStep(req, res, r);
});
domainRouter.post('/:stepSlug/unlock', async (req, res) => {
  const r = await resolveIn(served(res).funnel, String(req.params.stepSlug));
  if (!r) return unknownHost(res);
  await unlockStep(req, res, r);
});
domainRouter.post('/:stepSlug/consent', async (req, res) => {
  const r = await resolveIn(served(res).funnel, String(req.params.stepSlug));
  if (!r) return unknownHost(res);
  consentStep(req, res, r);
});
// payments: order form, payment page, return after the payment, one-click offer (routes/payments-public.ts)
domainRouter.post('/:stepSlug/checkout', async (req, res) => {
  const r = await resolveIn(served(res).funnel, String(req.params.stepSlug));
  if (!r) return unknownHost(res);
  await checkoutStep(req, res, r);
});
domainRouter.post('/:stepSlug/pay', async (req, res) => {
  const r = await resolveIn(served(res).funnel, String(req.params.stepSlug));
  if (!r) return res.status(404).json({ error: 'Page introuvable' });
  await payStep(req, res, r);
});
domainRouter.get('/:stepSlug/pay', async (req, res) => {
  const r = await resolveIn(served(res).funnel, String(req.params.stepSlug));
  if (!r) return unknownHost(res);
  await payPage(req, res, r);
});
domainRouter.get('/:stepSlug/paid', async (req, res) => {
  const r = await resolveIn(served(res).funnel, String(req.params.stepSlug));
  if (!r) return unknownHost(res);
  await paidStep(req, res, r);
});
domainRouter.post('/:stepSlug/upsell', async (req, res) => {
  const r = await resolveIn(served(res).funnel, String(req.params.stepSlug));
  if (!r) return unknownHost(res);
  await upsellStep(req, res, r);
});

export function customDomainMiddleware(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Express: Host header (X-Forwarded-Host only with TRUST_PROXY), without the port. Untrusted: only compared.
    const host = (req.hostname ?? '').toLowerCase().replace(/\.$/, '');
    if (!host || isAppHost(host)) return next();
    try {
      const d = await servedDomain(host);
      if (!d) return unknownHost(res);
      res.locals.customDomain = d;
      domainRouter(req, res, (err?: unknown) => {
        if (err) return next(err);
        unknownHost(res); // nothing else exists on a custom domain
      });
    } catch (e) {
      next(e);
    }
  };
}
