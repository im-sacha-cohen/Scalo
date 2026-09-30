// Affiliate program endpoints (settings, affiliates, commissions, payouts). See SPEC.md « Affiliation ».
import type {
  Affiliate,
  AffiliateCommission,
  AffiliateDetail,
  AffiliateMention,
  AffiliatePayable,
  AffiliatePayout,
  AffiliateProgram,
  AffiliateStatus,
  AffiliationSummary,
  CommissionRate,
  CommissionStatus,
} from '@scalo/shared';
import { rawRequest, request } from './api';

const qs = (params: Record<string, string | number | undefined | null>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
};

export type ProgramInput = Partial<Omit<AffiliateProgram, 'url' | 'rules'>> & {
  rules?: { product_id: number; price_id?: number | null; commission: CommissionRate }[];
};

export interface PayoutMeta {
  method?: string;
  reference?: string;
  note?: string;
}

export const affiliatesApi = {
  program: () => request<AffiliateProgram>('GET', '/affiliation/settings'),
  saveProgram: (b: ProgramInput) => request<AffiliateProgram>('PUT', '/affiliation/settings', b),
  summary: () => request<AffiliationSummary>('GET', '/affiliation/summary'),

  affiliates: (q: { status?: AffiliateStatus | ''; search?: string; page?: number; limit?: number } = {}) =>
    request<{ items: Affiliate[]; total: number }>('GET', `/affiliation/affiliates${qs(q)}`),
  affiliate: (id: number) => request<AffiliateDetail>('GET', `/affiliation/affiliates/${id}`),
  addAffiliate: (b: { email?: string; contact_id?: number; first_name?: string; last_name?: string }) => request<Affiliate>('POST', '/affiliation/affiliates', b),
  updateAffiliate: (id: number, b: { status?: Exclude<AffiliateStatus, 'pending'>; commission?: CommissionRate | null; code?: string }) =>
    request<AffiliateDetail>('PATCH', `/affiliation/affiliates/${id}`, b),

  commissions: (q: { status?: CommissionStatus | ''; affiliate_id?: number | null; page?: number; limit?: number } = {}) =>
    request<{ items: AffiliateCommission[]; total: number }>('GET', `/affiliation/commissions${qs(q)}`),
  cancelCommission: (id: number, reason: string) => request<AffiliateCommission>('POST', `/affiliation/commissions/${id}/cancel`, { reason }),

  payables: () => request<AffiliatePayable[]>('GET', '/affiliation/payouts/balances'),
  payouts: (q: { affiliate_id?: number | null; page?: number; limit?: number } = {}) => request<{ items: AffiliatePayout[]; total: number }>('GET', `/affiliation/payouts${qs(q)}`),
  pay: (b: { affiliate_id: number; currency: string } & PayoutMeta) => request<AffiliatePayout>('POST', '/affiliation/payouts', b),
  payAll: (b: PayoutMeta & { items?: { affiliate_id: number; currency: string }[] }) => request<{ payouts: AffiliatePayout[]; count: number }>('POST', '/affiliation/payouts/batch', b),
  exportPayables: async () => (await rawRequest('GET', '/affiliation/payouts/export')).blob(),

  orderMention: (orderId: number) => request<AffiliateMention>('GET', `/affiliation/orders/${orderId}`),
  contactMention: (contactId: number) => request<AffiliateMention>('GET', `/affiliation/contacts/${contactId}`),
};
