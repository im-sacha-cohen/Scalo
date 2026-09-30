[← Retour au README](../README.md)

# Automatisations et CRM

## Champs personnalisés
- **Contacts → Champs personnalisés** : texte, nombre, date, liste de choix, case à cocher. La **clé** (ex. `entreprise`) est stable : elle sert dans l’import CSV, l’API et les emails (`{{field.entreprise}}`, aussi dans le menu « Variable » des éditeurs). Le type et la clé ne changent plus après création ; supprimer un champ efface ses valeurs.
- Fiche contact : carte « Champs personnalisés ». Import CSV : les colonnes sont reconnues par clé ou par libellé (une cellule vide ne remplace rien, une valeur invalide est ignorée et comptée). Export : une colonne par champ.
- Formulaires de tunnel (éditeur → bloc Formulaire) : ajoutez un champ personnalisé comme n’importe quel champ ; ses options de liste sont copiées dans le formulaire (réajoutez le champ si vous modifiez ensuite les options).

## Segments et filtres
- **Contacts → Filtres** : conditions combinées en ET / OU (avec groupes) sur les tags, les champs (dont email / prénom / nom / téléphone), le statut, la date d’ajout, l’activité email des N derniers jours, l’inscription via un tunnel, les campagnes et les achats. **Enregistrer comme segment** ; onglet **Segments** avec le nombre de contacts correspondant (recalculé à chaque affichage).
- Une **newsletter** peut cibler un segment (Paramètres d’envoi → Destinataires, combiné au tag) : la liste est calculée au moment du départ. Un segment utilisé par une newsletter non envoyée ne peut pas être supprimé.

## Actions groupées
Cochez des contacts (ou **Sélectionner les N contacts correspondants** pour toute la liste filtrée), puis **Actions** : ajouter / retirer un tag, inscrire à / retirer d’une campagne, définir un champ, désinscrire, supprimer (confirmation). Les effets habituels s’appliquent (un tag peut inscrire à une campagne, historique, automatisations). Traitement par lots de 200 contacts (une transaction par lot), 100 000 contacts max par action.

## Automatisations
- Menu **Automatisations** : *quand* (inscription via un formulaire, nouveau contact, tag ajouté / retiré, clic sur un lien d’email, achat, campagne terminée, webhook entrant) → *si* (conditions facultatives : même constructeur que les segments) → *alors* (tag, campagne, champ, désinscription, webhook sortant, attente de N minutes / heures / jours). Les actions s’exécutent en arrière-plan quelques secondes après le déclencheur ; **Journal** détaillé par exécution et par action.
- **Webhook entrant** : chaque automatisation « Webhook entrant » a une URL secrète (`/api/hooks/automations/hk_…`, régénérable) : `POST` JSON ou formulaire avec `email` (+ `first_name`, `fields`, `product`, `amount`…) → contact créé ou mis à jour, achat enregistré si `product`, actions exécutées. 60 appels / minute par automatisation. En dev, le proxy Vite transmet `/api`.
- **Webhook sortant** : `POST` JSON signé (`X-Scalo-Signature: t=…,v1=HMAC-SHA256(secret, "t.corps")`, secret affiché dans l’automatisation). HTTPS uniquement ; les adresses privées / locales (après résolution DNS) sont refusées, délai 5 s, pas de redirection. En cas d’interruption du serveur pendant l’appel, il peut être rejoué avec le même `X-Scalo-Delivery` : dédoublonnez sur cet en-tête.
- **Achats** : chaque commande payée dans un tunnel (voir [Paiements](payments.md)) enregistre un achat par produit ; les ventes faites avec un autre outil s’enregistrent via `POST /api/v1/purchases` (scope `purchases:write`) ou un webhook entrant.
- Sécurité anti-boucle : une automatisation ne se redéclenche pas elle-même pour le même contact dans une même chaîne ; une chaîne s’arrête après 5 automatisations. Les attentes et exécutions interrompues reprennent au redémarrage sans rejouer les actions déjà faites. La règle historique « tag déclencheur → campagne » continue de fonctionner.
