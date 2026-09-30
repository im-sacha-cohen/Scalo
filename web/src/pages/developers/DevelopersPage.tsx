// `/developers` — applications registered by the user on the OAuth 2.0 authorization server + documentation.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Blocks, ChevronRight, Plus } from 'lucide-react';
import { api } from '../../lib/api';
import { useLoad } from '../../lib/hooks';
import { fmtDate } from '../../lib/format';
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, PageLoader } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { AppLogo } from '../oauth/common';
import { AppForm, emptyApp } from './AppForm';
import { OAuthDocs } from './Docs';
import { McpDocs } from './McpDocs';
import { SecretModal } from './SecretModal';

export function DevelopersPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useLoad(() => api.developerApps(), []);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ id: number; clientId: string; secret: string } | null>(null);

  if (loading && !data) return <PageLoader />;
  if (error && !data) return <ErrorState message={error} onRetry={reload} />;
  const apps = data ?? [];

  return (
    <>
      <PageHeader
        title="Développeurs"
        description="Créez des applications qui accèdent aux comptes scalo avec l’accord de leurs utilisateurs (OAuth 2.0)."
        actions={
          <Button icon={Plus} onClick={() => setCreating(true)}>
            Nouvelle application
          </Button>
        }
      />

      <div className="space-y-6">
        {apps.length === 0 ? (
          <Card>
            <EmptyState
              icon={Blocks}
              title="Aucune application"
              description="Enregistrez une application (intégration, script, partenaire) pour obtenir un client_id et connecter des comptes via OAuth."
              action={
                <Button icon={Plus} onClick={() => setCreating(true)}>
                  Nouvelle application
                </Button>
              }
            />
          </Card>
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
        )}
        <McpDocs />
        <OAuthDocs />
      </div>

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
