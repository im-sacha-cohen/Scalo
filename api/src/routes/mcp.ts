// MCP server (Model Context Protocol) — lets Claude or any MCP client drive a Scalo account.
//
//   POST /mcp                                     Streamable HTTP transport (stateless, JSON responses)
//   POST /mcp/<workspace id>                      the same, bound to one workspace: connect one client per business
//   GET  /.well-known/oauth-protected-resource    RFC 9728 metadata: tells the client which authorization server to use
//
// Workspaces: an access token is bound to one workspace, chosen on the consent screen. Through /mcp/<id> the client
// asks for that workspace (`resource` parameter, RFC 8707): the consent screen imposes it and the endpoint refuses a
// token of another workspace — two connectors in Claude never mix up two businesses.
// Through /mcp the person may also grant « Tous mes espaces »: every tool then takes a required `workspace_id` (no
// "current workspace" kept between calls — the same connector serves every conversation), list_workspaces gives the
// choices, and each result names the workspace it acted on.
//
// Authentication: the OAuth 2.0 access tokens of the existing authorization server (`Authorization: Bearer scalo_at_…`),
// same scopes as the public API. Claude and local tools only need the URL: they discover the authorization server and
// register themselves (POST /oauth/register). Any other client uses an application created in "Développeurs".
//
// Each tool is a thin wrapper around one /api/v1 endpoint, called in-process over the loopback interface with the
// caller's own token: validation, scope checks, account isolation, rate limit and business rules are exactly those of
// the public API — nothing is re-implemented here.
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { OAUTH_SCOPES, type OAuthScope } from '@scalo/shared';
import { db } from '../db';
import { env } from '../env';
import { findAccessToken, ISSUER } from '../services/oauth-server';
import { tokenWorkspace, tokenWorkspaces } from '../services/workspaces';
import { WORKSPACE_HEADER } from '../workspace-access';

export const MCP_RESOURCE = `${env.PUBLIC_URL}/mcp`;
const metadataUrl = (workspace?: number) => `${env.PUBLIC_URL}/.well-known/oauth-protected-resource${workspace ? `/mcp/${workspace}` : ''}`;
const resourceOf = (workspace?: number) => (workspace ? `${MCP_RESOURCE}/${workspace}` : MCP_RESOURCE);

/** `resource` of an authorization request (RFC 8707) → the workspace whose MCP endpoint it names, else null. */
export function workspaceOfResource(resource: string): number | null {
  if (!resource.startsWith(`${MCP_RESOURCE}/`)) return null;
  const rest = resource.slice(MCP_RESOURCE.length + 1).replace(/\/$/, '');
  if (!/^\d{1,15}$/.test(rest)) return null;
  return Number(rest);
}

/** `:workspace` of the route: undefined on /mcp, null if malformed. */
const workspaceParam = (raw: string | undefined) => (raw === undefined ? undefined : /^\d{1,15}$/.test(raw) && Number(raw) > 0 ? Number(raw) : null);

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

const emailText = {
  preheader: z.string().max(150).optional().describe('Phrase d’aperçu affichée après l’objet dans la boîte de réception'),
  paragraphs: z
    .array(z.string().max(5000))
    .min(1)
    .max(50)
    .describe('Paragraphes du corps de l’email. Mise en forme : **gras**, *italique*, [texte du lien](https://…). Variables : {{first_name}}, {{last_name}}, {{email}}.'),
  button_label: z.string().max(60).optional().describe('Texte du bouton (avec button_url)'),
  button_url: z.string().max(500).optional().describe('Lien du bouton, https://…'),
};
const emailTextPatch = { ...emailText, paragraphs: emailText.paragraphs.optional().describe('Nouveau corps complet (remplace tout le contenu, avec preheader et bouton)') };
const NO_SMTP = 'Sans serveur SMTP configuré dans Scalo (Paramètres), les emails ne partent pas réellement : ils restent visibles dans Emails → Suivi des envois.';

/** Tools = endpoints of the public API v1 (see routes/v1.ts, routes/v1-crm.ts, routes/v1-emails.ts). */
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
  { name: 'get_newsletter', title: 'Détail d’une newsletter', description: 'Une newsletter avec son contenu, ses destinataires, son statut et ses statistiques.', scope: 'emails:read', readOnly: true, input: { newsletter_id: id('Identifiant de la newsletter') }, call: (a) => ({ method: 'GET', path: `/broadcasts/${a.newsletter_id}` }) },
  {
    name: 'create_newsletter',
    title: 'Rédiger une newsletter',
    description:
      'Crée une newsletter en brouillon (rien n’est envoyé). Destinataires : tous les contacts confirmés et abonnés, ou ceux d’un tag (`tag_id`) ou d’un segment (`segment_id`). Pour l’envoyer : schedule_newsletter.',
    scope: 'emails:write',
    readOnly: false,
    input: { subject: z.string().min(1).max(250), ...emailText, tag_id: id('Envoyer seulement aux contacts de ce tag').optional(), segment_id: id('Envoyer seulement aux contacts de ce segment').optional() },
    call: (a) => ({ method: 'POST', path: '/broadcasts', body: a }),
  },
  {
    name: 'update_newsletter',
    title: 'Modifier une newsletter',
    description: 'Modifie une newsletter en brouillon ou programmée (objet, corps, destinataires ; `tag_id` / `segment_id` à null = tous les contacts). Impossible une fois envoyée.',
    scope: 'emails:write',
    readOnly: false,
    input: {
      newsletter_id: id('Identifiant de la newsletter'),
      subject: z.string().min(1).max(250).optional(),
      ...emailTextPatch,
      tag_id: id('Identifiant du tag').nullable().optional(),
      segment_id: id('Identifiant du segment').nullable().optional(),
    },
    call: ({ newsletter_id, ...body }) => ({ method: 'PATCH', path: `/broadcasts/${newsletter_id}`, body }),
  },
  {
    name: 'send_test_email',
    title: 'Envoyer un test',
    description: `Envoie tout de suite la newsletter à une seule adresse, avec [TEST] dans l’objet. ${NO_SMTP}`,
    scope: 'emails:write',
    readOnly: false,
    input: { newsletter_id: id('Identifiant de la newsletter'), email: z.string().max(254).describe('Adresse qui reçoit le test') },
    call: (a) => ({ method: 'POST', path: `/broadcasts/${a.newsletter_id}/test`, body: { email: a.email } }),
  },
  {
    name: 'schedule_newsletter',
    title: 'Programmer l’envoi d’une newsletter',
    description: `Programme l’envoi à tous ses destinataires, de 1 minute à 1 an à l’avance. Demandez confirmation à l’utilisateur avant : l’envoi part tout seul à l’heure dite. ${NO_SMTP}`,
    scope: 'emails:write',
    readOnly: false,
    input: { newsletter_id: id('Identifiant de la newsletter'), scheduled_at: z.string().describe('Date et heure ISO 8601 avec fuseau, ex. 2026-11-05T09:00:00+01:00') },
    call: (a) => ({ method: 'POST', path: `/broadcasts/${a.newsletter_id}/schedule`, body: { scheduled_at: a.scheduled_at } }),
  },
  {
    name: 'unschedule_newsletter',
    title: 'Annuler la programmation',
    description: 'Repasse une newsletter programmée en brouillon (tant que l’envoi n’a pas commencé).',
    scope: 'emails:write',
    readOnly: false,
    input: { newsletter_id: id('Identifiant de la newsletter') },
    call: (a) => ({ method: 'POST', path: `/broadcasts/${a.newsletter_id}/unschedule` }),
  },
  { name: 'get_campaign', title: 'Détail d’une campagne', description: 'Une campagne avec ses emails (objet, contenu, délai), son nombre d’inscrits et ses statistiques.', scope: 'emails:read', readOnly: true, input: { campaign_id: id('Identifiant de la campagne') }, call: (a) => ({ method: 'GET', path: `/campaigns/${a.campaign_id}` }) },
  {
    name: 'create_campaign',
    title: 'Créer une campagne',
    description:
      'Crée une campagne email automatique (séquence), vide. `trigger_tag` : nom du tag qui inscrit automatiquement un contact (créé s’il n’existe pas) ; `stop_tag` : tag qui l’arrête. Ajoutez ensuite les emails avec add_campaign_email.',
    scope: 'emails:write',
    readOnly: false,
    input: { name: z.string().min(1).max(120), trigger_tag: z.string().min(1).max(60).optional(), stop_tag: z.string().min(1).max(60).optional() },
    call: (a) => ({ method: 'POST', path: '/campaigns', body: a }),
  },
  {
    name: 'add_campaign_email',
    title: 'Ajouter un email à une campagne',
    description: `Ajoute un email à la fin de la séquence. \`delay_days\` : jours d’attente après l’email précédent (après l’inscription pour le premier, 0 = tout de suite). Les inscrits actifs pour qui il est déjà dû le reçoivent maintenant, sauf \`apply_to_existing: false\`. ${NO_SMTP}`,
    scope: 'emails:write',
    readOnly: false,
    input: { campaign_id: id('Identifiant de la campagne'), subject: z.string().min(1).max(250), delay_days: z.number().int().min(0).max(3650), ...emailText, apply_to_existing: z.boolean().optional() },
    call: ({ campaign_id, ...body }) => ({ method: 'POST', path: `/campaigns/${campaign_id}/emails`, body }),
  },
  {
    name: 'update_campaign_email',
    title: 'Modifier un email de campagne',
    description: 'Modifie l’objet, le délai ou le corps d’un email de campagne (un nouveau délai décale les envois en attente).',
    scope: 'emails:write',
    readOnly: false,
    input: { email_id: id('Identifiant de l’email (voir get_campaign)'), subject: z.string().min(1).max(250).optional(), delay_days: z.number().int().min(0).max(3650).optional(), ...emailTextPatch },
    call: ({ email_id, ...body }) => ({ method: 'PATCH', path: `/campaign-emails/${email_id}`, body }),
  },
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
async function callV1(req: Request, token: string, workspace: number, c: V1Call): Promise<ToolResult> {
  // the local address of this connection is always one the server listens on (IPv4-mapped IPv6 → plain IPv4)
  const addr = (req.socket.localAddress ?? '127.0.0.1').replace(/^::ffff:/i, '');
  const host = addr.includes(':') ? `[${addr}]` : addr;
  const url = new URL(`http://${host}:${req.socket.localPort}/api/v1${c.path}`);
  for (const [k, v] of Object.entries(c.query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method: c.method,
    headers: { authorization: `Bearer ${token}`, [WORKSPACE_HEADER]: String(workspace), ...(c.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: c.body !== undefined ? JSON.stringify(c.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const data: any = await res.json().catch(() => null);
  if (res.ok) return result(data);
  return result(`Erreur ${res.status} : ${data?.error_description ?? data?.error ?? 'requête refusée'}`, true);
}

type Ws = { id: number; name: string };
/** One workspace (bound token, or /mcp/<id>), or every workspace of the person: the tools then name it on each call. */
type WorkspaceScope = { kind: 'one'; workspace: Ws } | { kind: 'all'; workspaces: Ws[] };

const RULES = 'Les outils d’écriture agissent sur des données réelles : un tag ou une inscription à une campagne peut déclencher l’envoi d’emails. Demandez confirmation avant de programmer l’envoi d’une newsletter.';
const label = (w: Ws) => `« ${w.name} » (workspace_id ${w.id})`;

function instructions(ws: WorkspaceScope) {
  if (ws.kind === 'one') return `Outils de l’espace de travail Scalo « ${ws.workspace.name} » de l’utilisateur (tunnels de vente, emails, CRM) : ils n’agissent que sur cet espace. ${RULES}`;
  return [
    `Outils Scalo de l’utilisateur (tunnels de vente, emails, CRM) sur plusieurs espaces de travail, un par business, aux données entièrement séparées : ${ws.workspaces.map(label).join(', ')}.`,
    'Chaque outil exige `workspace_id`. Si l’utilisateur n’a pas dit sur quel espace travailler, demandez-le avant le premier appel (list_workspaces donne la liste à jour). Gardez ensuite le même espace pour toute la conversation, sauf s’il demande d’en changer, et nommez l’espace dans vos réponses. Ne recopiez jamais des contacts ou des contenus d’un espace à l’autre sans qu’il le demande.',
    RULES,
  ].join(' ');
}

function buildServer(req: Request, token: string, scopes: OAuthScope[], ws: WorkspaceScope) {
  const server = new McpServer({ name: 'scalo', title: 'Scalo', version: '1.0.0' }, { instructions: instructions(ws) });
  const annotations = (readOnly: boolean) => ({ readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false });
  if (ws.kind === 'all') {
    server.registerTool(
      'list_workspaces',
      { title: 'Espaces de travail', description: 'Espaces de travail Scalo auxquels cette connexion donne accès (un par business) : `workspace_id` à passer à chaque outil, et nom.', inputSchema: {}, annotations: annotations(true) },
      async () => result({ workspaces: ws.workspaces.map((w) => ({ workspace_id: w.id, name: w.name })) }),
    );
  }
  for (const t of MCP_TOOLS) {
    const input = ws.kind === 'all' ? { workspace_id: id('Espace de travail sur lequel agir (voir list_workspaces)'), ...t.input } : t.input;
    server.registerTool(t.name, { title: t.title, description: `${t.description} (scope requis : ${t.scope})`, inputSchema: input, annotations: annotations(t.readOnly) }, async (raw: unknown) => {
      if (!scopes.includes(t.scope)) {
        return result(`Scope « ${t.scope} » requis : l’application connectée n’a pas cette autorisation. Déconnectez puis reconnectez Scalo dans votre client MCP pour l’accorder (ou ajoutez ce scope à l’application dans Développeurs).`, true);
      }
      const { workspace_id, ...args } = (raw ?? {}) as Record<string, unknown>;
      const target = ws.kind === 'one' ? ws.workspace : ws.workspaces.find((w) => w.id === workspace_id);
      if (!target) return result(`Espace de travail ${String(workspace_id)} inconnu ou inaccessible. Espaces disponibles : ${(ws.kind === 'all' ? ws.workspaces : []).map(label).join(', ')}.`, true);
      try {
        const r = await callV1(req, token, target.id, t.call(ws.kind === 'one' ? (raw ?? {}) : args));
        // several workspaces: every result says which business it comes from
        return ws.kind === 'all' ? { ...r, content: [{ type: 'text' as const, text: `Espace de travail : ${label(target)}` }, ...r.content] } : r;
      } catch (e) {
        console.error(`[mcp] ${t.name}:`, (e as Error).message);
        return result('Erreur interne du serveur', true);
      }
    });
  }
  return server;
}

function unauthorized(res: Response, error: '' | 'invalid_request' | 'invalid_token', description: string, workspace?: number) {
  const params = [`realm="scalo"`, ...(error ? [`error="${error}"`] : []), `resource_metadata="${metadataUrl(workspace)}"`];
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

  const metadata = (req: Request, res: Response) => {
    cors(res);
    const workspace = workspaceParam(req.params.workspace as string | undefined);
    if (workspace === null) return void res.status(404).json({ error: 'Ressource inconnue' });
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json({
      resource: resourceOf(workspace),
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
  r.get('/.well-known/oauth-protected-resource/mcp/:workspace', metadata);

  const handle = async (req: Request, res: Response) => {
    cors(res);
    if (req.method === 'OPTIONS') return void res.status(204).end();
    const workspace = workspaceParam(req.params.workspace as string | undefined);
    if (workspace === null) return void res.status(404).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Espace de travail inconnu : utilisez l’adresse /mcp/<numéro> indiquée dans Scalo' }, id: null });

    const h = req.headers.authorization ?? '';
    const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
    // no credentials: no error code in the challenge (RFC 6750 §3.1)
    if (!m) return unauthorized(res, h ? 'invalid_request' : '', h ? 'En-tête Authorization invalide' : 'Jeton d’accès manquant (Authorization: Bearer …)', workspace);
    const t = await findAccessToken(m[1]);
    if (!t) return unauthorized(res, 'invalid_token', 'Jeton d’accès invalide, expiré ou révoqué', workspace);
    let scope: WorkspaceScope;
    if (workspace === undefined && t.person_id !== null) {
      // granted to every workspace: those the person may still authorize, read again on each request
      const workspaces = await tokenWorkspaces({ user_id: t.user_id, person_id: t.person_id });
      if (!workspaces.length) return unauthorized(res, 'invalid_token', 'Aucun espace de travail accessible avec cette autorisation');
      scope = { kind: 'all', workspaces: workspaces.map((w) => ({ id: w.id, name: w.name })) };
    } else {
      // a bound token only works on the endpoint of its own workspace (the client reconnects and the consent imposes it)
      const target = await tokenWorkspace(t, workspace);
      if (target === null) return unauthorized(res, 'invalid_token', 'Ce jeton donne accès à un autre espace de travail', workspace);
      const account = await db.selectFrom('accounts').select('name').where('id', '=', target).executeTakeFirst();
      if (!account) return unauthorized(res, 'invalid_token', 'Espace de travail supprimé', workspace);
      scope = { kind: 'one', workspace: { id: target, name: account.name } };
    }

    // stateless server: no session, hence no server-to-client stream (GET) and nothing to delete
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, OPTIONS');
      return void res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Méthode non autorisée : utilisez POST' }, id: null });
    }

    const server = buildServer(req, m[1], t.scopes, scope);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
  r.all('/mcp', handle);
  r.all('/mcp/:workspace', handle);

  return r;
}
