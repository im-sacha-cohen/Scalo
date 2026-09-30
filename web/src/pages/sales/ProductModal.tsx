// Create / edit a product and its offers (one-time, subscription, installments), with the tag and the campaign
// given to buyers.
import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { CURRENCIES, computeAmounts, priceLabel, type Campaign, type PriceInterval, type PriceType, type Product, type Tag } from '@scalo/shared';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { Button, Field, IconButton, Input, Select, Textarea, Toggle } from '../../components/ui';
import { paymentsApi, type PriceInput } from '../../lib/payments-api';
import { amountInput, parseAmount } from './labels';

interface PriceDraft {
  key: string;
  id?: number;
  name: string;
  type: PriceType;
  amount: string;
  currency: string;
  interval: PriceInterval;
  installments: string;
  tax_rate: string;
  tax_inclusive: boolean;
  active: boolean;
}

let draftSeq = 0;
const newDraft = (): PriceDraft => ({ key: `n${++draftSeq}`, name: '', type: 'one_time', amount: '', currency: 'eur', interval: 'month', installments: '3', tax_rate: '0', tax_inclusive: true, active: true });

const TYPE_LABELS: Record<PriceType, string> = { one_time: 'Paiement unique', subscription: 'Abonnement', installments: 'Paiement en plusieurs fois' };

function toInput(d: PriceDraft): PriceInput | string {
  const amount = parseAmount(d.amount);
  if (amount === null || amount < 50) return 'Montant invalide (0,50 minimum)';
  const tax = Number(d.tax_rate.replace(',', '.'));
  if (!Number.isFinite(tax) || tax < 0 || tax > 100) return 'Taux de TVA invalide (0 à 100)';
  const n = Number(d.installments);
  if (d.type === 'installments' && (!Number.isInteger(n) || n < 2 || n > 36)) return 'Nombre d’échéances : de 2 à 36';
  return {
    ...(d.id ? { id: d.id } : {}),
    name: d.name.trim(),
    type: d.type,
    amount,
    currency: d.currency,
    interval: d.type === 'subscription' ? d.interval : null,
    installments: d.type === 'installments' ? n : null,
    tax_rate: tax,
    tax_inclusive: d.tax_inclusive,
    active: d.active,
  };
}

export function ProductModal({ product, tags, campaigns, onClose, onSaved }: { product: Product | null; tags: Tag[]; campaigns: Campaign[]; onClose: () => void; onSaved: (p: Product) => void }) {
  const toast = useToast();
  const [name, setName] = useState(product?.name ?? '');
  const [description, setDescription] = useState(product?.description ?? '');
  const [imageUrl, setImageUrl] = useState(product?.image_url ?? '');
  const [tagName, setTagName] = useState(product?.tag_name ?? '');
  const [campaignId, setCampaignId] = useState<number | ''>(product?.campaign_id ?? '');
  const [revoke, setRevoke] = useState(product?.revoke_on_refund ?? true);
  const [prices, setPrices] = useState<PriceDraft[]>(() =>
    product?.prices.length
      ? product.prices.map((p) => ({
          key: `p${p.id}`,
          id: p.id,
          name: p.name,
          type: p.type,
          amount: amountInput(p.amount),
          currency: p.currency,
          interval: p.interval ?? 'month',
          installments: String(p.installments ?? 3),
          tax_rate: String(p.tax_rate).replace('.', ','),
          tax_inclusive: p.tax_inclusive,
          active: p.active,
        }))
      : [newDraft()],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patch = (key: string, p: Partial<PriceDraft>) => setPrices((list) => list.map((x) => (x.key === key ? { ...x, ...p } : x)));

  const save = async () => {
    setError(null);
    if (!name.trim()) return setError('Donnez un nom au produit');
    const inputs: PriceInput[] = [];
    for (const [i, d] of prices.entries()) {
      const r = toInput(d);
      if (typeof r === 'string') return setError(`Offre ${i + 1} : ${r}`);
      inputs.push(r);
    }
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        description: description.trim(),
        image_url: imageUrl.trim() || null,
        ...(tagName.trim() ? { tag_name: tagName.trim() } : { tag_id: null }),
        campaign_id: campaignId === '' ? null : campaignId,
        revoke_on_refund: revoke,
        prices: inputs,
      };
      const saved = product ? await paymentsApi.updateProduct(product.id, body) : await paymentsApi.createProduct(body);
      toast.success(product ? 'Produit enregistré' : 'Produit créé');
      onSaved(saved);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={product ? 'Modifier le produit' : 'Nouveau produit'}
      description="Ce que vous vendez, à quel prix, et ce que l’acheteur reçoit une fois le paiement confirmé."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button onClick={save} loading={saving}>
            {product ? 'Enregistrer' : 'Créer le produit'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nom du produit">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex. Formation Instagram" autoFocus />
          </Field>
          <Field label="Image (facultatif)" hint="URL https:// affichée sur la page de paiement Stripe.">
            <Input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://…" />
          </Field>
        </div>
        <Field label="Description (facultatif)" hint="Affichée sur la page de paiement.">
          <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-slate-700">Offres</span>
            <Button variant="ghost" size="xs" icon={Plus} onClick={() => setPrices((l) => [...l, newDraft()])} disabled={prices.length >= 20}>
              Ajouter une offre
            </Button>
          </div>
          <div className="space-y-3">
            {prices.map((d) => {
              const amount = parseAmount(d.amount);
              const tax = Number(d.tax_rate.replace(',', '.')) || 0;
              const a = amount !== null ? computeAmounts(amount, tax, d.tax_inclusive) : null;
              return (
                <div key={d.key} className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
                  <div className="grid gap-3 sm:grid-cols-[1.4fr_1fr_0.8fr_auto]">
                    <Field label="Type">
                      <Select value={d.type} onChange={(e) => patch(d.key, { type: e.target.value as PriceType })}>
                        {(Object.keys(TYPE_LABELS) as PriceType[]).map((t) => (
                          <option key={t} value={t}>
                            {TYPE_LABELS[t]}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label={d.type === 'installments' ? 'Montant par échéance' : 'Montant'}>
                      <Input inputMode="decimal" value={d.amount} onChange={(e) => patch(d.key, { amount: e.target.value })} placeholder="97" />
                    </Field>
                    <Field label="Devise">
                      <Select value={d.currency} onChange={(e) => patch(d.key, { currency: e.target.value })}>
                        {CURRENCIES.map((c) => (
                          <option key={c} value={c}>
                            {c.toUpperCase()}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <div className="flex items-end pb-0.5">
                      <IconButton icon={Trash2} label="Supprimer l’offre" onClick={() => setPrices((l) => l.filter((x) => x.key !== d.key))} disabled={prices.length <= 1} />
                    </div>
                  </div>
                  <div className="mt-3 grid gap-3 sm:grid-cols-4">
                    {d.type === 'subscription' && (
                      <Field label="Périodicité">
                        <Select value={d.interval} onChange={(e) => patch(d.key, { interval: e.target.value as PriceInterval })}>
                          <option value="month">Mensuel</option>
                          <option value="year">Annuel</option>
                        </Select>
                      </Field>
                    )}
                    {d.type === 'installments' && (
                      <Field label="Échéances (mensuelles)">
                        <Input inputMode="numeric" value={d.installments} onChange={(e) => patch(d.key, { installments: e.target.value })} />
                      </Field>
                    )}
                    <Field label="TVA (%)">
                      <Input inputMode="decimal" value={d.tax_rate} onChange={(e) => patch(d.key, { tax_rate: e.target.value })} />
                    </Field>
                    <Field label="Montant saisi">
                      <Select value={d.tax_inclusive ? 'ttc' : 'ht'} onChange={(e) => patch(d.key, { tax_inclusive: e.target.value === 'ttc' })}>
                        <option value="ttc">TTC (TVA incluse)</option>
                        <option value="ht">HT (TVA en plus)</option>
                      </Select>
                    </Field>
                    <Field label="Libellé (facultatif)" className={d.type === 'one_time' ? 'sm:col-span-2' : undefined}>
                      <Input value={d.name} onChange={(e) => patch(d.key, { name: e.target.value })} placeholder="ex. Paiement en 3 fois" />
                    </Field>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs text-slate-500">
                      {a ? (
                        <>
                          L’acheteur paie <strong className="text-slate-800">{priceLabel({ type: d.type, interval: d.interval, installments: Number(d.installments) || 2, currency: d.currency }, a.total)}</strong>
                          {a.tax > 0 && <> (dont TVA {(a.tax / 100).toFixed(2).replace('.', ',')})</>}
                        </>
                      ) : (
                        'Saisissez un montant (ex. 97 ou 97,50).'
                      )}
                    </p>
                    <Toggle checked={d.active} onChange={(active) => patch(d.key, { active })} label="En vente" />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Tag attribué à l’achat" hint="Donne accès à vos formations et déclenche vos campagnes / automatisations. Créé s’il n’existe pas.">
            <Input list="product-tags" value={tagName} onChange={(e) => setTagName(e.target.value)} placeholder="ex. client-formation" />
            <datalist id="product-tags">
              {tags.map((t) => (
                <option key={t.id} value={t.name} />
              ))}
            </datalist>
          </Field>
          <Field label="Inscrire à la campagne email (facultatif)">
            <Select value={campaignId} onChange={(e) => setCampaignId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">Aucune campagne</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Toggle
          checked={revoke}
          onChange={setRevoke}
          label="Retirer le tag en cas de remboursement"
          description="Le tag (et donc l’accès) est retiré quand la commande est entièrement remboursée ou que l’abonnement prend fin."
        />
        {error && <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
      </div>
    </Modal>
  );
}
