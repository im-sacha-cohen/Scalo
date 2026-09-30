// Funnel → "Partage": JSON export and revocable share link (preview + "Importer dans mon compte").
import { useState } from 'react';
import { Check, Copy, Download, Link2, RefreshCw, Share2, Unlink } from 'lucide-react';
import type { Funnel } from '@scalo/shared';
import { downloadBlob } from '../../../lib/api';
import { growthApi } from '../../../lib/growth-api';
import { copyText, useLoad } from '../../../lib/hooks';
import { fmtDateTime } from '../../../lib/format';
import { Badge, Button, Card, CardHeader, IconButton, Skeleton } from '../../../components/ui';
import { useToast } from '../../../components/Toast';
import { useConfirm } from '../../../components/ConfirmDialog';

export function FunnelShareTab({ funnel }: { funnel: Funnel }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data: share, setData } = useLoad(() => growthApi.shareInfo(funnel.id), [funnel.id]);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const exportJson = async () => {
    setBusy('export');
    try {
      const data = await growthApi.exportFunnel(funnel.id);
      downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `tunnel-${funnel.slug}.json`);
      toast.success('Export téléchargé');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    if (share?.active) {
      const ok = await confirm({
        title: 'Générer un nouveau lien ?',
        message: 'L’ancien lien cessera immédiatement de fonctionner.',
        confirmLabel: 'Générer un nouveau lien',
      });
      if (!ok) return;
    }
    setBusy('create');
    try {
      const s = await growthApi.createShare(funnel.id);
      setData(s);
      setUrl(s.url ?? null);
      toast.success('Lien de partage créé');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };

  const revoke = async () => {
    const ok = await confirm({ title: 'Désactiver le lien de partage ?', message: 'Plus personne ne pourra voir ni importer ce tunnel avec ce lien.', confirmLabel: 'Désactiver' });
    if (!ok) return;
    setBusy('revoke');
    try {
      setData(await growthApi.revokeShare(funnel.id));
      setUrl(null);
      toast.success('Lien désactivé');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <Card>
        <CardHeader
          icon={Share2}
          title="Lien de partage"
          description="Toute personne ayant le lien peut voir les pages de ce tunnel et l’importer dans son propre compte (copie indépendante). Les contacts et statistiques ne sont jamais partagés."
        />
        {!share ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Badge tone={share.active ? 'green' : 'slate'} dot>
                {share.active ? 'Actif' : 'Aucun lien actif'}
              </Badge>
              {share.active && share.created_at && <span className="text-xs text-slate-500">créé le {fmtDateTime(share.created_at)}</span>}
            </div>
            {url ? (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                <p className="mb-2 text-xs font-medium text-emerald-800">Copiez ce lien maintenant : pour des raisons de sécurité, il ne sera plus affiché.</p>
                <div className="flex items-center gap-1">
                  <Link2 size={14} className="shrink-0 text-emerald-700" />
                  <code className="min-w-0 flex-1 truncate font-mono text-xs text-emerald-900" title={url}>
                    {url}
                  </code>
                  <IconButton
                    icon={copied ? Check : Copy}
                    label="Copier le lien"
                    size={14}
                    onClick={async () => {
                      if (await copyText(url)) {
                        setCopied(true);
                        toast.success('Lien copié');
                        setTimeout(() => setCopied(false), 1500);
                      }
                    }}
                  />
                </div>
              </div>
            ) : (
              share.active && <p className="text-sm text-slate-500">Le lien n’est affiché qu’à sa création. Générez-en un nouveau si vous l’avez perdu.</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button icon={share.active ? RefreshCw : Link2} onClick={create} loading={busy === 'create'} variant={share.active ? 'secondary' : 'primary'}>
                {share.active ? 'Générer un nouveau lien' : 'Créer un lien de partage'}
              </Button>
              {share.active && (
                <Button variant="ghost" icon={Unlink} className="text-rose-600 hover:bg-rose-50 hover:text-rose-700" onClick={revoke} loading={busy === 'revoke'}>
                  Désactiver
                </Button>
              )}
            </div>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          icon={Download}
          title="Exporter le tunnel"
          description="Fichier JSON avec les étapes, leurs pages, les variantes A/B, les règles d’accès (sans mot de passe) et les réglages de suivi. Les tags sont repris par leur nom ; les campagnes email ne sont pas incluses."
        />
        <Button variant="secondary" icon={Download} onClick={exportJson} loading={busy === 'export'}>
          Télécharger l’export (.json)
        </Button>
        <p className="mt-3 text-xs text-slate-500">Pour l’importer : Tunnels → « Importer » dans n’importe quel compte.</p>
      </Card>
    </div>
  );
}
