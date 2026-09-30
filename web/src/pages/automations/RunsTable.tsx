// Execution journal (automation_runs): status, contact, step, error, per-action log.
import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ChevronDown, ChevronRight, History } from 'lucide-react';
import type { AutomationRunStatus } from '@scalo/shared';
import { crmApi } from '../../lib/crm-api';
import { useLoad, usePolling } from '../../lib/hooks';
import { fmtDateTime, fmtRelative } from '../../lib/format';
import { Badge, Card, EmptyState, ErrorState, Pagination, Select, Skeleton, cx } from '../../components/ui';
import { RUN_STATUS } from './labels';

const LIMIT = 25;

export function RunsTable({ automationId, showAutomation = false, refreshKey = 0 }: { automationId: number | null; showAutomation?: boolean; refreshKey?: number }) {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<AutomationRunStatus | ''>('');
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => setPage(1), [status]);
  const { data, error, loading, reload } = useLoad(() => crmApi.automationRuns(automationId, { page, limit: LIMIT, status }), [automationId, page, status, refreshKey]);
  // runs are executed by the worker in the background: keep the journal fresh while it is shown
  usePolling(reload, 5000, page === 1);

  return (
    <Card padded={false} className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <h3 className="flex items-center gap-2 text-[15px] font-semibold text-slate-900">
          <History size={16} className="text-slate-400" /> Journal des exécutions
        </h3>
        <Select className="w-44" value={status} onChange={(e) => setStatus(e.target.value as AutomationRunStatus | '')}>
          <option value="">Tous les statuts</option>
          {(Object.keys(RUN_STATUS) as AutomationRunStatus[]).map((s) => (
            <option key={s} value={s}>
              {RUN_STATUS[s].label}
            </option>
          ))}
        </Select>
      </div>
      {error && !data ? (
        <div className="p-4">
          <ErrorState message={error} onRetry={reload} />
        </div>
      ) : loading && !data ? (
        <div className="space-y-2 p-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      ) : data && data.total === 0 ? (
        <EmptyState icon={History} title="Aucune exécution" description="Les exécutions apparaîtront ici dès que le déclencheur se produira." className="m-4 border-0" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs font-medium text-slate-500">
                <th className="w-8 px-2 py-2.5" />
                <th className="px-3 py-2.5">Date</th>
                {showAutomation && <th className="px-3 py-2.5">Automatisation</th>}
                <th className="px-3 py-2.5">Contact</th>
                <th className="px-3 py-2.5">Statut</th>
                <th className="px-3 py-2.5">Détail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data?.items.map((r) => {
                const st = RUN_STATUS[r.status];
                const last = r.log[r.log.length - 1];
                const detail =
                  r.error ??
                  (r.status === 'waiting' && r.resume_at ? `Reprise ${fmtRelative(r.resume_at)} (${fmtDateTime(r.resume_at)})` : last ? last.message : r.status === 'completed' ? 'Aucune action' : '');
                const expanded = open === r.id;
                return (
                  <Fragment key={r.id}>
                    <tr className={cx('cursor-pointer hover:bg-slate-50', expanded && 'bg-slate-50')} onClick={() => setOpen(expanded ? null : r.id)}>
                      <td className="px-2 py-2.5 text-slate-400">{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-slate-500" title={fmtDateTime(r.created_at)}>
                        {fmtRelative(r.created_at)}
                      </td>
                      {showAutomation && (
                        <td className="px-3 py-2.5">
                          <Link to={`/automations/${r.automation_id}`} onClick={(e) => e.stopPropagation()} className="font-medium text-slate-800 hover:text-brand-700">
                            {r.automation_name}
                          </Link>
                        </td>
                      )}
                      <td className="max-w-[220px] truncate px-3 py-2.5">
                        {r.contact_id ? (
                          <Link to={`/contacts/${r.contact_id}`} onClick={(e) => e.stopPropagation()} className="text-slate-700 hover:text-brand-700">
                            {r.contact_email}
                          </Link>
                        ) : (
                          <span className="text-slate-400">Contact supprimé</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge tone={st.tone} dot>
                          {st.label}
                        </Badge>
                        {r.depth > 0 && <span className="ml-1.5 text-xs text-slate-400" title="Déclenchée par une autre automatisation">↳ {r.depth}</span>}
                      </td>
                      <td className={cx('max-w-[360px] truncate px-3 py-2.5', r.status === 'failed' ? 'text-rose-700' : 'text-slate-500')} title={detail}>
                        {detail}
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="bg-slate-50/70">
                        <td />
                        <td colSpan={showAutomation ? 5 : 4} className="px-3 pt-1 pb-3">
                          {r.log.length === 0 ? (
                            <p className="text-xs text-slate-500">Aucune action exécutée.</p>
                          ) : (
                            <ol className="space-y-1">
                              {r.log.map((l, i) => (
                                <li key={i} className="flex items-baseline gap-2 text-xs">
                                  <span className={cx('font-semibold', l.ok ? 'text-emerald-600' : 'text-rose-600')}>{l.ok ? '✓' : '✗'}</span>
                                  <span className="text-slate-400">Étape {l.step + 1}</span>
                                  <span className="text-slate-700">{l.message}</span>
                                  <span className="text-slate-400">{fmtDateTime(l.at)}</span>
                                </li>
                              ))}
                            </ol>
                          )}
                          {Object.keys(r.trigger_data ?? {}).length > 1 && (
                            <p className="mt-2 truncate font-mono text-[11px] text-slate-400">Déclencheur : {JSON.stringify(r.trigger_data)}</p>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {data && <Pagination page={page} total={data.total} limit={LIMIT} onChange={setPage} />}
    </Card>
  );
}
