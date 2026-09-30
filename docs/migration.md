[← Retour au README](../README.md)

# Migrer depuis un autre outil

**Contacts → « Migrer depuis un autre outil »** (`/migrate`) ouvre un assistant en sept étapes : source → connexion ou fichier → correspondance des champs → options → aperçu → import → rapport.

## Importer depuis systeme.io (clé API)

1. Dans votre compte systeme.io, créez une clé dans *Paramètres → Clés API publiques*.
2. Collez-la dans l’assistant : Scalo lit vos contacts par l’API publique de systeme.io (champs personnalisés, tags, désinscriptions, date d’inscription).
3. Vérifiez la correspondance (prénom, nom, téléphone sont reconnus ; les autres champs peuvent être associés à un champ existant ou créés en un clic), puis lancez l’import.

La clé ne sert qu’à lire vos contacts : elle est chiffrée pendant l’import, effacée dès qu’il se termine (ou est annulé) et n’apparaît dans aucun journal. Les limites de débit de systeme.io sont respectées : en cas de réponse « trop de requêtes », l’import se met en pause et reprend seul.

## Importer un fichier CSV

Les exports de **systeme.io, Mailchimp, Brevo, ActiveCampaign et Kit (ConvertKit)** sont reconnus à leurs en-têtes ; tout autre CSV fonctionne avec la correspondance manuelle. Sont repris : email, prénom, nom, téléphone, tags (séparés par `,` `;` ou `|`), statut d’abonnement, date d’inscription d’origine, champs personnalisés. 5 Mo et 200 000 lignes par fichier.

## Ce qu’un import fait — et ne fait pas

- **Aucun email ne part par surprise** : par défaut, l’import ne déclenche ni campagne ni automatisation (option à décocher si vous voulez que les contacts entrent dans vos séquences).
- **Les désinscrits restent désinscrits**, les adresses en erreur (bounce) restent exclues, et un contact déjà désinscrit dans Scalo n’est jamais réinscrit.
- Les contacts importés sont considérés comme confirmés : vous attestez avoir leur consentement (case obligatoire). Ceux qui attendaient une confirmation de double opt-in restent en attente.
- L’import tourne en arrière-plan (worker), par lots : vous pouvez fermer la page, l’annuler, et il reprend là où il s’était arrêté après un redémarrage du serveur. Le rapport donne les contacts créés, mis à jour, ignorés et en erreur, avec un **journal d’erreurs téléchargeable en CSV**.
- Option « ne pas écraser les champs existants », et tag d’import facultatif pour retrouver les contacts.

## Pages et tunnels

systeme.io ne propose pas d’export de pages. L’onglet **Pages** propose « Importer une page par URL » : Scalo lit la page publique (https) et en reprend **la structure et les textes** — titres, paragraphes, listes, boutons, images (par leur URL), formulaire d’inscription — sous forme de blocs modifiables dans l’éditeur. Vous attestez que la page vous appartient.

C’est volontairement simple : la mise en page, les couleurs, les polices, les vidéos et les scripts ne sont pas repris (aucun code n’est copié), et une page affichée uniquement par JavaScript ne peut pas être lue. Les images restent chargées depuis leur adresse d’origine tant que vous ne les réimportez pas dans la médiathèque. Les campagnes email et les automatisations sont à recréer dans Scalo.

*systeme.io, Mailchimp, Brevo, ActiveCampaign et Kit sont des marques de leurs propriétaires respectifs ; Scalo n’est affilié à aucun d’eux.*
