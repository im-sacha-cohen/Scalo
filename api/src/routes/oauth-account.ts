// OAuth authorization server — routes used by the web app (session JWT, mounted under /api with requireAuth):
//   consent screen:           GET /api/oauth/requests/:id, POST /api/oauth/consent
//   connected applications:   GET /api/oauth/authorizations, DELETE /api/oauth/authorizations/:clientId
//   developers (owner only):  /api/developer/apps[/:id[/rotate-secret]]
// These routes authenticate with the Authorization header (never cookies), so they are not exposed to CSRF.
import crypto from 'node:crypto';
import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { OAUTH_SCOPES, type OAuthApp, type OAuthAppWithSecret, type OAuthAuthorization, type OAuthConsentRequest, type OAuthScope } from '@scalo/shared';
import { db, type OAuthClientRow } from '../db';
import {
  CODE_TTL_S,
  ISSUER,
  PREFIX,
  isSubset,
  newClientId,
  newSecret,
  redirectUriError,
  revokeGrant,
  sha256,
  withParams,
} from '../services/oauth-server';
import { HttpError, notFound, paramId, uid } from '../util';

export const oauthAccountRouter = Router();

const REQUEST_GONE = 'Cette demande d’autorisation a expiré ou a déjà été traitée. Retournez sur l’application et recommencez.';
const MAX_APPS = 25;

async function findRequest(rawId: unknown) {
  const id = typeof rawId === 'string' ? rawId : '';
  if (!id.startsWith(PREFIX.request) || id.length > 100) throw notFound('Demande d’autorisation');
  const row = await db
    .selectFrom('oauth_authorization_requests as r')
    .innerJoin('oauth_clients as c', 'c.id', 'r.client_id')
    .innerJoin('users as o', 'o.id', 'c.user_id')
    .select([
      'r.id_hash',
      'r.client_id',
      'r.redirect_uri',
      'r.scopes',
      'r.state',
      'r.code_challenge',
      'r.prompt_consent',
      'r.expires_at',
      'r.consumed_at',
      'c.client_id as public_client_id',
      'c.name',
      'c.description',
      'c.website',
      'c.logo_url',
      'c.type',
      'o.name as owner_name',
    ])
    .where('r.id_hash', '=', sha256(id))
    .executeTakeFirst();
  if (!row) throw notFound('Demande d’autorisation');
  if (row.consumed_at || new Date(row.expires_at).getTime() <= Date.now()) throw new HttpError(410, REQUEST_GONE);
  return { id, row };
}

oauthAccountRouter.get('/oauth/requests/:id', async (req, res) => {
  const userId = uid(req);
  const { id, row } = await findRequest(req.params.id);
  const consent = await db.selectFrom('oauth_consents').select('scopes').where('user_id', '=', userId).where('client_id', '=', row.client_id).executeTakeFirst();
  const out: OAuthConsentRequest = {
    request_id: id,
    client: {
      client_id: row.public_client_id,
      name: row.name,
      description: row.description,
      website: row.website,
      logo_url: row.logo_url,
      type: row.type,
      owner_name: row.owner_name,
    },
    scopes: row.scopes as OAuthScope[],
    redirect_uri: row.redirect_uri,
    remembered: !row.prompt_consent && !!consent && isSubset(row.scopes, consent.scopes),
    prompt_consent: row.prompt_consent,
    expires_at: row.expires_at,
  };
  res.setHeader('Cache-Control', 'no-store');
  res.json(out);
});

const consentSchema = z.object({ request_id: z.string().min(1).max(100), decision: z.enum(['approve', 'deny']) });

oauthAccountRouter.post('/oauth/consent', async (req, res) => {
  const userId = uid(req);
  const body = consentSchema.parse(req.body);
  await findRequest(body.request_id); // 404 / 410 with a clear message
  // single use: consumed atomically (a double click can't issue two codes)
  const r = await db
    .updateTable('oauth_authorization_requests')
    .set({ consumed_at: sql`now()` })
    .where('id_hash', '=', sha256(body.request_id))
    .where('consumed_at', 'is', null)
    .where('expires_at', '>', sql<string>`now()`)
    .returningAll()
    .executeTakeFirst();
  if (!r) throw new HttpError(410, REQUEST_GONE);
  res.setHeader('Cache-Control', 'no-store');
  if (body.decision === 'deny') {
    return res.json({
      redirect_to: withParams(r.redirect_uri, { error: 'access_denied', error_description: 'L’utilisateur a refusé l’accès', state: r.state, iss: ISSUER }),
    });
  }
  const code = newSecret(PREFIX.code);
  await db.transaction().execute(async (trx) => {
    // remembered consent = union of everything the user granted to this application
    await trx
      .insertInto('oauth_consents')
      .values({ user_id: userId, client_id: r.client_id, scopes: r.scopes })
      .onConflict((oc) =>
        oc.columns(['user_id', 'client_id']).doUpdateSet({
          scopes: sql<string[]>`ARRAY(SELECT DISTINCT unnest(oauth_consents.scopes || excluded.scopes))`,
          updated_at: sql`now()`,
        }),
      )
      .execute();
    await trx
      .insertInto('oauth_codes')
      .values({
        code_hash: code.hash,
        client_id: r.client_id,
        user_id: userId,
        redirect_uri: r.redirect_uri,
        scopes: r.scopes,
        code_challenge: r.code_challenge,
        family_id: crypto.randomUUID(),
        expires_at: new Date(Date.now() + CODE_TTL_S * 1000),
      })
      .execute();
  });
  res.json({ redirect_to: withParams(r.redirect_uri, { code: code.value, state: r.state, iss: ISSUER }) });
});

// ---------- connected applications (user side) ----------

oauthAccountRouter.get('/oauth/authorizations', async (req, res) => {
  const rows = await db
    .selectFrom('oauth_consents as g')
    .innerJoin('oauth_clients as c', 'c.id', 'g.client_id')
    .innerJoin('users as o', 'o.id', 'c.user_id')
    .select(['g.scopes', 'g.created_at', 'g.updated_at', 'g.last_used_at', 'c.client_id', 'c.name', 'c.description', 'c.website', 'c.logo_url', 'o.name as owner_name'])
    .where('g.user_id', '=', uid(req))
    .orderBy('g.updated_at', 'desc')
    .execute();
  const out: OAuthAuthorization[] = rows.map((r) => ({
    client: { client_id: r.client_id, name: r.name, description: r.description, website: r.website, logo_url: r.logo_url, owner_name: r.owner_name },
    scopes: OAUTH_SCOPES.filter((x) => r.scopes.includes(x)),
    granted_at: r.created_at,
    updated_at: r.updated_at,
    last_used_at: r.last_used_at,
  }));
  res.json(out);
});

oauthAccountRouter.delete('/oauth/authorizations/:clientId', async (req, res) => {
  const userId = uid(req);
  const client = await db.selectFrom('oauth_clients').select('id').where('client_id', '=', String(req.params.clientId)).executeTakeFirst();
  if (!client) throw notFound('Application');
  const hadConsent = await revokeGrant(userId, client.id);
  if (!hadConsent) throw notFound('Autorisation');
  res.json({ ok: true });
});

// ---------- developers: registered applications (owner only) ----------

const optionalUrl = (https: boolean) =>
  z
    .string()
    .trim()
    .max(500)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null))
    .refine(
      (v) => {
        if (!v) return true;
        try {
          const u = new URL(v);
          return https ? u.protocol === 'https:' : u.protocol === 'https:' || u.protocol === 'http:';
        } catch {
          return false;
        }
      },
      { message: https ? 'URL https:// attendue' : 'URL http(s):// attendue' },
    );

const redirectUrisSchema = z
  .array(z.string().trim())
  .min(1, 'Ajoutez au moins une URL de redirection')
  .max(10, '10 URL de redirection maximum')
  .transform((l) => [...new Set(l.filter(Boolean))])
  .superRefine((l, ctx) => {
    if (!l.length) ctx.addIssue({ code: 'custom', message: 'Ajoutez au moins une URL de redirection' });
    for (const u of l) {
      const err = redirectUriError(u);
      if (err) ctx.addIssue({ code: 'custom', message: `« ${u} » : ${err}` });
    }
  });

const scopesSchema = z
  .array(z.enum(OAUTH_SCOPES))
  .min(1, 'Choisissez au moins un scope')
  .transform((l) => OAUTH_SCOPES.filter((s) => l.includes(s)));

const appFields = {
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  website: optionalUrl(false),
  logo_url: optionalUrl(true),
  redirect_uris: redirectUrisSchema,
  scopes: scopesSchema,
};
const createAppSchema = z.object({ ...appFields, type: z.enum(['confidential', 'public']) });
const patchAppSchema = z.object(appFields).partial();

function toApp(r: OAuthClientRow, authorizations = 0): OAuthApp {
  return {
    id: r.id,
    client_id: r.client_id,
    name: r.name,
    description: r.description,
    website: r.website,
    logo_url: r.logo_url,
    type: r.type,
    redirect_uris: r.redirect_uris,
    scopes: r.scopes as OAuthScope[],
    secret_hint: r.secret_hint,
    secret_rotated_at: r.secret_rotated_at,
    authorizations_count: authorizations,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

const authorizationsCount = (clientIds: number[]) =>
  clientIds.length
    ? db
        .selectFrom('oauth_consents')
        .select(['client_id', (eb) => eb.fn.countAll<number>().as('n')])
        .where('client_id', 'in', clientIds)
        .groupBy('client_id')
        .execute()
        .then((rs) => new Map(rs.map((r) => [r.client_id, r.n])))
    : Promise.resolve(new Map<number, number>());

async function ownedApp(userId: number, rawId: unknown) {
  const row = await db.selectFrom('oauth_clients').selectAll().where('id', '=', paramId(rawId, 'Application')).where('user_id', '=', userId).executeTakeFirst();
  if (!row) throw notFound('Application');
  return row;
}

const newClientSecret = () => {
  const s = newSecret(PREFIX.clientSecret);
  return { ...s, hint: s.value.slice(-4) };
};

oauthAccountRouter.get('/developer/apps', async (req, res) => {
  const rows = await db.selectFrom('oauth_clients').selectAll().where('user_id', '=', uid(req)).orderBy('created_at', 'desc').orderBy('id', 'desc').execute();
  const counts = await authorizationsCount(rows.map((r) => r.id));
  res.json(rows.map((r) => toApp(r, counts.get(r.id) ?? 0)));
});

oauthAccountRouter.post('/developer/apps', async (req, res) => {
  const userId = uid(req);
  const body = createAppSchema.parse(req.body);
  const { n } = await db.selectFrom('oauth_clients').select((eb) => eb.fn.countAll<number>().as('n')).where('user_id', '=', userId).executeTakeFirstOrThrow();
  if (n >= MAX_APPS) throw new HttpError(409, `Limite de ${MAX_APPS} applications atteinte`);
  const secret = body.type === 'confidential' ? newClientSecret() : null;
  const row = await db
    .insertInto('oauth_clients')
    .values({
      client_id: newClientId(),
      user_id: userId,
      name: body.name,
      description: body.description ?? '',
      website: body.website,
      logo_url: body.logo_url,
      type: body.type,
      secret_hash: secret?.hash ?? null,
      secret_hint: secret?.hint ?? null,
      redirect_uris: body.redirect_uris,
      scopes: body.scopes,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const out: OAuthAppWithSecret = { ...toApp(row), ...(secret ? { client_secret: secret.value } : {}) };
  res.setHeader('Cache-Control', 'no-store');
  res.status(201).json(out);
});

oauthAccountRouter.get('/developer/apps/:id', async (req, res) => {
  const row = await ownedApp(uid(req), req.params.id);
  res.json(toApp(row, (await authorizationsCount([row.id])).get(row.id) ?? 0));
});

oauthAccountRouter.patch('/developer/apps/:id', async (req, res) => {
  const row = await ownedApp(uid(req), req.params.id);
  const body = patchAppSchema.parse(req.body);
  const updated = await db
    .updateTable('oauth_clients')
    .set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.website !== undefined ? { website: body.website } : {}),
      ...(body.logo_url !== undefined ? { logo_url: body.logo_url } : {}),
      ...(body.redirect_uris !== undefined ? { redirect_uris: body.redirect_uris } : {}),
      // removed scopes stop working at once for existing tokens (effective scopes = token ∩ application)
      ...(body.scopes !== undefined ? { scopes: body.scopes } : {}),
      updated_at: sql`now()`,
    })
    .where('id', '=', row.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  res.json(toApp(updated, (await authorizationsCount([row.id])).get(row.id) ?? 0));
});

oauthAccountRouter.post('/developer/apps/:id/rotate-secret', async (req, res) => {
  const row = await ownedApp(uid(req), req.params.id);
  if (row.type !== 'confidential') throw new HttpError(409, 'Une application publique n’a pas de secret');
  const secret = newClientSecret();
  const updated = await db
    .updateTable('oauth_clients')
    .set({ secret_hash: secret.hash, secret_hint: secret.hint, secret_rotated_at: sql`now()`, updated_at: sql`now()` })
    .where('id', '=', row.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  const out: OAuthAppWithSecret = { ...toApp(updated, (await authorizationsCount([row.id])).get(row.id) ?? 0), client_secret: secret.value };
  res.setHeader('Cache-Control', 'no-store');
  res.json(out);
});

oauthAccountRouter.delete('/developer/apps/:id', async (req, res) => {
  const row = await ownedApp(uid(req), req.params.id);
  // cascades to its tokens, codes, pending requests and consents: every token stops working immediately
  await db.deleteFrom('oauth_clients').where('id', '=', row.id).execute();
  res.json({ ok: true });
});
