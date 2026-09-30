// « Apporté par » card of the order and contact screens: the affiliate who brought the sale / the contact, the
// commissions of the order, and whether the contact is an affiliate himself. Renders nothing when there is nothing to say.
import { Link } from 'react-router';
import { HandCoins } from 'lucide-react';
import { COMMISSION_STATUS_LABELS, formatMoney } from '@scalo/shared';
import { affiliatesApi } from '../../lib/affiliates-api';
import { contactName } from '../../lib/format';
import { useLoad } from '../../lib/hooks';
import { Badge, Card, CardHeader, StatCard } from '../../components/ui';
import { AffiliateStatusBadge } from './widgets';

/** Dashboard: sales brought by affiliates over the last 30 days (hidden while the program is off or has no affiliate). */
export function AffiliationCard() {
  const { data } = useLoad(() => affiliatesApi.summary(), []);
  if (!data?.enabled || !data.affiliates.total) return null;
  const due = data.balances.filter((b) => b.approved > 0);
  return (
    <StatCard
      label="Ventes par affiliation (30 j)"
      value={data.sales}
      icon={HandCoins}
      tone="violet"
      hint={
        <Link to="/affiliation" className="font-medium text-brand-600 hover:underline">
          {data.clicks} clic{data.clicks > 1 ? 's' : ''}
          {due.length ? ` · ${due.map((b) => formatMoney(b.approved, b.currency)).join(' + ')} à payer` : ''}
          {data.affiliates.pending ? ` · ${data.affiliates.pending} demande${data.affiliates.pending > 1 ? 's' : ''}` : ''} →
        </Link>
      }
    />
  );
}

export function AffiliateMentionCard({ orderId, contactId }: { orderId?: number; contactId?: number }) {
  const { data } = useLoad(() => (orderId ? affiliatesApi.orderMention(orderId) : affiliatesApi.contactMention(contactId!)), [orderId, contactId]);
  if (!data || (!data.affiliate && !data.is_affiliate)) return null;
  const a = data.affiliate;
  return (
    <Card>
      <CardHeader title="Affiliation" icon={HandCoins} />
      <div className="space-y-3 text-sm">
        {data.is_affiliate && (
          <p className="flex flex-wrap items-center gap-2 text-slate-700">
            Ce contact est affilié (code <span className="font-mono text-xs">{data.is_affiliate.code}</span>) <AffiliateStatusBadge status={data.is_affiliate.status} />
            <Link to="/affiliation" className="font-medium text-brand-700 hover:underline">
              Voir l’affiliation
            </Link>
          </p>
        )}
        {a && (
          <p className="text-slate-700">
            {orderId ? 'Vente apportée par ' : 'Contact apporté par '}
            <Link to="/affiliation" className="font-medium text-slate-900 hover:text-brand-700" title={a.email}>
              {contactName(a)}
            </Link>{' '}
            <span className="font-mono text-xs text-slate-500">({a.code})</span>
          </p>
        )}
        {!!data.commissions?.length && (
          <ul className="space-y-1">
            {data.commissions.map((c, i) => (
              <li key={i} className="flex items-center justify-between gap-3">
                <span className="text-slate-500">{c.amount < 0 ? 'Reprise de commission' : 'Commission'}</span>
                <span className="inline-flex items-center gap-2">
                  <span className="font-medium tabular-nums text-slate-800">{formatMoney(c.amount, c.currency)}</span>
                  <Badge tone={c.status === 'paid' ? 'green' : c.status === 'approved' ? 'blue' : c.status === 'pending' ? 'amber' : 'slate'}>{COMMISSION_STATUS_LABELS[c.status]}</Badge>
                </span>
              </li>
            ))}
          </ul>
        )}
        {a && orderId && !data.commissions?.length && <p className="text-xs text-slate-500">Aucune commission pour cette commande.</p>}
      </div>
    </Card>
  );
}
