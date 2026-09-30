// Inspector panels of the payment blocks: « Paiement » (order form + order bump) and « Offre en un clic » (upsell).
// The offer is picked among the account's active offers (Ventes → Produits); its label is remembered in the block for
// the editor preview only — public pages always read the name and the price from the database.
import type { CheckoutBlock, Offer, PageSettings, UpsellBlock } from '@scalo/shared';
import { useLoad } from '../lib/hooks';
import { paymentsApi } from '../lib/payments-api';
import { Check, ColorInput, Disclosure, Prop, RangeInput, inputCls, textareaCls } from './controls';

type Setter<T> = (patch: Partial<T>, merge?: boolean) => void;

const offerLabel = (o: Offer) => `${o.product_name}${o.price_name ? ` — ${o.price_name}` : ''} · ${o.price_label}`;

function OfferSelect({ value, label, offers, empty, onChange }: { value: number | undefined; label: string | undefined; offers: Offer[] | undefined; empty: string; onChange: (o: Offer | null) => void }) {
  return (
    <>
      <select className={inputCls} value={value ?? ''} onChange={(e) => onChange(offers?.find((o) => o.id === Number(e.target.value)) ?? null)}>
        <option value="">{empty}</option>
        {offers?.map((o) => (
          <option key={o.id} value={o.id}>
            {offerLabel(o)}
          </option>
        ))}
        {value !== undefined && offers && !offers.some((o) => o.id === value) && <option value={value}>{label ? `${label} (indisponible)` : `Offre #${value} (indisponible)`}</option>}
      </select>
      {offers && offers.length === 0 && (
        <p className="mt-1.5 text-xs text-amber-700">
          Aucune offre en vente. Créez un produit dans <a href="/sales?tab=products" target="_blank" rel="noreferrer" className="font-medium underline">Ventes → Produits</a>.
        </p>
      )}
    </>
  );
}

export function CheckoutProps({ b, set, settings }: { b: CheckoutBlock; set: Setter<CheckoutBlock>; settings: PageSettings }) {
  const { data: offers } = useLoad(() => paymentsApi.offers(), []);
  const { data: stripe } = useLoad(() => paymentsApi.settings(), []);
  const main = offers?.find((o) => o.id === b.offerId);
  return (
    <>
      {stripe && !stripe.connected && (
        <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Stripe n’est pas connecté : le formulaire affichera « offre indisponible ». <a href="/settings#paiements" target="_blank" rel="noreferrer" className="font-medium underline">Paramètres → Paiements</a>
        </p>
      )}
      <Prop label="Offre vendue" hint="Le visiteur saisit son email, puis paie sur la page sécurisée de Stripe. Une fois le paiement confirmé, il reçoit le tag du produit et passe à l’étape suivante du tunnel.">
        <OfferSelect
          value={b.offerId}
          label={b.offerLabel}
          offers={offers}
          empty="Choisir une offre…"
          onChange={(o) => set({ offerId: o?.id, offerLabel: o ? offerLabel(o) : undefined })}
        />
      </Prop>
      <Prop label="Texte du bouton">
        <input className={inputCls} value={b.submitLabel} onChange={(e) => set({ submitLabel: e.target.value }, true)} data-primary-field="" />
      </Prop>
      <Check checked={b.showSummary !== false} onChange={(showSummary) => set({ showSummary })} label="Afficher le produit et le prix" />
      <Check checked={b.askName !== false} onChange={(askName) => set({ askName })} label="Demander le prénom" />
      <Check checked={!!b.askLastName} onChange={(askLastName) => set({ askLastName })} label="Demander le nom" />
      <Prop label="Mention sous le bouton">
        <input className={inputCls} value={b.secureNote ?? ''} placeholder="Paiement sécurisé par Stripe" onChange={(e) => set({ secureNote: e.target.value || undefined }, true)} />
      </Prop>

      <Disclosure title="Order bump" id="checkout-bump" defaultOpen={!!b.bumpOfferId}>
        <Prop label="Offre complémentaire" hint="Une case à cocher au-dessus du bouton : si le visiteur la coche, cette offre est ajoutée à sa commande et payée en même temps.">
          <OfferSelect
            value={b.bumpOfferId}
            label={b.bumpOfferLabel}
            offers={offers?.filter((o) => o.id !== b.offerId && (!main || o.currency === main.currency))}
            empty="Aucune"
            onChange={(o) => set({ bumpOfferId: o?.id, bumpOfferLabel: o ? offerLabel(o) : undefined })}
          />
        </Prop>
        {b.bumpOfferId !== undefined && (
          <>
            <Prop label="Titre de la case">
              <input className={inputCls} value={b.bumpTitle ?? ''} placeholder="Oui, j’ajoute cette offre" onChange={(e) => set({ bumpTitle: e.target.value || undefined }, true)} />
            </Prop>
            <Prop label="Texte">
              <textarea className={textareaCls} rows={3} value={b.bumpText ?? ''} placeholder="Offre unique : uniquement sur cette page." onChange={(e) => set({ bumpText: e.target.value || undefined }, true)} />
            </Prop>
          </>
        )}
      </Disclosure>

      <Disclosure title="Apparence" id="checkout-look">
        <Prop label="Couleur du bouton">
          <ColorInput value={b.buttonBg} placeholder={settings.accent} onChange={(buttonBg) => set({ buttonBg }, true)} />
        </Prop>
        <Prop label="Couleur du texte du bouton">
          <ColorInput value={b.buttonColor} placeholder="#ffffff" onChange={(buttonColor) => set({ buttonColor }, true)} />
        </Prop>
        <Prop label="Arrondi des champs">
          <RangeInput value={b.inputRadius} placeholder={8} min={0} max={40} onChange={(inputRadius) => set({ inputRadius }, true)} onReset={() => set({ inputRadius: undefined })} />
        </Prop>
      </Disclosure>
    </>
  );
}

export function UpsellProps({ b, set, settings }: { b: UpsellBlock; set: Setter<UpsellBlock>; settings: PageSettings }) {
  const { data: offers } = useLoad(() => paymentsApi.offers(), []);
  const picked = offers?.find((o) => o.id === b.offerId);
  return (
    <>
      <Prop
        label="Offre proposée"
        hint="À placer sur l’étape qui suit un bloc « Paiement ». En acceptant, le visiteur est débité sur la carte qu’il vient d’utiliser, sans la ressaisir. Si sa banque demande une authentification, il est redirigé vers la page de paiement Stripe."
      >
        <OfferSelect value={b.offerId} label={b.offerLabel} offers={offers} empty="Choisir une offre…" onChange={(o) => set({ offerId: o?.id, offerLabel: o ? offerLabel(o) : undefined })} />
      </Prop>
      {picked && picked.type !== 'one_time' && (
        <p className="mb-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">Abonnement ou paiement en plusieurs fois : le visiteur confirme sur la page de paiement Stripe (le paiement en un clic concerne les paiements uniques).</p>
      )}
      <Prop label="Bouton « accepter »">
        <input className={inputCls} value={b.acceptLabel} onChange={(e) => set({ acceptLabel: e.target.value }, true)} data-primary-field="" />
      </Prop>
      <Prop label="Lien « refuser »" hint="Mène à l’étape suivante du tunnel (par exemple une offre de repli, ou la page de remerciement). Vide = pas de lien.">
        <input className={inputCls} value={b.declineLabel ?? ''} placeholder="Non merci" onChange={(e) => set({ declineLabel: e.target.value || undefined }, true)} />
      </Prop>
      <Prop label="Mention sous le bouton">
        <input className={inputCls} value={b.note ?? ''} onChange={(e) => set({ note: e.target.value || undefined }, true)} />
      </Prop>
      <Check checked={!!b.skipNextOnAccept} onChange={(skipNextOnAccept) => set({ skipNextOnAccept })} label="Si l’offre est acceptée, sauter l’étape suivante (offre de repli)" />
      <Disclosure title="Apparence" id="upsell-look">
        <Prop label="Couleur du bouton">
          <ColorInput value={b.buttonBg} placeholder={settings.accent} onChange={(buttonBg) => set({ buttonBg }, true)} />
        </Prop>
        <Prop label="Couleur du texte du bouton">
          <ColorInput value={b.buttonColor} placeholder="#ffffff" onChange={(buttonColor) => set({ buttonColor }, true)} />
        </Prop>
      </Disclosure>
    </>
  );
}
