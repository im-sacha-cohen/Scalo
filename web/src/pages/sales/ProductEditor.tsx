// Product editor (« Ventes → Produits »). Creation is a 4-step wizard — Produit, Prix, Accès, Récapitulatif — so that
// each screen asks for one thing; editing an existing product shows the same sections as tabs with a save button.
// A preview on the side shows what the buyer will see on the order form.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft, ArrowRight, Check, ClipboardCheck, ImagePlus, KeyRound, Package, Tag as TagIcon, Wallet, X, type LucideIcon } from 'lucide-react';
import { computeAmounts, formatMoney, planLabel, priceLabel, INSTALLMENT_RHYTHMS, type Campaign, type Product, type Tag } from '@scalo/shared';
import { api } from '../../lib/api';
import { paymentsApi } from '../../lib/payments-api';
import { useLoad } from '../../lib/hooks';
import { useToast } from '../../components/Toast';
import { useUnsavedGuard } from '../../components/useUnsavedGuard';
import { Badge, Button, Card, ErrorState, Field, Input, PageHeader, PageLoader, Select, Spinner, Tabs, Textarea, Toggle, cx } from '../../components/ui';
import { PricingEditor } from './PricingEditor';
import { draftOf, plansOf, priceInput, productInput, stepError, type PriceDraft, type ProductDraft } from './product-draft';
import { parseAmount } from './labels';

type StepId = 'product' | 'pricing' | 'access' | 'review';
const STEPS: { id: StepId; label: string; icon: LucideIcon; title: string; text: string }[] = [
  { id: 'product', label: 'Produit', icon: Package, title: 'Que vendez-vous ?', text: 'Le nom et la présentation que verront vos acheteurs.' },
  { id: 'pricing', label: 'Prix', icon: Wallet, title: 'À quel prix ?', text: 'Paiement unique, en plusieurs fois au choix de l’acheteur, ou abonnement.' },
  { id: 'access', label: 'Accès', icon: KeyRound, title: 'Que reçoit l’acheteur ?', text: 'Ce qui se passe automatiquement une fois le paiement confirmé.' },
  { id: 'review', label: 'Récapitulatif', icon: ClipboardCheck, title: 'Tout est bon ?', text: 'Vérifiez avant de créer le produit. Vous pourrez tout modifier ensuite.' },
];

export function ProductEditorPage() {
  const params = useParams();
  const id = params.id ? Number(params.id) : null;
  const product = useLoad(() => (id ? paymentsApi.product(id) : Promise.resolve(null)), [id]);
  if (id && product.loading && !product.data) return <PageLoader />;
  if (id && product.error && !product.data) return <ErrorState message={product.error} onRetry={product.reload} />;
  return <ProductEditor key={id ?? 'new'} product={product.data ?? null} />;
}

function ProductEditor({ product }: { product: Product | null }) {
  const navigate = useNavigate();
  const toast = useToast();
  const creating = !product;
  const [draft, setDraft] = useState<ProductDraft>(() => draftOf(product));
  const initial = useRef(JSON.stringify(draftOf(product)));
  const [step, setStep] = useState<StepId>('product');
  const [reached, setReached] = useState(0);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const leaving = useRef(false);
  const dirty = JSON.stringify(draft) !== initial.current;
  useUnsavedGuard(dirty, leaving);
  useEffect(() => {
    api.tags().then(setTags).catch(() => {});
    api.campaigns().then(setCampaigns).catch(() => {});
  }, []);

  const set = (p: Partial<ProductDraft>) => setDraft((d) => ({ ...d, ...p }));
  const index = STEPS.findIndex((s) => s.id === step);
  const meta = STEPS[index];

  const go = (target: StepId) => {
    const to = STEPS.findIndex((s) => s.id === target);
    // moving forward checks every step in between
    for (const s of STEPS.slice(0, to)) {
      if (s.id === 'review') continue;
      const e = stepError(s.id, draft);
      if (e) {
        setStep(s.id);
        setShowErrors(true);
        setError(e);
        return;
      }
    }
    setError(null);
    setShowErrors(false);
    setStep(target);
    setReached((r) => Math.max(r, to));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const save = async () => {
    for (const s of ['product', 'pricing', 'access'] as const) {
      const e = stepError(s, draft);
      if (e) {
        setStep(s);
        setShowErrors(true);
        setError(e);
        return;
      }
    }
    setError(null);
    setSaving(true);
    try {
      const body = productInput(draft);
      if (product) {
        const saved = await paymentsApi.updateProduct(product.id, body);
        const next = draftOf(saved);
        initial.current = JSON.stringify(next);
        setDraft(next);
        toast.success('Produit enregistré');
      } else {
        await paymentsApi.createProduct(body);
        toast.success('Produit créé : ajoutez un bloc « Paiement » à un tunnel pour le vendre');
        leaving.current = true;
        navigate('/sales?tab=products');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const sections: Record<Exclude<StepId, 'review'>, ReactNode> = {
    product: <ProductSection draft={draft} set={set} showErrors={showErrors} />,
    pricing: <PricingEditor prices={draft.prices} onChange={(prices) => set({ prices })} showErrors={showErrors} />,
    access: <AccessSection draft={draft} set={set} tags={tags} campaigns={campaigns} />,
  };

  return (
    <>
      <PageHeader
        back={
          <Link to="/sales?tab=products" className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-900">
            <ArrowLeft size={15} /> Produits
          </Link>
        }
        title={creating ? 'Nouveau produit' : product.name}
        description={creating ? 'Quatre étapes rapides : le produit, son prix, ce que l’acheteur reçoit, puis une vérification.' : 'Modifiez le produit, ses offres et ce que reçoivent les acheteurs.'}
        actions={
          !creating && (
            <>
              {dirty && <Badge tone="amber">Modifications non enregistrées</Badge>}
              <Button onClick={save} loading={saving} disabled={!dirty} icon={Check}>
                Enregistrer
              </Button>
            </>
          )
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          {creating ? (
            <Stepper index={index} reached={reached} onPick={(s) => go(s)} />
          ) : (
            <Tabs
              className="mb-5"
              value={step === 'review' ? 'product' : step}
              onChange={(t) => {
                setStep(t);
                setError(null);
              }}
              tabs={STEPS.filter((s) => s.id !== 'review').map((s) => ({ id: s.id as Exclude<StepId, 'review'>, label: s.label, icon: s.icon }))}
            />
          )}

          <Card className="p-5 sm:p-6">
            {creating && (
              <div className="mb-5">
                <h2 className="font-display text-lg font-bold text-ink">{meta.title}</h2>
                <p className="mt-0.5 text-sm text-slate-500">{meta.text}</p>
              </div>
            )}
            {step === 'review' ? <Review draft={draft} tags={tags} campaigns={campaigns} onEdit={(s) => setStep(s)} /> : sections[step]}
            {error && <p className="mt-5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
          </Card>

          {creating && (
            <div className="mt-5 flex items-center justify-between gap-3">
              {index > 0 ? (
                <Button variant="secondary" icon={ArrowLeft} onClick={() => setStep(STEPS[index - 1].id)}>
                  Retour
                </Button>
              ) : (
                <span />
              )}
              {step === 'review' ? (
                <Button onClick={save} loading={saving} icon={Check}>
                  Créer le produit
                </Button>
              ) : (
                <Button onClick={() => go(STEPS[index + 1].id)}>
                  Continuer <ArrowRight size={15} />
                </Button>
              )}
            </div>
          )}
        </div>

        <aside className="lg:sticky lg:top-6 lg:self-start">
          <BuyerPreview draft={draft} />
        </aside>
      </div>
    </>
  );
}

function Stepper({ index, reached, onPick }: { index: number; reached: number; onPick: (s: StepId) => void }) {
  return (
    <ol className="mb-5 flex items-center gap-2 overflow-x-auto pb-1">
      {STEPS.map((s, i) => {
        const done = i < index;
        const current = i === index;
        const reachable = i <= reached + 1;
        return (
          <li key={s.id} className="flex min-w-0 shrink-0 items-center gap-2">
            {i > 0 && <span className={cx('h-px w-6 sm:w-10', i <= index ? 'bg-brand-400' : 'bg-slate-200')} />}
            <button
              type="button"
              disabled={!reachable}
              onClick={() => onPick(s.id)}
              aria-current={current ? 'step' : undefined}
              className={cx('flex items-center gap-2 rounded-full py-1 pr-3 pl-1 text-sm transition', current ? 'bg-brand-50 font-semibold text-brand-700' : 'text-slate-600 hover:bg-slate-100', !reachable && 'cursor-not-allowed opacity-50')}
            >
              <span
                className={cx(
                  'flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold',
                  done ? 'bg-brand-600 text-white' : current ? 'bg-brand-600 text-white' : 'bg-slate-200 text-slate-600',
                )}
              >
                {done ? <Check size={13} /> : i + 1}
              </span>
              {s.label}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function ProductSection({ draft, set, showErrors }: { draft: ProductDraft; set: (p: Partial<ProductDraft>) => void; showErrors: boolean }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const upload = async (f: File | undefined) => {
    if (!f) return;
    setUploading(true);
    try {
      set({ imageUrl: (await api.upload(f)).url });
    } catch (e) {
      toast.error(e);
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <div className="space-y-5">
      <Field label="Nom du produit" error={showErrors && !draft.name.trim() ? 'Obligatoire' : null}>
        <Input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="ex. Formation Instagram" autoFocus maxLength={200} />
      </Field>
      <Field label="Description (facultatif)" hint="Quelques mots sur ce que contient le produit.">
        <Textarea rows={3} value={draft.description} onChange={(e) => set({ description: e.target.value })} maxLength={2000} />
      </Field>
      <Field label="Image (facultatif)">
        <div className="flex items-center gap-4">
          {draft.imageUrl ? (
            <span className="relative">
              <img src={draft.imageUrl} alt="" className="h-20 w-20 rounded-xl object-cover ring-1 ring-slate-200" />
              <button type="button" onClick={() => set({ imageUrl: '' })} className="absolute -top-2 -right-2 rounded-full bg-white p-0.5 text-slate-500 shadow ring-1 ring-slate-200 hover:text-rose-600" aria-label="Retirer l’image">
                <X size={14} />
              </button>
            </span>
          ) : (
            <span className="flex h-20 w-20 items-center justify-center rounded-xl border border-dashed border-slate-300 text-slate-400">
              <Package size={22} />
            </span>
          )}
          <div className="min-w-0 flex-1 space-y-2">
            <Button variant="secondary" size="sm" icon={uploading ? undefined : ImagePlus} onClick={() => input.current?.click()} disabled={uploading}>
              {uploading ? <Spinner size={14} /> : null} {draft.imageUrl ? 'Changer l’image' : 'Choisir une image'}
            </Button>
            <Input value={draft.imageUrl} onChange={(e) => set({ imageUrl: e.target.value })} placeholder="ou collez une URL https://…" className="text-xs" />
          </div>
          <input ref={input} type="file" accept="image/*" hidden onChange={(e) => upload(e.target.files?.[0])} />
        </div>
      </Field>
    </div>
  );
}

function AccessSection({ draft, set, tags, campaigns }: { draft: ProductDraft; set: (p: Partial<ProductDraft>) => void; tags: Tag[]; campaigns: Campaign[] }) {
  return (
    <div className="space-y-5">
      <Field label="Tag attribué à l’acheteur" hint="C’est lui qui ouvre l’accès à vos formations et déclenche vos campagnes et automatisations. Il est créé s’il n’existe pas.">
        <Input icon={TagIcon} list="product-tags" value={draft.tagName} onChange={(e) => set({ tagName: e.target.value })} placeholder="ex. client-formation" maxLength={60} />
        <datalist id="product-tags">
          {tags.map((t) => (
            <option key={t.id} value={t.name} />
          ))}
        </datalist>
      </Field>
      <Field label="Inscrire à une campagne email (facultatif)">
        <Select value={draft.campaignId} onChange={(e) => set({ campaignId: e.target.value ? Number(e.target.value) : '' })}>
          <option value="">Aucune campagne</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      <Toggle
        checked={draft.revoke}
        onChange={(revoke) => set({ revoke })}
        label="Retirer le tag en cas de remboursement"
        description="Le tag, et donc l’accès, est retiré quand la commande est entièrement remboursée ou que l’abonnement prend fin. Un paiement en plusieurs fois mené à son terme garde l’accès."
      />
      <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
        Dans tous les cas, l’acheteur reçoit un email de confirmation de commande et devient un contact, avec l’achat enregistré sur sa fiche (déclencheur « Achat » des automatisations).
      </div>
    </div>
  );
}

const offerSummary = (d: PriceDraft): string => {
  const amount = parseAmount(d.amount);
  if (amount === null) return 'Prix à définir';
  const total = computeAmounts(amount, Number(d.tax_rate.replace(',', '.')) || 0, d.tax_inclusive).total;
  if (d.type !== 'installments') return priceLabel({ type: d.type, interval: d.type === 'subscription' ? d.interval : null, currency: d.currency }, total);
  const plans = plansOf(d) ?? [];
  const rhythm = INSTALLMENT_RHYTHMS.find((r) => r.id === d.rhythm)!;
  const counts = plans.map((p) => p.count);
  return `${formatMoney(plans[0]?.total ?? total, d.currency)} · de ${counts[0]} à ${counts.at(-1)} fois (${rhythm.label.toLowerCase()})`;
};

function Review({ draft, tags, campaigns, onEdit }: { draft: ProductDraft; tags: Tag[]; campaigns: Campaign[]; onEdit: (s: StepId) => void }) {
  const campaign = campaigns.find((c) => c.id === draft.campaignId);
  const known = tags.some((t) => t.name.toLowerCase() === draft.tagName.trim().toLowerCase());
  const Row = ({ label, step, children }: { label: string; step: StepId; children: ReactNode }) => (
    <div className="flex gap-4 py-3">
      <div className="w-28 shrink-0 text-sm text-slate-500">{label}</div>
      <div className="min-w-0 flex-1 text-sm text-slate-900">{children}</div>
      <button type="button" onClick={() => onEdit(step)} className="text-sm font-medium text-brand-600 hover:underline">
        Modifier
      </button>
    </div>
  );
  return (
    <div className="divide-y divide-slate-100">
      <Row label="Produit" step="product">
        <span className="font-semibold">{draft.name}</span>
        {draft.description && <span className="mt-0.5 block text-slate-500">{draft.description}</span>}
      </Row>
      <Row label={draft.prices.length > 1 ? 'Offres' : 'Prix'} step="pricing">
        <ul className="space-y-1">
          {draft.prices.map((p) => (
            <li key={p.key}>
              {p.name && <span className="font-medium">{p.name} : </span>}
              {offerSummary(p)}
              {!p.active && <Badge className="ml-2">Pas en vente</Badge>}
            </li>
          ))}
        </ul>
      </Row>
      <Row label="Accès" step="access">
        {draft.tagName.trim() ? (
          <>
            Tag <Badge tone="brand">{draft.tagName.trim()}</Badge> {!known && <span className="text-slate-500">(sera créé)</span>}
          </>
        ) : (
          <span className="text-amber-700">Aucun tag : l’achat n’ouvre aucun accès automatiquement</span>
        )}
        {campaign && <span className="mt-1 block">Campagne « {campaign.name} »</span>}
        <span className="mt-1 block text-slate-500">{draft.revoke ? 'Accès retiré en cas de remboursement' : 'Accès conservé en cas de remboursement'}</span>
      </Row>
    </div>
  );
}

/** What the buyer sees on the order form (first offer on sale). */
function BuyerPreview({ draft }: { draft: ProductDraft }) {
  const offer = draft.prices.find((p) => p.active) ?? draft.prices[0];
  const plans = useMemo(() => (offer && offer.type === 'installments' ? plansOf(offer) : null), [offer]);
  const [picked, setPicked] = useState(0);
  if (!offer) return null;
  const valid = typeof priceInput(offer) !== 'string';
  const amount = parseAmount(offer.amount);
  const total = amount !== null ? computeAmounts(amount, Number(offer.tax_rate.replace(',', '.')) || 0, offer.tax_inclusive).total : null;
  const rhythm = INSTALLMENT_RHYTHMS.find((r) => r.id === offer.rhythm)!;
  const chosen = plans?.[Math.min(picked, plans.length - 1)];
  const price =
    total === null
      ? '—'
      : chosen
        ? planLabel(chosen, offer.currency, rhythm.interval, rhythm.count)
        : priceLabel({ type: offer.type, interval: offer.type === 'subscription' ? offer.interval : null, currency: offer.currency }, total);
  return (
    <div>
      <p className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">Aperçu pour l’acheteur</p>
      <Card className="p-4">
        {draft.imageUrl && <img src={draft.imageUrl} alt="" className="mb-3 aspect-video w-full rounded-lg object-cover" />}
        <div className="flex items-baseline justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
          <span className="truncate text-sm font-semibold text-slate-900">
            {draft.name.trim() || 'Nom du produit'}
            {offer.name && <span className="font-normal text-slate-500"> — {offer.name}</span>}
          </span>
          <span className="text-sm font-extrabold whitespace-nowrap text-slate-900">{price}</span>
        </div>
        {plans && plans.length > 1 && valid && (
          <div className="mt-3 space-y-1.5">
            <p className="text-xs font-semibold text-slate-700">Comment souhaitez-vous payer ?</p>
            {plans.map((p, i) => (
              <label key={p.count} className={cx('flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 text-xs', i === picked ? 'border-brand-500 bg-brand-50/50' : 'border-slate-200')}>
                <input type="radio" className="mt-0.5" checked={i === picked} onChange={() => setPicked(i)} />
                <span>
                  <strong>{p.count === 1 ? 'En une fois' : `En ${p.count} fois`}</strong> — {planLabel(p, offer.currency, rhythm.interval, rhythm.count)}
                  {p.count > 1 && p.first !== p.each && <span className="block text-slate-500">1re échéance : {formatMoney(p.first, offer.currency)}</span>}
                </span>
              </label>
            ))}
          </div>
        )}
        <div className="mt-3 space-y-1.5">
          <div className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs leading-8 text-slate-400">Votre email</div>
          <div className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs leading-8 text-slate-400">Carte · Apple Pay · Google Pay</div>
        </div>
        <div className="mt-3 rounded-md bg-brand-600 py-2 text-center text-sm font-bold text-white">{chosen ? `Payer ${formatMoney(chosen.first, offer.currency)}` : total !== null ? `Payer ${formatMoney(total, offer.currency)}` : 'Commander'}</div>
        <p className="mt-2 text-center text-[11px] text-slate-400">Paiement sur votre page, sans redirection</p>
      </Card>
    </div>
  );
}
