// Small sales widgets embedded in other screens: revenue card (dashboard), purchases of a contact (contact page).
import { Link } from 'react-router';
import { ShoppingBag, TrendingUp } from 'lucide-react';
import { Card, CardHeader, StatCard } from '../../components/ui';
import { fmtDate } from '../../lib/format';
import { useLoad } from '../../lib/hooks';
import { paymentsApi } from '../../lib/payments-api';
import { money, OrderStatusBadge } from './labels';

/** Dashboard: net revenue of the last 30 days (hidden until the first payment). */
export function RevenueCard() {
  const { data } = useLoad(() => paymentsApi.stats(30), []);
  const main = data?.totals[0];
  if (!main) return null;
  return (
    <StatCard
      label="Chiffre d’affaires (30 j)"
      value={money(main.net, main.currency)}
      icon={TrendingUp}
      tone="green"
      hint={
        <Link to="/sales" className="font-medium text-brand-600 hover:underline">
          {main.orders} commande{main.orders > 1 ? 's' : ''} · voir les ventes →
        </Link>
      }
    />
  );
}

/** Contact page: orders of the contact (nothing when it never ordered). */
export function ContactOrders({ contactId }: { contactId: number }) {
  const { data } = useLoad(() => paymentsApi.contactOrders(contactId), [contactId]);
  if (!data?.length) return null;
  const paid = data.filter((o) => o.status === 'paid');
  const total = paid.reduce((n, o) => n + o.amount_paid - o.amount_refunded, 0);
  return (
    <Card>
      <CardHeader icon={ShoppingBag} title="Achats" description={paid.length ? `${paid.length} commande${paid.length > 1 ? 's' : ''} payée${paid.length > 1 ? 's' : ''} · ${money(total, paid[0].currency)}` : undefined} />
      <ul className="divide-y divide-slate-100 text-sm">
        {data.map((o) => (
          <li key={o.id} className="flex items-center justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <Link to={`/sales/orders/${o.id}`} className="block truncate font-medium text-slate-800 hover:text-brand-700">
                {o.items.map((i) => i.product_name).join(', ') || `Commande #${o.id}`}
              </Link>
              <span className="text-xs text-slate-500">
                #{o.id} · {fmtDate(o.created_at)}
              </span>
            </div>
            <div className="shrink-0 text-right">
              <span className="block font-semibold text-slate-900 tabular-nums">{money(o.amount_paid || o.amount_total, o.currency)}</span>
              <OrderStatusBadge order={o} />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
