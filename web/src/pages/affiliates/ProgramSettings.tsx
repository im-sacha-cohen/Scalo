// « Affiliation → Réglages »: program on/off, commissions (default, per product / offer), recurring, cookie, attribution,
// validation delay, payout threshold, signup mode, affiliate area address and terms.
import { useEffect, useState } from 'react';
import { Copy, ExternalLink, Plus, Save, Trash2 } from 'lucide-react';
import type { AffiliateProgram, CommissionRate, Product } from '@scalo/shared';
import { affiliatesApi } from '../../lib/affiliates-api';
import { paymentsApi } from '../../lib/payments-api';
import { useEdition } from '../../lib/edition';
import { copyText, useLoad } from '../../lib/hooks';
import { useToast } from '../../components/Toast';
import { Button, Card, CardHeader, ErrorState, Field, IconButton, Input, Select, Skeleton, Textarea, Toggle } from '../../components/ui';
import { amountInput, parseAmount } from '../sales/labels';
import { RateInput } from './widgets';

interface RuleDraft {
  key: number;
  product_id: number | '';
  price_id: number | '';
  commission: CommissionRate;
}

let ruleKey = 0;
const toDrafts = (p: AffiliateProgram): RuleDraft[] => p.rules.map((r) => ({ key: ++ruleKey, product_id: r.product_id, price_id: r.price_id ?? '', commission: r.commission }));
const intOf = (v: string, min: number, max: number) => Math.min(max, Math.max(min, Math.round(Number(v) || 0)));

export function ProgramSettings({ onSaved }: { onSaved: () => void }) {
  const toast = useToast();
  const { isAdmin } = useEdition();
  const { data, error, reload } = useLoad(() => affiliatesApi.program(), []);
  const products = useLoad(() => paymentsApi.products(), []);
  const [p, setP] = useState<AffiliateProgram | null>(null);
  const [rules, setRules] = useState<RuleDraft[]>([]);
  const [minPayout, setMinPayout] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!data) return;
    setP(data);
    setRules(toDrafts(data));
    setMinPayout(amountInput(data.min_payout));
    setDirty(false);
  }, [data]);

  if (error && !data) return <ErrorState message={error} onRetry={reload} />;
  if (!p) {
    return (
      <Card>
        <Skeleton className="h-6 w-48" />
        <Skeleton className="mt-4 h-24 w-full" />
      </Card>
    );
  }

  const set = <K extends keyof AffiliateProgram>(k: K, v: AffiliateProgram[K]) => {
    setP({ ...p, [k]: v });
    setDirty(true);
  };
  const setRule = (key: number, patch: Partial<RuleDraft>) => {
    setRules(rules.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setDirty(true);
  };
  const productOf = (id: number | ''): Product | undefined => products.data?.find((x) => x.id === id);

  const save = async () => {
    const min = minPayout.trim() ? parseAmount(minPayout) : 0;
    if (min === null) return toast.error('Seuil minimum de paiement invalide');
    if (rules.some((r) => !r.product_id)) return toast.error('Choisissez un produit pour chaque commission par produit');
    setBusy(true);
    try {
      const saved = await affiliatesApi.saveProgram({
        enabled: p.enabled,
        name: p.name.trim(),
        slug: p.slug.trim(),
        commission: p.commission,
        recurring: p.recurring,
        recurring_months: p.recurring ? p.recurring_months : null,
        cookie_days: p.cookie_days,
        attribution: p.attribution,
        validation_days: p.validation_days,
        min_payout: min,
        signup_mode: p.signup_mode,
        terms: p.terms,
        rules: rules.map((r) => ({ product_id: Number(r.product_id), price_id: r.price_id === '' ? null : Number(r.price_id), commission: r.commission })),
      });
      setP(saved);
      setRules(toDrafts(saved));
      setDirty(false);
      toast.success('Réglages du programme enregistrés');
      onSaved();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {!isAdmin && <p className="rounded-2xl border border-slate-200 bg-slate-50 px-5 py-3 text-sm text-slate-600">Les réglages du programme sont réservés aux administrateurs du compte : vous pouvez les consulter.</p>}

      <Card>
        <CardHeader title="Programme" description="Quand le programme est désactivé, les liens ne sont plus suivis et aucune commission n’est créée. Les commissions déjà gagnées restent dues." />
        <div className="space-y-5">
          <Toggle checked={p.enabled} onChange={(v) => set('enabled', v)} label="Programme d’affiliation activé" description="Les pages de vos tunnels acceptent alors le paramètre ?aff=<code> de vos affiliés." />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nom du programme" hint="Affiché dans l’espace affilié et dans les emails de connexion.">
              <Input value={p.name} maxLength={120} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field label="Adresse de l’espace affilié" hint="Lettres minuscules, chiffres et tirets.">
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-sm text-slate-500">/a/</span>
                <Input value={p.slug} maxLength={60} onChange={(e) => set('slug', e.target.value.toLowerCase())} />
              </div>
            </Field>
          </div>
          <Field label="Lien à partager" hint="Page d’inscription et de connexion de vos affiliés.">
            <div className="flex gap-2">
              <Input readOnly value={p.url} onFocus={(e) => e.currentTarget.select()} />
              <Button variant="secondary" onClick={async () => ((await copyText(p.url)) ? toast.success('Lien copié') : toast.error('Copie impossible'))}>
                <Copy size={14} /> Copier
              </Button>
              <a href={p.url} target="_blank" rel="noreferrer" className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-slate-200 px-4 text-sm font-medium text-slate-700 hover:bg-slate-50">
                <ExternalLink size={14} /> Ouvrir
              </a>
            </div>
          </Field>
          <Field label="Inscriptions">
            <Select className="sm:w-96" value={p.signup_mode} onChange={(e) => set('signup_mode', e.target.value as AffiliateProgram['signup_mode'])}>
              <option value="approval">Sur validation : j’approuve chaque demande</option>
              <option value="open">Ouvertes : approbation automatique</option>
            </Select>
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader title="Commissions" description="Calculées sur le montant hors taxes réellement encaissé. Priorité : offre, puis produit, puis commission personnalisée de l’affilié, puis commission par défaut." />
        <div className="space-y-5">
          <Field label="Commission par défaut" hint={p.commission.type === 'fixed' ? 'Montant fixe par produit vendu, dans la devise de la commande.' : 'Pourcentage du montant hors taxes de chaque vente.'}>
            <RateInput key={`default-${data?.commission.type}-${data?.commission.value}`} value={p.commission} onChange={(v) => v && set('commission', v)} />
          </Field>
          <Toggle
            checked={p.recurring}
            onChange={(v) => set('recurring', v)}
            label="Commissions récurrentes sur les abonnements"
            description="Chaque paiement d’un abonnement apporté par un affilié génère une commission. Les paiements en plusieurs fois sont toujours commissionnés."
          />
          {p.recurring && (
            <Field label="Durée maximale (mois)" hint="Laissez vide pour une commission tant que l’abonnement dure." className="sm:w-64">
              <Input inputMode="numeric" value={p.recurring_months ?? ''} placeholder="Illimitée" onChange={(e) => set('recurring_months', e.target.value.trim() ? intOf(e.target.value, 1, 120) : null)} />
            </Field>
          )}

          <div>
            <p className="mb-1.5 text-sm font-medium text-slate-700">Commissions par produit ou par offre</p>
            {rules.length === 0 && <p className="mb-3 text-sm text-slate-500">Aucune surcharge : la commission par défaut s’applique à tous les produits.</p>}
            <div className="space-y-2">
              {rules.map((r) => {
                const prod = productOf(r.product_id);
                return (
                  <div key={r.key} className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200/80 p-2.5">
                    <Select className="w-52" value={r.product_id} onChange={(e) => setRule(r.key, { product_id: e.target.value ? Number(e.target.value) : '', price_id: '' })} aria-label="Produit">
                      <option value="">Choisir un produit…</option>
                      {products.data?.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                    </Select>
                    <Select className="w-48" value={r.price_id} onChange={(e) => setRule(r.key, { price_id: e.target.value ? Number(e.target.value) : '' })} aria-label="Offre" disabled={!prod}>
                      <option value="">Toutes les offres</option>
                      {prod?.prices?.map((pr, i) => (
                        <option key={pr.id} value={pr.id}>
                          {pr.name || `Offre ${i + 1}`}
                        </option>
                      ))}
                    </Select>
                    <RateInput value={r.commission} onChange={(v) => v && setRule(r.key, { commission: v })} />
                    <IconButton
                      icon={Trash2}
                      label="Retirer"
                      className="ml-auto"
                      onClick={() => {
                        setRules(rules.filter((x) => x.key !== r.key));
                        setDirty(true);
                      }}
                    />
                  </div>
                );
              })}
            </div>
            <Button
              variant="secondary"
              size="sm"
              className="mt-3"
              disabled={!products.data?.length}
              onClick={() => {
                setRules([...rules, { key: ++ruleKey, product_id: '', price_id: '', commission: { type: 'percent', value: 50 } }]);
                setDirty(true);
              }}
            >
              <Plus size={14} /> Ajouter une commission par produit
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Suivi et paiement" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Durée du cookie (jours)" hint="Délai pendant lequel un achat est attribué à l’affilié après le clic.">
            <Input inputMode="numeric" value={p.cookie_days} onChange={(e) => set('cookie_days', intOf(e.target.value, 1, 365))} />
          </Field>
          <Field label="Modèle d’attribution" hint="Quand un visiteur clique sur les liens de plusieurs affiliés.">
            <Select value={p.attribution} onChange={(e) => set('attribution', e.target.value as AffiliateProgram['attribution'])}>
              <option value="last_click">Dernier clic : le dernier affilié gagne</option>
              <option value="first_click">Premier clic : le premier affilié est conservé</option>
            </Select>
          </Field>
          <Field label="Délai de validation (jours)" hint="Une commission devient payable après ce délai : il couvre la période de remboursement.">
            <Input inputMode="numeric" value={p.validation_days} onChange={(e) => set('validation_days', intOf(e.target.value, 0, 365))} />
          </Field>
          <Field label="Seuil minimum de paiement" hint="Solde à atteindre avant de pouvoir payer un affilié (0 = aucun).">
            <Input
              inputMode="decimal"
              value={minPayout}
              placeholder="0"
              onChange={(e) => {
                setMinPayout(e.target.value);
                setDirty(true);
              }}
            />
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader title="Conditions du programme" description="Texte affiché aux affiliés dans leur espace et à accepter lors de l’inscription." />
        <Textarea rows={8} value={p.terms} maxLength={20000} onChange={(e) => set('terms', e.target.value)} placeholder="Règles de promotion, modalités de paiement, pratiques interdites…" />
      </Card>

      <div className="flex justify-end">
        <Button onClick={save} loading={busy} disabled={!dirty || !p.name.trim() || !p.slug.trim()}>
          <Save size={15} /> Enregistrer les réglages
        </Button>
      </div>
    </div>
  );
}
