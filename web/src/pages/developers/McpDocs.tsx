// Développeurs → MCP: the MCP server URL (this workspace, or all of them chosen at authorization), how to connect any
// MCP client, and the tools it gets. A connection bound to one workspace never sees the other businesses of the person.
import { useState } from 'react';
import { workspaceMcpUrl, type OAuthScope } from '@scalo/shared';
import { Building2, FileJson, Gauge, KeyRound, Mail, Plug, Send, ShieldCheck, ShoppingBag, Tag, Users, Funnel, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router';
import { Button, Card, cx } from '../../components/ui';
import { useEdition } from '../../lib/edition';
import { useLoad } from '../../lib/hooks';
import { api } from '../../lib/api';
import { CodeBlock, CopyValue } from '../oauth/common';
import { C, Fact, Note, ORIGIN, Scope, Section, Steps } from './doc-ui';

const ALL_URL = `${ORIGIN}/mcp`;

export type Tool = [name: string, what: string, scope: OAuthScope];
export const MCP_TOOL_GROUPS: { icon: LucideIcon; title: string; tools: Tool[] }[] = [
  {
    icon: Users,
    title: 'Contacts',
    tools: [
      ['list_contacts', 'Lister et chercher des contacts', 'contacts:read'],
      ['get_contact', 'Consulter un contact, ses tags et ses champs', 'contacts:read'],
      ['create_contact', 'Créer un contact', 'contacts:write'],
      ['update_contact', 'Modifier un contact', 'contacts:write'],
      ['list_custom_fields', 'Champs personnalisés', 'contacts:read'],
    ],
  },
  {
    icon: Tag,
    title: 'Tags et segments',
    tools: [
      ['list_tags', 'Tags et nombre de contacts', 'contacts:read'],
      ['add_tag_to_contact', 'Taguer un contact (peut lancer une campagne)', 'tags:write'],
      ['remove_tag_from_contact', 'Retirer un tag', 'tags:write'],
      ['list_segments', 'Segments enregistrés', 'contacts:read'],
      ['list_segment_contacts', 'Contacts d’un segment', 'contacts:read'],
    ],
  },
  {
    icon: Send,
    title: 'Newsletters',
    tools: [
      ['list_newsletters', 'Newsletters et statistiques', 'emails:read'],
      ['get_newsletter', 'Contenu d’une newsletter', 'emails:read'],
      ['create_newsletter', 'Rédiger une newsletter', 'emails:write'],
      ['update_newsletter', 'La modifier', 'emails:write'],
      ['send_test_email', 'S’envoyer un test', 'emails:write'],
      ['schedule_newsletter', 'Programmer l’envoi', 'emails:write'],
      ['unschedule_newsletter', 'Annuler la programmation', 'emails:write'],
    ],
  },
  {
    icon: Mail,
    title: 'Campagnes automatiques',
    tools: [
      ['list_campaigns', 'Campagnes et statistiques', 'emails:read'],
      ['get_campaign', 'Emails d’une campagne', 'emails:read'],
      ['create_campaign', 'Créer une campagne', 'emails:write'],
      ['add_campaign_email', 'Ajouter un email à la séquence', 'emails:write'],
      ['update_campaign_email', 'Modifier un email de la séquence', 'emails:write'],
      ['enroll_in_campaign', 'Inscrire un contact', 'campaigns:write'],
    ],
  },
  { icon: Funnel, title: 'Tunnels', tools: [['list_funnels', 'Tunnels, étapes, vues et inscriptions', 'funnels:read']] },
  {
    icon: ShoppingBag,
    title: 'Compte et ventes',
    tools: [
      ['get_account', 'Nom et email du compte connecté', 'profile'],
      ['record_purchase', 'Enregistrer un achat', 'purchases:write'],
    ],
  },
];

const TOOL_COUNT = MCP_TOOL_GROUPS.reduce((n, g) => n + g.tools.length, 0);

export function McpDocs({ onCreateApp }: { onCreateApp: () => void }) {
  const account = useEdition().info?.account;
  const { data: ws } = useLoad(() => api.workspaces(), []);
  // « Tous mes espaces » is offered at authorization when the person may authorize more than one workspace
  const canAll = (ws?.workspaces.filter((w) => w.role === 'owner' || w.role === 'admin').length ?? 0) > 1;
  const [mode, setMode] = useState<'one' | 'all'>('one');
  const all = canAll && mode === 'all';
  const url = all || !account ? ALL_URL : workspaceMcpUrl(ORIGIN, account.id);

  return (
    <div className="space-y-10">
      <Card className="overflow-hidden" padded={false}>
        <div className="grid grid-cols-1 gap-6 p-4 sm:p-6 lg:grid-cols-[1fr_1.1fr] lg:gap-10 [&>*]:min-w-0">
          <div>
            <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-ink text-lime-400">
              <Plug size={20} />
            </span>
            <h2 className="font-display text-xl font-extrabold tracking-[-0.02em] text-ink">Serveur MCP</h2>
            <p className="mt-1.5 text-sm text-slate-600">
              Branchez n’importe quel client compatible MCP (Model Context Protocol) — assistant IA, éditeur de code, agent — sur Scalo. Il consulte et agit sur vos contacts, emails et
              ventes avec les droits que vous lui accordez.
            </p>
            <ul className="mt-4 space-y-1.5 text-sm text-slate-600">
              <li className="flex items-center gap-2">
                <ShieldCheck size={15} className="text-emerald-600" /> Pas de clé à copier : connexion OAuth automatique
              </li>
              <li className="flex items-center gap-2">
                <Gauge size={15} className="text-emerald-600" /> {TOOL_COUNT} outils, transport Streamable HTTP
              </li>
            </ul>
          </div>

          <div className="rounded-2xl bg-slate-50 p-3 ring-1 sm:p-4 ring-slate-200/80">
            {canAll && (
              <div className="mb-4 grid grid-cols-2 gap-1 rounded-xl bg-slate-200/60 p-1" role="radiogroup" aria-label="Accès">
                {(
                  [
                    ['one', 'Cet espace'],
                    ['all', 'Tous mes espaces'],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    role="radio"
                    aria-checked={mode === id}
                    onClick={() => setMode(id)}
                    className={cx(
                      'truncate rounded-lg px-2 py-1.5 text-[13px] font-medium sm:text-sm transition-colors',
                      mode === id ? 'bg-white text-ink shadow-xs ring-1 ring-slate-200' : 'text-slate-500 hover:text-slate-800',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            <p className="mb-1.5 text-xs font-medium text-slate-500">URL du serveur MCP</p>
            <CopyValue value={url} className="bg-white py-1.5" />
            <p className="mt-3 flex gap-2 text-xs text-slate-500">
              <Building2 size={14} className="mt-px shrink-0 text-slate-400" />
              {all ? (
                <span>
                  Un seul connecteur pour tous vos business. À l’autorisation, choisissez « Tous mes espaces » ; chaque action indique alors l’espace sur lequel elle porte.
                </span>
              ) : (
                <span>
                  Le client ne verra que l’espace <strong className="font-semibold text-slate-700">« {account?.name ?? 'courant'} »</strong>.
                  {canAll ? ' Pour un autre business, changez d’espace ou choisissez « Tous mes espaces ».' : ''}
                </span>
              )}
            </p>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-2">
        <Section title="Connecter un client" description="Trois étapes, quel que soit le client MCP.">
          <Steps
            steps={[
              {
                title: 'Ajoutez un serveur MCP distant',
                body: 'Dans les réglages de votre client : « serveur MCP personnalisé », « connecteur » ou « remote MCP server » selon les outils.',
              },
              { title: 'Collez l’URL ci-dessus', body: 'Rien d’autre : ni clé d’API, ni jeton. Le client découvre seul comment s’authentifier.' },
              {
                title: 'Autorisez l’accès sur Scalo',
                body: (
                  <>
                    Connectez-vous, choisissez l’espace et validez. Révocable à tout moment dans{' '}
                    <Link to="/settings#applications" className="font-medium text-brand-700 hover:underline">
                      Applications connectées
                    </Link>
                    .
                  </>
                ),
              },
            ]}
          />
        </Section>

        <Section title="Configuration par fichier" description="Pour les clients qui se configurent avec un fichier JSON (format mcpServers).">
          <CodeBlock code={JSON.stringify({ mcpServers: { scalo: { type: 'http', url } } }, null, 2)} />
          <p className="flex items-center gap-2 text-xs text-slate-500">
            <FileJson size={14} className="text-slate-400" /> Au premier appel, le client ouvre l’écran d’autorisation Scalo dans votre navigateur.
          </p>
        </Section>
      </div>

      <Note
        icon={KeyRound}
        action={
          <Button variant="secondary" size="sm" onClick={onCreateApp}>
            Créer une application
          </Button>
        }
      >
        <strong className="font-semibold text-slate-900">Votre client ne s’enregistre pas tout seul ?</strong> Les clients locaux et les principaux assistants s’enregistrent automatiquement.
        Pour un autre client hébergé, créez une application avec son adresse de redirection et les scopes voulus (plus <C>offline_access</C> pour rester connecté).
      </Note>

      <Section title="Outils disponibles" description="Chaque outil demande un scope : le client n’obtient que ceux que vous acceptez sur l’écran d’autorisation.">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {MCP_TOOL_GROUPS.map((g) => (
            <div key={g.title} className="rounded-2xl border border-slate-200/80 bg-white p-4">
              <p className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900">
                <g.icon size={15} className="text-slate-400" /> {g.title}
              </p>
              <ul className="space-y-2.5">
                {g.tools.map(([name, what, scope]) => (
                  <li key={name} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-[12.5px] font-medium text-slate-800">{name}</p>
                      <p className="text-xs text-slate-500">{what}</p>
                    </div>
                    <Scope s={scope} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="text-xs text-slate-500">
          Avec « Tous mes espaces », chaque outil prend en plus un <C>workspace_id</C> et l’outil <C>list_workspaces</C> donne la liste de vos espaces.
        </p>
      </Section>

      <Section title="Bon à savoir">
        <div className="grid gap-3 sm:grid-cols-3">
          <Fact icon={ShieldCheck} title="Les mêmes règles que l’API">
            Les outils passent par l’API REST : mêmes scopes, mêmes effets (un tag peut déclencher une campagne).
          </Fact>
          <Fact icon={Gauge} title="120 requêtes par minute">
            Par autorisation. Au-delà, le client reçoit une erreur et réessaie un peu plus tard.
          </Fact>
          <Fact icon={Building2} title="Un espace bien séparé">
            Une URL d’espace refuse les jetons d’un autre espace : deux connecteurs ne mélangent jamais deux business.
          </Fact>
        </div>
      </Section>
    </div>
  );
}
