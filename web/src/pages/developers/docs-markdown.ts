// The whole developer documentation (MCP, REST API, OAuth 2.0) as one Markdown file, built from the same data as the
// Développeurs tabs: something to copy or download and hand to an agent that is not connected to Scalo.
import { OAUTH_SCOPES, OAUTH_SCOPE_INFO, workspaceMcpUrl } from '@scalo/shared';
import { API_GROUPS, ERRORS, OAUTH_ENDPOINTS } from './Docs';
import { MCP_TOOL_GROUPS } from './McpDocs';

/** `|` would break a Markdown table cell. */
const cell = (s: string) => s.replace(/\|/g, '\\|');

export function developerDocsMarkdown(origin: string, workspace?: { id: number; name: string }): string {
  const api = `${origin}/api/v1`;
  const oneUrl = workspace ? workspaceMcpUrl(origin, workspace.id) : `${origin}/mcp/<id de l’espace>`;
  const out: string[] = [];
  const p = (...lines: string[]) => out.push(...lines, '');

  p(
    '# Scalo — documentation développeur',
    '',
    `Instance : ${origin}${workspace ? ` · espace de travail « ${workspace.name} » (id ${workspace.id})` : ''}`,
    '',
    'Trois façons de se brancher sur Scalo : le serveur MCP (un client MCP, sans code), l’API REST (HTTP + JSON) et OAuth 2.0 (qui délivre les jetons de l’API). Chaque espace de travail est un business séparé : ses contacts, tunnels, emails et ventes.',
  );

  p('## 1. Serveur MCP', 'Transport Streamable HTTP. Authentification OAuth 2.0 découverte automatiquement : aucune clé à fournir au client.');
  p(
    '| URL | Accès |',
    '| --- | --- |',
    `| \`${oneUrl}\` | Un seul espace${workspace ? ` (« ${cell(workspace.name)} »)` : ''} : un jeton d’un autre espace y est refusé. |`,
    `| \`${origin}/mcp\` | L’espace se choisit à l’autorisation, ou « Tous mes espaces » (chaque outil prend alors un \`workspace_id\`). |`,
  );
  p(
    '### Connexion',
    '1. Dans le client MCP, ajoutez un serveur MCP distant avec l’URL, sans clé ni jeton.',
    '2. Le client ouvre l’écran d’autorisation Scalo : l’utilisateur se connecte, choisit l’espace et accepte les scopes.',
    '3. Révocation à tout moment dans Paramètres → Applications connectées.',
  );
  p('Configuration par fichier (format `mcpServers`) :', '```json', JSON.stringify({ mcpServers: { scalo: { type: 'http', url: oneUrl } } }, null, 2), '```');
  p(
    'Découverte : sans jeton, `POST /mcp` répond `401` avec `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"` (RFC 9728). Les clients locaux et connus s’enregistrent seuls (`POST /oauth/register`, RFC 7591, PKCE obligatoire) ; un autre client hébergé a besoin d’une application créée dans Développeurs → Applications.',
  );
  out.push('### Outils', '', '| Outil | Rôle | Scope |', '| --- | --- | --- |');
  for (const g of MCP_TOOL_GROUPS) for (const [name, what, scope] of g.tools) out.push(`| \`${name}\` | ${g.title} — ${cell(what)} | \`${scope}\` |`);
  out.push('');
  p(
    'Avec « Tous mes espaces » : `list_workspaces` liste les espaces accessibles, chaque outil exige `workspace_id`, et chaque résultat commence par l’espace sur lequel il a porté. Demandez à l’utilisateur quel espace utiliser avant d’agir.',
    'Les outils passent par l’API REST : mêmes scopes, mêmes effets (un tag peut déclencher une campagne), même limite de 120 requêtes par minute.',
  );

  p(
    '## 2. API REST',
    `URL de base : \`${api}\`. Corps et réponses en JSON. Chaque requête porte un jeton d’accès OAuth : \`Authorization: Bearer scalo_at_…\`.`,
    '```bash',
    `curl "${api}/contacts?limit=10" \\`,
    '  -H "Authorization: Bearer $ACCESS_TOKEN"',
    '```',
  );
  for (const g of API_GROUPS) {
    out.push(`### ${g.title}`, '', '| Méthode | Chemin | Rôle | Scope | Paramètres |', '| --- | --- | --- | --- | --- |');
    for (const [m, path, what, scope, body] of g.routes) out.push(`| ${m} | \`${path}\` | ${cell(what)} | \`${scope}\` | ${body ? `\`${cell(body)}\`` : ''} |`);
    out.push('');
  }
  p(
    '### Espaces de travail',
    'Un jeton donné pour un espace n’agit que sur cet espace. Un jeton « Tous mes espaces » choisit l’espace de chaque requête avec l’en-tête `X-Scalo-Workspace: <id>` (par défaut : l’espace depuis lequel l’accès a été donné).',
  );
  out.push('### Erreurs', '', 'Réponses JSON avec un champ `error` (et `error_description` quand c’est utile).', '', '| Code | Signification |', '| --- | --- |');
  for (const [k, v] of ERRORS) out.push(`| \`${k}\` | ${cell(v)} |`);
  out.push('');

  p(
    '## 3. OAuth 2.0',
    'Code d’autorisation avec PKCE (S256) et jetons de rafraîchissement avec rotation. Créez d’abord une application (Développeurs → Applications) pour obtenir un `client_id` (et un `client_secret` pour une application confidentielle).',
    '- Code d’autorisation : 60 secondes, usage unique.',
    '- Jeton d’accès (`scalo_at_…`) : 1 heure.',
    '- Jeton de rafraîchissement (`scalo_rt_…`) : 30 jours, avec le scope `offline_access`. Chaque usage en renvoie un nouveau ; réutiliser un ancien révoque toute l’autorisation.',
  );
  p(
    '### Parcours',
    `1. Redirigez l’utilisateur vers \`GET ${origin}/oauth/authorize\` avec \`response_type=code\`, \`client_id\`, \`redirect_uri\` (identique à une adresse enregistrée), \`scope\` (séparés par des espaces), \`state\` et \`code_challenge\` + \`code_challenge_method=S256\`.`,
    '2. L’utilisateur se connecte, choisit l’espace et accepte.',
    '3. Retour sur `redirect_uri` avec `code`, `state` et `iss` (ou `error=access_denied`). Vérifiez `state` et `iss`.',
    `4. Échangez le code : \`POST ${origin}/oauth/token\` avec \`grant_type=authorization_code\`, \`code\`, \`redirect_uri\`, \`code_verifier\`.`,
    '5. Appelez l’API ; à expiration, `grant_type=refresh_token` avec `refresh_token`.',
  );
  p(
    '```bash',
    `curl -X POST ${origin}/oauth/token \\`,
    '  -u "$CLIENT_ID:$CLIENT_SECRET" \\',
    '  -d grant_type=authorization_code -d code=$CODE \\',
    '  -d redirect_uri=$REDIRECT_URI -d code_verifier=$CODE_VERIFIER',
    '```',
  );
  out.push('### Endpoints', '', '| Endpoint | Rôle |', '| --- | --- |');
  for (const [k, v] of OAUTH_ENDPOINTS) out.push(`| \`${k}\` | ${cell(v)} |`);
  out.push(
    '',
    'Authentification du client : `client_secret_basic` ou `client_secret_post` ; application publique : `client_id` seul avec PKCE. Corps en `application/x-www-form-urlencoded` (JSON accepté).',
    '',
  );
  out.push('### Scopes', '', '| Scope | Droit |', '| --- | --- |');
  for (const s of OAUTH_SCOPES) out.push(`| \`${s}\` | ${cell(OAUTH_SCOPE_INFO[s].label)} — ${cell(OAUTH_SCOPE_INFO[s].description)} |`);
  out.push('');
  p(
    '### Sécurité',
    '- Jamais de `client_secret` dans une application web ou mobile : application publique + PKCE.',
    '- Un `state` aléatoire par demande, vérifié au retour avec `iss`.',
    '- Jetons gardés côté serveur ; leurs préfixes (`scalo_at_`, `scalo_rt_`, `scalo_cs_`) permettent de les détecter en cas de fuite.',
    '- Révoquez les jetons à la déconnexion (`POST /oauth/revoke`).',
  );
  return out.join('\n').trimEnd() + '\n';
}
