// MCP server (Model Context Protocol) — lets Claude or any MCP client drive a Scalo account.
//
//   POST /mcp                                     Streamable HTTP transport (stateless, JSON responses)
//   GET  /.well-known/oauth-protected-resource    RFC 9728 metadata: tells the client which authorization server to use
//
// Authentication: the OAuth 2.0 access tokens of the existing authorization server (`Authorization: Bearer scalo_at_…`),
// same scopes as the public API. No dynamic client registration: the user creates an application in "Développeurs" and
// gives its client id (and secret) to the MCP client.
//
// Each tool is a thin wrapper around one /api/v1 endpoint, called in-process over the loopback interface with the
// caller's own token: validation, scope checks, account isolation, rate limit and business rules are exactly those of
// the public API — nothing is re-implemented here.
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { OAUTH_SCOPES, type OAuthScope } from '@scalo/shared';
import { env } from '../env';
import { findAccessToken, ISSUER } from '../services/oauth-server';

export const MCP_RESOURCE = `${env.PUBLIC_URL}/mcp`;
const METADATA_URL = `${env.PUBLIC_URL}/.well-known/oauth-protected-resource`;

interface V1Call {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
}

interface ToolDef {
  name: string;
  title: string;
  description: string;
  scope: OAuthScope;
  readOnly: boolean;
  input: z.ZodRawShape;
  call: (args: any) => V1Call;
}

const id = (what: string) => z.number().int().positive().describe(what);
const page = { page: z.number().int().min(1).optional().describe('Page (1 par défaut)'), limit: z.number().int().min(1).max(100).optional().describe('Résultats par page (50 par défaut, 100 max)') };
const contactFields = {
  first_name: z.string().max(200).optional(),
  last_name: z.string().max(200).optional(),
  phone: z.string().max(200).optional(),
  fields: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Champs personnalisés {clé: valeur} (voir list_custom_fields ; null vide un champ). Date : AAAA-MM-JJ. Date et heure : ISO 8601 avec fuseau (2026-10-01T14:30:00+02:00), sinon heure de Paris. Case à cocher : true / false.',
    ),
};

/** Tools = endpoints of the public API v1 (see routes/v1.ts, routes/v1-crm.ts). */
export const MCP_TOOLS: ToolDef[] = [
  { name: 'get_account', title: 'Compte', description: 'Nom et adresse email du compte Scalo connecté.', scope: 'profile', readOnly: true, input: {}, call: () => ({ method: 'GET', path: '/me' }) },
  {
    name: 'list_contacts',
    title: 'Lister / chercher des contacts',
    description: 'Liste paginée des contacts. `search` cherche dans l’email, le prénom et le nom ; filtres par tag, segment ou statut.',
    scope: 'contacts:read',
    readOnly: true,
    input: {
      search: z.string().max(200).optional(),
      tag_id: id('Identifiant du tag').optional(),
      segment_id: id('Identifiant du segment').optional(),
      status: z.enum(['pending_confirmation', 'confirmed', 'unsubscribed', 'bounced']).optional(),
      ...page,
    },
    call: (a) => ({ method: 'GET', path: '/contacts', query: a }),
  },
  { name: 'get_contact', title: 'Détail d’un contact', description: 'Un contact avec ses tags et ses champs personnalisés.', scope: 'contacts:read', readOnly: true, input: { contact_id: id('Identifiant du contact') }, call: (a) => ({ method: 'GET', path: `/contacts/${a.contact_id}` }) },
  {
    name: 'create_contact',
    title: 'Créer un contact',
    description: 'Crée un contact, ou met à jour celui qui a déjà cet email. `tags` (noms) demande aussi le scope tags:write ; un tag peut déclencher une campagne.',
    scope: 'contacts:write',
    readOnly: false,
    input: { email: z.string().max(254), ...contactFields, tags: z.array(z.string().min(1).max(60)).max(50).optional() },
    call: (a) => ({ method: 'POST', path: '/contacts', body: a }),
  },
  {
    name: 'update_contact',
    title: 'Mettre à jour un contact',
    description: 'Modifie un contact (seuls les champs fournis changent). `unsubscribed: true` le désabonne des emails.',
    scope: 'contacts:write',
    readOnly: false,
    input: { contact_id: id('Identifiant du contact'), email: z.string().max(254).optional(), ...contactFields, unsubscribed: z.boolean().optional() },
    call: ({ contact_id, ...body }) => ({ method: 'PATCH', path: `/contacts/${contact_id}`, body }),
  },
  {
    name: 'list_custom_fields',
    title: 'Champs personnalisés',
    description: 'Champs personnalisés du compte : clé (à utiliser dans `fields`), libellé, type (texte, nombre, date, date et heure — ISO 8601 UTC —, liste, case à cocher) et options des listes.',
    scope: 'contacts:read',
    readOnly: true,
    input: {},
    call: () => ({ method: 'GET', path: '/custom-fields' }),
  },
  { name: 'list_tags', title: 'Lister les tags', description: 'Tags du compte avec le nombre de contacts.', scope: 'contacts:read', readOnly: true, input: {}, call: () => ({ method: 'GET', path: '/tags' }) },
  {
    name: 'add_tag_to_contact',
    title: 'Ajouter un tag à un contact',
    description: 'Ajoute un tag (créé s’il n’existe pas) à un contact. Peut déclencher les campagnes et automatisations liées à ce tag.',
    scope: 'tags:write',
    readOnly: false,
    input: { contact_id: id('Identifiant du contact'), name: z.string().min(1).max(60).describe('Nom du tag') },
    call: (a) => ({ method: 'POST', path: `/contacts/${a.contact_id}/tags`, body: { name: a.name } }),
  },
  {
    name: 'remove_tag_from_contact',
    title: 'Retirer un tag d’un contact',
    description: 'Retire un tag d’un contact.',
    scope: 'tags:write',
    readOnly: false,
    input: { contact_id: id('Identifiant du contact'), tag_id: id('Identifiant du tag') },
    call: (a) => ({ method: 'DELETE', path: `/contacts/${a.contact_id}/tags/${a.tag_id}` }),
  },
  { name: 'list_segments', title: 'Lister les segments', description: 'Segments enregistrés avec leur nombre de contacts.', scope: 'contacts:read', readOnly: true, input: {}, call: () => ({ method: 'GET', path: '/segments' }) },
  {
    name: 'list_segment_contacts',
    title: 'Contacts d’un segment',
    description: 'Liste paginée des contacts d’un segment.',
    scope: 'contacts:read',
    readOnly: true,
    input: { segment_id: id('Identifiant du segment'), ...page },
    call: ({ segment_id, ...query }) => ({ method: 'GET', path: `/segments/${segment_id}/contacts`, query }),
  },
  { name: 'list_funnels', title: 'Tunnels et statistiques', description: 'Tunnels de vente avec leurs étapes, leurs URL publiques, les vues et les inscriptions.', scope: 'funnels:read', readOnly: true, input: {}, call: () => ({ method: 'GET', path: '/funnels' }) },
  { name: 'list_newsletters', title: 'Newsletters', description: 'Newsletters (brouillons, programmées, envoyées) avec leurs statistiques d’envoi, d’ouverture et de clic.', scope: 'emails:read', readOnly: true, input: {}, call: () => ({ method: 'GET', path: '/broadcasts' }) },
  { name: 'list_campaigns', title: 'Campagnes email', description: 'Campagnes (séquences automatiques) avec leur tag déclencheur et leur nombre d’emails.', scope: 'emails:read', readOnly: true, input: {}, call: () => ({ method: 'GET', path: '/campaigns' }) },
  {
    name: 'enroll_in_campaign',
    title: 'Inscrire à une campagne',
    description: 'Inscrit un contact confirmé à une campagne email : il recevra la séquence.',
    scope: 'campaigns:write',
    readOnly: false,
    input: { campaign_id: id('Identifiant de la campagne'), contact_id: id('Identifiant du contact') },
    call: (a) => ({ method: 'POST', path: `/campaigns/${a.campaign_id}/enroll`, body: { contact_id: a.contact_id } }),
  },
  {
    name: 'record_purchase',
    title: 'Enregistrer un achat',
    description: 'Enregistre un achat pour un contact (par `contact_id` ou par `email`) ; déclenche les automatisations « Achat ». Idempotent sur `external_id`.',
    scope: 'purchases:write',
    readOnly: false,
    input: {
      contact_id: id('Identifiant du contact').optional(),
      email: z.string().max(254).optional(),
      first_name: z.string().max(200).optional(),
      last_name: z.string().max(200).optional(),
      product: z.string().min(1).max(200),
      amount: z.number().min(0).optional(),
      currency: z.string().length(3).optional().describe('Code ISO (EUR, USD…)'),
      external_id: z.string().max(200).optional().describe('Référence de la commande (évite les doublons)'),
    },
    call: (a) => ({ method: 'POST', path: '/purchases', body: a }),
  },
];

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const result = (data: unknown, isError = false): ToolResult => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }], ...(isError ? { isError: true } : {}) });

/** Calls /api/v1 on this same server (the socket the MCP request arrived on) with the caller's token. */
async function callV1(req: Request, token: string, c: V1Call): Promise<ToolResult> {
  // the local address of this connection is always one the server listens on (IPv4-mapped IPv6 → plain IPv4)
  const addr = (req.socket.localAddress ?? '127.0.0.1').replace(/^::ffff:/i, '');
  const host = addr.includes(':') ? `[${addr}]` : addr;
  const url = new URL(`http://${host}:${req.socket.localPort}/api/v1${c.path}`);
  for (const [k, v] of Object.entries(c.query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method: c.method,
    headers: { authorization: `Bearer ${token}`, ...(c.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: c.body !== undefined ? JSON.stringify(c.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const data: any = await res.json().catch(() => null);
  if (res.ok) return result(data);
  return result(`Erreur ${res.status} : ${data?.error_description ?? data?.error ?? 'requête refusée'}`, true);
}

function buildServer(req: Request, token: string, scopes: OAuthScope[]) {
  const server = new McpServer(
    { name: 'scalo', title: 'Scalo', version: '1.0.0' },
    { instructions: 'Outils du compte Scalo de l’utilisateur (tunnels de vente, emails, CRM). Les outils d’écriture agissent sur des données réelles : un tag ou une inscription à une campagne peut déclencher l’envoi d’emails.' },
  );
  for (const t of MCP_TOOLS) {
    server.registerTool(
      t.name,
      { title: t.title, description: `${t.description} (scope requis : ${t.scope})`, inputSchema: t.input, annotations: { readOnlyHint: t.readOnly, destructiveHint: false, openWorldHint: false } },
      async (args: unknown) => {
        if (!scopes.includes(t.scope)) {
          return result(`Scope « ${t.scope} » requis : l’application connectée n’a pas cette autorisation. Ajoutez ce scope à l’application dans Développeurs puis reconnectez-la.`, true);
        }
        try {
          return await callV1(req, token, t.call(args ?? {}));
        } catch (e) {
          console.error(`[mcp] ${t.name}:`, (e as Error).message);
          return result('Erreur interne du serveur', true);
        }
      },
    );
  }
  return server;
}

function unauthorized(res: Response, error: '' | 'invalid_request' | 'invalid_token', description: string) {
  const params = [`realm="scalo"`, ...(error ? [`error="${error}"`] : []), `resource_metadata="${METADATA_URL}"`];
  res.setHeader('WWW-Authenticate', `Bearer ${params.join(', ')}`);
  res.setHeader('Cache-Control', 'no-store');
  res.status(401).json({ error: error || 'invalid_token', error_description: description });
}

const cors = (res: Response) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id');
  res.setHeader('Access-Control-Max-Age', '600');
};

export function createMcpRouter() {
  const r = Router();

  const metadata = (_req: Request, res: Response) => {
    cors(res);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json({
      resource: MCP_RESOURCE,
      authorization_servers: [ISSUER],
      scopes_supported: OAUTH_SCOPES,
      bearer_methods_supported: ['header'],
      resource_name: 'Scalo',
      resource_documentation: `${env.PUBLIC_URL}/developers`,
    });
  };
  // RFC 9728 §3.1: also served with the resource path appended
  r.get('/.well-known/oauth-protected-resource', metadata);
  r.get('/.well-known/oauth-protected-resource/mcp', metadata);

  r.all('/mcp', async (req, res) => {
    cors(res);
    if (req.method === 'OPTIONS') return void res.status(204).end();

    const h = req.headers.authorization ?? '';
    const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
    // no credentials: no error code in the challenge (RFC 6750 §3.1)
    if (!m) return unauthorized(res, h ? 'invalid_request' : '', h ? 'En-tête Authorization invalide' : 'Jeton d’accès manquant (Authorization: Bearer …)');
    const t = await findAccessToken(m[1]);
    if (!t) return unauthorized(res, 'invalid_token', 'Jeton d’accès invalide, expiré ou révoqué');

    // stateless server: no session, hence no server-to-client stream (GET) and nothing to delete
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, OPTIONS');
      return void res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Méthode non autorisée : utilisez POST' }, id: null });
    }

    const server = buildServer(req, m[1], t.scopes);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return r;
}
