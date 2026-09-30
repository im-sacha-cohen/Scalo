// Payments endpoints (Stripe connection, products & offers, orders, revenue). See SPEC.md « Paiements ».
import type { Offer, Order, OrderStatus, PaymentSettings, PriceInterval, PriceType, Product, SalesStats } from '@scalo/shared';
import { request } from './api';

type Ok = { ok: true };
const qs = (params: Record<string, string | number | undefined | null>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
};

export interface PriceInput {
  id?: number;
  name?: string;
  type: PriceType;
  /** Minor units (cents). */
  amount: number;
  currency: string;
  interval?: PriceInterval | null;
  installments?: number | null;
  tax_rate?: number;
  tax_inclusive?: boolean;
  active?: boolean;
}

export interface ProductInput {
  name: string;
  description?: string;
  image_url?: string | null;
  tag_id?: number | null;
  tag_name?: string;
  campaign_id?: number | null;
  revoke_on_refund?: boolean;
  archived?: boolean;
  prices?: PriceInput[];
}

export type OrderFilter = OrderStatus | 'subscription';
export interface OrderQuery {
  status?: OrderFilter | '';
  search?: string;
  product_id?: number | null;
  funnel_id?: number | null;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

export type OrderDetail = Order & {
  upsells: { id: number; status: OrderStatus; amount_total: number; currency: string }[];
  visitor_id: string | null;
};

export const paymentsApi = {
  // Stripe connection
  settings: () => request<PaymentSettings>('GET', '/payments/settings'),
  saveSettings: (b: { secret_key?: string; publishable_key?: string | null; webhook_secret?: string | null }) => request<PaymentSettings>('PUT', '/payments/settings', b),
  testConnection: () => request<{ ok: true; settings: PaymentSettings }>('POST', '/payments/settings/test'),
  disconnect: () => request<PaymentSettings>('DELETE', '/payments/settings'),

  // products & offers
  products: (archived = false) => request<Product[]>('GET', `/products${archived ? '?archived=1' : ''}`),
  createProduct: (b: ProductInput) => request<Product>('POST', '/products', b),
  updateProduct: (id: number, b: Partial<ProductInput>) => request<Product>('PATCH', `/products/${id}`, b),
  deleteProduct: (id: number) => request<Ok>('DELETE', `/products/${id}`),
  offers: () => request<Offer[]>('GET', '/offers'),

  // orders
  orders: (q: OrderQuery = {}) => request<{ items: Order[]; total: number }>('GET', `/orders${qs(q as Record<string, string | number | undefined | null>)}`),
  order: (id: number) => request<OrderDetail>('GET', `/orders/${id}`),
  refund: (id: number, b: { amount?: number; revoke?: boolean; cancel_subscription?: boolean }) => request<OrderDetail>('POST', `/orders/${id}/refund`, b),
  cancelSubscription: (id: number, b: { revoke?: boolean } = {}) => request<OrderDetail>('POST', `/orders/${id}/cancel-subscription`, b),
  contactOrders: (contactId: number) => request<Order[]>('GET', `/contacts/${contactId}/orders`),

  // revenue
  stats: (days = 30) => request<SalesStats>('GET', `/sales/stats?days=${days}`),
};
