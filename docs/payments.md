[← Retour au README](../README.md)

# Paiements (Stripe)

Vendez dans vos tunnels avec **votre propre compte Stripe** : l’argent arrive directement chez vous, sans commission de Scalo. Le paiement a lieu sur la page sécurisée de Stripe (3-D Secure géré par Stripe) : aucune donnée de carte ne passe par votre serveur.

## Connecter Stripe

1. **Paramètres → Paiements** : collez votre clé secrète (`sk_test_…` pour essayer, `sk_live_…` pour encaisser — une clé restreinte `rk_…` convient) et, si vous voulez, la clé publique. Le mode test / réel est détecté d’après le préfixe. Cliquez sur **Tester la connexion**.
2. Dans Stripe → Développeurs → Webhooks, ajoutez un point de terminaison avec l’**URL affichée** dans Paramètres → Paiements et les événements listés, puis collez son **secret de signature** (`whsec_…`). Le webhook confirme les paiements même si l’acheteur ferme la page, et synchronise remboursements et abonnements.

Les clés sont chiffrées en base (AES-256-GCM, clé `ENCRYPTION_KEY` ou dérivée de `JWT_SECRET`) et ne sont plus jamais affichées (seuls les 4 derniers caractères le sont). En local, Stripe ne peut pas joindre `localhost` : utilisez `stripe listen --forward-to localhost:4000/api/payments/webhook/<jeton>` (le secret `whsec_…` affiché par la commande est celui à coller) — sans webhook, les paiements sont quand même confirmés au retour de l’acheteur sur le tunnel.

## Produits et offres

Menu **Ventes → Produits** : un produit (nom, description, image) a une ou plusieurs **offres** — paiement unique, abonnement mensuel ou annuel, paiement en plusieurs fois (2 à 36 mensualités, arrêt automatique après la dernière) — avec devise et TVA (montant saisi TTC ou HT). Le **tag attribué à l’achat** est la clé de voûte : c’est lui qui donne accès à vos formations et qui déclenche vos campagnes et automatisations ; une campagne email peut aussi être choisie directement.

## Vendre dans un tunnel

- Bloc **Paiement** (palette « Vente ») : bon de commande (prénom, email) + bouton. Option **order bump** : une case à cocher qui ajoute une seconde offre à la commande.
- Bloc **Offre en un clic**, sur l’étape qui suit : l’acheteur accepte un **upsell** sans ressaisir sa carte (débit du moyen de paiement enregistré). Si sa banque exige une authentification ou refuse la carte, il est redirigé vers la page de paiement Stripe. Le lien « Non merci » mène à l’étape suivante — placez-y un second bloc pour un **downsell**, et cochez « sauter l’étape suivante » sur le premier pour que ceux qui acceptent n’y passent pas.
- Une fois le paiement confirmé : contact créé ou mis à jour, tag et campagne du produit appliqués, achat enregistré (déclencheur d’automatisation « Achat », condition de segment « a acheté »), email de confirmation envoyé, redirection vers l’étape suivante.

## Commandes, remboursements, chiffre d’affaires

Menu **Ventes** : chiffre d’affaires net (paiements − remboursements), commandes payées, panier moyen et abonnements actifs sur la période ; liste des commandes (recherche, statut, produit) ; fiche d’une commande (lignes, TVA, paiements, origine : tunnel, étape, UTM). **Rembourser** (total ou partiel) envoie le remboursement à Stripe et, s’il est total, retire le tag du produit — donc l’accès — sauf si vous décochez l’option ou si le produit est réglé pour le conserver. **Annuler l’abonnement** arrête les prélèvements et retire l’accès. Les achats d’un contact apparaissent sur sa fiche, et une carte « Chiffre d’affaires » sur le tableau de bord.

API publique : `GET /api/v1/products`, `GET /api/v1/orders`, `GET /api/v1/orders/:id` (scope `sales:read`). Extensions (affiliation…) : voir « Point d’extension » dans [`SPEC.md`](../SPEC.md) (`registerOrderHook`).

Limites connues : pas de coupons ni de quantités ; l’upsell en un clic concerne les offres à paiement unique (abonnements et paiements en plusieurs fois passent par la page Stripe) ; devises à deux décimales (EUR, USD, GBP, CHF, CAD, AUD) ; factures et TVA par pays ne sont pas gérées (la TVA est un taux simple par offre).
