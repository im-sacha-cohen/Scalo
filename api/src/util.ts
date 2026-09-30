import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { apiPath, ROLE_DENIED, roleAllows } from './access';
import { db } from './db';
import { loadEe } from './ee';
import { env } from './env';

z.config(z.locales.fr());

export const JWT_SECRET = env.JWT_SECRET;
export const PUBLIC_URL = env.PUBLIC_URL;

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
export const notFound = (what = 'Ressource') => new HttpError(404, `${what} introuvable`);

/** Parses a numeric route param; anything else is a 404. */
export function paramId(v: unknown, what?: string): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw notFound(what);
  return n;
}

// ---------- auth ----------

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The account the request works on (tenant of every query). */
      userId?: number;
      /** The signed-in person: equal to userId, except for a team member acting for the account (Enterprise). */
      actorId?: number;
      /** Role of the actor on the account; always 'owner' for a solo account. Enforced by access.ts. */
      role?: import('@scalo/shared').AccountRole;
    }
  }
}

export function signToken(userId: number) {
  return jwt.sign({ sub: String(userId) }, JWT_SECRET, { expiresIn: '30d' });
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const h = req.headers.authorization ?? '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new HttpError(401, 'Non authentifié');
  let id: number;
  try {
    const payload = jwt.verify(m[1], JWT_SECRET) as jwt.JwtPayload;
    id = Number(payload.sub);
  } catch {
    throw new HttpError(401, 'Session expirée ou invalide');
  }
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(401, 'Session invalide');
  const exists = await db.selectFrom('users').select('id').where('id', '=', id).executeTakeFirst();
  if (!exists) throw new HttpError(401, 'Session invalide');
  req.userId = id;
  req.actorId = id;
  req.role = 'owner';
  // Enterprise edition only: a team member acts on behalf of the account he belongs to. No-op otherwise.
  const ext = await loadEe();
  if (ext) {
    const actor = await ext.resolveActor(id);
    if (actor) {
      req.userId = actor.accountId;
      req.role = actor.role;
    }
    ext.onRequest(req, res); // audit trail
    // Generic rule by HTTP method / area (access.ts): covers every authenticated route, however it is mounted.
    if (!roleAllows(req.role, req.method, apiPath(req.originalUrl))) throw new HttpError(403, ROLE_DENIED[req.role]);
  }
  next();
}

export function uid(req: Request): number {
  if (!req.userId) throw new HttpError(401, 'Non authentifié');
  return req.userId;
}

// ---------- signed ids (contact cookie, unsubscribe token) ----------

export const hmac = (purpose: string, value: string) =>
  crypto.createHmac('sha256', JWT_SECRET).update(`${purpose}:${value}`).digest('base64url').slice(0, 32);

export function signId(purpose: string, id: number) {
  return `${id}.${hmac(purpose, String(id))}`;
}

export function verifySignedId(purpose: string, token: string | undefined): number | null {
  if (!token) return null;
  const m = /^(\d+)\.([\w-]+)$/.exec(token);
  if (!m) return null;
  const expected = Buffer.from(hmac(purpose, m[1]));
  const given = Buffer.from(m[2]);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  return Number(m[1]);
}

// ---------- misc ----------

export function slugify(s: string, fallback = 'page') {
  const out = s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return out || fallback;
}

/** Escapes LIKE/ILIKE wildcards (used with the default `\` escape character). */
export const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => '\\' + m);

export const daysAgoIso = (days: number) => new Date(Date.now() - days * 86400_000).toISOString();

/** Loose schema for a PageContent payload (the renderer is defensive about unknown fields). */
export const pageContentSchema = z.object({
  settings: z.looseObject({}),
  blocks: z.array(z.looseObject({ id: z.string().min(1), type: z.string().min(1) })).max(500),
});

// ---------- owner preview links (bypass step access rules) ----------

const PREVIEW_TTL_MS = 24 * 3600_000;

/** Funnel-scoped token so the owner can browse all steps of a funnel in preview, valid 24 h. */
export function previewToken(funnelId: number) {
  const exp = Date.now() + PREVIEW_TTL_MS;
  return `${exp.toString(36)}.${hmac('preview', `${funnelId}:${exp}`)}`;
}

export function verifyPreviewToken(funnelId: number, token: unknown) {
  if (typeof token !== 'string') return false;
  const m = /^([0-9a-z]+)\.([\w-]+)$/.exec(token);
  if (!m) return false;
  const exp = parseInt(m[1], 36);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = Buffer.from(hmac('preview', `${funnelId}:${exp}`));
  const given = Buffer.from(m[2]);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
