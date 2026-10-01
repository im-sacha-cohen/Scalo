// Form state of the product editor (strings as typed) and its conversion to the API payload, with the checks of each
// step of the creation wizard.
import { INSTALLMENT_RHYTHMS, MAX_INSTALLMENTS, installmentOptions, type InstallmentOption, type PriceType, type Product } from '@scalo/shared';
import type { PriceInput, ProductInput } from '../../lib/payments-api';
import { amountInput, parseAmount } from './labels';

export type Rhythm = (typeof INSTALLMENT_RHYTHMS)[number]['id'];
/** Surcharge of the payment in several times: none, one rate for every count, or one rate per count. */
export type FeeMode = 'none' | 'same' | 'custom';

export interface PriceDraft {
  key: string;
  id?: number;
  name: string;
  type: PriceType;
  /** One-time / installments: price in one go. Subscription: price per period. */
  amount: string;
  currency: string;
  /** Subscriptions. */
  interval: 'month' | 'year';
  /** Installments. */
  rhythm: Rhythm;
  min: number;
  max: number;
  feeMode: FeeMode;
  sameFee: string;
  fees: Record<string, string>;
  tax_rate: string;
  tax_inclusive: boolean;
  active: boolean;
}

export interface ProductDraft {
  name: string;
  description: string;
  imageUrl: string;
  tagName: string;
  campaignId: number | '';
  revoke: boolean;
  prices: PriceDraft[];
}

let seq = 0;
export const newPrice = (type: PriceType = 'one_time', currency = 'eur'): PriceDraft => ({
  key: `n${++seq}`,
  name: '',
  type,
  amount: '',
  currency,
  interval: 'month',
  rhythm: 'month',
  min: 1,
  max: 3,
  feeMode: 'none',
  sameFee: '',
  fees: {},
  tax_rate: '0',
  tax_inclusive: true,
  active: true,
});

const pct = (v: number) => String(v).replace('.', ',');
export const parsePercent = (v: string): number | null => {
  const t = v.trim().replace(',', '.');
  if (!t) return 0;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) / 100 : null;
};

export function draftOf(p: Product | null): ProductDraft {
  if (!p) return { name: '', description: '', imageUrl: '', tagName: '', campaignId: '', revoke: true, prices: [newPrice()] };
  return {
    name: p.name,
    description: p.description,
    imageUrl: p.image_url ?? '',
    tagName: p.tag_name ?? '',
    campaignId: p.campaign_id ?? '',
    revoke: p.revoke_on_refund,
    prices: p.prices.length
      ? p.prices.map((x) => {
          const fees = Object.entries(x.installment_fees ?? {}).filter(([, v]) => v > 0);
          const same = fees.length > 0 && new Set(fees.map(([, v]) => v)).size === 1 && fees.length === Math.max(0, (x.installments_max ?? 0) - Math.max(2, x.installments_min ?? 2) + 1);
          return {
            ...newPrice(x.type, x.currency),
            key: `p${x.id}`,
            id: x.id,
            name: x.name,
            amount: amountInput(x.amount),
            interval: x.interval === 'year' ? 'year' : 'month',
            rhythm: INSTALLMENT_RHYTHMS.find((r) => r.interval === x.interval && r.count === x.interval_count)?.id ?? 'month',
            min: x.installments_min ?? 1,
            max: x.installments_max ?? 3,
            feeMode: !fees.length ? 'none' : same ? 'same' : 'custom',
            sameFee: same ? pct(fees[0][1]) : '',
            fees: Object.fromEntries(fees.map(([k, v]) => [k, pct(v)])),
            tax_rate: pct(x.tax_rate),
            tax_inclusive: x.tax_inclusive,
            active: x.active,
          } satisfies PriceDraft;
        })
      : [newPrice()],
  };
}

/** Surcharges in percent per count, as the API takes them (null: a value is invalid). */
export function feesOf(d: PriceDraft): Record<string, number> | null {
  const out: Record<string, number> = {};
  if (d.feeMode === 'none') return out;
  for (let n = Math.max(2, d.min); n <= d.max; n++) {
    const v = parsePercent(d.feeMode === 'same' ? d.sameFee : d.fees[String(n)] ?? '');
    if (v === null) return null;
    if (v > 0) out[String(n)] = v;
  }
  return out;
}

/** Plans the buyer will choose from (live preview), or null while the amount is not valid. */
export function plansOf(d: PriceDraft): InstallmentOption[] | null {
  const amount = parseAmount(d.amount);
  const tax = parsePercent(d.tax_rate);
  if (amount === null || tax === null) return null;
  return installmentOptions({ amount, tax_rate: tax, tax_inclusive: d.tax_inclusive, installment_fees: feesOf(d) ?? {}, installments_min: d.min, installments_max: d.max });
}

export function priceInput(d: PriceDraft): PriceInput | string {
  const amount = parseAmount(d.amount);
  if (amount === null || amount < 50) return 'Prix invalide (0,50 minimum, ex. 97 ou 97,50)';
  const tax = parsePercent(d.tax_rate);
  if (tax === null) return 'Taux de TVA invalide (0 à 100)';
  const base = { ...(d.id ? { id: d.id } : {}), name: d.name.trim(), type: d.type, amount, currency: d.currency, tax_rate: tax, tax_inclusive: d.tax_inclusive, active: d.active };
  if (d.type === 'one_time') return base;
  if (d.type === 'subscription') return { ...base, interval: d.interval };
  if (d.max < 2 || d.max > MAX_INSTALLMENTS || d.min < 1 || d.min > d.max) return `Nombre d’échéances : de 1 à ${MAX_INSTALLMENTS}, le minimum ne dépassant pas le maximum`;
  const fees = feesOf(d);
  if (!fees) return 'Majoration invalide (0 à 100 %)';
  const plans = plansOf(d);
  if (plans && plans[plans.length - 1].each < 50) return `Échéance trop faible en ${d.max} fois (0,50 minimum)`;
  const rhythm = INSTALLMENT_RHYTHMS.find((r) => r.id === d.rhythm)!;
  return { ...base, interval: rhythm.interval, interval_count: rhythm.count, installments_min: d.min, installments_max: d.max, installment_fees: fees };
}

/** Checks of a wizard step: the first problem found, or null. */
export function stepError(step: 'product' | 'pricing' | 'access', d: ProductDraft): string | null {
  if (step === 'product') return d.name.trim() ? null : 'Donnez un nom au produit';
  if (step === 'pricing') {
    if (!d.prices.length) return 'Ajoutez au moins une offre';
    for (const [i, p] of d.prices.entries()) {
      const r = priceInput(p);
      if (typeof r === 'string') return d.prices.length > 1 ? `Offre ${i + 1} : ${r}` : r;
    }
  }
  return null;
}

export function productInput(d: ProductDraft): ProductInput {
  return {
    name: d.name.trim(),
    description: d.description.trim(),
    image_url: d.imageUrl.trim() || null,
    ...(d.tagName.trim() ? { tag_name: d.tagName.trim() } : { tag_id: null }),
    campaign_id: d.campaignId === '' ? null : d.campaignId,
    revoke_on_refund: d.revoke,
    prices: d.prices.map((p) => priceInput(p) as PriceInput),
  };
}
