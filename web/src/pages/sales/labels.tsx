// Shared bits of the « Ventes » screens: status badges, money helpers.
import { ORDER_STATUS_LABELS, SUBSCRIPTION_STATUS_LABELS, formatMoney, type Order, type OrderStatus, type OrderSubscriptionStatus } from '@scalo/shared';
import { Badge } from '../../components/ui';

type Tone = 'slate' | 'green' | 'amber' | 'red' | 'blue' | 'violet';

export const ORDER_STATUS_TONES: Record<OrderStatus, Tone> = { pending: 'amber', paid: 'green', failed: 'red', refunded: 'slate', canceled: 'slate' };
const SUB_TONES: Record<OrderSubscriptionStatus, Tone> = { active: 'violet', past_due: 'amber', canceled: 'slate', completed: 'blue' };

export function OrderStatusBadge({ order }: { order: Pick<Order, 'status' | 'subscription_status' | 'amount_refunded' | 'livemode'> }) {
  const partial = order.status === 'paid' && order.amount_refunded > 0;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge tone={ORDER_STATUS_TONES[order.status]} dot>
        {partial ? 'Remboursée en partie' : ORDER_STATUS_LABELS[order.status]}
      </Badge>
      {order.subscription_status && order.status !== 'pending' && <Badge tone={SUB_TONES[order.subscription_status]}>{SUBSCRIPTION_STATUS_LABELS[order.subscription_status]}</Badge>}
      {!order.livemode && <Badge tone="amber">Test</Badge>}
    </span>
  );
}

export const money = (minor: number, currency: string) => formatMoney(minor, currency);

/** « 97 », « 97,5 », « 97.50 » → 9750 (null when not a valid amount). */
export function parseAmount(v: string): number | null {
  const t = v.replace(/\s/g, '').replace(',', '.');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}
export const amountInput = (minor: number) => (minor / 100).toFixed(2).replace('.', ',').replace(/,00$/, '');

export const buyerName = (o: Pick<Order, 'first_name' | 'last_name' | 'email'>) => [o.first_name, o.last_name].filter(Boolean).join(' ') || o.email;
