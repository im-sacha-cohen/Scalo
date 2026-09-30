// Développeurs → « Connecter Claude » : the MCP server URL and how to connect Claude (or any MCP client) to an account.
import { OAUTH_SCOPE_INFO, type OAuthScope } from '@scalo/shared';
import { Bot } from 'lucide-react';
import { Card, CardHeader } from '../../components/ui';
import { CodeBlock, CopyValue } from '../oauth/common';

const ORIGIN = window.location.origin;
export const MCP_URL = `${ORIGIN}/mcp`;
/** Redirect URI of Claude's connectors (claude.ai, Claude Desktop). */
export const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

const TOOLS: [string, string, OAuthScope][] = [
  ['get_account', 'Compte connecté', 'profile'],
  ['list_contacts · get_contact', 'Lister, chercher, consulter des contacts', 'contacts:read'],
  ['create_contact · update_contact', 'Créer / mettre à jour des contacts', 'contacts:write'],
  ['list_tags', 'Tags et nombre de contacts', 'contacts:read'],
  ['add_tag_to_contact · remove_tag_from_contact', 'Taguer un contact', 'tags:write'],
  ['list_segments · list_segment_contacts', 'Segments (lecture)', 'contacts:read'],
  ['list_funnels', 'Tunnels, étapes, vues et inscriptions', 'funnels:read'],
  ['list_newsletters · list_campaigns', 'Newsletters, campagnes et statistiques', 'emails:read'],
  ['enroll_in_campaign', 'Inscrire un contact à une campagne', 'campaigns:write'],
  ['record_purchase', 'Enregistrer un achat', 'purchases:write'],
];

const code = 'font-mono text-[13px]';

export function McpDocs() {
  return (
    <Card>
      <CardHeader icon={Bot} title="Connecter Claude" description="Pilotez votre compte depuis Claude ou tout client compatible MCP (Model Context Protocol)." />
      <div className="space-y-5 text-sm text-slate-700">
        <div>
          <p className="mb-1.5 text-xs font-medium text-slate-500">URL du serveur MCP (transport Streamable HTTP)</p>
          <CopyValue value={MCP_URL} />
        </div>

        <section>
          <h4 className="font-semibold text-slate-900">1. Créez une application</h4>
          <p className="mt-1.5">
            Cliquez sur « Nouvelle application » ci-dessus : type <strong>Confidentielle</strong>, les scopes que vous souhaitez donner à Claude (plus <span className={code}>offline_access</span>{' '}
            pour rester connecté), et cette adresse de redirection :
          </p>
          <CopyValue className="mt-2" value={CLAUDE_CALLBACK} />
          <p className="mt-2 text-xs text-slate-500">Conservez le client_id et le client_secret affichés à la création. Pas d’enregistrement dynamique de client : seules vos applications peuvent se connecter.</p>
        </section>

        <section>
          <h4 className="font-semibold text-slate-900">2. Ajoutez le connecteur dans Claude</h4>
          <ol className="mt-1.5 list-decimal space-y-1 pl-5">
            <li>Dans Claude : Paramètres → Connecteurs → « Ajouter un connecteur personnalisé ».</li>
            <li>Collez l’URL du serveur MCP, puis dans les paramètres avancés le client_id et le client_secret de votre application.</li>
            <li>Claude ouvre l’écran d’autorisation Scalo : connectez-vous et acceptez. Vous pouvez révoquer l’accès à tout moment dans Paramètres → Applications connectées.</li>
          </ol>
          <p className="mt-3 text-xs font-medium text-slate-500">Claude Code (ajoutez aussi http://localhost:8765/callback aux adresses de redirection de l’application)</p>
          <CodeBlock className="mt-1.5" code={`claude mcp add --transport http scalo ${MCP_URL} \\\n  --client-id scalo_app_… --client-secret --callback-port 8765`} />
        </section>

        <section>
          <h4 className="font-semibold text-slate-900">3. Outils disponibles</h4>
          <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-left text-[13px]">
              <tbody className="divide-y divide-slate-100">
                {TOOLS.map(([name, what, scope]) => (
                  <tr key={name}>
                    <td className="px-3 py-2 font-mono text-slate-800">{name}</td>
                    <td className="px-3 py-2 text-slate-600">{what}</td>
                    <td className="px-3 py-2 font-mono text-xs whitespace-nowrap text-brand-700" title={OAUTH_SCOPE_INFO[scope].description}>
                      {scope}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Chaque outil appelle l’API publique avec le jeton de l’application : mêmes scopes, mêmes règles (un tag peut déclencher une campagne), même limite de 120 requêtes par minute. Sans
            jeton, <span className="font-mono">POST /mcp</span> répond <span className="font-mono">401</span> avec l’en-tête <span className="font-mono">WWW-Authenticate</span> qui pointe vers{' '}
            <span className="font-mono">/.well-known/oauth-protected-resource</span> (découverte automatique du serveur d’autorisation).
          </p>
        </section>
      </div>
    </Card>
  );
}
