// OAuth 2.0 authorization server — protocol endpoints (public, outside /api):
//   GET  /.well-known/oauth-authorization-server   RFC 8414 metadata
//   GET  /oauth/authorize                          RFC 6749 §4.1.1 (+ RFC 7636 PKCE, RFC 9207 iss)
//   POST /oauth/token                              authorization_code / refresh_token grants
//   POST /oauth/revoke                             RFC 7009
//   POST /oauth/introspect                         RFC 7662 (confidential clients, their own tokens only)
// The consent screen itself is the front route /oauth/consent (see routes/oauth-account.ts for its API).
import { Router, type NextFunction, type Request, type Response } from 'express';
import { sql } from 'kysely';
import { OAUTH_SCOPES, type OAuthScope } from '@scalo/shared';
import { db, type OAuthClientRow } from '../db';
import { env } from '../env';
import { hit, LIMITS, type Limit } from '../services/ratelimit';
import {
  CHALLENGE_RE,
  ISSUER,
  REQUEST_TTL_S,
  PREFIX,
  VERIFIER_RE,
  clientIsPublic,
  intersect,
  isSubset,
  issueTokens,
  newSecret,
  parseScopes,
  pkceMatches,
  revokeFamily,
  secretMatches,
  sha256,
  withParams,
  type IssuedTokens,
} from '../services/oauth-server';
import { clientIp } from './auth';

type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'invalid_scope'
  | 'unsupported_response_type'
  | 'access_denied'
  | 'server_error';

class OAuthError extends Error {
  constructor(public code: OAuthErrorCode, public description: string, public status = code === 'invalid_client' ? 401 : 400) {
    super(description);
  }
}

const noStore = (res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
};

function sendError(res: Response, e: OAuthError) {
  noStore(res);
  if (e.status === 401) res.setHeader('WWW-Authenticate', 'Basic realm="scalo", error="invalid_client"');
  res.status(e.status).json({ error: e.code, error_description: e.description });
}

/** Single-valued parameter: a repeated parameter is an invalid_request (RFC 6749 §3.1, §3.2). */
function param(src: unknown, name: string): string | undefined {
  const v = src && typeof src === 'object' ? (src as Record<string, unknown>)[name] : undefined;
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new OAuthError('invalid_request', `Paramètre « ${name} » répété ou invalide`);
  return v;
}

/** CORS for endpoints called from browser apps (public clients): no cookies are used, so `*` is safe. */
function cors(methods: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', `${methods}, OPTIONS`);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}

async function rateLimit(res: Response, key: string, limit: Limit) {
  const r = await hit(key, limit);
  if (r.blocked) {
    res.setHeader('Retry-After', String(r.retryAfter));
    noStore(res);
    res.status(429).json({ error: 'too_many_requests', error_description: `Trop de requêtes, réessayez dans ${r.retryAfter} s` });
    return false;
  }
  return true;
}

// ---------- client authentication (client_secret_basic / client_secret_post / none) ----------

const formDecode = (s: string) => decodeURIComponent(s.replace(/\+/g, ' '));

interface PresentedClient {
  id: string;
  secret?: string;
  method: 'client_secret_basic' | 'client_secret_post' | 'none';
}

function presentedClient(req: Request): PresentedClient {
  const header = req.headers.authorization;
  const bodyId = param(req.body, 'client_id');
  const bodySecret = param(req.body, 'client_secret');
  if (header) {
    const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
    if (!m) throw new OAuthError('invalid_client', 'En-tête Authorization invalide (Basic attendu)');
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i < 0) throw new OAuthError('invalid_client', 'En-tête Authorization invalide');
    let id: string;
    let secret: string;
    try {
      id = formDecode(decoded.slice(0, i));
      secret = formDecode(decoded.slice(i + 1));
    } catch {
      throw new OAuthError('invalid_client', 'En-tête Authorization invalide');
    }
    if (bodySecret !== undefined) throw new OAuthError('invalid_request', 'Une seule méthode d’authentification du client est autorisée');
    if (bodyId !== undefined && bodyId !== id) throw new OAuthError('invalid_request', 'client_id différent de celui de l’en-tête Authorization');
    return { id, secret, method: 'client_secret_basic' };
  }
  if (!bodyId) throw new OAuthError('invalid_client', 'Authentification du client requise (client_id)');
  return bodySecret !== undefined ? { id: bodyId, secret: bodySecret, method: 'client_secret_post' } : { id: bodyId, method: 'none' };
}

async function authenticateClient(p: PresentedClient): Promise<OAuthClientRow> {
  const client = p.id.length <= 100 ? await db.selectFrom('oauth_clients').selectAll().where('client_id', '=', p.id).executeTakeFirst() : undefined;
  if (!client) {
    if (p.secret !== undefined) secretMatches(p.secret, null); // same work whether or not the client exists
    throw new OAuthError('invalid_client', 'Application inconnue ou identifiants invalides');
  }
  if (clientIsPublic(client)) {
    if (p.secret !== undefined) throw new OAuthError('invalid_client', 'Application publique : aucun client_secret ne doit être envoyé');
    return client;
  }
  if (p.secret === undefined || !secretMatches(p.secret, client.secret_hash)) {
    throw new OAuthError('invalid_client', 'Application inconnue ou identifiants invalides');
  }
  return client;
}

// ---------- authorization endpoint: error page (never redirect to an unvalidated URI) ----------

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Headers of the pages served by the authorization server: no framing (clickjacking), no caching, no referrer. */
function pageHeaders(res: Response) {
  noStore(res);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function errorPage(res: Response, message: string, status = 400) {
  pageHeaders(res);
  res
    .status(status)
    .type('html')
    .send(
      `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>Autorisation impossible</title><style>body{font-family:system-ui,-apple-system,sans-serif;background:#f8fafc;color:#0f172a;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}` +
        `.c{max-width:440px;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,.06)}h1{font-size:18px;margin:0 0 8px}p{color:#475569;font-size:14px;line-height:1.5;margin:8px 0 0}code{background:#f1f5f9;padding:1px 5px;border-radius:4px}</style></head>` +
        `<body><div class="c"><h1>Autorisation impossible</h1><p>${escapeHtml(message)}</p>` +
        `<p>L’application qui vous a envoyé ici est mal configurée. Contactez son éditeur. Vous pouvez fermer cette page.</p></div></body></html>`,
    );
}

// ---------- router ----------

export function createOAuthRouter() {
  const r = Router();

  r.use('/.well-known/oauth-authorization-server', cors('GET'));
  r.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth/authorize`,
      token_endpoint: `${ISSUER}/oauth/token`,
      revocation_endpoint: `${ISSUER}/oauth/revoke`,
      introspection_endpoint: `${ISSUER}/oauth/introspect`,
      scopes_supported: OAUTH_SCOPES,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
      revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
      introspection_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
      service_documentation: `${env.PUBLIC_URL}/developers`,
    });
  });

  r.get('/oauth/authorize', async (req, res) => {
    const q = req.query;
    // 1) client + redirect_uri first: until both are validated, errors are shown here, never redirected
    let clientId: string | undefined;
    let redirectUri: string | undefined;
    try {
      clientId = param(q, 'client_id');
      redirectUri = param(q, 'redirect_uri');
    } catch {
      return errorPage(res, 'Paramètre client_id ou redirect_uri répété.');
    }
    if (!clientId) return errorPage(res, 'Paramètre client_id manquant.');
    const client = clientId.length <= 100 ? await db.selectFrom('oauth_clients').selectAll().where('client_id', '=', clientId).executeTakeFirst() : undefined;
    if (!client) return errorPage(res, 'Application inconnue (client_id invalide).', 400);
    if (!redirectUri) return errorPage(res, 'Paramètre redirect_uri manquant.');
    // exact string comparison with a registered URI (RFC 9700 §4.1.3)
    if (!client.redirect_uris.includes(redirectUri)) return errorPage(res, 'L’adresse de redirection (redirect_uri) ne correspond à aucune adresse enregistrée pour cette application.');

    // 2) from here on, errors go back to the application
    let state: string | undefined;
    const fail = (error: OAuthErrorCode, description: string) => {
      noStore(res);
      res.redirect(302, withParams(redirectUri!, { error, error_description: description, state, iss: ISSUER }));
    };
    try {
      state = param(q, 'state');
      if (state && state.length > 1000) {
        state = undefined;
        return fail('invalid_request', 'state trop long (1000 caractères max)');
      }
      const responseType = param(q, 'response_type');
      const rawScope = param(q, 'scope');
      const challenge = param(q, 'code_challenge');
      const method = param(q, 'code_challenge_method');
      const prompt = param(q, 'prompt');
      if (!responseType) return fail('invalid_request', 'response_type manquant');
      if (responseType !== 'code') return fail('unsupported_response_type', 'Seul response_type=code est pris en charge');
      if (!rawScope) return fail('invalid_scope', 'Paramètre scope manquant');
      const scopes = parseScopes(rawScope);
      if (!scopes) return fail('invalid_scope', 'Scope inconnu');
      if (!isSubset(scopes, client.scopes)) return fail('invalid_scope', 'Scope non autorisé pour cette application');
      if (method !== undefined && method !== 'S256') return fail('invalid_request', 'Seule la méthode PKCE S256 est acceptée');
      if (challenge !== undefined && method === undefined) return fail('invalid_request', 'code_challenge_method=S256 requis');
      if (method !== undefined && challenge === undefined) return fail('invalid_request', 'code_challenge manquant');
      if (challenge !== undefined && !CHALLENGE_RE.test(challenge)) return fail('invalid_request', 'code_challenge invalide (BASE64URL(SHA256(code_verifier)), 43 caractères)');
      if (clientIsPublic(client) && !challenge) return fail('invalid_request', 'PKCE (code_challenge S256) est obligatoire pour une application publique');

      const id = newSecret(PREFIX.request);
      await db
        .insertInto('oauth_authorization_requests')
        .values({
          id_hash: id.hash,
          client_id: client.id,
          redirect_uri: redirectUri,
          scopes,
          state: state ?? null,
          code_challenge: challenge ?? null,
          code_challenge_method: challenge ? 'S256' : null,
          prompt_consent: (prompt ?? '').split(' ').includes('consent'),
          expires_at: new Date(Date.now() + REQUEST_TTL_S * 1000),
        })
        .execute();
      noStore(res);
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.redirect(302, `${env.PUBLIC_URL}/oauth/consent?request=${encodeURIComponent(id.value)}`);
    } catch (e) {
      if (e instanceof OAuthError) return fail(e.code, e.description);
      throw e;
    }
  });

  // ----- token endpoint -----

  r.use('/oauth/token', cors('POST'));
  r.post('/oauth/token', async (req, res) => {
    try {
      const presented = presentedClient(req);
      if (!(await rateLimit(res, `oauth:token:${presented.id.slice(0, 100)}:${clientIp(req)}`, LIMITS.oauthToken))) return;
      const client = await authenticateClient(presented);
      const grantType = param(req.body, 'grant_type');
      if (!grantType) throw new OAuthError('invalid_request', 'grant_type manquant');
      let tokens: IssuedTokens;
      if (grantType === 'authorization_code') tokens = await authorizationCodeGrant(req, client);
      else if (grantType === 'refresh_token') tokens = await refreshTokenGrant(req, client);
      else throw new OAuthError('unsupported_grant_type', 'Seuls authorization_code et refresh_token sont pris en charge');
      noStore(res);
      res.json(tokens);
    } catch (e) {
      if (e instanceof OAuthError) return sendError(res, e);
      throw e;
    }
  });

  // ----- revocation (RFC 7009) -----

  r.use('/oauth/revoke', cors('POST'));
  r.post('/oauth/revoke', async (req, res) => {
    try {
      const presented = presentedClient(req);
      if (!(await rateLimit(res, `oauth:revoke:${presented.id.slice(0, 100)}:${clientIp(req)}`, LIMITS.oauthToken))) return;
      const client = await authenticateClient(presented);
      const token = param(req.body, 'token');
      if (!token) throw new OAuthError('invalid_request', 'Paramètre token manquant');
      const row = await db.selectFrom('oauth_tokens').select(['id', 'type', 'family_id', 'client_id']).where('token_hash', '=', sha256(token)).executeTakeFirst();
      // unknown tokens and tokens of another client: 200 without effect (the client learns nothing)
      if (row && row.client_id === client.id) {
        if (row.type === 'refresh') await revokeFamily(db, row.family_id); // + the access tokens of the same grant
        else await db.updateTable('oauth_tokens').set({ revoked_at: sql`now()` }).where('id', '=', row.id).where('revoked_at', 'is', null).execute();
      }
      noStore(res);
      res.status(200).end();
    } catch (e) {
      if (e instanceof OAuthError) return sendError(res, e);
      throw e;
    }
  });

  // ----- introspection (RFC 7662) -----

  r.post('/oauth/introspect', async (req, res) => {
    try {
      const presented = presentedClient(req);
      if (!(await rateLimit(res, `oauth:introspect:${presented.id.slice(0, 100)}:${clientIp(req)}`, LIMITS.oauthIntrospect))) return;
      const client = await authenticateClient(presented);
      if (clientIsPublic(client)) throw new OAuthError('invalid_client', 'L’introspection est réservée aux applications confidentielles');
      const token = param(req.body, 'token');
      if (!token) throw new OAuthError('invalid_request', 'Paramètre token manquant');
      const row = await db
        .selectFrom('oauth_tokens as t')
        .innerJoin('users as u', 'u.id', 't.user_id')
        .select(['t.type', 't.client_id', 't.scopes', 't.expires_at', 't.created_at', 't.revoked_at', 't.rotated_at', 't.user_id', 'u.email'])
        .where('t.token_hash', '=', sha256(token))
        .executeTakeFirst();
      noStore(res);
      const active = !!row && row.client_id === client.id && !row.revoked_at && !row.rotated_at && new Date(row.expires_at).getTime() > Date.now();
      if (!active) return res.json({ active: false });
      const sec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
      res.json({
        active: true,
        scope: intersect(row.scopes, client.scopes).join(' '),
        client_id: client.client_id,
        username: row.email,
        sub: String(row.user_id),
        token_type: row.type === 'access' ? 'access_token' : 'refresh_token',
        exp: sec(row.expires_at),
        iat: sec(row.created_at),
        iss: ISSUER,
      });
    } catch (e) {
      if (e instanceof OAuthError) return sendError(res, e);
      throw e;
    }
  });

  return r;
}

// ---------- grants ----------

type GrantResult = { tokens: IssuedTokens } | { error: OAuthError };

async function authorizationCodeGrant(req: Request, client: OAuthClientRow): Promise<IssuedTokens> {
  const code = param(req.body, 'code');
  const redirectUri = param(req.body, 'redirect_uri');
  const verifier = param(req.body, 'code_verifier');
  if (!code) throw new OAuthError('invalid_request', 'Paramètre code manquant');
  if (!redirectUri) throw new OAuthError('invalid_request', 'Paramètre redirect_uri manquant');
  if (verifier !== undefined && !VERIFIER_RE.test(verifier)) throw new OAuthError('invalid_request', 'code_verifier invalide (43 à 128 caractères)');
  const invalid = (d: string) => ({ error: new OAuthError('invalid_grant', d) });

  // The code is marked used before any other check (and committed even when a check fails): a code is never
  // accepted twice, and a replay revokes what was issued from it.
  const result: GrantResult = await db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom('oauth_codes').selectAll().where('code_hash', '=', sha256(code)).forUpdate().executeTakeFirst();
    if (!row) return invalid('Code invalide ou expiré');
    if (row.used_at) {
      await revokeFamily(trx, row.family_id);
      return invalid('Code déjà utilisé : les jetons obtenus avec ce code ont été révoqués');
    }
    await trx.updateTable('oauth_codes').set({ used_at: sql`now()` }).where('code_hash', '=', row.code_hash).execute();
    if (row.client_id !== client.id) return invalid('Code émis pour une autre application');
    if (new Date(row.expires_at).getTime() <= Date.now()) return invalid('Code expiré');
    if (row.redirect_uri !== redirectUri) return invalid('redirect_uri différent de celui de la demande d’autorisation');
    if (row.code_challenge) {
      if (!verifier) return invalid('code_verifier manquant (PKCE)');
      if (!pkceMatches(verifier, row.code_challenge)) return invalid('code_verifier incorrect (PKCE)');
    } else if (verifier) {
      return invalid('code_verifier envoyé alors qu’aucun code_challenge n’a été utilisé');
    }
    const scopes = intersect(row.scopes, client.scopes);
    if (!scopes.length) return { error: new OAuthError('invalid_scope', 'Les scopes accordés ne sont plus autorisés pour cette application') };
    return { tokens: await issueTokens(trx, { clientId: client.id, userId: row.user_id, familyId: row.family_id, scopes }) };
  });
  if ('error' in result) throw result.error;
  return result.tokens;
}

async function refreshTokenGrant(req: Request, client: OAuthClientRow): Promise<IssuedTokens> {
  const token = param(req.body, 'refresh_token');
  const rawScope = param(req.body, 'scope');
  if (!token) throw new OAuthError('invalid_request', 'Paramètre refresh_token manquant');
  let requested: OAuthScope[] | null = null;
  if (rawScope !== undefined) {
    requested = parseScopes(rawScope);
    if (!requested) throw new OAuthError('invalid_scope', 'Scope inconnu');
  }
  const invalid = (d: string) => ({ error: new OAuthError('invalid_grant', d) });

  const result: GrantResult = await db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('oauth_tokens')
      .selectAll()
      .where('token_hash', '=', sha256(token))
      .where('type', '=', 'refresh')
      .forUpdate()
      .executeTakeFirst();
    if (!row || row.client_id !== client.id) return invalid('Jeton de rafraîchissement invalide');
    if (row.revoked_at) return invalid('Jeton de rafraîchissement révoqué');
    if (row.rotated_at) {
      // an old refresh token presented again: stolen or replayed → the whole grant is revoked (RFC 9700 §4.14.2)
      await revokeFamily(trx, row.family_id);
      return invalid('Jeton de rafraîchissement déjà utilisé : l’autorisation a été révoquée par sécurité');
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) return invalid('Jeton de rafraîchissement expiré');
    if (requested && !isSubset(requested, row.scopes)) {
      return { error: new OAuthError('invalid_scope', 'Le scope demandé dépasse celui accordé initialement') };
    }
    const refreshScopes = intersect(row.scopes, client.scopes);
    if (!refreshScopes.includes('offline_access')) return invalid('L’accès hors ligne n’est plus autorisé pour cette application');
    const scopes = intersect(requested ?? row.scopes, client.scopes);
    if (!scopes.length) return { error: new OAuthError('invalid_scope', 'Aucun scope autorisé') };
    await trx.updateTable('oauth_tokens').set({ rotated_at: sql`now()` }).where('id', '=', row.id).execute();
    return {
      tokens: await issueTokens(trx, { clientId: client.id, userId: row.user_id, familyId: row.family_id, scopes, refreshScopes, parentId: row.id }),
    };
  });
  if ('error' in result) throw result.error;
  return result.tokens;
}
