[← Retour au README](../README.md)

# Formations et espace membres

Menu **Formations** : vendez et diffusez vos formations en ligne, sans outil tiers.

## Créer une formation

1. **Formations → Nouvelle formation**, puis ajoutez des **modules** et des **leçons** (boutons monter / descendre pour les ordonner ; une leçon peut passer d’un module à l’autre).
2. Chaque leçon s’édite avec le même éditeur que les pages (textes, images, colonnes, vidéos…). Dans le panneau **Réglages de la leçon** : statut (brouillon / publiée), **vidéo** (lien YouTube, Vimeo ou fichier `.mp4`), **diffusion progressive** (disponible N jours après l’obtention de l’accès), **aperçu gratuit** (lisible sans connexion) et **fichiers à télécharger** (PDF, archives, documents, audio… 25 Mo par fichier).
3. **Publiez** les leçons, puis la formation. Une formation ou une leçon en brouillon n’est visible que dans l’aperçu propriétaire (bouton « Aperçu membre »).

Les blocs « HTML personnalisé », formulaire et paiement ne sont pas disponibles dans une leçon (ils sont retirés à l’enregistrement).

## Donner accès

- **Par tag** (Réglages de la formation → « Tag donnant accès ») : tout contact qui a ce tag a accès. C’est le branchement avec le reste de l’application : un achat, une automatisation (« Ajouter un tag »), un formulaire de tunnel, un import ou l’API publique attribuent le tag, et l’accès suit. La diffusion progressive démarre à la date d’obtention du tag ; « Durée de l’accès » le fait expirer N jours plus tard. Retirer le tag retire l’accès (la progression est conservée).
- **Manuellement** (onglet Élèves → « Inscrire un contact ») : par adresse email, avec une date d’accès (départ de la diffusion progressive) et une date d’expiration facultative.
- **Lien d’achat** : URL libre (page de vente, tunnel…) proposée sur la fiche de la formation aux visiteurs et aux contacts sans accès.

L’onglet **Élèves** liste les contacts ayant accès, leur progression, et permet de modifier les dates ou de retirer l’accès. La fiche d’un contact affiche « accès donné », « leçon terminée » et « formation terminée » ; le déclencheur d’automatisation **Formation terminée** permet d’enchaîner (tag « diplômé », campagne, webhook…).

## Espace membres

Vos membres se connectent sur `PUBLIC_URL/m/<adresse>` (Formations → Espace membres pour le nom, l’adresse, le logo et la couleur). Pas de mot de passe : ils saisissent leur email et reçoivent un **lien de connexion** valable 20 minutes et utilisable une seule fois. Ajoutez l’adresse de l’espace dans l’email envoyé après l’achat (par exemple une campagne déclenchée par le tag d’accès).

- La page affichée est la même que l’adresse soit connue ou non, et le nombre de demandes est limité (10 / 15 min par IP, 3 emails / 15 min par adresse).
- Le lien ouvre d’abord une page avec un bouton : les antivirus et scanners de messagerie qui ouvrent les liens ne consomment pas le lien.
- Sans SMTP configuré (mode dev), l’email est visible dans Emails → Envois.
- Les pages, vidéos et fichiers des leçons ne sont servis qu’aux membres ayant accès ; les fichiers de leçon sont stockés dans `UPLOAD_DIR/_courses/` et ne sont jamais accessibles par `/uploads/…`. Pensez à sauvegarder ce dossier avec le reste de `UPLOAD_DIR`.
- En dev, le proxy Vite transmet `/m/` à l’API ; en production, rien à faire si l’API sert aussi le front (image Docker) ; sinon ajoutez `/m/*` aux chemins envoyés à l’API par votre reverse proxy (voir l’exemple Caddy dans [Tunnels](funnels.md#domaines-personnalisés)).

Limites actuelles : l’espace membres est servi sur le domaine de l’application (pas sur les domaines personnalisés des tunnels) ; les images insérées dans une leçon viennent de la médiathèque, dont les URL (non devinables) restent publiques ; une vidéo hébergée ailleurs (YouTube, Vimeo, fichier) est protégée par son hébergeur, l’application ne masque que son adresse aux non-membres ; l’accès par tag n’apparaît dans la fiche du contact que sous la forme de l’événement « tag ajouté ».
