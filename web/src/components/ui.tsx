import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { ChevronDown, LoaderCircle, type LucideIcon } from 'lucide-react';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/* ---------------- Button ---------------- */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'dark' | 'success';
type Size = 'xs' | 'sm' | 'md' | 'lg';

const variants: Record<Variant, string> = {
  primary: 'bg-brand-500 text-white hover:bg-brand-600 shadow-xs focus-visible:ring-brand-500/40',
  secondary: 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:text-slate-900 shadow-xs focus-visible:ring-slate-400/30',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus-visible:ring-slate-400/30',
  danger: 'bg-rose-600 text-white hover:bg-rose-700 shadow-sm focus-visible:ring-rose-500/40',
  dark: 'bg-ink text-white hover:bg-brand-900 focus-visible:ring-brand-500/40',
  success: 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm focus-visible:ring-emerald-500/40',
};
const sizes: Record<Size, string> = {
  // pill-shaped, like the logo's steps
  xs: 'h-7 px-2.5 text-xs gap-1 rounded-full',
  sm: 'h-8 px-3.5 text-sm gap-1.5 rounded-full',
  md: 'h-9 px-4 text-sm gap-2 rounded-full',
  lg: 'h-11 px-6 text-base gap-2 rounded-full',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: LucideIcon;
  iconRight?: LucideIcon;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, icon: Icon, iconRight: IconRight, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  const iconSize = size === 'xs' ? 14 : size === 'lg' ? 18 : 16;
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cx(
        'inline-flex shrink-0 items-center justify-center font-semibold whitespace-nowrap transition-colors outline-none focus-visible:ring-4 disabled:opacity-50 disabled:pointer-events-none',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <LoaderCircle size={iconSize} className="animate-spin" /> : Icon ? <Icon size={iconSize} /> : null}
      {children}
      {IconRight && !loading && <IconRight size={iconSize} />}
    </button>
  );
});

export function IconButton({
  icon: Icon,
  label,
  className,
  size = 16,
  active,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string; size?: number; active?: boolean }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={cx(
        'inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors disabled:opacity-40 disabled:pointer-events-none',
        active ? 'bg-slate-100 text-slate-900' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900',
        className,
      )}
      {...rest}
    >
      <Icon size={size} />
    </button>
  );
}

/* ---------------- Form controls ---------------- */

const fieldBase =
  'w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 shadow-xs outline-none transition focus:border-brand-500 focus:ring-4 focus:ring-brand-500/15 disabled:bg-slate-50 disabled:text-slate-500';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { icon?: LucideIcon }>(function Input(
  { className, icon: Icon, ...rest },
  ref,
) {
  if (Icon) {
    return (
      <div className={cx('relative', className)}>
        <Icon size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" />
        <input ref={ref} className={cx(fieldBase, 'h-9 pl-9')} {...rest} />
      </div>
    );
  }
  return <input ref={ref} className={cx(fieldBase, 'h-9', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...rest },
  ref,
) {
  return <textarea ref={ref} className={cx(fieldBase, 'py-2 leading-relaxed', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <div className={cx('relative', className)}>
      <select ref={ref} className={cx(fieldBase, 'h-9 appearance-none pr-9')} {...rest}>
        {children}
      </select>
      <ChevronDown size={16} className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-slate-400" />
    </div>
  );
});

export function Field({ label, hint, error, children, className }: { label?: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      {label && <span className="mb-1.5 block text-sm font-medium text-slate-700">{label}</span>}
      {children}
      {error ? <span className="mt-1 block text-xs text-rose-600">{error}</span> : hint ? <span className="mt-1 block text-xs text-slate-500">{hint}</span> : null}
    </label>
  );
}

export function Toggle({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; description?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cx('flex items-start gap-3 select-none', disabled ? 'opacity-50' : 'cursor-pointer')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          'relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors outline-none focus-visible:ring-4 focus-visible:ring-brand-500/30',
          checked ? 'bg-brand-500' : 'bg-slate-300',
        )}
      >
        <span className={cx('inline-block h-4 w-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
      </button>
      {(label || description) && (
        <span className="min-w-0">
          {label && <span className="block text-sm font-medium text-slate-800">{label}</span>}
          {description && <span className="block text-xs text-slate-500">{description}</span>}
        </span>
      )}
    </label>
  );
}

/* ---------------- Layout pieces ---------------- */

export function Card({ className, children, padded = true }: { className?: string; children: ReactNode; padded?: boolean }) {
  return <div className={cx('rounded-2xl border border-slate-200/80 bg-white', padded && 'p-5', className)}>{children}</div>;
}

export function CardHeader({ title, description, actions, icon: Icon }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; icon?: LucideIcon }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-3">
        {Icon && (
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
            <Icon size={15} />
          </span>
        )}
        <div className="min-w-0">
          <h3 className="font-display text-base font-bold tracking-[-0.01em] text-ink">{title}</h3>
          {description && <p className="mt-0.5 text-sm text-slate-500">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageHeader({ title, description, actions, back }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <div className="mb-7">
      {back && <div className="mb-3">{back}</div>}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-[28px] leading-tight font-extrabold tracking-[-0.03em] text-ink">{title}</h1>
          {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

type Tone = 'slate' | 'brand' | 'green' | 'amber' | 'red' | 'blue' | 'violet';
const tones: Record<Tone, string> = {
  slate: 'bg-slate-100 text-slate-600 ring-transparent',
  brand: 'bg-brand-50 text-brand-700 ring-transparent',
  green: 'bg-emerald-50 text-emerald-700 ring-transparent',
  amber: 'bg-amber-50 text-amber-800 ring-transparent',
  red: 'bg-rose-50 text-rose-700 ring-transparent',
  blue: 'bg-sky-50 text-sky-700 ring-transparent',
  violet: 'bg-violet-50 text-violet-700 ring-transparent',
};

export function Badge({ tone = 'slate', children, className, dot }: { tone?: Tone; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset', tones[tone], className)}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />}
      {children}
    </span>
  );
}

export function Spinner({ size = 20, className }: { size?: number; className?: string }) {
  return <LoaderCircle size={size} className={cx('animate-spin text-brand-600', className)} />;
}

export function PageLoader({ label = 'Chargement…' }: { label?: string }) {
  return (
    <div className="flex h-64 flex-col items-center justify-center gap-3 text-sm text-slate-500">
      <Spinner size={28} />
      {label}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-md bg-slate-200/70', className)} />;
}

export function EmptyState({ icon: Icon, title, description, action, className }: { icon: LucideIcon; title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx('flex flex-col items-center justify-center rounded-2xl border border-dashed border-brand-200 bg-white px-6 py-16 text-center', className)}>
      <span className="mb-4 flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
        <Icon size={22} strokeWidth={1.75} />
      </span>
      <h3 className="font-display text-lg font-extrabold tracking-[-0.02em] text-ink">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700">
      <p className="font-medium">Une erreur est survenue</p>
      <p className="mt-1">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
          Réessayer
        </Button>
      )}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, className }: { tabs: { id: T; label: ReactNode; icon?: LucideIcon; count?: number }[]; value: T; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={cx('flex gap-5 border-b border-slate-200', className)} role="tablist">
      {tabs.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            className={cx(
              '-mb-px inline-flex items-center gap-2 border-b-2 px-1 pt-2 pb-2.5 text-sm font-medium transition-colors',
              active ? 'border-brand-500 text-ink' : 'border-transparent text-slate-500 hover:text-slate-800',
            )}
          >
            {t.icon && <t.icon size={15} className={active ? 'text-brand-500' : 'text-slate-400'} />}
            {t.label}
            {t.count !== undefined && (
              <span className={cx('rounded-full px-1.5 py-px text-[11px] tabular-nums', active ? 'bg-brand-50 text-brand-700' : 'bg-slate-100 text-slate-500')}>{t.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

const avatarColors = ['bg-brand-100 text-brand-700', 'bg-emerald-100 text-emerald-700', 'bg-amber-100 text-amber-800', 'bg-rose-100 text-rose-700', 'bg-sky-100 text-sky-700', 'bg-violet-100 text-violet-700'];

export function Avatar({ text, seed, size = 36 }: { text: string; seed?: string | number; size?: number }) {
  const s = String(seed ?? text);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return (
    <span
      className={cx('inline-flex shrink-0 items-center justify-center rounded-full font-semibold', avatarColors[h % avatarColors.length])}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
    >
      {text}
    </span>
  );
}

export function StatCard({ label, value, icon: Icon, hint, tone = 'brand' }: { label: string; value: ReactNode; icon: LucideIcon; hint?: ReactNode; tone?: 'brand' | 'green' | 'amber' | 'sky' | 'rose' | 'violet' }) {
  const t = {
    brand: 'text-brand-500',
    green: 'text-emerald-500',
    amber: 'text-amber-500',
    sky: 'text-sky-500',
    rose: 'text-rose-500',
    violet: 'text-violet-500',
  }[tone];
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="truncate text-[13px] font-medium text-slate-500">{label}</p>
        <Icon size={16} className={cx('shrink-0', t)} />
      </div>
      <p className="mt-1.5 font-display text-[28px] leading-tight font-extrabold tracking-[-0.03em] text-ink tabular-nums">{value}</p>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </Card>
  );
}

/** Small keyboard key cap. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="scalo-kbd">{children}</kbd>;
}

/** Hover / focus tooltip (CSS only). `side` places the bubble. */
export function Tip({ label, children, side = 'bottom', className }: { label: ReactNode; children: ReactNode; side?: 'top' | 'bottom'; className?: string }) {
  return (
    <span className={cx('group/tip relative inline-flex', className)}>
      {children}
      <span
        role="tooltip"
        className={cx(
          'pointer-events-none absolute left-1/2 z-[70] w-max max-w-[240px] -translate-x-1/2 rounded-md bg-slate-900 px-2 py-1 text-center text-xs font-medium text-white opacity-0 shadow-lg transition-opacity delay-0 group-hover/tip:opacity-100 group-hover/tip:delay-300 group-focus-within/tip:opacity-100',
          side === 'bottom' ? 'top-full mt-1.5' : 'bottom-full mb-1.5',
        )}
      >
        {label}
      </span>
    </span>
  );
}

export function Pagination({ page, total, limit, onChange }: { page: number; total: number; limit: number; onChange: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / limit));
  if (total === 0) return null;
  const from = (page - 1) * limit + 1;
  const to = Math.min(total, page * limit);
  return (
    <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-sm text-slate-500">
      <span>
        {from}–{to} sur {total}
      </span>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>
          Précédent
        </Button>
        <span className="tabular-nums">
          {page} / {pages}
        </span>
        <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => onChange(page + 1)}>
          Suivant
        </Button>
      </div>
    </div>
  );
}
