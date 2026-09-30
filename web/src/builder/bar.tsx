// Small building blocks of the editors' single top bar (page editor, newsletter, campaign email).
import type { ReactNode } from 'react';
import { Check, ChevronDown, CloudUpload, Eye, EyeOff, LoaderCircle } from 'lucide-react';
import { cx } from '../components/ui';
import { DropdownMenu, type MenuEntry } from '../components/Menu';

/** Discreet save state: a dot / icon with a short label, details in the tooltip. */
export function SaveStatus({ saving, dirty, detail }: { saving: boolean; dirty: boolean; detail?: string }) {
  const label = saving ? 'Enregistrement…' : dirty ? 'Non enregistré' : 'Enregistré';
  const tip = saving ? 'Enregistrement en cours' : dirty ? 'Modifications non enregistrées (Ctrl+S pour enregistrer)' : (detail ?? 'Toutes les modifications sont enregistrées');
  return (
    <span className="group/save relative hidden sm:inline-flex">
      <span className={cx('inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium whitespace-nowrap', dirty ? 'text-amber-700' : 'text-slate-400')} aria-live="polite">
        {saving ? <LoaderCircle size={14} className="animate-spin" /> : dirty ? <span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> : <Check size={14} className="text-emerald-500" />}
        <span className="hidden xl:inline">{label}</span>
      </span>
      <span className="pointer-events-none absolute top-full right-0 z-[70] mt-1.5 rounded-md bg-slate-900 px-2 py-1 text-xs font-medium whitespace-nowrap text-white opacity-0 shadow-lg transition-opacity group-hover/save:opacity-100 group-hover/save:delay-200">
        {tip}
      </span>
    </span>
  );
}

/** "Aperçu" split button: main part toggles the in-editor preview, the chevron opens the other options. */
export function PreviewMenu({ preview, onToggle, items }: { preview: boolean; onToggle: () => void; items: MenuEntry[] }) {
  return (
    <div className="inline-flex h-8 items-stretch rounded-lg border border-slate-200 bg-white text-sm font-medium text-slate-700 shadow-xs">
      <button type="button" onClick={onToggle} className="inline-flex items-center gap-1.5 rounded-l-lg px-2.5 hover:bg-slate-50 hover:text-slate-900" title={preview ? 'Revenir à l’édition (Échap)' : 'Aperçu dans l’éditeur'}>
        {preview ? <EyeOff size={15} /> : <Eye size={15} />}
        <span className="hidden lg:inline">{preview ? 'Quitter l’aperçu' : 'Aperçu'}</span>
      </button>
      <span className="w-px bg-slate-200" />
      <DropdownMenu
        width={264}
        items={items}
        trigger={({ toggle, ref, open }) => (
          <button ref={ref} type="button" onClick={toggle} className={cx('inline-flex w-7 items-center justify-center rounded-r-lg hover:bg-slate-50', open && 'bg-slate-50')} aria-label="Autres aperçus" title="Autres aperçus">
            <ChevronDown size={14} />
          </button>
        )}
      />
    </div>
  );
}

/** Secondary button of the bar (white, bordered). */
export function BarButton({ children, className, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return (
    <button
      type="button"
      className={cx(
        'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 text-sm font-medium whitespace-nowrap text-slate-700 shadow-xs transition-colors hover:bg-slate-50 hover:text-slate-900 disabled:opacity-50 disabled:hover:bg-white',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Primary save button of the bar. */
export function SaveButton({ onClick, saving, dirty, label = 'Enregistrer' }: { onClick: () => void; saving: boolean; dirty: boolean; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={saving || !dirty}
      title="Enregistrer (Ctrl+S)"
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-brand-600 px-3 text-sm font-medium whitespace-nowrap text-white shadow-xs transition-colors hover:bg-brand-700 disabled:bg-slate-100 disabled:text-slate-400 disabled:shadow-none"
    >
      {saving ? <LoaderCircle size={15} className="animate-spin" /> : <CloudUpload size={15} />}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
