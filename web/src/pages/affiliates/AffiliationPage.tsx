// « Affiliation »: summary, affiliates (validation, suspension, personal commission), commissions, payouts, program
// settings. Client: web/src/lib/affiliates-api.ts. See SPEC.md « Affiliation ».
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Ban, Check, Coins, Copy, Download, HandCoins, MousePointerClick, Plus, Search, Settings2, ShoppingCart, UserCheck, UserPlus, Users, Wallet, X } from 'lucide-react';
import {
  COMMISSION_STATUS_LABELS,
  commissionLabel,
  type Affiliate,
  type AffiliateBalance,
  type AffiliateCommission,
  type AffiliatePayable,
  type AffiliateStatus,
  type CommissionRate,
  type CommissionStatus,
} from '@scalo/shared';
import { downloadBlob } from '../../lib/api';
import { affiliatesApi } from '../../lib/affiliates-api';
import { contactName, fmtDate, fmtDateTime, fmtNumber, fmtPercent, fmtRelative } from '../../lib/format';
import { copyText, useDebounced, useLoad } from '../../lib/hooks';
import { useToast } from '../../components/Toast';
import { Modal } from '../../components/Modal';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, PageHeader, Pagination, Select, Skeleton, StatCard, Tabs, Textarea } from '../../components/ui';
import { money } from '../sales/labels';
import { ProgramSettings } from './ProgramSettings';
import { AffiliateStatusBadge, RateInput } from './widgets';

type TabId = 'affiliates' | 'commissions' | 'payouts' | 'settings';
const TABS: TabId[] = ['affiliates', 'commissions', 'payouts', 'settings'];
const LIMIT = 25;

const COM_TONES: Record<CommissionStatus, 'amber' | 'blue' | 'green' | 'slate'> = { pending: 'amber', approved: 'blue', paid: 'green', cancelled: 'slate' };

const sumOf = (balances: AffiliateBalance[], pick: (b: AffiliateBalance) => number) =>
  balances.length ? balances.map((b) => money(pick(b), b.currency)).join(' + ') : money(0, 'eur');

export function AffiliationPage() {
  const [params, setParams] = useSearchParams();
  const tab: TabId = TABS.includes(params.get('tab') as TabId) ? (params.get('tab') as TabId) : 'affiliates';
  const summary = useLoad(() => affiliatesApi.summary(), []);
  const s = summary.data;

  return (
    <>
      <PageHeader title="Affiliation" description="Vos affiliés recommandent vos offres avec leur lien et touchent une commission sur chaque vente." />

      {s && !s.enabled && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900">
          <p className="flex items-center gap-2">
            <HandCoins size={16} className="shrink-0" />
            Le programme d’affiliation est désactivé : les liens d’affiliés ne sont pas suivis et aucune commission n’est créée.
          </p>
          <button className="font-semibold underline underline-offset-2" onClick={() => setParams({ tab: 'settings' }, { replace: true })}>
            Ouvrir les réglages
          </button>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {summary.loading && !s ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="p-4">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="mt-3 h-7 w-28" />
            </Card>
          ))
        ) : (
          <>
            <StatCard label="Affiliés approuvés" value={fmtNumber(s?.affiliates.approved ?? 0)} icon={Users} tone="brand" hint={s?.affiliates.pending ? `${s.affiliates.pending} demande${s.affiliates.pending > 1 ? 's' : ''} en attente` : `${s?.affiliates.total ?? 0} au total`} />
            <StatCard label="Clics (30 j)" value={fmtNumber(s?.clicks ?? 0)} icon={MousePointerClick} tone="sky" hint={`${fmtNumber(s?.leads ?? 0)} lead${(s?.leads ?? 0) > 1 ? 's' : ''} apporté${(s?.leads ?? 0) > 1 ? 's' : ''}`} />
            <StatCard label="Ventes (30 j)" value={fmtNumber(s?.sales ?? 0)} icon={ShoppingCart} tone="green" hint={s?.clicks ? `${fmtPercent((s.sales ?? 0) / s.clicks)} des clics` : 'Commandes apportées par un affilié'} />
            <StatCard
              label="Commissions à payer"
              value={sumOf(s?.balances ?? [], (b) => b.approved)}
              icon={Wallet}
              tone="violet"
              hint={`${sumOf(s?.balances ?? [], (b) => b.pending)} en attente · ${sumOf(s?.balances ?? [], (b) => b.paid)} payées`}
            />
          </>
        )}
      </div>

      <Tabs
        className="mt-8 mb-5"
        value={tab}
        onChange={(t) => setParams(t === 'affiliates' ? {} : { tab: t }, { replace: true })}
        tabs={[
          { id: 'affiliates', label: 'Affiliés', icon: Users, count: s?.affiliates.pending || undefined },
          { id: 'commissions', label: 'Commissions', icon: Coins },
          { id: 'payouts', label: 'Paiements', icon: Wallet },
          { id: 'settings', label: 'Réglages', icon: Settings2 },
        ]}
      />
      {tab === 'affiliates' && <AffiliatesTab onChange={summary.reload} />}
      {tab === 'commissions' && <CommissionsTab onChange={summary.reload} />}
      {tab === 'payouts' && <PayoutsTab onChange={summary.reload} />}
      {tab === 'settings' && <ProgramSettings onSaved={summary.reload} />}
    </>
  );
}

// ---------- affiliates ----------

const STATUS_FILTERS: { id: AffiliateStatus | ''; label: string }[] = [
  { id: '', label: 'Tous les statuts' },
  { id: 'pending', label: 'En attente' },
  { id: 'approved', label: 'Approuvés' },
  { id: 'suspended', label: 'Suspendus' },
  { id: 'rejected', label: 'Refusés' },
];

function AffiliatesTab({ onChange }: { onChange: () => void }) {
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<AffiliateStatus | ''>('');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const q = useDebounced(search);
  useEffect(() => setPage(1), [status, q]);
  const { data, error, loading, reload } = useLoad(() => affiliatesApi.affiliates({ page, limit: LIMIT, status, search: q }), [page, status, q]);
  const refresh = () => {
    reload();
    onChange();
  };

  const setAffStatus = async (a: Affiliate, next: 'approved' | 'rejected') => {
    try {
      await affiliatesApi.updateAffiliate(a.id, { status: next });
      toast.success(next === 'approved' ? 'Affilié approuvé' : 'Demande refusée');
      refresh();
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <>
      <Card padded={false} className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3">
          <Input icon={Search} className="w-full sm:w-64" placeholder="Email, nom ou code" value={search} onChange={(e) => setSearch(e.target.value)} />
          <Select className="w-48" value={status} onChange={(e) => setStatus(e.target.value as AffiliateStatus | '')} aria-label="Statut">
            {STATUS_FILTERS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </Select>
          <Button className="ml-auto" onClick={() => setAdding(true)}>
            <Plus size={15} /> Ajouter un affilié
          </Button>
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
            icon={Users}
            className="m-4 border-0"
            title={status || q ? 'Aucun affilié ne correspond' : 'Aucun affilié pour l’instant'}
            description={status || q ? 'Modifiez les filtres pour élargir la recherche.' : 'Ajoutez un affilié à la main ou partagez l’adresse de votre espace affilié (onglet Réglages) pour recevoir des inscriptions.'}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs font-medium text-slate-500">
                  <th className="px-4 py-2.5">Affilié</th>
                  <th className="px-3 py-2.5">Code</th>
                  <th className="px-3 py-2.5">Statut</th>
                  <th className="px-3 py-2.5 text-right">Clics</th>
                  <th className="px-3 py-2.5 text-right">Leads</th>
                  <th className="px-3 py-2.5 text-right">Ventes</th>
                  <th className="px-3 py-2.5 text-right">À payer</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data?.items.map((a) => (
                  <tr key={a.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpenId(a.id)}>
                    <td className="max-w-[240px] px-4 py-2.5">
                      <span className="block truncate font-medium text-slate-800">{contactName(a)}</span>
                      {(a.first_name || a.last_name) && <span className="block truncate text-xs text-slate-500">{a.email}</span>}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs text-slate-600">{a.code}</td>
                    <td className="px-3 py-2.5">
                      <AffiliateStatusBadge status={a.status} />
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">{fmtNumber(a.stats.clicks)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">{fmtNumber(a.stats.leads)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">{fmtNumber(a.stats.sales)}</td>
                    <td className="px-3 py-2.5 text-right font-medium whitespace-nowrap tabular-nums text-slate-800">{a.balances.length ? sumOf(a.balances, (b) => b.approved) : '—'}</td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                      {a.status === 'pending' && (
                        <span className="inline-flex gap-1.5">
                          <Button size="xs" variant="success" onClick={() => setAffStatus(a, 'approved')}>
                            <Check size={13} /> Approuver
                          </Button>
                          <Button size="xs" variant="secondary" onClick={() => setAffStatus(a, 'rejected')}>
                            <X size={13} /> Refuser
                          </Button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && <Pagination page={page} total={data.total} limit={LIMIT} onChange={setPage} />}
      </Card>
      {adding && (
        <AddAffiliateModal
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            refresh();
          }}
        />
      )}
      {openId !== null && <AffiliateModal id={openId} onClose={() => setOpenId(null)} onChange={refresh} />}
    </>
  );
}

function AddAffiliateModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await affiliatesApi.addAffiliate({ email: email.trim(), first_name: firstName.trim() || undefined });
      toast.success('Affilié ajouté');
      onDone();
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
      title="Ajouter un affilié"
      description="Le contact est créé s’il n’existe pas. L’affilié est approuvé immédiatement et se connecte à son espace avec cette adresse."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button onClick={submit} loading={busy} disabled={!email.trim()}>
            <UserPlus size={15} /> Ajouter
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Adresse email">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="partenaire@exemple.fr" />
        </Field>
        <Field label="Prénom" hint="Sert à proposer un code lisible (modifiable ensuite).">
          <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function AffiliateModal({ id, onClose, onChange }: { id: number; onClose: () => void; onChange: () => void }) {
  const toast = useToast();
  const { data: a, setData, error, reload } = useLoad(() => affiliatesApi.affiliate(id), [id]);
  const [rate, setRate] = useState<CommissionRate | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const current = rate === undefined ? (a?.commission ?? null) : rate;

  const patch = async (b: Parameters<typeof affiliatesApi.updateAffiliate>[1], message: string) => {
    setBusy(true);
    try {
      setData(await affiliatesApi.updateAffiliate(id, b));
      setRate(undefined);
      toast.success(message);
      onChange();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} size="lg" title={a ? contactName(a) : 'Affilié'} description={a ? a.email : undefined}>
      {error && !a ? (
        <ErrorState message={error} onRetry={reload} />
      ) : !a ? (
        <div className="space-y-2">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-2">
            <AffiliateStatusBadge status={a.status} />
            <span className="text-xs text-slate-500">Inscrit le {fmtDate(a.created_at)}</span>
            <span className="ml-auto inline-flex gap-2">
              {(a.status === 'pending' || a.status === 'rejected' || a.status === 'suspended') && (
                <Button size="sm" variant="success" loading={busy} onClick={() => patch({ status: 'approved' }, a.status === 'suspended' ? 'Affilié réactivé' : 'Affilié approuvé')}>
                  <UserCheck size={14} /> {a.status === 'suspended' ? 'Réactiver' : 'Approuver'}
                </Button>
              )}
              {a.status === 'pending' && (
                <Button size="sm" variant="secondary" loading={busy} onClick={() => patch({ status: 'rejected' }, 'Demande refusée')}>
                  Refuser
                </Button>
              )}
              {a.status === 'approved' && (
                <Button size="sm" variant="secondary" loading={busy} onClick={() => patch({ status: 'suspended' }, 'Affilié suspendu : ses liens ne génèrent plus de commission')}>
                  <Ban size={14} /> Suspendre
                </Button>
              )}
              <Link to={`/contacts/${a.contact_id}`} className="inline-flex h-8 items-center rounded-full border border-slate-200 px-3.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
                Fiche contact
              </Link>
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ['Clics', fmtNumber(a.stats.clicks)],
              ['Leads', fmtNumber(a.stats.leads)],
              ['Ventes', fmtNumber(a.stats.sales)],
              ['Conversion', fmtPercent(a.stats.conversion)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl border border-slate-200/80 px-3 py-2.5">
                <p className="text-xs text-slate-500">{label}</p>
                <p className="font-display text-xl font-extrabold tabular-nums text-ink">{value}</p>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {[
              ['En attente', sumOf(a.balances, (b) => b.pending)],
              ['Validées (à payer)', sumOf(a.balances, (b) => b.approved)],
              ['Payées', sumOf(a.balances, (b) => b.paid)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl bg-slate-50 px-3 py-2.5">
                <p className="text-xs text-slate-500">{label}</p>
                <p className="font-semibold tabular-nums text-slate-800">{value}</p>
              </div>
            ))}
          </div>

          <Field label="Lien d’affiliation" hint={`Code « ${a.code} » — il fonctionne sur toutes les pages de vos tunnels : ajoutez ?aff=${a.code} à leur adresse.`}>
            <div className="flex gap-2">
              <Input readOnly value={a.link ?? `?aff=${a.code}`} onFocus={(e) => e.currentTarget.select()} />
              <Button variant="secondary" onClick={async () => ((await copyText(a.link ?? `?aff=${a.code}`)) ? toast.success('Lien copié') : toast.error('Copie impossible'))}>
                <Copy size={14} /> Copier
              </Button>
            </div>
          </Field>

          <Field label="Commission personnalisée" hint="Remplace la commission par défaut du programme pour cet affilié (une commission définie sur un produit reste prioritaire).">
            <div className="flex flex-wrap items-center gap-2">
              <RateInput key={`${a.id}-${a.commission?.type}-${a.commission?.value}`} value={current} onChange={setRate} allowDefault />
              {rate !== undefined && (
                <Button size="sm" loading={busy} onClick={() => patch({ commission: rate }, 'Commission enregistrée')}>
                  Enregistrer
                </Button>
              )}
              {rate === undefined && a.commission && <Badge tone="violet">{commissionLabel(a.commission)}</Badge>}
            </div>
          </Field>

          <div>
            <p className="mb-1.5 text-sm font-medium text-slate-700">Coordonnées de paiement</p>
            {!a.payout_details_visible ? (
              <p className="text-sm text-slate-500">Visibles uniquement par les administrateurs du compte.</p>
            ) : a.payout_details === null ? (
              <p className="text-sm text-slate-500">L’affilié n’a pas encore renseigné ses coordonnées (IBAN, PayPal…) dans son espace.</p>
            ) : a.payout_details === '' ? (
              <p className="text-sm text-amber-700">Les coordonnées enregistrées ne peuvent plus être lues (clé de chiffrement modifiée) : l’affilié doit les saisir à nouveau.</p>
            ) : (
              <pre className="rounded-xl bg-slate-50 px-3 py-2.5 font-sans text-sm whitespace-pre-wrap text-slate-800">{a.payout_details}</pre>
            )}
          </div>

          <div>
            <p className="mb-1.5 text-sm font-medium text-slate-700">Paiements effectués</p>
            {a.payouts.length === 0 ? (
              <p className="text-sm text-slate-500">Aucun paiement enregistré pour cet affilié.</p>
            ) : (
              <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200/80 text-sm">
                {a.payouts.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="min-w-0 truncate text-slate-600">
                      {fmtDate(p.created_at)} {p.method && `· ${p.method}`} {p.reference && `· ${p.reference}`}
                    </span>
                    <span className="font-medium tabular-nums text-slate-800">{money(p.amount, p.currency)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------- commissions ----------

const COMMISSION_FILTERS: { id: CommissionStatus | ''; label: string }[] = [
  { id: '', label: 'Tous les statuts' },
  { id: 'pending', label: 'En attente' },
  { id: 'approved', label: 'Validées' },
  { id: 'paid', label: 'Payées' },
  { id: 'cancelled', label: 'Annulées' },
];

function CommissionsTab({ onChange }: { onChange: () => void }) {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<CommissionStatus | ''>('');
  const [affiliateId, setAffiliateId] = useState<number | ''>('');
  const [cancelling, setCancelling] = useState<AffiliateCommission | null>(null);
  useEffect(() => setPage(1), [status, affiliateId]);
  const affiliates = useLoad(() => affiliatesApi.affiliates({ limit: 100 }), []);
  const { data, error, loading, reload } = useLoad(() => affiliatesApi.commissions({ page, limit: LIMIT, status, affiliate_id: affiliateId || null }), [page, status, affiliateId]);

  return (
    <>
      <Card padded={false} className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3">
          <Select className="w-48" value={status} onChange={(e) => setStatus(e.target.value as CommissionStatus | '')} aria-label="Statut">
            {COMMISSION_FILTERS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </Select>
          {!!affiliates.data?.items.length && (
            <Select className="w-60" value={affiliateId} onChange={(e) => setAffiliateId(e.target.value ? Number(e.target.value) : '')} aria-label="Affilié">
              <option value="">Tous les affiliés</option>
              {affiliates.data.items.map((a) => (
                <option key={a.id} value={a.id}>
                  {contactName(a)} ({a.code})
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
            icon={Coins}
            className="m-4 border-0"
            title={status || affiliateId ? 'Aucune commission ne correspond' : 'Aucune commission pour l’instant'}
            description="Une commission est créée quand une commande apportée par un affilié est payée. Elle devient payable après le délai de validation."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs font-medium text-slate-500">
                  <th className="px-4 py-2.5">Date</th>
                  <th className="px-3 py-2.5">Affilié</th>
                  <th className="px-3 py-2.5">Produit</th>
                  <th className="px-3 py-2.5">Commande</th>
                  <th className="px-3 py-2.5 text-right">Base HT</th>
                  <th className="px-3 py-2.5 text-right">Taux</th>
                  <th className="px-3 py-2.5 text-right">Commission</th>
                  <th className="px-3 py-2.5">Statut</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data?.items.map((c) => (
                  <tr key={c.id}>
                    <td className="px-4 py-2.5 whitespace-nowrap text-slate-500" title={fmtDateTime(c.created_at)}>
                      {fmtRelative(c.created_at)}
                    </td>
                    <td className="max-w-[200px] truncate px-3 py-2.5 text-slate-800" title={c.affiliate_email}>
                      {c.affiliate_email}
                    </td>
                    <td className="max-w-[220px] px-3 py-2.5 text-slate-600">
                      <span className="block truncate">{c.product_name}</span>
                      {c.kind === 'recurring' && <Badge tone="violet">Récurrent</Badge>}
                      {c.kind === 'clawback' && <Badge tone="red">Reprise après remboursement</Badge>}
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      {c.order_id ? (
                        <Link to={`/sales/orders/${c.order_id}`} className="font-medium text-slate-700 hover:text-brand-700">
                          #{c.order_id}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap tabular-nums text-slate-600">{c.kind === 'clawback' ? '—' : money(c.base_amount, c.currency)}</td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap tabular-nums text-slate-600">{commissionLabel(c.rate, c.currency)}</td>
                    <td className="px-3 py-2.5 text-right font-medium whitespace-nowrap tabular-nums text-slate-800">
                      {money(c.amount, c.currency)}
                      {c.status !== 'cancelled' && c.amount !== c.amount_initial && <span className="block text-xs font-normal text-slate-400 line-through">{money(c.amount_initial, c.currency)}</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge tone={COM_TONES[c.status]} dot>
                        {COMMISSION_STATUS_LABELS[c.status]}
                      </Badge>
                      {c.status === 'pending' && <span className="mt-0.5 block text-xs text-slate-500">payable le {fmtDate(c.approve_at)}</span>}
                      {c.status === 'cancelled' && c.cancel_reason && <span className="mt-0.5 block max-w-[180px] truncate text-xs text-slate-500" title={c.cancel_reason}>{c.cancel_reason}</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {(c.status === 'pending' || c.status === 'approved') && c.kind !== 'clawback' && (
                        <Button size="xs" variant="ghost" onClick={() => setCancelling(c)}>
                          Annuler
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && <Pagination page={page} total={data.total} limit={LIMIT} onChange={setPage} />}
      </Card>
      {cancelling && (
        <CancelCommissionModal
          commission={cancelling}
          onClose={() => setCancelling(null)}
          onDone={() => {
            setCancelling(null);
            reload();
            onChange();
          }}
        />
      )}
    </>
  );
}

function CancelCommissionModal({ commission, onClose, onDone }: { commission: AffiliateCommission; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await affiliatesApi.cancelCommission(commission.id, reason.trim());
      toast.success('Commission annulée');
      onDone();
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
      title="Annuler cette commission ?"
      description={`${money(commission.amount, commission.currency)} pour ${commission.affiliate_email}. Cette action est définitive.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Retour
          </Button>
          <Button variant="danger" onClick={submit} loading={busy} disabled={reason.trim().length < 3}>
            Annuler la commission
          </Button>
        </>
      }
    >
      <Field label="Motif" hint="Conservé dans l’historique de la commission.">
        <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex. : vente frauduleuse, auto-parrainage…" />
      </Field>
    </Modal>
  );
}

// ---------- payouts ----------

function PayoutsTab({ onChange }: { onChange: () => void }) {
  const toast = useToast();
  const [page, setPage] = useState(1);
  const payables = useLoad(() => affiliatesApi.payables(), []);
  const history = useLoad(() => affiliatesApi.payouts({ page, limit: LIMIT }), [page]);
  const [paying, setPaying] = useState<AffiliatePayable | 'all' | null>(null);
  const ready = payables.data?.filter((p) => p.payable) ?? [];
  const refresh = () => {
    payables.reload();
    history.reload();
    onChange();
  };
  const exportCsv = async () => {
    try {
      downloadBlob(await affiliatesApi.exportPayables(), 'paiements-affilies.csv');
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div className="space-y-6">
      <Card padded={false} className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div>
            <h3 className="font-display text-base font-bold tracking-[-0.01em] text-ink">Montants à payer</h3>
            <p className="mt-0.5 text-sm text-slate-500">Commissions validées, remboursements déduits. Le virement se fait en dehors de Scalo : enregistrez-le ici une fois effectué.</p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={exportCsv} disabled={!ready.length}>
              <Download size={15} /> Exporter en CSV
            </Button>
            <Button onClick={() => setPaying('all')} disabled={!ready.length}>
              <Wallet size={15} /> Tout marquer comme payé
            </Button>
          </div>
        </div>
        {payables.error && !payables.data ? (
          <div className="p-4">
            <ErrorState message={payables.error} onRetry={payables.reload} />
          </div>
        ) : !payables.data ? (
          <div className="p-4">
            <Skeleton className="h-9 w-full" />
          </div>
        ) : payables.data.length === 0 ? (
          <EmptyState icon={Wallet} className="m-4 border-0" title="Rien à payer pour le moment" description="Les commissions deviennent payables une fois le délai de validation écoulé." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs font-medium text-slate-500">
                  <th className="px-5 py-2.5">Affilié</th>
                  <th className="px-3 py-2.5 text-right">Commissions</th>
                  <th className="px-3 py-2.5 text-right">Solde</th>
                  <th className="px-3 py-2.5">Coordonnées</th>
                  <th className="px-5 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {payables.data.map((p) => (
                  <tr key={`${p.affiliate_id}-${p.currency}`}>
                    <td className="max-w-[260px] px-5 py-2.5">
                      <span className="block truncate font-medium text-slate-800">{contactName(p)}</span>
                      <span className="block truncate text-xs text-slate-500">
                        {p.email} · {p.code}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">{p.commissions_count}</td>
                    <td className={`px-3 py-2.5 text-right font-medium whitespace-nowrap tabular-nums ${p.amount < 0 ? 'text-rose-600' : 'text-slate-800'}`}>{money(p.amount, p.currency)}</td>
                    <td className="px-3 py-2.5">{p.has_payout_details ? <Badge tone="green">Renseignées</Badge> : <Badge tone="amber">Manquantes</Badge>}</td>
                    <td className="px-5 py-2.5 text-right whitespace-nowrap">
                      {p.payable ? (
                        <Button size="xs" onClick={() => setPaying(p)}>
                          Marquer comme payé
                        </Button>
                      ) : (
                        <span className="text-xs text-slate-500">{p.amount <= 0 ? 'Solde négatif : reporté sur les prochaines commissions' : 'Sous le seuil minimum de paiement'}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card padded={false} className="overflow-hidden">
        <div className="px-5 pt-4">
          <CardHeader title="Historique des paiements" />
        </div>
        {history.error && !history.data ? (
          <div className="p-4">
            <ErrorState message={history.error} onRetry={history.reload} />
          </div>
        ) : history.data && history.data.total === 0 ? (
          <p className="px-5 pb-5 text-sm text-slate-500">Aucun paiement enregistré.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs font-medium text-slate-500">
                  <th className="px-5 py-2.5">Date</th>
                  <th className="px-3 py-2.5">Affilié</th>
                  <th className="px-3 py-2.5">Moyen</th>
                  <th className="px-3 py-2.5">Référence</th>
                  <th className="px-3 py-2.5 text-right">Commissions</th>
                  <th className="px-5 py-2.5 text-right">Montant</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {history.data?.items.map((p) => (
                  <tr key={p.id}>
                    <td className="px-5 py-2.5 whitespace-nowrap text-slate-500">{fmtDateTime(p.created_at)}</td>
                    <td className="max-w-[220px] truncate px-3 py-2.5 text-slate-800">{p.affiliate_email}</td>
                    <td className="px-3 py-2.5 text-slate-600">{p.method || '—'}</td>
                    <td className="max-w-[220px] truncate px-3 py-2.5 text-slate-600" title={p.note || undefined}>
                      {p.reference || '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">{p.commissions_count ?? '—'}</td>
                    <td className="px-5 py-2.5 text-right font-medium whitespace-nowrap tabular-nums text-slate-800">{money(p.amount, p.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {history.data && <Pagination page={page} total={history.data.total} limit={LIMIT} onChange={setPage} />}
      </Card>

      {paying && (
        <PayModal
          target={paying}
          count={ready.length}
          onClose={() => setPaying(null)}
          onDone={() => {
            setPaying(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function PayModal({ target, count, onClose, onDone }: { target: AffiliatePayable | 'all'; count: number; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [method, setMethod] = useState('Virement');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const meta = { method: method.trim(), reference: reference.trim(), note: note.trim() };
    try {
      if (target === 'all') {
        const r = await affiliatesApi.payAll(meta);
        toast.success(`${r.count} paiement${r.count > 1 ? 's' : ''} enregistré${r.count > 1 ? 's' : ''}`);
      } else {
        await affiliatesApi.pay({ affiliate_id: target.affiliate_id, currency: target.currency, ...meta });
        toast.success('Paiement enregistré');
      }
      onDone();
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
      title={target === 'all' ? `Enregistrer ${count} paiement${count > 1 ? 's' : ''}` : `Payer ${money(target.amount, target.currency)}`}
      description={
        target === 'all'
          ? 'Un paiement est enregistré pour chaque affilié payable ; leurs commissions validées passent à « Payée ». Aucun virement n’est émis par Scalo.'
          : `${target.email} — ses commissions validées passent à « Payée ». Aucun virement n’est émis par Scalo.`
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button onClick={submit} loading={busy}>
            Enregistrer le paiement
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Moyen de paiement">
          <Input value={method} onChange={(e) => setMethod(e.target.value)} placeholder="Virement, PayPal…" maxLength={80} />
        </Field>
        <Field label="Référence" hint="Numéro de virement, identifiant de transaction…">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={200} />
        </Field>
        <Field label="Note interne">
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
        </Field>
      </div>
    </Modal>
  );
}
