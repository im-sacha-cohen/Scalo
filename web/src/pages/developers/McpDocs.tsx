// Développeurs → « Connecter Claude » : the MCP server URL of the current workspace and how to connect Claude (or any
// MCP client) to it. One connector per workspace: a connection never sees the other businesses of the person.
import { OAUTH_SCOPE_INFO, workspaceMcpUrl, type OAuthScope } from '@scalo/shared';
import { Bot } from 'lucide-react';
import { Card, CardHeader } from '../../components/ui';
import { useEdition } from '../../lib/edition';
import { CodeBlock, CopyValue } from '../oauth/common';

const ORIGIN = window.location.origin;
export const MCP_URL = `${ORIGIN}/mcp`;

const TOOLS: [string, string, OAuthScope][] = [
  ['get_account', 'Compte connecté', 'profile'],
  ['list_contacts · get_contact', 'Lister, chercher, consulter des contacts', 'contacts:read'],
  ['create_contact · update_contact', 'Créer / mettre à jour des contacts', 'contacts:write'],
  ['list_tags', 'Tags et nombre de contacts', 'contacts:read'],
  ['add_tag_to_contact · remove_tag_from_contact', 'Taguer un contact', 'tags:write'],
  ['list_segments · list_segment_contacts', 'Segments (lecture)', 'contacts:read'],
  ['list_funnels', 'Tunnels, étapes, vues et inscriptions', 'funnels:read'],
  ['list_newsletters · list_campaigns · get_newsletter · get_campaign', 'Newsletters, campagnes, contenu et statistiques', 'emails:read'],
  ['create_newsletter · update_newsletter · send_test_email', 'Rédiger une newsletter, s’envoyer un test', 'emails:write'],
  ['schedule_newsletter · unschedule_newsletter', 'Programmer l’envoi, l’annuler', 'emails:write'],
  ['create_campaign · add_campaign_email · update_campaign_email', 'Créer une séquence automatique et ses emails', 'emails:write'],
  ['enroll_in_campaign', 'Inscrire un contact à une campagne', 'campaigns:write'],
  ['record_purchase', 'Enregistrer un achat', 'purchases:write'],
];

const code = 'font-mono text-[13px]';
/** Name of the connector in Claude Code: `scalo-<workspace>`. */
const connectorName = (name: string) =>
  `scalo-${
    name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || 'espace'
  }`;

export function McpDocs() {
  const account = useEdition().info?.account;
  const url = account ? workspaceMcpUrl(ORIGIN, account.id) : MCP_URL;
  return (
    <Card>
      <CardHeader icon={Bot} title="Connecter Claude" description="Pilotez votre espace de travail depuis Claude ou tout client compatible MCP (Model Context Protocol)." />
      <div className="space-y-5 text-sm text-slate-700">
        <div>
          <p className="mb-1.5 text-xs font-medium text-slate-500">
            URL du serveur MCP de l’espace {account ? <strong className="font-semibold text-slate-700">« {account.name} »</strong> : 'courant'} (transport Streamable HTTP)
          </p>
          <CopyValue value={url} />
          <p className="mt-1.5 text-xs text-slate-500">
            Cette adresse ne donne accès qu’à cet espace. Pour un autre business, changez d’espace (en haut à gauche) et ajoutez un second connecteur avec son adresse. L’adresse{' '}
            <span className="font-mono">{MCP_URL}</span> laisse choisir l’espace au moment d’autoriser.
          </p>
        </div>

        <section>
          <h4 className="font-semibold text-slate-900">1. Ajoutez le connecteur dans Claude</h4>
          <ol className="mt-1.5 list-decimal space-y-1 pl-5">
            <li>Dans Claude : Paramètres → Connecteurs → « Ajouter un connecteur personnalisé ».</li>
            <li>Donnez-lui le nom de l’espace (ex. « Scalo – {account?.name ?? 'Mon espace'} ») et collez l’URL du serveur MCP, sans rien d’autre.</li>
            <li>Claude ouvre l’écran d’autorisation Scalo : connectez-vous et acceptez. Vous pouvez révoquer l’accès à tout moment dans Paramètres → Applications connectées.</li>
          </ol>
          <p className="mt-3 text-xs font-medium text-slate-500">Claude Code</p>
          <CodeBlock className="mt-1.5" code={`claude mcp add --transport http ${connectorName(account?.name ?? '')} ${url}`} />
        </section>

        <section>
          <h4 className="font-semibold text-slate-900">2. Autres clients MCP : créez une application</h4>
          <p className="mt-1.5">
            Claude et les outils locaux s’enregistrent tout seuls. Un autre client hébergé a besoin d’une application : « Nouvelle application » ci-dessus, avec l’adresse de redirection de ce client et les scopes à lui donner (plus <span className={code}>offline_access</span> pour rester connecté).
          </p>
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
            jeton, <span className="font-mono">POST /mcp/&lt;espace&gt;</span> répond <span className="font-mono">401</span> avec l’en-tête <span className="font-mono">WWW-Authenticate</span> qui pointe vers{' '}
            <span className="font-mono">/.well-known/oauth-protected-resource/mcp/&lt;espace&gt;</span> (découverte automatique du serveur d’autorisation). Un jeton d’un autre espace y est refusé.
          </p>
        </section>
      </div>
    </Card>
  );
}
