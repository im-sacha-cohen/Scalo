import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import { sql } from 'kysely';
import { ZodError } from 'zod';
import { db, pgCode } from './db';
import { createAuthRouter } from './routes/auth';
import { env } from './env';
import { createOAuthRouter } from './routes/oauth';
import { oauthAccountRouter } from './routes/oauth-account';
import { createV1Router } from './routes/v1';
import { contactsRouter } from './routes/contacts';
import { tagsRouter } from './routes/tags';
import { funnelsRouter } from './routes/funnels';
import { emailsRouter } from './routes/emails';
import { createSettingsRouter } from './routes/settings';
import { createWebhooksRouter } from './routes/webhooks';
import type { DnsResolver } from './services/dns';
import { dashboardRouter } from './routes/dashboard';
import { publicRouter } from './routes/public';
import { customDomainMiddleware } from './routes/custom-domain';
import { createGrowthPublicRouter, createGrowthRouter } from './routes/growth';
import { serveUpload, uploadsRouter } from './routes/uploads';
import { crmRouter } from './routes/crm';
import { automationsRouter, hooksRouter } from './routes/automations';
import { paymentsRouter } from './routes/payments';
import { paymentsPublicRouter } from './routes/payments-public';
import { setStripeFactory, type StripeFactory } from './services/stripe';
import { coursesRouter } from './routes/courses';
import { membersRouter } from './routes/members';
import { importsRouter } from './routes/imports';
import { affiliatesRouter } from './routes/affiliates';
import { affiliateSpaceRouter } from './routes/affiliate-space';
import { HttpError, requireAuth } from './util';
import { createAiRouter } from './routes/ai';
import { createMcpRouter } from './routes/mcp';
import type { AiOptions } from './services/ai';
import { editionGate, editionPublicGate } from './routes/edition';
import { createSpaRouter } from './routes/spa';
import { onboardingRouter } from './routes/onboarding';
import { createAccountRouter } from './routes/account';
import type { DeletionOptions } from './services/account';

/** Postgres errors that reach the error handler (the routes handle the expected ones with specific messages). */
function pgErrorStatus(e: unknown): { status: number; error: string } | null {
  const code = pgCode(e);
  if (!code) {
    const msg = (e as { message?: string })?.message ?? '';
    if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'].includes((e as { code?: string })?.code ?? '') || /timeout exceeded when trying to connect|Connection terminated/i.test(msg)) {
      return { status: 503, error: 'Base de données indisponible, réessayez dans un instant' };
    }
    return null;
  }
  if (code === '23505') return { status: 409, error: 'Cette ressource existe déjà' };
  if (code === '23503') return { status: 404, error: 'Ressource liée introuvable' };
  if (code === '23514' || code === '23502' || code === '22P02' || code === '22003' || code === '22001') return { status: 400, error: 'Données invalides' };
  if (code === '40001' || code === '40P01') return { status: 409, error: 'Conflit de mise à jour, réessayez' };
  if (code === '57014') return { status: 503, error: 'La requête a pris trop de temps' };
  if (code.startsWith('08') || code === '57P01' || code === '53300') return { status: 503, error: 'Base de données indisponible, réessayez dans un instant' };
  return null;
}

export interface AppOptions {
  /** DNS resolver of the sender-domain check (tests inject a fake one). */
  dns?: DnsResolver;
  /** fetch used by webhooks (SNS subscription confirmation); tests inject a mock. */
  fetch?: typeof fetch;
  /** Payments: builds the Stripe client of an account from its secret key (tests inject a fake one: no network). */
  stripe?: StripeFactory;
  /** AI: Claude API transport, instance key, rate limit (tests inject a fake transport: no network). */
  ai?: AiOptions;
  /** Built web app served by the API (routes/spa.ts). Default: WEB_DIST, or `web/dist` in production. null: never. */
  webDist?: string | null;
  /** Account deletions: how long to wait for the emails being delivered (tests use a short delay). */
  account?: DeletionOptions;
}

export function createApp(opts: AppOptions = {}) {
  const app = express();
  app.disable('x-powered-by');
  // req.ip (rate limits) — only trust X-Forwarded-For when explicitly configured (TRUST_PROXY).
  app.set('trust proxy', env.TRUST_PROXY);
  // Stripe webhooks are verified on their raw body: read it as a Buffer before the JSON parser
  app.use('/api/payments/webhook', express.raw({ type: () => true, limit: '1mb' }));
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(cookieParser());
  // Host routing: verified custom domains serve their funnel; unknown hosts never reach the app or the API.
  app.use(customDomainMiddleware());

  app.get('/api/health', async (_req, res) => {
    try {
      await sql`select 1`.execute(db);
      res.json({ ok: true, db: 'up' });
    } catch {
      res.status(503).json({ ok: false, db: 'down' });
    }
  });
  // editions: loads the optional Enterprise extension (api/src/ee.ts) and mounts its public routes — no-op without ee/
  app.use('/api', editionPublicGate());
  app.use('/api/auth', createAuthRouter());
  app.use('/api/webhooks', createWebhooksRouter({ fetch: opts.fetch }));
  // automations: incoming webhooks (public, secret URL)
  app.use('/api/hooks', hooksRouter);
  // payments, public: Stripe webhook of each account (signed), order forms and one-click offers of funnel steps
  setStripeFactory(opts.stripe);
  app.use(paymentsPublicRouter);
  // public API for third-party apps (OAuth access tokens), before the session-authenticated routes
  app.use('/api/v1', createV1Router());
  // native AI (Claude API): key, generations, usage log
  app.use('/api/ai', requireAuth, createAiRouter(opts.ai));
  // funnels growth, public: TLS on-demand check (/api/domains/allowed), shared funnel preview (/api/share/:token)
  app.use('/api', createGrowthPublicRouter());
  app.use(
    '/api',
    requireAuth,
    ...editionGate(), // GET /edition + Enterprise routes (team, audit log, white label, license)
    createGrowthRouter({ dns: opts.dns }),
    contactsRouter,
    tagsRouter,
    funnelsRouter,
    emailsRouter,
    createSettingsRouter({ dns: opts.dns }),
    dashboardRouter,
    uploadsRouter,
    oauthAccountRouter,
    crmRouter,
    automationsRouter,
    paymentsRouter,
    importsRouter,
    coursesRouter,
    affiliatesRouter, // affiliate program: /affiliation/…
    onboardingRouter, // welcome flow + "Bien démarrer" checklist: /onboarding
    createAccountRouter(opts.account), // Paramètres → Données et compte: /account/summary|export|reset|delete (owner only)
  );
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Route introuvable' });
  });
  app.get('/uploads/:userId/:file', serveUpload);
  // OAuth 2.0 authorization server: /oauth/authorize|token|revoke|introspect, /.well-known/oauth-authorization-server
  app.use(createOAuthRouter());
  // MCP server (POST /mcp, OAuth access tokens) + /.well-known/oauth-protected-resource
  app.use(createMcpRouter());
  // members area (courses): /m/<slug>/… — magic-link login, library, lessons, protected files
  app.use(membersRouter);
  // affiliate area: /a/<slug>/… — program page, signup, magic-link login, dashboard
  app.use(affiliateSpaceRouter);
  app.use(publicRouter);
  // self-hosting: the built web app (static files + index.html for the app routes), last so it never hides a route above
  const spa = createSpaRouter(opts.webDist);
  if (spa) app.use(spa);

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      const field = issue?.path?.length ? `${issue.path.join('.')} : ` : '';
      res.status(400).json({ error: `${field}${issue?.message ?? 'Données invalides'}` });
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    const e = err as { type?: string; status?: number };
    if (e?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'JSON invalide' });
      return;
    }
    if (e?.type === 'entity.too.large') {
      res.status(413).json({ error: 'Contenu trop volumineux' });
      return;
    }
    const pgErr = pgErrorStatus(err);
    if (pgErr) {
      if (pgErr.status >= 500) console.error(`[db] ${req.method} ${req.originalUrl}`, (err as Error).message);
      res.status(pgErr.status).json({ error: pgErr.error });
      return;
    }
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
    res.status(500).json({ error: 'Erreur interne du serveur' });
  });

  return app;
}
