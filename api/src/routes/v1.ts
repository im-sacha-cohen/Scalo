// Public API for third-party applications: /api/v1/*, authenticated with an OAuth 2.0 access token
// (`Authorization: Bearer scalo_at_…`, RFC 6750). Each route requires a scope. Business rules are the same as the web
// app's routes (same services: tags trigger campaigns, double opt-in, unsubscribe stops campaigns…).
import { Router, type NextFunction, type Request, type Response } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import type { OAuthScope } from '@scalo/shared';
import { db } from '../db';
import { env } from '../env';
import { addTag, getContact, getContactRow, getOrCreateTag, enrollInCampaign, normEmail, removeTag, upsertContact } from '../services/contacts';
import { findAccessToken, touchToken } from '../services/oauth-server';
import { hit, LIMITS } from '../services/ratelimit';
import { createSchema, listSchema, patchContact, patchSchema, listContacts } from './contacts';
import { stepStats } from './funnels';
import { statsFor, toCampaigns } from './emails';
import { HttpError, notFound, paramId } from '../util';
import { fieldDefMap, validateFields } from '../services/fields';
import { mountV1Crm } from './v1-crm';
import { mountV1Sales } from './v1-sales';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      oauth?: { tokenId: number; userId: number; clientId: number; publicClientId: string; scopes: OAuthScope[] };
    }
  }
}

const grant = (req: Request) => {
  if (!req.oauth) throw new HttpError(401, 'Non authentifié');
  return req.oauth;
};

function bearerError(res: Response, status: 401 | 403, error: string, description: string, scope?: string) {
  // header values must be ASCII: the (French) description only goes in the JSON body
  const params = [`realm="scalo"`, ...(error ? [`error="${error}"`] : []), ...(scope ? [`scope="${scope}"`] : [])];
  res.setHeader('WWW-Authenticate', `Bearer ${params.join(', ')}`);
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json({ error: error || 'invalid_token', error_description: description, ...(scope ? { scope } : {}) });
}

/** Bearer access token → req.oauth, then the per-authorization rate limit. */
async function requireAccessToken(req: Request, res: Response, next: NextFunction) {
  const h = req.headers.authorization ?? '';
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  if (!m) {
    // no credentials: no error code in the challenge (RFC 6750 §3.1)
    return bearerError(res, 401, h ? 'invalid_request' : '', h ? 'En-tête Authorization invalide' : 'Jeton d’accès manquant (Authorization: Bearer …)');
  }
  const t = await findAccessToken(m[1]);
  if (!t) return bearerError(res, 401, 'invalid_token', 'Jeton d’accès invalide, expiré ou révoqué');
  req.oauth = { tokenId: t.id, userId: t.user_id, clientId: t.client_id, publicClientId: t.public_client_id, scopes: t.scopes };

  // per authorization (application + account): refreshing the token does not reset the counter
  const limit = LIMITS.apiV1;
  const r = await hit(`api:v1:${t.client_id}:${t.user_id}`, limit);
  res.setHeader('X-RateLimit-Limit', String(limit.max));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit.max - r.count)));
  res.setHeader('X-RateLimit-Reset', String(r.retryAfter));
  if (r.blocked) {
    res.setHeader('Retry-After', String(r.retryAfter));
    return res.status(429).json({ error: 'rate_limited', error_description: `Limite de ${limit.max} requêtes par minute atteinte, réessayez dans ${r.retryAfter} s` });
  }
  void touchToken(t.id, t.user_id, t.client_id).catch((e) => console.error('[oauth] last_used_at:', e.message));
  next();
}

/** 403 insufficient_scope unless the token carries `scope`. */
const need = (scope: OAuthScope) => (req: Request, res: Response, next: NextFunction) => {
  if (!grant(req).scopes.includes(scope)) return bearerError(res, 403, 'insufficient_scope', `Scope « ${scope} » requis`, scope);
  next();
};

async function ownedContact(userId: number, rawId: unknown) {
  const row = await getContactRow(userId, paramId(rawId, 'Contact'));
  if (!row) throw notFound('Contact');
  return row;
}

export function createV1Router() {
  const r = Router();

  // browser apps (public clients) call the API directly: bearer tokens, no cookies → `*` is safe
  r.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After, WWW-Authenticate');
    res.setHeader('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });
  r.use(requireAccessToken);

  r.get('/me', need('profile'), async (req, res) => {
    const u = await db.selectFrom('users').select(['id', 'email', 'name', 'created_at']).where('id', '=', grant(req).userId).executeTakeFirstOrThrow();
    res.json(u);
  });

  // ----- contacts -----

  const v1List = listSchema.extend({ limit: z.coerce.number().int().min(1).max(100).optional().default(50) });

  r.get('/contacts', need('contacts:read'), async (req, res) => {
    const q = v1List.parse(req.query);
    res.json({ ...(await listContacts(grant(req).userId, q)), page: q.page, limit: q.limit });
  });

  r.get('/contacts/:id', need('contacts:read'), async (req, res) => {
    const { userId } = grant(req);
    const row = await ownedContact(userId, req.params.id);
    res.json(await getContact(userId, row.id));
  });

  /** Upsert by email: 201 when created, 200 when an existing contact was updated (non-empty fields). */
  r.post('/contacts', need('contacts:write'), async (req, res) => {
    const g = grant(req);
    const body = createSchema.parse(req.body);
    if (body.tags?.length && !g.scopes.includes('tags:write')) return bearerError(res, 403, 'insufficient_scope', 'Scope « tags:write » requis pour ajouter des tags', 'tags:write');
    const fields = body.fields ? validateFields(await fieldDefMap(g.userId), body.fields) : null;
    const result = await db.transaction().execute(async (trx) => {
      const { contact, created } = await upsertContact(g.userId, { ...body, email: normEmail(body.email), fields }, {}, trx);
      for (const name of body.tags ?? []) await addTag(g.userId, contact.id, await getOrCreateTag(g.userId, name, trx), undefined, trx);
      return { contact: (await getContact(g.userId, contact.id, trx))!, created };
    });
    res.status(result.created ? 201 : 200).json(result.contact);
  });

  r.patch('/contacts/:id', need('contacts:write'), async (req, res) => {
    const { userId } = grant(req);
    const row = await ownedContact(userId, req.params.id);
    await patchContact(userId, row, patchSchema.parse(req.body), 'api');
    res.json(await getContact(userId, row.id));
  });

  r.delete('/contacts/:id', need('contacts:write'), async (req, res) => {
    const { userId } = grant(req);
    const row = await ownedContact(userId, req.params.id);
    await db.deleteFrom('contacts').where('id', '=', row.id).where('user_id', '=', userId).execute();
    res.json({ ok: true });
  });

  r.post('/contacts/:id/tags', need('tags:write'), async (req, res) => {
    const { userId } = grant(req);
    const row = await ownedContact(userId, req.params.id);
    const { name } = z.object({ name: z.string().trim().min(1).max(60) }).parse(req.body);
    await db.transaction().execute(async (trx) => addTag(userId, row.id, await getOrCreateTag(userId, name, trx), undefined, trx));
    res.json(await getContact(userId, row.id));
  });

  r.delete('/contacts/:id/tags/:tagId', need('tags:write'), async (req, res) => {
    const { userId } = grant(req);
    const row = await ownedContact(userId, req.params.id);
    const tagId = paramId(req.params.tagId, 'Tag');
    if (!(await db.selectFrom('tags').select('id').where('id', '=', tagId).where('user_id', '=', userId).executeTakeFirst())) throw notFound('Tag');
    await removeTag(userId, row.id, tagId);
    res.json(await getContact(userId, row.id));
  });

  r.get('/tags', need('contacts:read'), async (req, res) => {
    const rows = await db
      .selectFrom('tags as t')
      .select((eb) => [
        't.id',
        't.name',
        eb.selectFrom('contact_tags as ct').select(eb.fn.countAll<number>().as('n')).whereRef('ct.tag_id', '=', 't.id').as('contacts_count'),
      ])
      .where('t.user_id', '=', grant(req).userId)
      .orderBy(sql`lower(t.name)`)
      .execute();
    res.json(rows.map((t) => ({ ...t, contacts_count: Number(t.contacts_count ?? 0) })));
  });

  // ----- funnels (read only, without page content) -----

  r.get('/funnels', need('funnels:read'), async (req, res) => {
    const funnels = await db.selectFrom('funnels').selectAll().where('user_id', '=', grant(req).userId).orderBy('created_at', 'desc').orderBy('id', 'desc').execute();
    const ids = funnels.map((f) => f.id);
    const steps = ids.length
      ? await db.selectFrom('steps').select(['id', 'funnel_id', 'name', 'slug', 'type', 'position', 'created_at']).where('funnel_id', 'in', ids).orderBy('position').orderBy('id').execute()
      : [];
    const stats = await stepStats(steps.map((s) => s.id));
    const optins = ids.length
      ? await db
          .selectFrom('contact_events')
          .select(['funnel_id', (eb) => eb.fn.countAll<number>().as('n')])
          .where('funnel_id', 'in', ids)
          .where('type', '=', 'optin')
          .groupBy('funnel_id')
          .execute()
      : [];
    res.json(
      funnels.map((f) => {
        const fs = steps
          .filter((s) => s.funnel_id === f.id)
          .map(({ funnel_id: _f, ...s }) => ({ ...s, url: `${env.PUBLIC_URL}/p/${f.slug}/${s.slug}`, ...(stats.get(s.id) ?? { views: 0, optins: 0 }) }));
        return {
          id: f.id,
          name: f.name,
          slug: f.slug,
          url: `${env.PUBLIC_URL}/p/${f.slug}`,
          created_at: f.created_at,
          views: fs.reduce((a, s) => a + s.views, 0),
          optins: optins.find((o) => o.funnel_id === f.id)?.n ?? 0,
          steps: fs,
        };
      }),
    );
  });

  // ----- emails (read only) -----

  r.get('/broadcasts', need('emails:read'), async (req, res) => {
    const rows = await db
      .selectFrom('broadcasts')
      .select(['id', 'subject', 'status', 'tag_id', 'sent_at', 'scheduled_at', 'created_at'])
      .where('user_id', '=', grant(req).userId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    const stats = await statsFor('broadcast_id', rows.map((b) => b.id));
    res.json(rows.map((b) => ({ ...b, stats: stats.get(b.id) })));
  });

  r.get('/campaigns', need('emails:read'), async (req, res) => {
    const rows = await db.selectFrom('campaigns').selectAll().where('user_id', '=', grant(req).userId).orderBy('created_at', 'desc').orderBy('id', 'desc').execute();
    res.json(await toCampaigns(rows, false));
  });

  r.post('/campaigns/:id/enroll', need('campaigns:write'), async (req, res) => {
    const { userId } = grant(req);
    const campaign = await db.selectFrom('campaigns').select('id').where('id', '=', paramId(req.params.id, 'Campagne')).where('user_id', '=', userId).executeTakeFirst();
    if (!campaign) throw notFound('Campagne');
    const { contact_id } = z.object({ contact_id: z.number().int().positive() }).parse(req.body);
    const contact = await getContactRow(userId, contact_id);
    if (!contact) throw notFound('Contact');
    if (!contact.confirmed_at) throw new HttpError(409, 'Ce contact n’a pas encore confirmé son inscription (double opt-in)');
    const enrolled = await enrollInCampaign(userId, campaign.id, contact_id);
    res.json({ ok: true, enrolled });
  });

  // ----- CRM: custom fields, segments (read), purchases -----
  mountV1Crm(r, { need, grant });
  // ----- sales (read only): products, orders -----
  mountV1Sales(r, { need, grant });

  r.use((_req, res) => {
    res.status(404).json({ error: 'Route introuvable' });
  });
  return r;
}
