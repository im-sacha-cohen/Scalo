// « Ventes »: revenue over a period, orders (filters) and products (offers).
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Archive, ArchiveRestore, CreditCard, Package, Pencil, Plus, Receipt, Repeat, Search, ShoppingBag, ShoppingCart, Tag as TagIcon, Trash2, TrendingUp } from 'lucide-react';
import { computeAmounts, priceLabel, type Campaign, type Product, type Tag } from '@scalo/shared';
import { api } from '../../lib/api';
import { fmtDateTime, fmtNumber, fmtRelative } from '../../lib/format';
import { useDebounced, useLoad } from '../../lib/hooks';
import { paymentsApi, type OrderFilter } from '../../lib/payments-api';
import { useConfirm } from '../../components/ConfirmDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, EmptyState, ErrorState, IconButton, Input, PageHeader, Pagination, Select, Skeleton, StatCard, Tabs } from '../../components/ui';
import { buyerName, money, OrderStatusBadge } from './labels';
import { ProductModal } from './ProductModal';

type TabId = 'orders' | 'products';
const PERIODS = [
  { days: 7, label: '7 derniers jours' },
  { days: 30, label: '30 derniers jours' },
  { days: 90, label: '90 derniers jours' },
  { days: 365, label: '12 derniers mois' },
];
const LIMIT = 25;

export function SalesPage() {
  const [params, setParams] = useSearchParams();
  const tab: TabId = params.get('tab') === 'products' ? 'products' : 'orders';
  const [days, setDays] = useState(30);
  const settings = useLoad(() => paymentsApi.settings(), []);
  const stats = useLoad(() => paymentsApi.stats(days), [days]);
  const main = stats.data?.totals[0];
  const others = stats.data?.totals.slice(1) ?? [];
  const cur = main?.currency ?? 'eur';

  return (
    <>
      <PageHeader
        title="Ventes"
        description="Vos produits, vos commandes et votre chiffre d’affaires."
        actions={
          <Select className="w-48" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Période">
            {PERIODS.map((p) => (
              <option key={p.days} value={p.days}>
                {p.label}
              </option>
            ))}
          </Select>
        }
      />

      {settings.data && !settings.data.connected && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900">
          <p className="flex items-center gap-2">
            <CreditCard size={16} className="shrink-0" />
            Connectez votre compte Stripe pour encaisser des paiements dans vos tunnels.
          </p>
          <Link to="/settings#paiements" className="font-semibold text-amber-900 underline underline-offset-2">
            Paramètres → Paiements
          </Link>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.loading && !stats.data ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="p-4">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="mt-3 h-7 w-28" />
            </Card>
          ))
        ) : (
          <>
            <StatCard
              label="Chiffre d’affaires net"
              value={money(main?.net ?? 0, cur)}
              icon={TrendingUp}
              tone="green"
              hint={
                <>
                  {main && main.refunds > 0 ? `${money(main.revenue, cur)} encaissés − ${money(main.refunds, cur)} remboursés` : 'Paiements encaissés sur la période'}
                  {others.map((o) => (
                    <span key={o.currency} className="block">
                      + {money(o.net, o.currency)}
                    </span>
                  ))}
                </>
              }
            />
            <StatCard label="Commandes payées" value={fmtNumber(stats.data?.totals.reduce((n, t) => n + t.orders, 0) ?? 0)} icon={ShoppingBag} tone="brand" hint={stats.data?.pending ? `${stats.data.pending} en attente de paiement (24 h)` : 'Sur la période'} />
            <StatCard label="Panier moyen" value={money(main?.average ?? 0, cur)} icon={Receipt} tone="sky" hint="Par commande payée" />
            <StatCard label="Abonnements actifs" value={fmtNumber(stats.data?.active_subscriptions ?? 0)} icon={Repeat} tone="violet" hint="Abonnements et paiements en plusieurs fois en cours" />
          </>
        )}
      </div>

      <Tabs
        className="mt-8 mb-5"
        value={tab}
        onChange={(t) => setParams(t === 'orders' ? {} : { tab: t }, { replace: true })}
        tabs={[
          { id: 'orders', label: 'Commandes', icon: ShoppingCart },
          { id: 'products', label: 'Produits', icon: Package },
        ]}
      />
      {tab === 'orders' ? <OrdersTab /> : <ProductsTab connected={settings.data?.connected ?? true} />}
    </>
  );
}

const STATUS_FILTERS: { id: OrderFilter | ''; label: string }[] = [
  { id: '', label: 'Tous les statuts' },
  { id: 'paid', label: 'Payées' },
  { id: 'pending', label: 'En attente' },
  { id: 'failed', label: 'Échouées' },
  { id: 'refunded', label: 'Remboursées' },
  { id: 'canceled', label: 'Abandonnées' },
  { id: 'subscription', label: 'Abonnements actifs' },
];

function OrdersTab() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<OrderFilter | ''>('');
  const [productId, setProductId] = useState<number | ''>('');
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  useEffect(() => setPage(1), [status, q, productId]);
  const products = useLoad(() => paymentsApi.products(true), []);
  const { data, error, loading, reload } = useLoad(() => paymentsApi.orders({ page, limit: LIMIT, status, search: q, product_id: productId || null }), [page, status, q, productId]);
  const filtered = !!status || !!q || !!productId;

  return (
    <Card padded={false} className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3">
        <Input icon={Search} className="w-full sm:w-64" placeholder="Email, nom ou n° de commande" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Select className="w-48" value={status} onChange={(e) => setStatus(e.target.value as OrderFilter | '')} aria-label="Statut">
          {STATUS_FILTERS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </Select>
        {!!products.data?.length && (
          <Select className="w-52" value={productId} onChange={(e) => setProductId(e.target.value ? Number(e.target.value) : '')} aria-label="Produit">
            <option value="">Tous les produits</option>
            {products.data.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        )}
      </div>
      {error && !data ? (
        <div className="p-4">
          <ErrorState message={error} onRetry={reload} />
        </div>
      ) : loading && !data ? (
        <div className="space-y-2 p-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : data && data.total === 0 ? (
        <EmptyState
          icon={ShoppingCart}
          className="m-4 border-0"
          title={filtered ? 'Aucune commande ne correspond' : 'Aucune commande pour l’instant'}
          description={filtered ? 'Modifiez les filtres pour élargir la recherche.' : 'Ajoutez un bloc « Paiement » à une étape de tunnel : les commandes apparaîtront ici dès le premier achat.'}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs font-medium text-slate-500">
                <th className="px-4 py-2.5">N°</th>
                <th className="px-3 py-2.5">Date</th>
                <th className="px-3 py-2.5">Client</th>
                <th className="px-3 py-2.5">Produits</th>
                <th className="px-3 py-2.5">Origine</th>
                <th className="px-3 py-2.5 text-right">Montant</th>
                <th className="px-4 py-2.5">Statut</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data?.items.map((o) => (
                <tr key={o.id} className="cursor-pointer hover:bg-slate-50" onClick={() => navigate(`/sales/orders/${o.id}`)}>
                  <td className="px-4 py-2.5 font-medium whitespace-nowrap text-slate-800">
                    <Link to={`/sales/orders/${o.id}`} onClick={(e) => e.stopPropagation()} className="hover:text-brand-700">
                      #{o.id}
                    </Link>
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-slate-500" title={fmtDateTime(o.created_at)}>
                    {fmtRelative(o.created_at)}
                  </td>
                  <td className="max-w-[220px] px-3 py-2.5">
                    <span className="block truncate font-medium text-slate-800">{buyerName(o)}</span>
                    {(o.first_name || o.last_name) && <span className="block truncate text-xs text-slate-500">{o.email}</span>}
                  </td>
                  <td className="max-w-[260px] truncate px-3 py-2.5 text-slate-600" title={o.items.map((i) => i.product_name).join(', ')}>
                    {o.items.map((i) => i.product_name).join(', ')}
                    {o.kind === 'upsell' && <Badge className="ml-1.5" tone="violet">Un clic</Badge>}
                  </td>
                  <td className="max-w-[160px] truncate px-3 py-2.5 text-slate-500">{o.funnel_name ?? '—'}</td>
                  <td className="px-3 py-2.5 text-right font-semibold whitespace-nowrap text-slate-900 tabular-nums">{money(o.status === 'pending' || !o.amount_paid ? o.amount_total : o.amount_paid, o.currency)}</td>
                  <td className="px-4 py-2.5">
                    <OrderStatusBadge order={o} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && <Pagination page={page} total={data.total} limit={LIMIT} onChange={setPage} />}
    </Card>
  );
}

function ProductsTab({ connected }: { connected: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [archived, setArchived] = useState(false);
  const { data, error, loading, reload } = useLoad(() => paymentsApi.products(archived), [archived]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  useEffect(() => {
    api.tags().then(setTags).catch(() => {});
    api.campaigns().then(setCampaigns).catch(() => {});
  }, [editing]);

  const toggleArchive = async (p: Product) => {
    try {
      await paymentsApi.updateProduct(p.id, { archived: !p.archived });
      toast.success(p.archived ? 'Produit remis en vente' : 'Produit archivé');
      reload();
    } catch (e) {
      toast.error(e);
    }
  };
  const remove = async (p: Product) => {
    const ok = await confirm({
      title: `Supprimer « ${p.name} » ?`,
      message: p.sales_count
        ? 'Les commandes déjà passées sont conservées, mais les blocs « Paiement » qui vendent ce produit afficheront « offre indisponible ». Préférez l’archivage pour le retirer de la vente.'
        : 'Les blocs « Paiement » qui vendent ce produit afficheront « offre indisponible ».',
      confirmLabel: 'Supprimer',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await paymentsApi.deleteProduct(p.id);
      toast.success('Produit supprimé');
      reload();
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-brand-600" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
          Afficher les produits archivés
        </label>
        <Button icon={Plus} onClick={() => setEditing('new')}>
          Nouveau produit
        </Button>
      </div>
      {error && !data ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading && !data ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded-2xl" />
          ))}
        </div>
      ) : !data?.length ? (
        <EmptyState
          icon={Package}
          title="Aucun produit"
          description={connected ? 'Créez votre premier produit, puis vendez-le avec un bloc « Paiement » dans un tunnel.' : 'Créez votre premier produit. Pour encaisser, connectez Stripe dans Paramètres → Paiements.'}
          action={
            <Button icon={Plus} onClick={() => setEditing('new')}>
              Nouveau produit
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {data.map((p) => (
            <Card key={p.id} className="flex flex-wrap items-center gap-4 p-4">
              {p.image_url ? (
                <img src={p.image_url} alt="" className="h-12 w-12 shrink-0 rounded-xl object-cover" />
              ) : (
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
                  <Package size={20} />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2">
                  <button type="button" className="truncate font-display text-[15px] font-bold text-ink hover:text-brand-700" onClick={() => setEditing(p)}>
                    {p.name}
                  </button>
                  {p.archived && <Badge>Archivé</Badge>}
                  {p.tag_name && (
                    <Badge tone="brand">
                      <TagIcon size={11} /> {p.tag_name}
                    </Badge>
                  )}
                </p>
                <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-slate-600">
                  {p.prices.length === 0 && <span className="text-amber-700">Aucune offre : ajoutez un prix pour le vendre</span>}
                  {p.prices.map((pr) => (
                    <span key={pr.id} className={pr.active ? undefined : 'text-slate-400 line-through'}>
                      {pr.name ? `${pr.name} : ` : ''}
                      {priceLabel(pr, computeAmounts(pr.amount, pr.tax_rate, pr.tax_inclusive).total)}
                    </span>
                  ))}
                </p>
              </div>
              <div className="text-right text-sm">
                <p className="font-semibold text-slate-900 tabular-nums">{fmtNumber(p.sales_count ?? 0)}</p>
                <p className="text-xs text-slate-500">vente{(p.sales_count ?? 0) > 1 ? 's' : ''}</p>
              </div>
              <div className="flex items-center gap-1">
                <IconButton icon={Pencil} label="Modifier" onClick={() => setEditing(p)} />
                <IconButton icon={p.archived ? ArchiveRestore : Archive} label={p.archived ? 'Remettre en vente' : 'Archiver'} onClick={() => toggleArchive(p)} />
                <IconButton icon={Trash2} label="Supprimer" onClick={() => remove(p)} />
              </div>
            </Card>
          ))}
        </div>
      )}
      {editing && (
        <ProductModal
          product={editing === 'new' ? null : editing}
          tags={tags}
          campaigns={campaigns}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </>
  );
}
