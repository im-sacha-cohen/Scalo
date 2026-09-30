[← Retour au README](../README.md)

# Emails : programmation, double opt-in, campagnes, délivrabilité

## Newsletters programmées
- Éditeur de newsletter → **Programmer** (date + heure dans le fuseau du navigateur, affiché) ou **Envoyer maintenant**. Bandeau « Programmée pour … » avec compte à rebours, **Modifier la date**, **Annuler la programmation** (redevient brouillon).
- Le contenu, l’objet et le segment restent **modifiables jusqu’au départ** (pas besoin de déprogrammer). Une fois l’envoi commencé : 409.
- La liste des destinataires est calculée **au moment du départ** (nouveaux inscrits inclus, désinscrits et contacts non confirmés exclus). Le démarrage est fait par le worker (boucle de planification à chaque tick) avec un `UPDATE … WHERE status='scheduled' AND scheduled_at <= now()` conditionnel : plusieurs instances (ou un clic « Envoyer maintenant » concurrent) ne lancent jamais deux fois la même newsletter.
- **Test A/B de l’objet** (2 ou 3 objets) : chaque variante part à X % des destinataires (5–50 %, défaut 20 %), puis après N heures (défaut 4 h) la variante au meilleur taux d’ouverture (à égalité : clics, puis la première) est envoyée automatiquement au reste — recalculé à ce moment. Sous 100 destinataires : répartition égale, sans phase de gagnant. Compatible avec la programmation (la répartition se fait au départ). Statistiques par variante dans la page de la newsletter. Annuler l’envoi annule aussi la phase finale.

## Double opt-in
- Par formulaire (éditeur → bloc Formulaire → « Double opt-in » : par défaut du compte / activé / désactivé, objet et texte de l’email, page après confirmation) et réglage par défaut dans **Paramètres → Double opt-in**.
- À la soumission : contact créé **en attente de confirmation** (`confirmed_at` NULL ; un contact existant garde son état), événement `optin`, demande stockée dans `pending_optins` (jeton aléatoire 32 octets, seul son SHA-256 est stocké, valable **7 jours**) avec les actions à appliquer (tag, campagne, tunnel/étape, redirection), et email de confirmation mis en file **en priorité absolue**. L’étape suivante affiche « Vérifiez votre boîte mail » (`?doi=1`). Rien n’est appliqué avant la confirmation (ni tag, ni campagne, ni réabonnement).
- `GET /c/:token` affiche un bouton (les scanners de liens ne confirment donc personne), `POST /c/:token` confirme : contact confirmé et réabonné, tag appliqué (déclenche ses campagnes), campagne du formulaire + campagnes des tags déjà présents, événement `optin_confirmed`, puis redirection vers l’URL configurée ou page de succès. Lien expiré → 410, inconnu → 404.
- Un contact non confirmé ne reçoit **ni newsletters ni campagnes** (requêtes de destinataires + contrôle par le worker) ; badge « En attente de confirmation » et filtre dans Contacts ; bouton **Renvoyer l’email de confirmation** (nouveau lien, 1 fois / 5 min, 3 emails de confirmation / heure / contact — aussi appliqué aux soumissions répétées du formulaire).
- L’email de confirmation respecte les bounces et plaintes ; il part même si le contact s’était désinscrit *avant* de redemander à s’inscrire (demande explicite), pas s’il se désinscrit après. Il n’est pas compté dans les statistiques de newsletters.
- **Nettoyage** : les contacts non confirmés ne sont jamais supprimés automatiquement ; ils restent « en attente » (filtrez-les pour les supprimer si besoin). Les demandes expirées restent en base pour l’historique.
- En dev, le proxy Vite transmet `/c/` à l’API.

## Campagnes avancées
- Modèle : à l’inscription, un envoi par email est créé (échéance = inscription + délais cumulés) ; **tout ce qui dépend du contact est évalué quand l’email est dû** : statut de l’inscription, tag d’arrêt, condition, ordre (un email attend tant qu’un email précédent de la séquence est encore en attente).
- **Ajout d’un email** (`apply_to_existing`, défaut oui) : pour chaque inscrit actif, échéance = inscription + délais cumulés ; si elle est déjà passée, l’email part maintenant (après 10 min, le temps de le rédiger) ou est ignoré pour lui (`apply_to_existing=false`) ; sinon il le reçoit normalement. Jamais deux fois le même email de campagne à un contact (index unique partiel).
- **Réordonner** (flèches) ou **changer un délai** recalcule l’échéance des envois en attente ; supprimer un email décale les suivants.
- **Condition par email** : a / n’a pas le tag X, a ouvert / a cliqué / n’a pas ouvert l’email précédent (le dernier email de la campagne réellement envoyé) ; sinon *ignorer* (passe au suivant) ou *arrêter la séquence*. Donnez un délai ≥ 1 jour aux conditions sur l’ouverture.
- **Tag d’arrêt** de la campagne (ex. « client ») : le contact qui le reçoit quitte la séquence (envois restants « ignorés »).
- Liste paginée des **inscrits** (statut en cours / terminée / arrêtée / désinscrit, progression, prochain email) et **Désinscrire de la campagne**.

## Plaintes pour spam et rebonds (webhooks)
- URL par compte (Paramètres → « Plaintes et rebonds ») : `PUBLIC_URL/api/webhooks/email/<fournisseur>/<secret>` avec `generic`, `ses`, `postmark`, `mailgun`, `brevo`. Secret régénérable (l’ancienne URL cesse aussitôt de fonctionner). Mauvais secret ou fournisseur inconnu → 404.
- Format générique : `{"type": "complaint"|"bounce", "email": "...", "message_id": "..."}` (ou un tableau). Amazon SES : abonnement HTTPS SNS — la `SubscriptionConfirmation` est confirmée automatiquement **uniquement** si `SubscribeURL` est une URL `https://sns.<région>.amazonaws.com` ; notifications `Complaint` et `Bounce` permanents. Postmark : `SpamComplaint`, `Bounce` durs. Mailgun : `complained`, `failed` permanent. Brevo : `spam`, `hard_bounce`.
- L’envoi est retrouvé par l’en-tête `X-Scalo-Send-Id` (si le fournisseur le renvoie), puis par le `Message-ID` SMTP (stocké), sinon par l’adresse. Plainte → contact désinscrit + marqué `complained`, envois en attente annulés, campagnes arrêtées, événement `spam_complaint`. Bounce → comme un 5xx SMTP.
- Chaque email porte un en-tête `Feedback-ID` (`b<newsletter>|c<campagne>:<compte>:<type>:scalo`) en plus de `List-Unsubscribe`.
- Taux de plaintes (30 j) affiché dans le suivi des envois, alerte au-delà de 0,1 %. **Pause automatique** de l’envoi si les plaintes dépassent 0,3 % des 1 000 derniers envois (à partir de 100 envois, pour qu’une plainte isolée sur une petite liste ne bloque pas tout) ; `paused_reason` l’explique.
- Limite : la signature des messages SNS n’est pas vérifiée — l’authentification repose sur le secret de l’URL (gardez-le secret, régénérez-le au besoin).

## Domaine d’envoi (SPF, DKIM, DMARC)
- Paramètres → **Domaine d’envoi** : vérification DNS réelle (`node:dns/promises`, délai max 4 s par requête, aucune requête autre que DNS, syntaxe du domaine validée — pas d’IP ni de nom sans point) du domaine de l’expéditeur, ou d’un autre domaine saisi (sans modifier les paramètres). SPF (absent, multiple, `+all`, `?all`, fournisseur SMTP non inclus), DKIM (sélecteurs courants + sélecteurs configurables), DMARC (absent, `p=none`), MX. Enregistrements recommandés avec boutons Copier, guides pas à pas (Brevo, Mailgun, Amazon SES, Google Workspace, OVHcloud, Postmark), bouton **Revérifier**.
- La fenêtre d’envoi d’une newsletter avertit (sans bloquer) si SPF ou DKIM manquent.
