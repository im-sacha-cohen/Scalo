// Small shared pieces of the « Affiliation » screens: status badge, commission editor.
import { useState } from 'react';
import { AFFILIATE_STATUS_LABELS, type AffiliateStatus, type CommissionRate } from '@scalo/shared';
import { Badge, Input, Select } from '../../components/ui';
import { amountInput, parseAmount } from '../sales/labels';

const AFF_TONES: Record<AffiliateStatus, 'amber' | 'green' | 'red' | 'slate'> = { pending: 'amber', approved: 'green', rejected: 'slate', suspended: 'red' };

export const AffiliateStatusBadge = ({ status }: { status: AffiliateStatus }) => (
  <Badge tone={AFF_TONES[status]} dot>
    {AFFILIATE_STATUS_LABELS[status]}
  </Badge>
);

/** Commission editor: percentage or fixed amount. `value` null = « commission du programme ». */
export function RateInput({ value, onChange, allowDefault }: { value: CommissionRate | null; onChange: (v: CommissionRate | null) => void; allowDefault?: boolean }) {
  const [text, setText] = useState(value ? (value.type === 'percent' ? String(value.value).replace('.', ',') : amountInput(value.value)) : '');
  const type = value?.type ?? (allowDefault ? 'default' : 'percent');
  const apply = (t: string, raw: string) => {
    if (t === 'default') return onChange(null);
    if (t === 'percent') {
      const n = Number(raw.replace(',', '.'));
      onChange({ type: 'percent', value: raw.trim() && Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0 });
    } else onChange({ type: 'fixed', value: parseAmount(raw) ?? 0 });
  };
  return (
    <div className="flex gap-2">
      <Select className="w-44" value={type} onChange={(e) => apply(e.target.value, text)} aria-label="Type de commission">
        {allowDefault && <option value="default">Commission du programme</option>}
        <option value="percent">Pourcentage (%)</option>
        <option value="fixed">Montant fixe</option>
      </Select>
      {type !== 'default' && (
        <Input
          className="w-28"
          inputMode="decimal"
          value={text}
          aria-label={type === 'percent' ? 'Pourcentage' : 'Montant'}
          placeholder={type === 'percent' ? '30' : '15,00'}
          onChange={(e) => {
            setText(e.target.value);
            apply(type, e.target.value);
          }}
        />
      )}
    </div>
  );
}
