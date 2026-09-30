/**
 * Scalo Enterprise Edition — Copyright (c) 2026 Scalo. All rights reserved.
 * Licensed under the Scalo Enterprise License (see ee/LICENSE): source-available, NOT open source.
 * Production use requires a valid Scalo Enterprise subscription and license key.
 */
import { useState } from 'react';
import { BadgeCheck, KeyRound } from 'lucide-react';
import type { LicenseStatus } from '@scalo/shared';
import { useConfirm } from '../../../web/src/components/ConfirmDialog';
import { useToast } from '../../../web/src/components/Toast';
import { Badge, Button, Card, CardHeader, ErrorState, Field, PageLoader, Textarea } from '../../../web/src/components/ui';
import { useEdition } from '../../../web/src/lib/edition';
import { fmtDate } from '../../../web/src/lib/format';
import { useLoad } from '../../../web/src/lib/hooks';
import { ENTERPRISE_FEATURES, FEATURE_LABELS } from '../../shared/types';
import { eeApi } from './api';

const STATUS: Record<LicenseStatus, { label: string; tone: 'green' | 'amber' | 'red' | 'slate' }> = {
  valid: { label: 'Valide', tone: 'green' },
  grace: { label: 'Expirée — période de grâce', tone: 'amber' },
  expired: { label: 'Expirée', tone: 'red' },
  invalid: { label: 'Clé invalide', tone: 'red' },
  none: { label: 'Aucune licence', tone: 'slate' },
};

export function LicenseSection() {
  const toast = useToast();
  const confirm = useConfirm();
  const edition = useEdition();
  const { data, setData, error, loading, reload } = useLoad(() => eeApi.license(), []);
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);

  if (loading && !data) return <PageLoader />;
  if (error && !data) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;

  const save = async () => {
    setSaving(true);
    try {
      setData(await eeApi.saveLicense(key.trim()));
      setKey('');
      await edition.reload();
      toast.success('Licence enregistrée');
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: 'Retirer la licence ?',
      message: 'Les fonctions de l’édition Entreprise seront désactivées. Vos données et le reste de l’application ne sont pas touchés.',
      confirmLabel: 'Retirer la licence',
    });
    if (!ok) return;
    try {
      setData(await eeApi.removeLicense());
      await edition.reload();
      toast.success('Licence retirée');
    } catch (e) {
      toast.error(e);
    }
  };

  const st = STATUS[data.status];
  const covered = (f: string) => data.features.includes(f);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          icon={BadgeCheck}
          title="Licence Entreprise"
          description="Active les fonctions d’équipe et d’agence. Le cœur de Scalo est libre et sans limite, avec ou sans licence."
          actions={<Badge tone={st.tone}>{st.label}</Badge>}
        />
        {data.status === 'none' ? (
          <p className="text-sm text-slate-500">Cette instance utilise l’édition communautaire. Saisissez une clé pour activer l’édition Entreprise.</p>
        ) : data.status === 'invalid' ? (
          <p className="rounded-lg bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700">{data.error}</p>
        ) : (
          <>
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-slate-500">Client</dt>
                <dd className="font-medium text-slate-800">{data.customer}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Offre</dt>
                <dd className="font-medium text-slate-800">{data.plan}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Sièges par compte</dt>
                <dd className="font-medium text-slate-800">{data.seats}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">{data.status === 'valid' ? 'Expire le' : 'Expirée le'}</dt>
                <dd className="font-medium text-slate-800">
                  {fmtDate(data.expires_at)}
                  {data.status === 'valid' && data.days_left !== null && data.days_left <= 30 && <span className="ml-1.5 text-xs text-amber-700">dans {data.days_left} j</span>}
                </dd>
              </div>
            </dl>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {ENTERPRISE_FEATURES.map((f) => (
                <Badge key={f} tone={covered(f) ? 'brand' : 'slate'} className={covered(f) ? undefined : 'line-through opacity-60'}>
                  {FEATURE_LABELS[f]}
                </Badge>
              ))}
            </div>
            {data.status === 'grace' && (
              <p className="mt-4 rounded-lg bg-amber-50 px-3.5 py-2.5 text-sm text-amber-900">
                Les fonctions Entreprise restent actives jusqu’au {fmtDate(data.grace_until)}. Renouvelez votre licence pour éviter leur désactivation.
              </p>
            )}
            {data.status === 'expired' && (
              <p className="mt-4 rounded-lg bg-slate-50 px-3.5 py-2.5 text-sm text-slate-600">
                Les fonctions Entreprise sont désactivées. Vos données sont intactes et le reste de l’application fonctionne normalement.
              </p>
            )}
          </>
        )}
      </Card>

      <Card>
        <CardHeader icon={KeyRound} title="Clé de licence" description="Vérifiée hors ligne sur votre serveur : aucune donnée n’est envoyée à Scalo." />
        {data.source === 'env' ? (
          <p className="text-sm text-slate-500">
            La clé est fournie par la variable d’environnement <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">SCALO_LICENSE_KEY</code> : modifiez-la côté serveur.
          </p>
        ) : !data.can_manage ? (
          <p className="text-sm text-slate-500">Seul l’administrateur de l’instance peut saisir ou retirer la clé de licence.</p>
        ) : (
          <>
            <Field label={data.status === 'none' ? 'Saisir une clé' : 'Remplacer la clé'}>
              <Textarea rows={3} value={key} onChange={(e) => setKey(e.target.value)} placeholder="scalo_lic_…" className="font-mono text-xs" spellCheck={false} />
            </Field>
            <div className="mt-3 flex items-center justify-between gap-2">
              {data.source === 'database' ? (
                <Button variant="ghost" size="sm" onClick={remove}>
                  Retirer la licence
                </Button>
              ) : (
                <span />
              )}
              <Button size="sm" onClick={save} loading={saving} disabled={!key.trim()}>
                Enregistrer la clé
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
