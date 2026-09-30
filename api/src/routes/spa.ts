// Serves the compiled web app (Vite build, `web/dist`) from the API process, so a self-hosted instance is a single
// application container. Mounted LAST in app.ts, after every API / public route, and only on the app's own hosts
// (custom-domain hosts are answered by customDomainMiddleware before anything else, they never get the app).
//
//   WEB_DIST=/abs/path   serve that directory            WEB_DIST=false   never serve the web app
//   unset                production only: `web/dist` if it has been built; nothing in development / tests
//                        (in dev the Vite server serves the app and proxies to the API)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { Router } from 'express';
import { env } from '../env';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIST = path.resolve(here, '../../../web/dist');

/**
 * Paths that belong to the server, never to the single-page app: the API, the server-rendered public pages (funnels
 * /p, tracking /t, unsubscribe /u, opt-in confirmation /c, members area /m, affiliate links /a), the media library,
 * the OAuth protocol endpoints, the MCP endpoint and the discovery documents. An unknown path under one of these
 * prefixes is a 404, not the app shell. (`/oauth/consent` and `/share/:token` are app routes.)
 */
const SERVER_PATH = /^\/(?:api|p|t|u|c|m|a|uploads|mcp|\.well-known)(?:\/|$)|^\/oauth\/(?:authorize|token|revoke|introspect)(?:\/|$)/i;

export const isServerPath = (p: string) => SERVER_PATH.test(p);

/** Directory of the built web app to serve, or null. */
export function resolveWebDist(explicit?: string | null): string | null {
  if (explicit === null) return null;
  const raw = (explicit ?? process.env.WEB_DIST ?? '').trim();
  if (raw && ['0', 'false', 'no', 'off'].includes(raw.toLowerCase())) return null;
  const dir = raw ? path.resolve(raw) : env.NODE_ENV === 'production' ? DEFAULT_DIST : null;
  if (!dir) return null;
  if (!fs.existsSync(path.join(dir, 'index.html'))) {
    if (raw) console.warn(`[web] WEB_DIST=${dir} : index.html introuvable, l’application web n’est pas servie par l’API`);
    return null;
  }
  return dir;
}

/** Static files of the build + `index.html` fallback for the app routes. Null when there is nothing to serve. */
export function createSpaRouter(explicit?: string | null): Router | null {
  const dir = resolveWebDist(explicit);
  if (!dir) return null;
  const index = path.join(dir, 'index.html');
  const r = Router();

  r.use((req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || isServerPath(req.path)) return next('router');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  r.use(
    express.static(dir, {
      index: false,
      redirect: false,
      setHeaders: (res, file) => {
        const rel = path.relative(dir, file).split(path.sep).join('/');
        // Vite puts content-hashed files in assets/: safe to cache forever. Everything else must be revalidated.
        if (rel.startsWith('assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        else if (rel.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
        else res.setHeader('Cache-Control', 'public, max-age=3600');
      },
    }),
  );

  r.use((req, res, next) => {
    // a missing file (/assets/old-hash.js, /robots.txt) or a dotfile probe (/.env, /.git/config) is a 404, not the app shell
    if (path.extname(req.path) || req.path.includes('/.')) return next('router');
    // the OAuth consent screen must never be framed (clickjacking) — same headers as the Vite dev server
    if (req.path.startsWith('/oauth/consent')) {
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
      res.setHeader('Referrer-Policy', 'no-referrer');
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(index, (err) => (err ? next(err) : undefined));
  });

  return r;
}
