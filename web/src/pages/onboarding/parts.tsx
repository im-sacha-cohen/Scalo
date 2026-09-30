// Visual parts of the welcome flow: the "stairs" (the logo's stepped pills used as the progress indicator), the
// scaled preview of a real page, and the step heading. Brand rules: brand/BRAND.md — flat fills, ink for dark areas,
// lime only on dark backgrounds.
import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { Check } from 'lucide-react';
import type { OnboardingStep } from '@scalo/shared';
import { cx } from '../../components/ui';

export const FLOW: { id: OnboardingStep; label: string; short: string }[] = [
  { id: 'goal', label: 'Votre objectif', short: 'Objectif' },
  { id: 'business', label: 'Votre activité', short: 'Activité' },
  { id: 'funnel', label: 'Votre premier tunnel', short: 'Premier tunnel' },
  { id: 'live', label: 'C’est en ligne', short: 'En ligne' },
];
export const stepIndex = (s: OnboardingStep) => FLOW.findIndex((f) => f.id === s);

/**
 * Progress as the logo's staircase: the first step is the bottom pill, the last one the top pill. The current step
 * is lime (the accent climbs), the steps behind are indigo and can be reopened, the ones ahead are dimmed.
 */
export function Stairs({ current, onGo, locked }: { current: OnboardingStep; onGo: (s: OnboardingStep) => void; locked?: boolean }) {
  const cur = stepIndex(current);
  return (
    <nav aria-label="Étapes de la mise en route">
      <ol className="flex flex-col-reverse gap-2">
        {FLOW.map((s, i) => {
          const state = i < cur ? 'done' : i === cur ? 'current' : 'todo';
          // once the page is online there is nothing to redo behind: the pills become a plain picture of the climb
          const clickable = state === 'done' && !locked;
          return (
            <li key={s.id} style={{ marginLeft: i * 26 }}>
              <button
                type="button"
                disabled={!clickable}
                onClick={() => onGo(s.id)}
                aria-current={state === 'current' ? 'step' : undefined}
                aria-label={`Étape ${i + 1} : ${s.label}${state === 'done' ? ' (terminée' + (clickable ? ', revenir à cette étape)' : ')') : state === 'current' ? ' (en cours)' : ''}`}
                className={cx(
                  'onb-motion flex h-[52px] w-[232px] items-center gap-3 rounded-full py-2 pr-5 pl-3 text-left text-sm font-semibold outline-none transition-colors duration-500 focus-visible:ring-4 focus-visible:ring-white/30',
                  state === 'current' && 'bg-lime-400 text-ink',
                  state === 'done' && 'bg-brand-500 text-white',
                  state === 'done' && clickable && 'hover:bg-brand-400',
                  state === 'todo' && 'bg-brand-900 text-brand-300',
                  !clickable && 'cursor-default',
                )}
              >
                <span
                  className={cx(
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-mono text-xs',
                    state === 'current' ? 'bg-ink/10' : state === 'done' ? 'bg-white/15' : 'bg-white/5',
                  )}
                >
                  {state === 'done' ? <Check size={14} strokeWidth={2.5} /> : i + 1}
                </span>
                <span className="truncate">{s.label}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** The same staircase, flattened for the mobile header: four small pills, each one a little higher. */
export function StairsCompact({ current }: { current: OnboardingStep }) {
  const cur = stepIndex(current);
  return (
    <div className="flex items-end gap-1.5 pt-3" aria-hidden="true">
      {FLOW.map((s, i) => (
        <span
          key={s.id}
          className={cx('onb-motion h-2 w-9 rounded-full transition-colors duration-500', i < cur ? 'bg-brand-500' : i === cur ? 'bg-lime-400' : 'bg-brand-900')}
          style={{ transform: `translateY(-${i * 3}px)` }}
        />
      ))}
    </div>
  );
}

/** Heading of a step. Receives the focus when the step changes (keyboard and screen-reader users start at the top). */
export function StepHead({ n, eyebrow, title, lead, headingRef }: { n: number; eyebrow: string; title: ReactNode; lead?: ReactNode; headingRef: Ref<HTMLHeadingElement> }) {
  return (
    <header>
      <p className="font-mono text-xs font-medium tracking-[0.14em] text-brand-500 uppercase">
        {String(n).padStart(2, '0')} <span className="text-brand-300">/</span> {eyebrow}
      </p>
      <h1 ref={headingRef} tabIndex={-1} className="mt-3 max-w-[18ch] text-[32px] leading-[1.06] font-extrabold tracking-[-0.035em] text-ink outline-none sm:text-[44px]">
        {title}
      </h1>
      {lead && <p className="mt-4 max-w-[52ch] text-[15px] leading-relaxed text-slate-600 sm:text-base">{lead}</p>}
    </header>
  );
}

/** A full page document scaled down to the width of its container (script-less, not focusable). */
export function PageThumb({ html, docWidth = 1280, className }: { html: string; docWidth?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (!('ResizeObserver' in window)) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = width / docWidth;
  return (
    <div ref={ref} className={cx('relative overflow-hidden bg-white', className)}>
      {width > 0 && (
        <iframe
          title="Aperçu de la page"
          sandbox=""
          srcDoc={html}
          tabIndex={-1}
          aria-hidden="true"
          className="pointer-events-none absolute top-0 left-0 origin-top-left border-0"
          style={{ width: docWidth, height: `${100 / scale}%`, transform: `scale(${scale})` }}
        />
      )}
    </div>
  );
}

/** Browser window around a page preview: address bar in the brand mono face. */
export function BrowserFrame({ address, live, children, className }: { address: string; live?: boolean; children: ReactNode; className?: string }) {
  return (
    <div className={cx('overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-float', className)}>
      <div className="flex h-10 items-center gap-3 border-b border-slate-200 bg-slate-50 px-3.5">
        <span className="flex gap-1.5" aria-hidden="true">
          <i className="h-2.5 w-2.5 rounded-full bg-slate-300" />
          <i className="h-2.5 w-2.5 rounded-full bg-slate-300" />
          <i className="h-2.5 w-2.5 rounded-full bg-slate-300" />
        </span>
        <span className="flex h-6 min-w-0 flex-1 items-center gap-2 rounded-full bg-white px-3 font-mono text-[11px] text-slate-500 ring-1 ring-slate-200">
          {live && <LiveDot />}
          <span className="truncate">{address}</span>
        </span>
      </div>
      {children}
    </div>
  );
}

export function LiveDot() {
  return (
    <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
      <span className="onb-ping absolute inset-0 rounded-full bg-emerald-500" />
      <span className="relative h-2 w-2 rounded-full bg-emerald-500" />
    </span>
  );
}
