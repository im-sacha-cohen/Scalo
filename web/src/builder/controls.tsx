import { useEffect, useState, type ReactNode } from 'react';
import { ChevronRight, CircleHelp, RotateCcw, type LucideIcon } from 'lucide-react';
import { cx } from '../components/ui';

export const inputCls =
  'w-full h-9 rounded-lg border border-slate-200 bg-white px-2.5 text-sm text-slate-900 placeholder:text-slate-400 outline-none transition focus:border-brand-500 focus:ring-4 focus:ring-brand-500/15';
export const textareaCls =
  'w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm leading-relaxed text-slate-900 placeholder:text-slate-400 outline-none transition focus:border-brand-500 focus:ring-4 focus:ring-brand-500/15 resize-y';

export function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="border-b border-slate-100 px-4 py-4 last:border-b-0">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="text-[13px] font-medium text-slate-800">{title}</h4>
        {action}
      </div>
      <div className="space-y-3.5">{children}</div>
    </section>
  );
}

export function Prop({ label, children, hint, inline, aside }: { label: string; children: ReactNode; hint?: ReactNode; inline?: boolean; aside?: ReactNode }) {
  if (inline) {
    return (
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1 text-[13px] text-slate-600">
          {label}
          {hint && <HintIcon hint={hint} />}
        </span>
        {children}
      </div>
    );
  }
  return (
    <div className="relative">
      <div className="mb-1.5 flex items-center gap-1 text-xs font-medium text-slate-600">
        <span>{label}</span>
        {hint && <HintIcon hint={hint} />}
        {aside && <span className="ml-auto text-[11px] font-normal text-slate-400 tabular-nums">{aside}</span>}
      </div>
      {children}
    </div>
  );
}

/** Small "?" next to a label: the help text shows on hover / focus instead of taking room below the field. */
export function HintIcon({ hint }: { hint: ReactNode }) {
  return (
    <span className="group/hint static inline-flex">
      <span
        tabIndex={0}
        aria-label="Aide"
        className="inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full text-slate-300 outline-none hover:text-slate-500 focus-visible:text-brand-600"
      >
        <CircleHelp size={13} />
      </span>
      <span
        role="tooltip"
        className="pointer-events-none absolute top-5 right-0 left-0 z-30 rounded-lg bg-slate-900 px-2.5 py-2 text-[11.5px] leading-snug font-normal text-slate-100 opacity-0 shadow-lg transition-opacity group-focus-within/hint:opacity-100 group-hover/hint:opacity-100 group-hover/hint:delay-200"
      >
        {hint}
      </span>
    </span>
  );
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const toPicker = (v?: string) => {
  if (!v || !HEX.test(v)) return '#000000';
  if (v.length === 4) return '#' + [...v.slice(1)].map((c) => c + c).join('');
  return v.toLowerCase();
};

/** Native color picker + hex text field. `value` undefined = inherited (shows `placeholder`). */
export function ColorInput({
  value,
  onChange,
  placeholder,
  allowClear = true,
}: {
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  placeholder?: string;
  allowClear?: boolean;
}) {
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => setDraft(value ?? ''), [value]);
  const shown = value ?? placeholder;

  const commit = (v: string) => {
    const t = v.trim();
    if (!t) {
      if (allowClear) onChange(undefined);
      else setDraft(value ?? '');
      return;
    }
    const withHash = t.startsWith('#') ? t : '#' + t;
    if (HEX.test(withHash)) onChange(withHash.toLowerCase());
    else setDraft(value ?? '');
  };

  return (
    <div className="flex items-center gap-2">
      <label
        className="relative h-9 w-9 shrink-0 cursor-pointer overflow-hidden rounded-lg border border-slate-200 shadow-xs"
        style={{ background: shown && HEX.test(shown) ? shown : 'repeating-conic-gradient(#e2e8f0 0% 25%, #fff 0% 50%) 50% / 10px 10px' }}
        title="Choisir une couleur"
      >
        <input
          type="color"
          className="scalo-color absolute inset-0 h-full w-full cursor-pointer opacity-0"
          value={toPicker(shown)}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
      <input
        className={cx(inputCls, 'font-mono text-xs uppercase')}
        value={draft}
        placeholder={placeholder ? placeholder.toUpperCase() : 'Auto'}
        onChange={(e) => {
          setDraft(e.target.value);
          const t = e.target.value.trim();
          const withHash = t.startsWith('#') ? t : '#' + t;
          if (/^#[0-9a-f]{6}$/i.test(withHash)) onChange(withHash.toLowerCase());
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && commit((e.target as HTMLInputElement).value)}
        spellCheck={false}
      />
      {allowClear && value !== undefined && (
        <button
          type="button"
          onClick={() => onChange(undefined)}
          className="shrink-0 rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          title="Réinitialiser"
        >
          <RotateCcw size={14} />
        </button>
      )}
    </div>
  );
}

export function RangeInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  unit = 'px',
  placeholder,
  onReset,
}: {
  value: number | undefined;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  placeholder?: number;
  onReset?: () => void;
}) {
  const v = value ?? placeholder ?? min;
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        className="scalo-range flex-1"
        min={min}
        max={max}
        step={step}
        value={v}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ background: `linear-gradient(to right, var(--color-brand-500) ${((v - min) / (max - min)) * 100}%, #e2e8f0 0)` }}
      />
      <div className="relative w-[84px] shrink-0">
        <input
          type="number"
          className={cx(inputCls, 'h-8 pr-7 text-right tabular-nums', value === undefined && 'text-slate-400')}
          min={min}
          max={max}
          step={step}
          value={v}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (!Number.isNaN(n)) onChange(Math.max(min, Math.min(max, n)));
          }}
        />
        <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[11px] text-slate-400">{unit}</span>
      </div>
      {onReset && value !== undefined && (
        <button type="button" onClick={onReset} className="shrink-0 rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="Valeur par défaut">
          <RotateCcw size={13} />
        </button>
      )}
    </div>
  );
}

export function Segmented<T extends string | number>({
  value,
  onChange,
  options,
  full = true,
}: {
  value: T | undefined;
  onChange: (v: T) => void;
  options: { value: T; label?: string; icon?: LucideIcon; title?: string }[];
  full?: boolean;
}) {
  return (
    <div className={cx('inline-flex rounded-lg bg-slate-100 p-0.5', full && 'flex w-full')}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            title={o.title ?? o.label}
            onClick={() => onChange(o.value)}
            className={cx(
              'inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-all',
              active ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800',
            )}
          >
            {o.icon && <o.icon size={15} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700 select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-slate-300 accent-[var(--color-brand-600)]"
      />
      {label}
    </label>
  );
}

// Open / closed state of the inspector groups, remembered for the session (per title) so a group the user
// opened stays open when another block is selected.
const groupMemory = new Map<string, boolean>();

/** Collapsible group inside an inspector tab (collapsed by default unless `defaultOpen`). */
export function Group({ title, children, defaultOpen = false, action, id }: { title: string; children: ReactNode; defaultOpen?: boolean; action?: ReactNode; id?: string }) {
  const key = id ?? title;
  const [open, setOpenState] = useState(() => groupMemory.get(key) ?? defaultOpen);
  const setOpen = (v: boolean) => {
    groupMemory.set(key, v);
    setOpenState(v);
  };
  return (
    <section className="border-b border-slate-100 last:border-b-0">
      <div className="flex items-center justify-between px-4">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex h-11 flex-1 items-center gap-1.5 text-left text-[13px] font-medium text-slate-800 hover:text-slate-950"
        >
          <ChevronRight size={14} className={cx('shrink-0 text-slate-400 transition-transform', open && 'rotate-90')} />
          {title}
        </button>
        {action}
      </div>
      {open && <div className="space-y-3.5 px-4 pt-0.5 pb-4">{children}</div>}
    </section>
  );
}

/** Lightweight disclosure used inside a tab body (no padding of its own). */
export function Disclosure({ title, children, defaultOpen = false, id }: { title: string; children: ReactNode; defaultOpen?: boolean; id?: string }) {
  const key = `d:${id ?? title}`;
  const [open, setOpenState] = useState(() => groupMemory.get(key) ?? defaultOpen);
  return (
    <div className="-mx-4 border-t border-slate-100 px-4 pt-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          groupMemory.set(key, !open);
          setOpenState(!open);
        }}
        className="flex h-9 w-full items-center gap-1.5 text-left text-[13px] font-medium text-slate-800 hover:text-slate-950"
      >
        <ChevronRight size={14} className={cx('shrink-0 text-slate-400 transition-transform', open && 'rotate-90')} />
        {title}
      </button>
      {open && <div className="space-y-3.5 pt-1 pb-1">{children}</div>}
    </div>
  );
}

/** Two number inputs side by side (e.g. top / bottom). */
export function NumberPair({
  labels,
  values,
  placeholders,
  onChange,
  min = 0,
  max = 400,
  unit = 'px',
}: {
  labels: [string, string];
  values: [number | undefined, number | undefined];
  placeholders?: [number | undefined, number | undefined];
  onChange: (i: 0 | 1, v: number | undefined) => void;
  min?: number;
  max?: number;
  unit?: string;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {([0, 1] as const).map((i) => (
        <label key={i} className="block">
          <span className="mb-1 block text-[11px] text-slate-500">{labels[i]}</span>
          <div className="relative">
            <input
              type="number"
              min={min}
              max={max}
              className={cx(inputCls, 'h-8 pr-7 tabular-nums')}
              value={values[i] ?? ''}
              placeholder={placeholders?.[i] !== undefined ? String(placeholders[i]) : '—'}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === '') return onChange(i, undefined);
                const n = Number(raw);
                if (!Number.isNaN(n)) onChange(i, Math.max(min, Math.min(max, n)));
              }}
            />
            <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[11px] text-slate-400">{unit}</span>
          </div>
        </label>
      ))}
    </div>
  );
}

/** Image picker: preview + media library + URL. */
export function ImageField({ value, onChange, onBrowse, compact }: { value: string | undefined; onChange: (v: string) => void; onBrowse: () => void; compact?: boolean }) {
  return (
    <div className="space-y-2">
      {value ? (
        <div className={cx('group relative flex items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-[repeating-conic-gradient(#f1f5f9_0%_25%,#fff_0%_50%)] bg-[length:16px_16px]', compact ? 'h-20' : 'h-28')}>
          <img src={value} alt="" className="max-h-full max-w-full object-contain" />
          <div className="absolute inset-0 flex items-center justify-center gap-2 bg-slate-900/0 opacity-0 transition-all group-hover:bg-slate-900/40 group-hover:opacity-100">
            <button type="button" onClick={onBrowse} className="rounded-md bg-white px-2.5 py-1 text-xs font-semibold text-slate-800 shadow">
              Remplacer
            </button>
            <button type="button" onClick={() => onChange('')} className="rounded-md bg-white px-2.5 py-1 text-xs font-semibold text-rose-600 shadow">
              Retirer
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={onBrowse}
          className={cx('flex w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-slate-300 bg-slate-50/50 text-xs font-medium text-slate-500 hover:border-brand-400 hover:bg-brand-50/50 hover:text-brand-700', compact ? 'h-14' : 'h-20')}
        >
          Importer ou choisir une image
        </button>
      )}
      <input className={cx(inputCls, 'h-8 text-xs')} value={value ?? ''} placeholder="ou URL https://…" onChange={(e) => onChange(e.target.value.trim())} spellCheck={false} />
    </div>
  );
}
