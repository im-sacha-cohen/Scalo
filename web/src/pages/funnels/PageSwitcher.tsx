import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Filter, Lock, Search } from 'lucide-react';
import type { Funnel, Step } from '@scalo/shared';
import { api } from '../../lib/api';
import { STEP_TYPE_LABELS } from '../../lib/format';
import { cx, Spinner } from '../../components/ui';
import { STEP_TYPE_META } from './FunnelDetail';
import { accessLabel, isProtected } from './StepAccessModal';

/**
 * Header dropdown of the step editor: jump to another step of this funnel, or to a step of another funnel,
 * without going back to the funnel page.
 */
export function PageSwitcher({ funnel, step, onGo }: { funnel: Funnel; step: Step; onGo: (funnelId: number, stepId: number) => void }) {
  const [open, setOpen] = useState(false);
  const [funnels, setFunnels] = useState<Funnel[] | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [stepsById, setStepsById] = useState<Record<number, Step[]>>({});
  const [loadingId, setLoadingId] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    if (!funnels) api.funnels().then(setFunnels).catch(() => setFunnels([]));
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, funnels]);

  const toggleFunnel = async (id: number) => {
    if (expanded === id) return setExpanded(null);
    setExpanded(id);
    if (stepsById[id]) return;
    setLoadingId(id);
    try {
      const f = await api.funnel(id);
      setStepsById((m) => ({ ...m, [id]: f.steps ?? [] }));
    } finally {
      setLoadingId(null);
    }
  };

  const go = (fid: number, sid: number) => {
    setOpen(false);
    if (sid !== step.id) onGo(fid, sid);
  };

  const others = (funnels ?? []).filter((f) => f.id !== funnel.id && f.name.toLowerCase().includes(q.trim().toLowerCase()));
  const currentSteps = funnel.steps ?? [];

  const StepItem = ({ s, fid, index }: { s: Step; fid: number; index: number }) => {
    const meta = STEP_TYPE_META[s.type] ?? STEP_TYPE_META.custom;
    const current = s.id === step.id;
    return (
      <button
        type="button"
        onClick={() => go(fid, s.id)}
        className={cx('flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm', current ? 'bg-brand-50 text-brand-800' : 'text-slate-700 hover:bg-slate-100')}
      >
        <span className={cx('flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[11px] font-bold', current ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-500')}>
          {index + 1}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{s.name}</span>
          <span className="flex items-center gap-1 text-[11px] text-slate-400">
            <meta.icon size={11} /> {STEP_TYPE_LABELS[s.type]}
            {isProtected(s.access) && (
              <span className="ml-1 inline-flex items-center gap-0.5 text-amber-600">
                <Lock size={10} /> {accessLabel(s.access)}
              </span>
            )}
          </span>
        </span>
        {current && <Check size={15} className="shrink-0 text-brand-600" />}
      </button>
    );
  };

  return (
    <div ref={root} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cx('flex min-w-0 max-w-full items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-slate-100', open && 'bg-slate-100')}
        title="Changer de page ou de tunnel"
      >
        <span className="min-w-0">
          <span className="flex items-center gap-1 text-[11px] leading-tight text-slate-400">
            <span className="truncate">{funnel.name}</span>
            <ChevronRight size={11} className="shrink-0" />
            <span className="shrink-0">{STEP_TYPE_LABELS[step.type]}</span>
          </span>
          <span className="flex items-center gap-1.5 truncate text-sm leading-tight font-semibold text-slate-900">
            {isProtected(step.access) && <Lock size={12} className="shrink-0 text-amber-600" />}
            <span className="truncate">{step.name}</span>
          </span>
        </span>
        <ChevronDown size={15} className={cx('shrink-0 text-slate-400 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute top-full left-0 z-50 mt-2 flex max-h-[min(70vh,560px)] w-[340px] max-w-[calc(100vw-24px)] animate-pop-in flex-col overflow-hidden rounded-xl bg-white text-slate-900 shadow-pop">
          <div className="overflow-y-auto p-2">
            <p className="px-2 pt-1 pb-1.5 text-xs font-medium text-slate-400">Pages de « {funnel.name} »</p>
            {currentSteps.map((s, i) => (
              <StepItem key={s.id} s={s} fid={funnel.id} index={i} />
            ))}

            <div className="mt-3 border-t border-slate-100 pt-3">
              <p className="px-2 pb-1.5 text-xs font-medium text-slate-400">Autres tunnels</p>
              {(funnels?.length ?? 0) > 6 && (
                <div className="relative mb-1.5 px-1">
                  <Search size={14} className="absolute top-1/2 left-3.5 -translate-y-1/2 text-slate-400" />
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Rechercher un tunnel…"
                    className="h-8 w-full rounded-lg border border-slate-200 pr-2 pl-8 text-sm outline-none focus:border-brand-400"
                  />
                </div>
              )}
              {!funnels ? (
                <div className="flex justify-center py-3">
                  <Spinner size={18} />
                </div>
              ) : others.length === 0 ? (
                <p className="px-2 py-2 text-xs text-slate-400">Aucun autre tunnel.</p>
              ) : (
                others.map((f) => (
                  <div key={f.id}>
                    <button
                      type="button"
                      onClick={() => toggleFunnel(f.id)}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-100"
                    >
                      <Filter size={14} className="shrink-0 text-slate-400" />
                      <span className="min-w-0 flex-1 truncate font-medium">{f.name}</span>
                      <span className="text-[11px] text-slate-400">{f.steps_count ?? ''} p.</span>
                      {loadingId === f.id ? <Spinner size={14} /> : <ChevronDown size={14} className={cx('text-slate-400 transition-transform', expanded === f.id && 'rotate-180')} />}
                    </button>
                    {expanded === f.id && stepsById[f.id] && (
                      <div className="ml-4 border-l border-slate-100 pl-2">
                        {stepsById[f.id].length === 0 ? (
                          <p className="px-2 py-1.5 text-xs text-slate-400">Aucune page.</p>
                        ) : (
                          stepsById[f.id].map((s, i) => <StepItem key={s.id} s={s} fid={f.id} index={i} />)
                        )}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
