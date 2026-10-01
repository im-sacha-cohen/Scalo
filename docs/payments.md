[← Retour au README](../README.md)

# Paiements (Stripe)

Vendez dans vos tunnels avec **votre propre compte Stripe** : l’argent arrive directement chez vous, sans commission de Scalo. L’acheteur paie **directement sur votre page**, sans être redirigé vers Stripe : carte bancaire, Apple Pay et Google Pay, prélèvement SEPA si vous l’activez, validation 3-D Secure dans une fenêtre par-dessus la page. Le formulaire de carte est fourni par Stripe (Stripe Elements) : aucune donnée de carte ne passe par votre serveur.

## Connecter Stripe

1. **Paramètres → Paiements** : collez votre clé secrète (`sk_test_…` pour essayer, `sk_live_…` pour encaisser — une clé restreinte `rk_…` convient) et la **clé publique** (`pk_…`, indispensable : c’est elle qui affiche le formulaire de paiement sur vos pages). Le mode test / réel est détecté d’après le préfixe. Cliquez sur **Tester la connexion**.
2. Dans Stripe → Développeurs → Webhooks, ajoutez un point de terminaison avec l’**URL affichée** dans Paramètres → Paiements et les événements listés, puis collez son **secret de signature** (`whsec_…`). Le webhook confirme les paiements même si l’acheteur ferme la page, et synchronise remboursements et abonnements.

Les clés sont chiffrées en base (AES-256-GCM, clé `ENCRYPTION_KEY` ou dérivée de `JWT_SECRET`) et ne sont plus jamais affichées (seuls les 4 derniers caractères le sont). En local, Stripe ne peut pas joindre `localhost` : utilisez `stripe listen --forward-to localhost:4000/api/payments/webhook/<jeton>` (le secret `whsec_…` affiché par la commande est celui à coller) — sans webhook, les paiements sont quand même confirmés au retour de l’acheteur sur le tunnel.

Moyens de paiement : la carte est toujours proposée ; Apple Pay et Google Pay apparaissent sur les appareils compatibles si vous les activez dans Stripe → Paramètres → Moyens de paiement (Scalo déclare vos domaines à Stripe automatiquement). Le **prélèvement SEPA** (offres en euros) s’active dans Paramètres → Paiements, après l’avoir activé chez Stripe : l’acheteur passe à l’étape suivante tout de suite, mais l’accès n’est donné que lorsque la banque confirme le prélèvement (quelques jours, via le webhook).

## Produits et offres

Menu **Ventes → Produits → Nouveau produit** : la création se fait en quatre étapes — **Produit** (nom, description, image), **Prix**, **Accès** (ce que reçoit l’acheteur), **Récapitulatif** — avec, à côté, un aperçu de ce que verra l’acheteur. Un produit existant se modifie dans les mêmes sections, présentées en onglets.

Un produit a une ou plusieurs **offres** :
- **Paiement unique** ;
- **En plusieurs fois** : vous saisissez le prix total et laissez l’acheteur choisir en combien de fois il paie, entre un minimum (1 = il peut aussi payer comptant) et un maximum (jusqu’à 36), chaque mois, toutes les 2 semaines ou chaque semaine. Vous pouvez **majorer** le paiement en plusieurs fois (même pourcentage pour tous, ou un pourcentage par nombre d’échéances). Les échéances sont égales, la première absorbe les centimes d’arrondi (100 € en 3 fois : 33,34 € puis 2 × 33,33 €). Les prélèvements s’arrêtent seuls après la dernière échéance et l’acheteur garde l’accès ;
- **Abonnement** mensuel ou annuel.

Chaque offre a sa devise et sa TVA (montant saisi TTC ou HT, dans « Options avancées »). Le **tag attribué à l’achat** est la clé de voûte : c’est lui qui donne accès à vos formations et qui déclenche vos campagnes et automatisations ; une campagne email peut aussi être choisie directement.

## Vendre dans un tunnel

- Bloc **Paiement** (palette « Vente ») : bon de commande (prénom, email) + bouton. Pour une offre en plusieurs fois, l’acheteur choisit son échéancier (« En une fois », « En 3 fois — 3 × 99,00 € / mois »…). Après « Commander », le formulaire de paiement s’ouvre dans le bloc et le bouton devient « Payer 99,00 € ». Option **order bump** : une case à cocher qui ajoute une seconde offre à la commande.
- Page avec du **code personnalisé** (bloc HTML, code dans l’en-tête) : pour votre sécurité elle est isolée et ne peut pas afficher le formulaire de Stripe ; l’acheteur est alors envoyé sur la **page de paiement Scalo** de sa commande (même domaine, mêmes couleurs), puis revient dans votre tunnel.
- Bloc **Offre en un clic**, sur l’étape qui suit : l’acheteur accepte un **upsell** sans ressaisir sa carte (débit du moyen de paiement enregistré). Cela vaut aussi pour un abonnement ou un paiement en plusieurs fois (l’acheteur choisit ses échéances). Si sa banque exige une authentification ou refuse le paiement, il confirme sur la page de paiement Scalo. Le lien « Non merci » mène à l’étape suivante — placez-y un second bloc pour un **downsell**, et cochez « sauter l’étape suivante » sur le premier pour que ceux qui acceptent n’y passent pas.
- Une fois le paiement confirmé : contact créé ou mis à jour, tag et campagne du produit appliqués, achat enregistré (déclencheur d’automatisation « Achat », condition de segment « a acheté »), email de confirmation envoyé, redirection vers l’étape suivante.

## Commandes, remboursements, chiffre d’affaires

Menu **Ventes** : chiffre d’affaires net (paiements − remboursements), commandes payées, panier moyen et abonnements actifs sur la période ; liste des commandes (recherche, statut, produit) ; fiche d’une commande (lignes, TVA, paiements, origine : tunnel, étape, UTM). **Rembourser** (total ou partiel) envoie le remboursement à Stripe et, s’il est total, retire le tag du produit — donc l’accès — sauf si vous décochez l’option ou si le produit est réglé pour le conserver. **Annuler l’abonnement** arrête les prélèvements et retire l’accès. Les achats d’un contact apparaissent sur sa fiche, et une carte « Chiffre d’affaires » sur le tableau de bord.

API publique : `GET /api/v1/products`, `GET /api/v1/orders`, `GET /api/v1/orders/:id` (scope `sales:read`). Extensions (affiliation…) : voir « Point d’extension » dans [`SPEC.md`](../SPEC.md) (`registerOrderHook`).

Limites connues : pas de coupons ni de quantités ; une commande payée par prélèvement SEPA n’ouvre l’offre en un clic qu’une fois le prélèvement confirmé ; devises à deux décimales (EUR, USD, GBP, CHF, CAD, AUD) ; factures et TVA par pays ne sont pas gérées (la TVA est un taux simple par offre).
