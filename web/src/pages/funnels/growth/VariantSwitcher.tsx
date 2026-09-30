// Page editor top bar: which version of the page is being edited (original or an A/B test variant).
import { FlaskConical } from 'lucide-react';
import type { StepVariant } from '@scalo/shared';
import { cx } from '../../../components/ui';

export function VariantSwitcher({ variants, current, onGo }: { variants: StepVariant[]; current: number; onGo: (variantId: number) => void }) {
  if (!variants.length) return null;
  return (
    <label
      className={cx(
        'relative ml-1 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-sm font-medium',
        current ? 'bg-violet-50 text-violet-800' : 'text-slate-600 hover:bg-slate-100',
      )}
      title="Version de la page en cours d’édition (test A/B)"
    >
      <FlaskConical size={15} className="shrink-0" />
      <span className="sr-only">Version éditée</span>
      <select
        value={current}
        onChange={(e) => onGo(Number(e.target.value))}
        className="max-w-[150px] cursor-pointer appearance-none truncate bg-transparent pr-1 outline-none"
        aria-label="Version de la page en cours d’édition"
      >
        <option value={0}>Original</option>
        {variants.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
            {v.active ? '' : ' (inactive)'}
          </option>
        ))}
      </select>
    </label>
  );
}
