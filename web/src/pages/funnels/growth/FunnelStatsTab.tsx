// Funnel → "Statistiques": unique visitors, optins and conversion by source / medium / campaign / referrer / A/B
// variant over a period, per step, with a daily chart.
import { useState } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { BarChart3, Eye, MousePointerClick, Percent } from 'lucide-react';
import type { Funnel, FunnelStatsRow, StatsGroup, StatsPeriod } from '@scalo/shared';
import { growthApi } from '../../../lib/growth-api';
import { useLoad } from '../../../lib/hooks';
import { fmtNumber, fmtPercent } from '../../../lib/format';
import { Card, cx, EmptyState, ErrorState, Skeleton, StatCard } from '../../../components/ui';

const PERIODS: { id: StatsPeriod; label: string }[] = [
  { id: '7', label: '7 jours' },
  { id: '30', label: '30 jours' },
  { id: '90', label: '90 jours' },
  { id: 'all', label: 'Tout' },
];
const GROUPS: { id: StatsGroup; label: string; column: string }[] = [
  { id: 'source', label: 'Source', column: 'Source' },
  { id: 'medium', label: 'Support', column: 'Support (utm_medium)' },
  { id: 'campaign', label: 'Campagne', column: 'Campagne (utm_campaign)' },
  { id: 'referrer', label: 'Site référent', column: 'Site référent' },
  { id: 'variant', label: 'Variante A/B', column: 'Étape — variante' },
];

const shortDate = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });

function Segmented<T extends string>({ items, value, onChange, label }: { items: { id: T; label: string }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 shadow-xs">
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          role="radio"
          aria-checked={value === it.id}
          onClick={() => onChange(it.id)}
          className={cx('rounded-md px-2.5 py-1 text-sm font-medium transition-colors', value === it.id ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100')}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

function RateBar({ rate, max }: { rate: number; max: number }) {
  const w = max > 0 ? Math.max(2, Math.round((rate / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-100" aria-hidden>
        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${w}%` }} />
      </div>
      <span className="w-14 text-right tabular-nums">{fmtPercent(rate)}</span>
    </div>
  );
}

export function FunnelStatsTab({ funnel }: { funnel: Funnel }) {
  const [period, setPeriod] = useState<StatsPeriod>('30');
  const [group, setGroup] = useState<StatsGroup>('source');
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, loading, reload } = useLoad(() => growthApi.funnelStats(funnel.id, period, group), [funnel.id, period, group]);
  const groupMeta = GROUPS.find((g) => g.id === group)!;
  const maxRate = Math.max(0, ...(data?.rows ?? []).map((r) => r.rate));
  const stepName = (id: number) => data?.steps.find((s) => s.step_id === id)?.name ?? '—';

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented label="Période" items={PERIODS} value={period} onChange={setPeriod} />
        <Segmented label="Regrouper par" items={GROUPS} value={group} onChange={(g) => { setGroup(g); setOpen(null); }} />
      </div>

      {error && !data ? (
        <ErrorState message={error} onRetry={reload} />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="Visiteurs uniques" value={data ? fmtNumber(data.totals.visitors) : '…'} icon={Eye} tone="sky" />
            <StatCard label="Optins" value={data ? fmtNumber(data.totals.optins) : '…'} icon={MousePointerClick} tone="green" />
            <StatCard label="Taux de conversion" value={data ? fmtPercent(data.totals.rate) : '…'} icon={Percent} tone="amber" />
          </div>

          <Card>
            <h3 className="mb-3 text-sm font-semibold text-slate-900">Visiteurs et optins par jour</h3>
            <div className="h-56">
              {loading && !data ? (
                <Skeleton className="h-full w-full" />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data?.daily ?? []} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                    <defs>
                      <linearGradient id="fs-v" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#0ea5e9" stopOpacity={0.2} />
                        <stop offset="100%" stopColor="#0ea5e9" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="fs-o" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#10b981" stopOpacity={0.25} />
                        <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 12, fill: '#64748b' }} axisLine={false} tickLine={false} minTickGap={24} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: '#64748b' }} axisLine={false} tickLine={false} />
                    <Tooltip
                      labelFormatter={(l) => shortDate(String(l))}
                      contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', boxShadow: '0 10px 30px -10px rgba(15,23,42,.25)', fontSize: 13 }}
                    />
                    <Area type="monotone" dataKey="visitors" name="Visiteurs" stroke="#0ea5e9" strokeWidth={2} fill="url(#fs-v)" activeDot={{ r: 4, strokeWidth: 0 }} />
                    <Area type="monotone" dataKey="optins" name="Optins" stroke="#10b981" strokeWidth={2} fill="url(#fs-o)" activeDot={{ r: 4, strokeWidth: 0 }} />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </Card>

          <Card padded={false} className="overflow-hidden">
            <div className="border-b border-slate-100 px-4 py-3">
              <h3 className="text-sm font-semibold text-slate-900">Conversion par {groupMeta.label.toLowerCase()}</h3>
              <p className="text-xs text-slate-500">
                Attribution au premier contact (paramètres UTM de la première visite, sinon site référent). Cliquez sur une ligne pour le détail par étape.
              </p>
            </div>
            {!data ? (
              <div className="space-y-2 p-4">
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-6 w-full" />
              </div>
            ) : data.rows.length === 0 ? (
              <EmptyState
                icon={BarChart3}
                className="m-4 border-0"
                title={group === 'variant' ? 'Aucun test A/B sur cette période' : 'Pas encore de visites sur cette période'}
                description={
                  group === 'variant'
                    ? 'Lancez un test A/B sur une étape pour comparer ses variantes ici.'
                    : 'Ajoutez ?utm_source=…&utm_medium=…&utm_campaign=… à vos liens pour savoir d’où viennent vos inscrits.'
                }
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs font-medium text-slate-500">
                    <tr>
                      <th className="px-4 py-2">{groupMeta.column}</th>
                      <th className="px-4 py-2 text-right">Visiteurs</th>
                      <th className="px-4 py-2 text-right">Optins</th>
                      <th className="px-4 py-2 text-right">Conversion</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.rows.map((r) => (
                      <StatsRow key={r.key} row={r} maxRate={maxRate} open={open === r.key} onToggle={() => setOpen(open === r.key ? null : r.key)} stepName={stepName} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {data && data.steps.length > 0 && (
            <Card padded={false} className="overflow-hidden">
              <div className="border-b border-slate-100 px-4 py-3">
                <h3 className="text-sm font-semibold text-slate-900">Par étape</h3>
              </div>
              <table className="w-full text-sm">
                <tbody className="divide-y divide-slate-100">
                  {data.steps.map((s, i) => (
                    <tr key={s.step_id}>
                      <td className="px-4 py-2.5">
                        <span className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded bg-slate-100 text-[11px] font-bold text-slate-600">{i + 1}</span>
                        <span className="font-medium text-slate-800">{s.name}</span>
                      </td>
                      <td className="px-4 py-2.5 text-right text-slate-600 tabular-nums">{fmtNumber(s.visitors)} visiteurs</td>
                      <td className="px-4 py-2.5 text-right text-slate-600 tabular-nums">{fmtNumber(s.optins)} optins</td>
                      <td className="px-4 py-2.5 text-right">
                        <RateBar rate={s.rate} max={Math.max(0, ...data.steps.map((x) => x.rate))} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function StatsRow({ row, maxRate, open, onToggle, stepName }: { row: FunnelStatsRow; maxRate: number; open: boolean; onToggle: () => void; stepName: (id: number) => string }) {
  return (
    <>
      <tr className="cursor-pointer hover:bg-slate-50" onClick={onToggle} aria-expanded={open}>
        <td className="max-w-[320px] truncate px-4 py-2.5 font-medium text-slate-800" title={row.label}>
          <button type="button" className="text-left" onClick={(e) => { e.stopPropagation(); onToggle(); }}>
            {row.label}
          </button>
        </td>
        <td className="px-4 py-2.5 text-right tabular-nums">{fmtNumber(row.visitors)}</td>
        <td className="px-4 py-2.5 text-right tabular-nums">{fmtNumber(row.optins)}</td>
        <td className="px-4 py-2.5">
          <div className="flex justify-end">
            <RateBar rate={row.rate} max={maxRate} />
          </div>
        </td>
      </tr>
      {open &&
        row.steps.map((c) => (
          <tr key={c.step_id} className="bg-slate-50/70 text-xs text-slate-600">
            <td className="py-1.5 pr-4 pl-8">{stepName(c.step_id)}</td>
            <td className="px-4 py-1.5 text-right tabular-nums">{fmtNumber(c.visitors)}</td>
            <td className="px-4 py-1.5 text-right tabular-nums">{fmtNumber(c.optins)}</td>
            <td className="px-4 py-1.5 text-right tabular-nums">{fmtPercent(c.rate)}</td>
          </tr>
        ))}
    </>
  );
}
