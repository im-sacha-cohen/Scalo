// Settings › "Applications connectées": third-party applications the user authorized (OAuth), with revocation.
import { useState } from 'react';
import { Link } from 'react-router';
import { AppWindow, ExternalLink } from 'lucide-react';
import { api } from '../../lib/api';
import { useLoad } from '../../lib/hooks';
import { fmtDate, fmtRelative } from '../../lib/format';
import { Badge, Button, Card, CardHeader, Spinner } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import { AppLogo, scopeLabel } from './common';

export function ConnectedAppsCard() {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, loading, reload } = useLoad(() => api.oauthAuthorizations(), []);
  const [busy, setBusy] = useState<string | null>(null);

  const revoke = async (clientId: string, name: string) => {
    const ok = await confirm({
      title: `Révoquer l’accès de ${name} ?`,
      message: 'L’application ne pourra plus accéder à votre compte : ses jetons sont invalidés immédiatement. Elle devra vous redemander l’autorisation.',
      confirmLabel: 'Révoquer l’accès',
    });
    if (!ok) return;
    setBusy(clientId);
    try {
      await api.revokeOAuthAuthorization(clientId);
      toast.success(`Accès de ${name} révoqué`);
      await reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader
        icon={AppWindow}
        title="Applications connectées"
        description="Les applications tierces que vous avez autorisées à accéder à votre compte (intégrations, automatisations, partenaires)."
      />
      {loading && !data ? (
        <div className="flex h-24 items-center justify-center">
          <Spinner />
        </div>
      ) : error && !data ? (
        <p className="text-sm text-rose-600">{error}</p>
      ) : !data?.length ? (
        <div className="rounded-lg border border-dashed border-slate-200 px-4 py-8 text-center">
          <p className="text-sm font-medium text-slate-700">Aucune application connectée</p>
          <p className="mt-1 text-xs text-slate-500">
            Quand vous autoriserez une application à accéder à votre compte, elle apparaîtra ici. Vous développez une intégration ?{' '}
            <Link to="/developers" className="font-medium text-brand-600 hover:text-brand-700">
              Espace développeurs
            </Link>
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {data.map((a) => (
            <li key={a.client.client_id} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start">
              <AppLogo name={a.client.name} url={a.client.logo_url} size={40} />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-x-2 text-sm font-medium text-slate-900">
                  {a.client.name}
                  {a.client.website && (
                    <a href={a.client.website} target="_blank" rel="noopener noreferrer" className="text-slate-400 hover:text-slate-600" aria-label="Site de l’application">
                      <ExternalLink size={13} />
                    </a>
                  )}
                </p>
                <p className="text-xs text-slate-500">
                  Par {a.client.owner_name} · autorisée le {fmtDate(a.granted_at)} · {a.last_used_at ? `utilisée ${fmtRelative(a.last_used_at)}` : 'jamais utilisée'}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {a.scopes.map((s) => (
                    <Badge key={s} tone={s === 'offline_access' ? 'amber' : 'slate'}>
                      {scopeLabel(s)}
                    </Badge>
                  ))}
                </div>
              </div>
              <Button variant="secondary" size="sm" onClick={() => revoke(a.client.client_id, a.client.name)} loading={busy === a.client.client_id} disabled={!!busy && busy !== a.client.client_id}>
                Révoquer l’accès
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
