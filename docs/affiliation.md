[← Retour au README](../README.md)

# Affiliation

Menu **Affiliation** : vos affiliés recommandent vos offres avec leur lien personnel et touchent une commission sur les ventes qu’ils apportent. Le programme fait partie du cœur (AGPL) et s’appuie sur les paiements Stripe ([Paiements](payments.md)).

## Activer le programme

**Affiliation → Réglages** :

| Réglage | Défaut | |
|---|---|---|
| Programme activé | non | Désactivé : les liens ne sont plus suivis et aucune commission n’est créée (les commissions déjà gagnées restent dues). |
| Commission par défaut | 30 % | Pourcentage du montant **hors taxes réellement encaissé**, ou montant fixe par produit vendu. |
| Commissions par produit ou par offre | — | Surcharge de la commission par défaut. Priorité : offre, puis produit, puis commission personnalisée de l’affilié, puis défaut. 0 % exclut un produit. |
| Commissions récurrentes | oui | Chaque paiement d’un abonnement génère une commission, éventuellement limitée à N mois après la commande. Un paiement en plusieurs fois est toujours commissionné à chaque échéance. |
| Durée du cookie | 30 jours | Délai pendant lequel un achat est attribué à l’affilié après le clic (vérifié par le serveur à la commande). |
| Modèle d’attribution | dernier clic | « Premier clic » conserve le premier affilié tant que son cookie est valable. |
| Délai de validation | 30 jours | Une commission devient payable après ce délai, qui couvre la période de remboursement. |
| Seuil minimum de paiement | 0 | Solde à atteindre avant de pouvoir payer un affilié. |
| Inscriptions | sur validation | « Ouvertes » : tout inscrit qui confirme son adresse est approuvé. |
| Conditions du programme | — | Texte libre affiché dans l’espace affilié, à accepter à l’inscription. |

## Affiliés et liens

Un affilié est un **contact** de votre compte. Il s’inscrit lui-même dans l’espace affilié, ou vous l’ajoutez (Affiliation → Affiliés → « Ajouter un affilié », approuvé d’office). Statuts : en attente, approuvé, refusé, suspendu. Chaque affilié a un **code** lisible et unique (`alice`, `alice2`… modifiable) et peut recevoir une **commission personnalisée**.

Son lien est l’adresse de **n’importe quelle page de tunnel** suivie de `?aff=<code>` — y compris sur vos domaines personnalisés et sur la racine d’un tunnel :

```
https://app.exemple.fr/p/mon-tunnel/page-de-vente?aff=alice
https://www.mon-domaine.fr/?aff=alice
```

À la visite, Scalo pose un cookie (contenu chiffré et authentifié, propre à votre compte) et enregistre un **clic** — un seul par affilié, visiteur et jour, sans adresse IP ni navigateur. Un code inconnu ou celui d’un affilié suspendu reçoit exactement la même réponse qu’un code valable : on ne peut pas deviner qui est affilié.

- **Lead** : un visiteur venu par le lien qui s’inscrit via un formulaire est compté comme lead de l’affilié (statistique, sans commission).
- **Vente** : à la commande payée, la commission est créée « en attente ». Les offres en un clic (upsells) héritent de l’affilié de la commande d’origine.
- **Pas d’auto-parrainage** : un affilié qui achète avec sa propre adresse (ou un alias `+…`) ne touche rien. **Pas de commission** sur une commande à 0.
- Un affilié suspendu ou en attente ne génère aucune commission, y compris sur les renouvellements d’abonnement.

L’affilié apparaît sur le détail de la commande et sur la fiche du contact apporté ; sa propre fiche contact montre « Est devenu affilié » et « Commission gagnée ». Le déclencheur d’automatisation **Nouvel affilié approuvé** permet d’enchaîner (email de bienvenue, tag…).

## Commissions et remboursements

Cycle : **en attente** → **validée** (après le délai de validation, automatiquement) → **payée** (par un paiement) — ou **annulée**.

- **Remboursement total** : la commission est annulée. **Partiel** : elle est réduite au prorata du montant remboursé.
- Si la commission a **déjà été payée**, une ligne négative (« reprise après remboursement ») est ajoutée : le solde de l’affilié peut devenir négatif et se compense sur ses commissions suivantes.
- Un même paiement ne crée jamais deux commissions, même si Stripe renvoie plusieurs fois le même événement.
- **Annulation manuelle** (onglet Commissions) : motif obligatoire, impossible une fois la commission payée. Réservée aux administrateurs.

## Payer les affiliés

Scalo tient le **registre** des paiements ; le virement lui-même se fait en dehors (banque, PayPal…).

1. **Affiliation → Paiements** liste les soldes payables (commissions validées, reprises déduites). Un solde sous le seuil minimum ou négatif n’est pas payable.
2. **Exporter en CSV** : une ligne par affilié et devise, avec ses coordonnées de paiement (administrateurs uniquement).
3. Après le virement, **Marquer comme payé** (un affilié) ou **Tout marquer comme payé** (un lot) : indiquez le moyen et la référence. Les commissions concernées passent à « Payée ».

L’historique des paiements est visible dans le même onglet et sur la fiche de chaque affilié.

## Espace affilié

Adresse : `PUBLIC_URL/a/<adresse>` (Réglages → « Lien à partager »). Comme l’espace membres, il fonctionne sans mot de passe : l’affilié saisit son email et reçoit un **lien de connexion** valable 20 minutes, utilisable une fois.

- **Inscription** : l’affilié n’est créé qu’une fois le lien reçu par email utilisé (on ne peut pas inscrire l’adresse de quelqu’un d’autre). Un contact créé par cette inscription n’est pas abonné à vos emails.
- **Tableau de bord** : clics, leads, ventes, taux de conversion, commissions en attente / validées / payées, dernières commissions, paiements reçus. Un affilié ne voit que ses propres chiffres, jamais l’identité des acheteurs.
- **Mes liens** : générateur de lien vers chaque page publique de vos tunnels, copie en un clic.
- **Coordonnées de paiement** : texte libre (IBAN, PayPal…), **chiffré** en base ; seuls l’affilié et les administrateurs du compte peuvent le lire.
- **Conditions du programme**.

En dev, le proxy Vite transmet `/a/` à l’API ; en production, rien à faire si l’API sert aussi le front (image Docker) ; sinon ajoutez `/a/*` aux chemins envoyés à l’API par votre reverse proxy.

## Rôles (édition Entreprise)

Un **éditeur** peut consulter l’affiliation, approuver ou suspendre un affilié, mais ne peut ni modifier les réglages du programme, ni changer une commission, ni annuler une commission, ni enregistrer un paiement ; il ne voit pas les coordonnées de paiement. Un lecteur ne modifie rien.

## Limites actuelles

- Pas de virement automatique (registre manuel) ; pas de facture ni de relevé généré pour l’affilié.
- L’espace affilié est servi sur le domaine de l’application, pas sur les domaines personnalisés des tunnels (les **liens** d’affiliation, eux, fonctionnent partout).
- Le cookie est propre à chaque domaine : un clic sur un domaine personnalisé n’est pas connu d’un autre domaine.
- Le seuil minimum s’applique tel quel à chaque devise ; un montant fixe de commission est exprimé dans la devise de la commande.
- Pas d’email automatique à l’affilié lors de son approbation ou d’un paiement : utilisez l’automatisation « Nouvel affilié approuvé ».
- Les ventes enregistrées par l’API (`POST /api/v1/purchases`) ou un webhook entrant ne génèrent pas de commission : seules les commandes Stripe des tunnels sont attribuées.
