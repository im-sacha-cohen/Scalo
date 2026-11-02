// `/developers` — one tab per way to plug into Scalo (MCP server, REST API, OAuth 2.0) and the applications registered
// by the user on the authorization server. The tab lives in the URL (?tab=) so it can be linked.
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Blocks, Braces, ChevronRight, KeyRound, Plug, Plus } from 'lucide-react';
import { api } from '../../lib/api';
import { useLoad } from '../../lib/hooks';
import { fmtDate } from '../../lib/format';
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, PageLoader, Tabs } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { AppLogo } from '../oauth/common';
import { AppForm, emptyApp } from './AppForm';
import { ApiDocs, OAuthDocs } from './Docs';
import { McpDocs } from './McpDocs';
import { SecretModal } from './SecretModal';

const TABS = ['mcp', 'api', 'oauth', 'apps'] as const;
type Tab = (typeof TABS)[number];

export function DevelopersPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useLoad(() => api.developerApps(), []);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ id: number; clientId: string; secret: string } | null>(null);
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some((t) => t === params.get('tab')) ? params.get('tab') : 'mcp') as Tab;
  const setTab = (t: Tab) => setParams(t === 'mcp' ? {} : { tab: t }, { replace: true });

  if (loading && !data) return <PageLoader />;
  if (error && !data) return <ErrorState message={error} onRetry={reload} />;
  const apps = data ?? [];

  return (
    <>
      <PageHeader
        title="Développeurs"
        description="Branchez vos outils sur Scalo : un client MCP en collant une URL, ou votre propre code avec l’API REST."
        actions={
          tab === 'apps' && apps.length > 0 ? (
            <Button icon={Plus} onClick={() => setCreating(true)}>
              Nouvelle application
            </Button>
          ) : undefined
        }
      />

      <Tabs
        className="scalo-scroll mb-8 overflow-x-auto"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'mcp', label: 'Serveur MCP', icon: Plug },
          { id: 'api', label: 'API REST', icon: Braces },
          { id: 'oauth', label: 'OAuth 2.0', icon: KeyRound },
          { id: 'apps', label: 'Applications', icon: Blocks, count: apps.length },
        ]}
      />

      {tab === 'mcp' && <McpDocs onCreateApp={() => setCreating(true)} />}
      {tab === 'api' && <ApiDocs onOAuth={() => setTab('oauth')} />}
      {tab === 'oauth' && <OAuthDocs />}
      {tab === 'apps' &&
        (apps.length === 0 ? (
          <EmptyState
            icon={Blocks}
            title="Aucune application"
            description="Une application donne un client_id pour connecter des comptes Scalo par OAuth : votre intégration, un script, un partenaire ou un client MCP hébergé."
            action={
              <Button icon={Plus} onClick={() => setCreating(true)}>
                Nouvelle application
              </Button>
            }
          />
        ) : (
          <Card padded={false}>
            <ul className="divide-y divide-slate-100">
              {apps.map((a) => (
                <li key={a.id}>
                  <Link to={`/developers/${a.id}`} className="flex items-center gap-3 px-5 py-4 transition-colors hover:bg-slate-50">
                    <AppLogo name={a.name} url={a.logo_url} size={40} />
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-900">
                        {a.name}
                        <Badge tone={a.type === 'public' ? 'blue' : 'violet'}>{a.type === 'public' ? 'Publique' : 'Confidentielle'}</Badge>
                      </p>
                      <p className="truncate font-mono text-xs text-slate-500">{a.client_id}</p>
                    </div>
                    <div className="hidden text-right text-xs text-slate-500 sm:block">
                      <p>
                        {a.authorizations_count} utilisateur{a.authorizations_count > 1 ? 's' : ''} connecté{a.authorizations_count > 1 ? 's' : ''}
                      </p>
                      <p>Créée le {fmtDate(a.created_at)}</p>
                    </div>
                    <ChevronRight size={16} className="text-slate-300" />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        ))}

      <Modal open={creating} onClose={() => setCreating(false)} title="Nouvelle application" size="lg">
        <AppForm
          initial={emptyApp()}
          showType
          submitLabel="Créer l’application"
          onCancel={() => setCreating(false)}
          onSubmit={async (v) => {
            try {
              const app = await api.createDeveloperApp(v);
              setCreating(false);
              toast.success('Application créée');
              if (app.client_secret) setCreated({ id: app.id, clientId: app.client_id, secret: app.client_secret });
              else navigate(`/developers/${app.id}`);
            } catch (e) {
              toast.error(e);
            }
          }}
        />
      </Modal>
      <SecretModal
        clientId={created?.clientId ?? ''}
        secret={created?.secret ?? null}
        onClose={() => {
          const id = created?.id;
          setCreated(null);
          if (id) navigate(`/developers/${id}`);
        }}
      />
    </>
  );
}
