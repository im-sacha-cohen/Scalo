// « Prix » section of the product editor: one card per offer. The type is picked from three tiles; each type only
// shows what it needs (installments: range the buyer chooses from, rhythm, surcharge, with a live preview of every
// plan); VAT, label and availability are folded under « Options avancées ».
import { useState } from 'react';
import { CalendarClock, ChevronDown, CreditCard, Plus, Repeat, Trash2, type LucideIcon } from 'lucide-react';
import { CURRENCIES, INSTALLMENT_RHYTHMS, MAX_INSTALLMENTS, computeAmounts, formatMoney, planDetail, type PriceType } from '@scalo/shared';
import { Button, Field, IconButton, Input, Select, Toggle, cx } from '../../components/ui';
import { parseAmount } from './labels';
import { feesOf, newPrice, parsePercent, plansOf, priceInput, type FeeMode, type PriceDraft } from './product-draft';

const TYPES: { id: PriceType; label: string; text: string; icon: LucideIcon }[] = [
  { id: 'one_time', label: 'Paiement unique', text: 'Un seul paiement', icon: CreditCard },
  { id: 'installments', label: 'En plusieurs fois', text: 'L’acheteur choisit en combien de fois', icon: CalendarClock },
  { id: 'subscription', label: 'Abonnement', text: 'Chaque mois ou chaque année', icon: Repeat },
];

const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);

export function PricingEditor({ prices, onChange, showErrors }: { prices: PriceDraft[]; onChange: (p: PriceDraft[]) => void; showErrors: boolean }) {
  const patch = (key: string, p: Partial<PriceDraft>) => onChange(prices.map((x) => (x.key === key ? { ...x, ...p } : x)));
  return (
    <div className="space-y-4">
      {prices.map((d, i) => (
        <OfferCard
          key={d.key}
          d={d}
          title={prices.length > 1 ? `Offre ${i + 1}` : null}
          onPatch={(p) => patch(d.key, p)}
          onRemove={prices.length > 1 ? () => onChange(prices.filter((x) => x.key !== d.key)) : undefined}
          showErrors={showErrors}
        />
      ))}
      <Button variant="secondary" icon={Plus} onClick={() => onChange([...prices, newPrice('one_time', prices[0]?.currency ?? 'eur')])} disabled={prices.length >= 20}>
        Ajouter une autre offre
      </Button>
      <p className="text-xs text-slate-500">Plusieurs offres pour un même produit ? Par exemple un prix de lancement et un prix normal : vous choisissez ensuite laquelle vendre dans chaque bloc « Paiement ».</p>
    </div>
  );
}

function OfferCard({ d, title, onPatch, onRemove, showErrors }: { d: PriceDraft; title: string | null; onPatch: (p: Partial<PriceDraft>) => void; onRemove?: () => void; showErrors: boolean }) {
  const [advanced, setAdvanced] = useState(!!d.name || d.tax_rate !== '0' || !d.active);
  const error = showErrors ? priceInput(d) : null;
  const amount = parseAmount(d.amount);
  const tax = parsePercent(d.tax_rate) ?? 0;
  const one = amount !== null ? computeAmounts(amount, tax, d.tax_inclusive) : null;

  return (
    <div className={cx('rounded-2xl border bg-white p-4 sm:p-5', typeof error === 'string' ? 'border-rose-300' : 'border-slate-200')}>
      {(title || onRemove) && (
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-semibold text-slate-900">{title}</span>
          {onRemove && <IconButton icon={Trash2} label="Supprimer l’offre" onClick={onRemove} />}
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Type de paiement">
        {TYPES.map((t) => {
          const on = d.type === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onPatch({ type: t.id })}
              className={cx(
                'flex items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition',
                on ? 'border-brand-500 bg-brand-50/60 ring-1 ring-brand-500' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50',
              )}
            >
              <t.icon size={18} className={cx('mt-0.5 shrink-0', on ? 'text-brand-600' : 'text-slate-400')} />
              <span>
                <span className="block text-sm font-semibold text-slate-900">{t.label}</span>
                <span className="block text-xs text-slate-500">{t.text}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_7rem]">
        <Field label={d.type === 'subscription' ? 'Prix par période' : d.type === 'installments' ? 'Prix (payé en une fois)' : 'Prix'} hint={d.type === 'installments' ? 'Le montant total, divisé en échéances égales.' : undefined}>
          <Input inputMode="decimal" value={d.amount} onChange={(e) => onPatch({ amount: e.target.value })} placeholder="297" />
        </Field>
        <Field label="Devise">
          <Select value={d.currency} onChange={(e) => onPatch({ currency: e.target.value })}>
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c.toUpperCase()}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {d.type === 'subscription' && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Facturation">
            <Select value={d.interval} onChange={(e) => onPatch({ interval: e.target.value as 'month' | 'year' })}>
              <option value="month">Chaque mois</option>
              <option value="year">Chaque année</option>
            </Select>
          </Field>
        </div>
      )}

      {d.type === 'installments' && <InstallmentsFields d={d} onPatch={onPatch} />}

      <button type="button" onClick={() => setAdvanced((v) => !v)} className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-slate-600 hover:text-slate-900">
        <ChevronDown size={15} className={cx('transition', advanced && 'rotate-180')} /> Options avancées
        <span className="hidden font-normal text-slate-400 sm:inline">· TVA, libellé, disponibilité</span>
      </button>
      {advanced && (
        <div className="mt-3 space-y-4 rounded-xl bg-slate-50 p-3">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="TVA (%)">
              <Input inputMode="decimal" value={d.tax_rate} onChange={(e) => onPatch({ tax_rate: e.target.value })} />
            </Field>
            <Field label="Le prix saisi est">
              <Select value={d.tax_inclusive ? 'ttc' : 'ht'} onChange={(e) => onPatch({ tax_inclusive: e.target.value === 'ttc' })}>
                <option value="ttc">TTC (TVA incluse)</option>
                <option value="ht">HT (TVA en plus)</option>
              </Select>
            </Field>
            <Field label="Libellé (facultatif)" hint="Affiché à l’acheteur après le nom du produit.">
              <Input value={d.name} onChange={(e) => onPatch({ name: e.target.value })} placeholder="ex. Prix de lancement" />
            </Field>
          </div>
          <Toggle checked={d.active} onChange={(active) => onPatch({ active })} label="En vente" description="Une offre retirée de la vente n’est plus proposée dans vos pages." />
        </div>
      )}

      {(d.type !== 'installments' || typeof error === 'string') && (
      <div className="mt-4 rounded-xl border border-dashed border-slate-200 px-3 py-2 text-sm text-slate-600">
        {typeof error === 'string' ? (
          <span className="text-rose-600">{error}</span>
        ) : !one ? (
          'Saisissez un prix (ex. 97 ou 97,50).'
        ) : d.type === 'subscription' ? (
          <>
            L’acheteur paie <strong className="text-slate-900">{formatMoney(one.total, d.currency)}</strong> {d.interval === 'year' ? 'chaque année' : 'chaque mois'}, jusqu’à ce qu’il arrête.
          </>
        ) : d.type === 'one_time' ? (
          <>
            L’acheteur paie <strong className="text-slate-900">{formatMoney(one.total, d.currency)}</strong>
            {one.tax > 0 && <> (dont TVA {formatMoney(one.tax, d.currency)})</>}.
          </>
        ) : null}
      </div>
      )}
    </div>
  );
}

function InstallmentsFields({ d, onPatch }: { d: PriceDraft; onPatch: (p: Partial<PriceDraft>) => void }) {
  const plans = plansOf(d);
  const rhythm = INSTALLMENT_RHYTHMS.find((r) => r.id === d.rhythm)!;
  const feesOk = feesOf(d) !== null;
  return (
    <div className="mt-4 space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Au minimum" hint={d.min === 1 ? 'Le paiement comptant reste possible.' : undefined}>
          <Select value={d.min} onChange={(e) => onPatch({ min: Number(e.target.value), max: Math.max(d.max, Math.max(2, Number(e.target.value))) })}>
            <option value={1}>1 fois (comptant)</option>
            {range(2, MAX_INSTALLMENTS).map((n) => (
              <option key={n} value={n}>
                {n} fois
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Au maximum">
          <Select value={d.max} onChange={(e) => onPatch({ max: Number(e.target.value), min: Math.min(d.min, Number(e.target.value)) })}>
            {range(2, MAX_INSTALLMENTS).map((n) => (
              <option key={n} value={n}>
                {n} fois
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Échéances">
          <Select value={d.rhythm} onChange={(e) => onPatch({ rhythm: e.target.value as PriceDraft['rhythm'] })}>
            {INSTALLMENT_RHYTHMS.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field label="Majoration du paiement en plusieurs fois" hint="Pour couvrir le coût du crédit que vous accordez. Ne s’applique pas au paiement comptant.">
        <div className="flex flex-wrap items-center gap-3">
          <Select className="w-auto" value={d.feeMode} onChange={(e) => onPatch({ feeMode: e.target.value as FeeMode })}>
            <option value="none">Aucune</option>
            <option value="same">Même majoration quel que soit le nombre d’échéances</option>
            <option value="custom">Selon le nombre d’échéances</option>
          </Select>
          {d.feeMode === 'same' && (
            <span className="inline-flex items-center gap-2 text-sm text-slate-600">
              + <Input className="w-20" inputMode="decimal" value={d.sameFee} onChange={(e) => onPatch({ sameFee: e.target.value })} placeholder="5" /> %
            </span>
          )}
        </div>
      </Field>

      <div className="overflow-hidden rounded-xl border border-slate-200">
        <div className="bg-slate-50 px-3 py-2 text-xs font-medium text-slate-500">Ce que l’acheteur pourra choisir</div>
        {!plans ? (
          <p className="px-3 py-3 text-sm text-slate-500">Saisissez le prix pour voir les échéances.</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {plans.map((p) => (
              <li key={p.count} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1 sm:flex sm:gap-3">
                  <span className="block shrink-0 font-medium text-slate-900 sm:w-20">{p.count === 1 ? 'En une fois' : `En ${p.count} fois`}</span>
                  <span className="block text-slate-600">{p.count === 1 ? formatMoney(p.total, d.currency) : planDetail(p, d.currency, rhythm.interval, rhythm.count)}</span>
                </div>
                {p.count > 1 && d.feeMode === 'custom' ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-slate-500">
                    +
                    <Input
                      className="w-16 py-1 text-right"
                      inputMode="decimal"
                      aria-label={`Majoration en ${p.count} fois (%)`}
                      value={d.fees[String(p.count)] ?? ''}
                      onChange={(e) => onPatch({ fees: { ...d.fees, [String(p.count)]: e.target.value } })}
                      placeholder="0"
                    />
                    %
                  </span>
                ) : p.fee > 0 ? (
                  <span className="shrink-0 text-xs text-slate-500">+{String(p.fee).replace('.', ',')} %</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {!feesOk && <p className="border-t border-slate-100 px-3 py-2 text-xs text-rose-600">Majoration invalide : un pourcentage entre 0 et 100.</p>}
      </div>
    </div>
  );
}
