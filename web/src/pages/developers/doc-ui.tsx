// Building blocks of the developer documentation (Développeurs → MCP, API REST, OAuth).
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cx } from '../../components/ui';

export const ORIGIN = window.location.origin;

/** Inline code. */
export function C({ children }: { children: ReactNode }) {
  return <code className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[12.5px] text-slate-800">{children}</code>;
}

const METHOD_TONES: Record<string, string> = {
  GET: 'bg-emerald-50 text-emerald-700',
  POST: 'bg-sky-50 text-sky-700',
  PATCH: 'bg-amber-50 text-amber-800',
  DELETE: 'bg-rose-50 text-rose-700',
};

export function Method({ m }: { m: string }) {
  return <span className={cx('inline-flex w-14 shrink-0 justify-center rounded-md py-0.5 font-mono text-[11px] font-bold', METHOD_TONES[m] ?? 'bg-slate-100 text-slate-600')}>{m}</span>;
}

/** Scope required by a tool or an endpoint. */
export function Scope({ s }: { s: string }) {
  return <span className="inline-flex rounded-md bg-brand-50 px-1.5 py-0.5 font-mono text-[11px] font-medium whitespace-nowrap text-brand-700">{s}</span>;
}

/** A titled block of the documentation. */
export function Section({ title, description, children, className }: { title: ReactNode; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('min-w-0 space-y-4', className)}>
      <div>
        <h2 className="font-display text-lg font-extrabold tracking-[-0.02em] text-ink">{title}</h2>
        {description && <p className="mt-1 max-w-3xl text-sm text-slate-500">{description}</p>}
      </div>
      {children}
    </section>
  );
}

/** Numbered steps joined by a line. */
export function Steps({ steps }: { steps: { title: ReactNode; body?: ReactNode }[] }) {
  return (
    <ol className="relative space-y-5">
      {steps.map((s, i) => (
        <li key={i} className="relative flex gap-4">
          {i < steps.length - 1 && <span aria-hidden className="absolute top-8 bottom-[-20px] left-[13px] w-px bg-slate-200" />}
          <span className="relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink text-xs font-bold text-white">{i + 1}</span>
          <div className="min-w-0 pt-0.5">
            <p className="text-sm font-semibold text-slate-900">{s.title}</p>
            {s.body && <div className="mt-1 text-sm text-slate-600">{s.body}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Small card with an icon: a fact worth knowing. */
export function Fact({ icon: Icon, title, children }: { icon: LucideIcon; title: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-4">
      <span className="mb-3 flex h-8 w-8 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
        <Icon size={16} />
      </span>
      <p className="text-sm font-semibold text-slate-900">{title}</p>
      <div className="mt-1 text-sm text-slate-600">{children}</div>
    </div>
  );
}

/** Highlighted note. */
export function Note({ icon: Icon, children, action }: { icon: LucideIcon; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-brand-100 bg-brand-50/60 p-4 sm:flex-row sm:items-center">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-brand-600 ring-1 ring-brand-100">
        <Icon size={16} />
      </span>
      <div className="min-w-0 flex-1 text-sm text-slate-700">{children}</div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
