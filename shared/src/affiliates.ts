// Affiliate program: API shapes shared by the API and the web app. See SPEC.md « Affiliation ».
// Amounts are minor units (cents) of `currency`; a percentage is a number between 0 and 100.

export type CommissionRateType = 'percent' | 'fixed';
export interface CommissionRate {
  type: CommissionRateType;
  /** percent: 0–100 (2 decimals) ; fixed: minor units per line sold. */
  value: number;
}

export type AffiliateAttribution = 'last_click' | 'first_click';
export type AffiliateSignupMode = 'open' | 'approval';
export type AffiliateStatus = 'pending' | 'approved' | 'rejected' | 'suspended';
export type CommissionStatus = 'pending' | 'approved' | 'paid' | 'cancelled';
export type CommissionKind = 'sale' | 'recurring' | 'clawback';

export const AFFILIATE_STATUS_LABELS: Record<AffiliateStatus, string> = {
  pending: 'En attente',
  approved: 'Approuvé',
  rejected: 'Refusé',
  suspended: 'Suspendu',
};

export const COMMISSION_STATUS_LABELS: Record<CommissionStatus, string> = {
  pending: 'En attente',
  approved: 'Validée',
  paid: 'Payée',
  cancelled: 'Annulée',
};

export interface AffiliateCommissionRule {
  id: number;
  product_id: number;
  /** null = every offer of the product. */
  price_id: number | null;
  product_name: string;
  price_name: string | null;
  commission: CommissionRate;
}

export interface AffiliateProgram {
  enabled: boolean;
  slug: string;
  name: string;
  /** Public address of the affiliate area. */
  url: string;
  commission: CommissionRate;
  recurring: boolean;
  recurring_months: number | null;
  cookie_days: number;
  attribution: AffiliateAttribution;
  validation_days: number;
  min_payout: number;
  signup_mode: AffiliateSignupMode;
  terms: string;
  rules: AffiliateCommissionRule[];
}

export interface AffiliateStats {
  clicks: number;
  leads: number;
  sales: number;
  /** sales / clicks (0 when there is no click). */
  conversion: number;
}

export interface AffiliateBalance {
  currency: string;
  pending: number;
  /** Validated and not paid yet, clawbacks included (may be negative). */
  approved: number;
  paid: number;
}

export interface Affiliate {
  id: number;
  contact_id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
  code: string;
  status: AffiliateStatus;
  /** Personal commission (null = the program's). */
  commission: CommissionRate | null;
  created_at: string;
  approved_at: string | null;
  stats: AffiliateStats;
  balances: AffiliateBalance[];
}

export interface AffiliatePayout {
  id: number;
  affiliate_id: number;
  affiliate_email?: string;
  affiliate_code?: string;
  currency: string;
  amount: number;
  method: string;
  reference: string;
  note: string;
  commissions_count?: number;
  created_at: string;
}

export interface AffiliateDetail extends Affiliate {
  /** Example link (first funnel of the account) — any funnel page accepts `?aff=<code>`. */
  link: string | null;
  /** Free text (IBAN, PayPal…): only returned to the owner and administrators of the account. */
  payout_details: string | null;
  payout_details_visible: boolean;
  payouts: AffiliatePayout[];
}

export interface AffiliateCommission {
  id: number;
  affiliate_id: number;
  affiliate_email: string;
  affiliate_code: string;
  order_id: number | null;
  kind: CommissionKind;
  product_name: string;
  currency: string;
  base_amount: number;
  rate: CommissionRate;
  amount_initial: number;
  amount: number;
  status: CommissionStatus;
  approve_at: string;
  approved_at: string | null;
  paid_at: string | null;
  payout_id: number | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_at: string;
}

/** Payable balance of an affiliate in one currency (what a payout would pay now). */
export interface AffiliatePayable {
  affiliate_id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
  code: string;
  status: AffiliateStatus;
  currency: string;
  amount: number;
  commissions_count: number;
  /** false when the balance is below the program's minimum (or not positive). */
  payable: boolean;
  has_payout_details: boolean;
}

export interface AffiliationSummary {
  enabled: boolean;
  affiliates: { total: number; approved: number; pending: number };
  /** Last 30 days. */
  clicks: number;
  leads: number;
  sales: number;
  balances: AffiliateBalance[];
}

/** Affiliate of an order / a contact (« apporté par »), for the order and contact screens. */
export interface AffiliateMention {
  affiliate: { id: number; code: string; email: string; first_name: string | null; last_name: string | null; status: AffiliateStatus } | null;
  commissions?: { currency: string; amount: number; status: CommissionStatus }[];
  /** Contact screen: the contact is itself an affiliate. */
  is_affiliate?: { id: number; code: string; status: AffiliateStatus } | null;
}

export const commissionLabel = (c: CommissionRate, currency = 'eur'): string =>
  c.type === 'percent'
    ? `${String(Math.round(c.value * 100) / 100).replace('.', ',')} %`
    : `${(Math.round(c.value) / 100).toFixed(2).replace('.', ',')} ${currency.toUpperCase() === 'EUR' ? '€' : currency.toUpperCase()}`;
