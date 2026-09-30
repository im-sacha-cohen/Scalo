// Detail of an order: lines, payments / refunds, buyer, origin (funnel, attribution), refund and subscription actions.
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft, Ban, ExternalLink, Receipt, RotateCcw, Route, UserRound } from 'lucide-react';
import { priceLabel } from '@scalo/shared';
import { fmtDateTime } from '../../lib/format';
import { useLoad } from '../../lib/hooks';
import { paymentsApi, type OrderDetail } from '../../lib/payments-api';
import { useConfirm } from '../../components/ConfirmDialog';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, CardHeader, ErrorState, Field, Input, PageHeader, PageLoader, Toggle } from '../../components/ui';
import { amountInput, buyerName, money, OrderStatusBadge, parseAmount } from './labels';
import { AffiliateMentionCard } from '../affiliates/AffiliateMentionCard';

const ITEM_KINDS = { main: null, bump: 'Order bump', upsell: 'Offre en un clic' } as const;
const UTM_LABELS: Record<string, string> = { utm_source: 'Source', utm_medium: 'Support', utm_campaign: 'Campagne', utm_content: 'Contenu', utm_term: 'Terme', referrer: 'Site référent' };

export function OrderDetailPage() {
  const id = Number(useParams().id);
  const toast = useToast();
  const confirm = useConfirm();
  const { data: o, setData, error, loading, reload } = useLoad(() => paymentsApi.order(id), [id]);
  const [refunding, setRefunding] = useState(false);
  const [busy, setBusy] = useState(false);

  if (loading && !o) return <PageLoader />;
  if (error && !o) return <ErrorState message={error} onRetry={reload} />;
  if (!o) return null;

  const refundable = o.status === 'paid' ? o.amount_paid - o.amount_refunded : 0;
  const activeSub = o.subscription_status === 'active' || o.subscription_status === 'past_due';

  const cancelSubscription = async () => {
    const ok = await confirm({
      title: 'Annuler l’abonnement ?',
      message: 'Les prélèvements s’arrêtent immédiatement chez Stripe et le tag du produit est retiré au contact (il perd l’accès). Aucun remboursement n’est effectué.',
      confirmLabel: 'Annuler l’abonnement',
      cancelLabel: 'Retour',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy(true);
    try {
      setData(await paymentsApi.cancelSubscription(o.id));
      toast.success('Abonnement annulé');
      reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        back={
          <Link to="/sales" className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-900">
            <ArrowLeft size={15} /> Ventes
          </Link>
        }
        title={`Commande #${o.id}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {fmtDateTime(o.created_at)} · <OrderStatusBadge order={o} />
          </span>
        }
        actions={
          <>
            {o.stripe_url && (
              <a href={o.stripe_url} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-2 rounded-full border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 shadow-xs hover:bg-slate-50">
                <ExternalLink size={15} /> Voir dans Stripe
              </a>
            )}
            {activeSub && o.has_subscription && (
              <Button variant="secondary" icon={Ban} onClick={cancelSubscription} loading={busy}>
                Annuler l’abonnement
              </Button>
            )}
            {refundable > 0 && (
              <Button variant="danger" icon={RotateCcw} onClick={() => setRefunding(true)}>
                Rembourser
              </Button>
            )}
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card padded={false} className="overflow-hidden">
            <div className="px-5 pt-5">
              <CardHeader icon={Receipt} title="Contenu de la commande" />
            </div>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-slate-100 border-t border-slate-100">
                {o.items.map((i) => (
                  <tr key={i.id}>
                    <td className="px-5 py-3">
                      <span className="font-medium text-slate-900">{i.product_name}</span>
                      {i.price_name && <span className="text-slate-500"> — {i.price_name}</span>}
                      {ITEM_KINDS[i.kind] && <Badge className="ml-2" tone="violet">{ITEM_KINDS[i.kind]}</Badge>}
                      {i.tax_rate > 0 && <span className="block text-xs text-slate-500">TVA {String(i.tax_rate).replace('.', ',')} % : {money(i.amount_tax, o.currency)}</span>}
                    </td>
                    <td className="px-5 py-3 text-right font-semibold whitespace-nowrap text-slate-900 tabular-nums">
                      {priceLabel({ type: i.type, interval: i.interval, installments: i.installments, currency: o.currency }, i.amount_total)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-slate-200 bg-slate-50/70 text-sm">
                {o.amount_tax > 0 && (
                  <tr>
                    <td className="px-5 pt-3 text-slate-500">Total HT</td>
                    <td className="px-5 pt-3 text-right text-slate-700 tabular-nums">{money(o.amount_subtotal, o.currency)}</td>
                  </tr>
                )}
                {o.amount_tax > 0 && (
                  <tr>
                    <td className="px-5 pt-1 text-slate-500">TVA</td>
                    <td className="px-5 pt-1 text-right text-slate-700 tabular-nums">{money(o.amount_tax, o.currency)}</td>
                  </tr>
                )}
                <tr>
                  <td className="px-5 py-3 font-semibold text-slate-900">{o.subscription_status ? 'Premier paiement (TTC)' : 'Total (TTC)'}</td>
                  <td className="px-5 py-3 text-right text-base font-extrabold text-slate-900 tabular-nums">{money(o.amount_total, o.currency)}</td>
                </tr>
              </tfoot>
            </table>
          </Card>

          <Card>
            <CardHeader
              title="Paiements"
              description={
                o.amount_paid > 0 ? `${money(o.amount_paid, o.currency)} encaissés${o.amount_refunded ? ` · ${money(o.amount_refunded, o.currency)} remboursés` : ''}` : 'Aucun paiement encaissé pour cette commande.'
              }
            />
            {o.failure_message && <p className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{o.failure_message}</p>}
            {!!o.transactions?.length && (
              <ul className="divide-y divide-slate-100 text-sm">
                {o.transactions.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-3 py-2">
                    <span className="flex items-center gap-2">
                      <Badge tone={t.type === 'payment' ? 'green' : 'slate'}>{t.type === 'payment' ? 'Paiement' : 'Remboursement'}</Badge>
                      <span className="text-slate-500">{fmtDateTime(t.created_at)}</span>
                    </span>
                    <span className="font-semibold text-slate-900 tabular-nums">
                      {t.type === 'refund' ? '− ' : ''}
                      {money(t.amount, t.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {!!o.upsells.length && (
              <p className="mt-3 text-sm text-slate-600">
                Offres en un clic acceptées ensuite :{' '}
                {o.upsells.map((u, i) => (
                  <span key={u.id}>
                    {i > 0 && ', '}
                    <Link to={`/sales/orders/${u.id}`} className="font-medium text-brand-600 hover:underline">
                      #{u.id} ({money(u.amount_total, u.currency)})
                    </Link>
                  </span>
                ))}
              </p>
            )}
            {o.parent_order_id && (
              <p className="mt-3 text-sm text-slate-600">
                Offre en un clic acceptée après la commande{' '}
                <Link to={`/sales/orders/${o.parent_order_id}`} className="font-medium text-brand-600 hover:underline">
                  #{o.parent_order_id}
                </Link>
                .
              </p>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader icon={UserRound} title="Client" />
            <p className="font-medium text-slate-900">{buyerName(o)}</p>
            <p className="text-sm text-slate-500">{o.email}</p>
            {o.contact_id ? (
              <Link to={`/contacts/${o.contact_id}`} className="mt-3 inline-block text-sm font-medium text-brand-600 hover:underline">
                Voir la fiche contact →
              </Link>
            ) : (
              <p className="mt-3 text-xs text-slate-500">{o.status === 'pending' || o.status === 'failed' || o.status === 'canceled' ? 'Le contact est créé une fois le paiement confirmé.' : 'Contact supprimé.'}</p>
            )}
          </Card>
          <AffiliateMentionCard orderId={o.id} />
          <Card>
            <CardHeader icon={Route} title="Origine" />
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Tunnel</dt>
                <dd className="truncate text-right font-medium text-slate-800">{o.funnel_id ? <Link to={`/funnels/${o.funnel_id}`} className="hover:text-brand-700">{o.funnel_name ?? `#${o.funnel_id}`}</Link> : '—'}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Étape</dt>
                <dd className="truncate text-right text-slate-800">{o.step_name ?? '—'}</dd>
              </div>
              {Object.entries(o.attribution ?? {}).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3">
                  <dt className="text-slate-500">{UTM_LABELS[k] ?? k}</dt>
                  <dd className="truncate text-right text-slate-800">{v}</dd>
                </div>
              ))}
              {!Object.keys(o.attribution ?? {}).length && <p className="text-xs text-slate-500">Visite directe (aucun paramètre UTM ni site référent).</p>}
            </dl>
          </Card>
        </div>
      </div>

      {refunding && (
        <RefundModal
          order={o}
          refundable={refundable}
          onClose={() => setRefunding(false)}
          onDone={(next) => {
            setData(next);
            setRefunding(false);
            reload();
          }}
        />
      )}
    </>
  );
}

function RefundModal({ order, refundable, onClose, onDone }: { order: OrderDetail; refundable: number; onClose: () => void; onDone: (o: OrderDetail) => void }) {
  const toast = useToast();
  // the API refunds the latest payment: for a one-time order that is the whole order
  const last = [...(order.transactions ?? [])].reverse().find((t) => t.type === 'payment');
  const max = Math.min(refundable, last?.amount ?? refundable);
  const [amount, setAmount] = useState(amountInput(max));
  const [revoke, setRevoke] = useState(order.items.some((i) => i.tag_id && i.revoke_on_refund));
  const [cancelSub, setCancelSub] = useState(true);
  const [busy, setBusy] = useState(false);
  const activeSub = order.subscription_status === 'active' || order.subscription_status === 'past_due';
  const parsed = parseAmount(amount);
  const valid = parsed !== null && parsed > 0 && parsed <= max;
  const full = valid && parsed === refundable;
  const hasTag = order.items.some((i) => i.tag_id);

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      const next = await paymentsApi.refund(order.id, { amount: parsed!, revoke: full && hasTag ? revoke : undefined, cancel_subscription: activeSub ? cancelSub : undefined });
      toast.success('Remboursement effectué');
      onDone(next);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={`Rembourser la commande #${order.id}`}
      description="Le remboursement est envoyé à Stripe : le client est recrédité sur son moyen de paiement sous 5 à 10 jours."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="danger" onClick={submit} loading={busy} disabled={!valid}>
            Rembourser {valid ? money(parsed!, order.currency) : ''}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={`Montant (${order.currency.toUpperCase()})`} hint={`Maximum : ${money(max, order.currency)}${max < refundable ? ' (dernier paiement)' : ''}`} error={amount && !valid ? 'Montant invalide' : null}>
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
        </Field>
        {hasTag && (
          <Toggle
            checked={full && revoke}
            disabled={!full}
            onChange={setRevoke}
            label="Retirer l’accès (tag du produit)"
            description={full ? 'Le tag attribué à l’achat est retiré au contact.' : 'Un remboursement partiel ne retire pas l’accès.'}
          />
        )}
        {activeSub && <Toggle checked={cancelSub} onChange={setCancelSub} label="Arrêter aussi l’abonnement" description="Sinon les prochains prélèvements continuent." />}
      </div>
    </Modal>
  );
}
