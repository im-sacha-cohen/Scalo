/**
 * Scalo Enterprise Edition — Copyright (c) 2026 Scalo. All rights reserved.
 * Licensed under the Scalo Enterprise License (see ee/LICENSE): source-available, NOT open source.
 * Production use requires a valid Scalo Enterprise subscription and license key.
 */
import { useEffect, useState } from 'react';
import { Download, ScrollText, Search } from 'lucide-react';
import { useToast } from '../../../web/src/components/Toast';
import { Badge, Button, Card, CardHeader, ErrorState, Field, Input, PageLoader, Pagination } from '../../../web/src/components/ui';
import { downloadBlob } from '../../../web/src/lib/api';
import { useEdition } from '../../../web/src/lib/edition';
import { fmtDateTime } from '../../../web/src/lib/format';
import { useDebounced, useLoad } from '../../../web/src/lib/hooks';
import { ACCOUNT_ROLE_LABELS, type AccountRole } from '@scalo/shared';
import { eeApi } from './api';
import { EnterpriseFeatureScreen } from './EnterpriseGate';

const LIMIT = 25;

export function AuditSection() {
  const toast = useToast();
  const { has, isAdmin } = useEdition();
  const licensed = has('audit_log') && isAdmin;
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const { data, error, loading, reload } = useLoad(() => (licensed ? eeApi.audit({ page, limit: LIMIT, search: q }) : Promise.resolve(null)), [licensed, page, q]);
  const [retention, setRetention] = useState('');
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => setPage(1), [q]);
  useEffect(() => {
    if (data) setRetention(String(data.retention_days));
  }, [data?.retention_days]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isAdmin) {
    return (
      <Card>
        <CardHeader icon={ScrollText} title="Journal d’audit" description="Seuls le propriétaire et les administrateurs du compte consultent le journal." />
      </Card>
    );
  }
  if (!licensed) {
    return (
      <EnterpriseFeatureScreen feature="audit_log" icon={ScrollText}>
        Gardez la trace de qui a fait quoi sur le compte : auteur, action, ressource, adresse IP et date. Consultable, exportable en CSV, avec une durée de conservation réglable.
      </EnterpriseFeatureScreen>
    );
  }
  if (loading && !data) return <PageLoader />;
  if (error && !data) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;

  const days = Number(retention);
  const retentionValid = Number.isInteger(days) && days >= 1 && days <= 3650;

  const exportCsv = async () => {
    setExporting(true);
    try {
      downloadBlob(await eeApi.exportAudit(q), 'journal-audit.csv');
    } catch (e) {
      toast.error(e);
    } finally {
      setExporting(false);
    }
  };

  const saveRetention = async () => {
    setSaving(true);
    try {
      const r = await eeApi.saveAuditRetention(days);
      toast.success(r.purged ? `Conservation enregistrée — ${r.purged} entrée(s) ancienne(s) supprimée(s)` : 'Conservation enregistrée');
      await reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card padded={false}>
        <div className="p-5 pb-0">
          <CardHeader
            icon={ScrollText}
            title="Journal d’audit"
            description="Chaque modification faite sur le compte : qui, quoi, depuis où, quand. Les consultations ne sont pas enregistrées."
            actions={
              <Button variant="secondary" size="sm" icon={Download} onClick={exportCsv} loading={exporting}>
                Exporter en CSV
              </Button>
            }
          />
          <Input icon={Search} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Rechercher une action, un email, une adresse IP…" className="mb-4 max-w-sm" />
        </div>
        {data.items.length === 0 ? (
          <p className="px-5 pb-8 text-center text-sm text-slate-500">{q ? 'Aucune entrée ne correspond à cette recherche.' : 'Aucune action enregistrée pour le moment.'}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-y border-slate-100 bg-slate-50/60 text-xs text-slate-500">
                <tr>
                  <th className="px-5 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Auteur</th>
                  <th className="px-3 py-2 font-medium">Action</th>
                  <th className="px-3 py-2 font-medium">Ressource</th>
                  <th className="px-5 py-2 font-medium">IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.items.map((e) => (
                  <tr key={e.id}>
                    <td className="px-5 py-2 whitespace-nowrap text-slate-500">{fmtDateTime(e.created_at)}</td>
                    <td className="px-3 py-2">
                      <span className="block max-w-[200px] truncate text-slate-800">{e.actor_email || 'Compte supprimé'}</span>
                      <span className="text-xs text-slate-400">{ACCOUNT_ROLE_LABELS[e.actor_role as AccountRole] ?? e.actor_role}</span>
                    </td>
                    <td className="px-3 py-2">
                      <code className="text-xs text-slate-700">{e.action}</code>
                      {e.status === 403 && (
                        <Badge tone="red" className="ml-2">
                          Refusée
                        </Badge>
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-600">
                      {e.resource_type}
                      {e.resource_id ? ` nº ${e.resource_id}` : ''}
                    </td>
                    <td className="px-5 py-2 font-mono text-xs text-slate-500">{e.ip}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} total={data.total} limit={LIMIT} onChange={setPage} />
      </Card>

      <Card>
        <CardHeader title="Durée de conservation" description="Les entrées plus anciennes sont supprimées automatiquement." />
        <div className="flex items-end gap-3">
          <Field label="Jours" error={retentionValid ? null : 'Entre 1 et 3 650 jours.'} className="w-40">
            <Input type="number" min={1} max={3650} value={retention} onChange={(e) => setRetention(e.target.value)} />
          </Field>
          <Button variant="secondary" onClick={saveRetention} loading={saving} disabled={!retentionValid || days === data.retention_days}>
            Enregistrer
          </Button>
        </div>
      </Card>
    </div>
  );
}
