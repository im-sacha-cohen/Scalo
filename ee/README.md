# Scalo — édition Entreprise (`ee/`)

> **Licence.** Le contenu de ce dossier est publié sous la [licence Entreprise Scalo](LICENSE) (code visible,
> **non libre**) : vous pouvez le lire et le modifier pour le développement et les tests, mais son usage en
> production exige un abonnement et une clé de licence valide. Tout le reste du dépôt est sous **AGPL-3.0**.

Modèle « open core » : le cœur (tunnels, emails, contacts, automatisations, API…) est libre et **n’est jamais
bridé** — pas de limite de contacts, d’emails ou de tunnels. Ce dossier ne contient que des fonctions d’équipe et
d’agence.

| Fonction (clé de licence) | Ce qu’elle apporte |
|---|---|
| Équipe et rôles (`team`) | Inviter des collaborateurs sur un compte — administrateur, éditeur, lecture seule — chacun avec son email et son mot de passe ; permissions appliquées par l’API |
| Journal d’audit (`audit_log`) | Qui a fait quoi (auteur, action, ressource, IP, date) sur les modifications du compte ; consultation, export CSV, durée de conservation réglable |
| Marque blanche (`white_label`) | Retirer ou remplacer « Propulsé par Scalo » sur les pages publiques et les emails ; nom et logo personnalisés dans l’interface |

## Structure

```
ee/
  LICENSE                   licence commerciale (BROUILLON, à faire relire par un juriste)
  package.json              marqueur ESM (« type: module ») — ce n’est PAS un workspace npm
  shared/types.ts           types de l’API Entreprise (partagés api / web)
  api/src/index.ts          point d’entrée API : register() → routes, hooks (chargé par api/src/ee.ts)
  api/src/license/          format des clés (Ed25519), clés publiques, service license.has()
  api/src/team.ts           invitations, membres, résolution « acteur → compte »
  api/src/audit.ts          enregistrement, consultation, export CSV, rétention
  api/src/branding.ts       marque blanche
  api/test/                 tests d’intégration (npm run test:ee)
  web/src/index.tsx         point d’entrée web : routes, sections des paramètres, bandeau (chargé par web/src/lib/ee.ts)
  scripts/issue-license.ts  émission des clés (réservé à Scalo)
```

Ce sont de simples dossiers importés en source TypeScript (comme `shared/`) : pas de build, pas de dépendance npm
supplémentaire. Les paquets (`express`, `react`…) sont résolus dans le `node_modules` de la racine.

### Comment le cœur charge `ee/`

Le cœur ne contient **aucun import statique** vers `ee/`. Deux registres, et eux seuls, connaissent le dossier :

- **API** — `api/src/ee.ts` : `loadEe()` fait un `import()` dynamique de `ee/api/src/index.ts` **s’il existe**, et
  appelle `register()`, qui renvoie un objet `EeApi` (résolution de l’acteur, routes publiques et authentifiées,
  hook d’audit, mention « Propulsé par », état de l’édition, ménage périodique). Sans le dossier, chaque hook est
  un no-op.
- **Web** — `web/src/lib/ee.ts` : `import.meta.glob('../../../ee/web/src/index.tsx')` (objet vide si le dossier
  n’existe pas). Le module exporte `publicRoutes`, `settingsSections` et `Banner`. (`web/src/index.css` déclare
  aussi le dossier comme source Tailwind, sans effet s’il est absent.)

Les mécanismes neutres restent dans le cœur : `req.userId` / `req.actorId` / `req.role` et la règle de permissions
par méthode HTTP (`api/src/access.ts`), `GET /api/edition`, la mention « Propulsé par Scalo »
(`api/src/services/branding.ts`), les tables (migration `0011_ee`, schéma unique pour toutes les éditions).

**Le cœur compile, passe ses tests et tourne sans ce dossier** :

```bash
npm run check:core                 # copie le dépôt SANS ee/ dans un dossier temporaire : typecheck api + web, puis tests
SCALO_DISABLE_EE=1 npm run dev     # ignore ee/ sans le supprimer (VITE_SCALO_DISABLE_EE=1 côté web)
```

`api/test/editions.test.ts` (suite du cœur) vérifie l’édition communautaire et qu’aucun fichier du cœur ne
référence `ee/` en dehors des registres.

## Clés de licence

Un jeton signé **Ed25519**, vérifié **hors ligne** (aucun appel réseau, aucune donnée envoyée à Scalo) :

```
scalo_lic_<base64url(JSON)>.<base64url(signature)>
```

La signature porte sur `scalo-license-v1:` + le segment base64url du contenu. Contenu :

```json
{ "v": 1, "id": "lic_9f2c…", "customer": "Agence Dupont", "plan": "enterprise",
  "features": ["team", "audit_log", "white_label"], "seats": 10,
  "issued_at": "2026-09-30T08:00:00.000Z", "expires_at": "2027-09-30T08:00:00.000Z" }
```

- `seats` : nombre de personnes **par compte**, propriétaire compris (membres + invitations en attente).
- La clé est fournie par la variable **`SCALO_LICENSE_KEY`** (prioritaire), ou saisie dans **Paramètres → Licence**
  par l’administrateur de l’instance (le propriétaire du premier compte créé). Une clé invalide n’est jamais
  enregistrée.
- Service : `license.has('team')` (synchrone, en mémoire ; la clé saisie dans l’interface est relue toutes les
  minutes pour les autres instances de l’API).

| État | Quand | Effet |
|---|---|---|
| `none` | aucune clé | édition communautaire ; les écrans Entreprise affichent « Fonction de l’édition Entreprise » |
| `valid` | clé signée, non expirée | fonctions de la clé actives ; bandeau discret 14 jours avant l’expiration (propriétaire et administrateurs) |
| `grace` | expirée depuis moins de **14 jours** | fonctions toujours actives, bandeau |
| `expired` | expirée depuis plus de 14 jours | fonctions Entreprise désactivées, bandeau |
| `invalid` | clé mal formée, modifiée, ou signée par une autre clé | fonctions désactivées, message dans Paramètres → Licence |

**Jamais de blocage des données ni du cœur** : sans licence valide, le propriétaire garde l’accès complet à son
compte ; les collaborateurs ne peuvent plus se connecter (403 explicite) mais peuvent être retirés ; le journal
d’audit n’est plus alimenté mais reste exportable ; la mention « Propulsé par Scalo » réapparaît ; les réglages de
marque blanche sont conservés pour le retour de la licence.

### Émettre une clé (réservé à Scalo)

```bash
# 1. Une fois : générer la paire de clés. La clé privée est écrite HORS du dépôt (le script refuse un chemin dans le dépôt).
npm run ee:license -- keygen --out ~/.scalo/license-private-key.pem
#    → affiche la clé publique (43 caractères) à coller dans PRODUCTION_PUBLIC_KEYS (ee/api/src/license/keys.ts)

# 2. Signer une licence
npm run ee:license -- issue --private-key ~/.scalo/license-private-key.pem \
    --customer "Agence Dupont" --plan enterprise --seats 10 --days 365 \
    --features team,audit_log,white_label
#    → la clé est écrite sur la sortie standard (le détail sur la sortie d’erreur)

# 3. Vérifier une clé
npm run ee:license -- verify scalo_lic_… [--public-key <clé publique>]
```

> **TODO avant la première vente** : `PRODUCTION_PUBLIC_KEYS` est **vide** (emplacement à remplir). Tant qu’il
> l’est, aucune clé n’est valide en production. La clé privée ne doit jamais entrer dans le dépôt (gestionnaire de
> secrets / KMS) ; `ee/.gitignore` écarte `*.pem` par précaution. Plusieurs clés publiques peuvent coexister
> (rotation).

Hors production (`NODE_ENV` ≠ `production`), `SCALO_LICENSE_PUBLIC_KEY` ajoute une clé publique de développement
pour essayer une licence émise localement ; elle est **ignorée en production**. Les tests génèrent une paire à la
volée (`ee/api/test/ee-helpers.ts`).

## Équipe et rôles

Un membre est une ligne `users` ordinaire (son email, son mot de passe) rattachée à **un** compte par
`account_members`. À chaque requête, `requireAuth` demande à l’extension pour quel compte la personne agit :
`req.userId` = le compte (toutes les données restent isolées par compte, sans rien changer aux routes),
`req.actorId` = la personne, `req.role` = son rôle. La règle de permissions du cœur est **générique** (méthode HTTP
+ zone), pas une liste de routes : une route ajoutée demain est couverte par défaut.

| Rôle | Peut |
|---|---|
| Propriétaire | tout (c’est le compte lui-même ; seul à pouvoir gérer les administrateurs, la licence, la suppression du compte) |
| Administrateur | tout sauf ce qui est réservé au propriétaire : paramètres, équipe (éditeurs et lecteurs), journal d’audit, marque blanche, applications |
| Éditeur | créer et modifier tunnels, emails, contacts, automatisations… ; pas les paramètres, la facturation, l’équipe, le journal, les applications OAuth |
| Lecture seule | `GET` uniquement (plus quelques `POST` de pure lecture : recherche de contacts, aperçus) |

Invitation : lien `PUBLIC_URL/invite/<jeton>` à usage unique, valable 7 jours, dont seul le SHA-256 est stocké ;
envoyé par email via le SMTP du compte et affiché une fois à l’invitant. Une adresse qui a déjà un compte Scalo ne
peut pas être invitée (un membre appartient à un seul compte). Retirer un membre supprime son identifiant.

## API

Routes sous `/api` (session), ajoutées quand `ee/` est installé ; `402` = la fonction demande une licence.

| Méthode | Route | Rôle | Description |
|---|---|---|---|
| GET | /license | tous | état de la licence (`LicenseInfo`) |
| PUT / DELETE | /license | administrateur de l’instance | `{key}` — 400 clé refusée, 409 si fournie par `SCALO_LICENSE_KEY` |
| GET | /team | propriétaire, admin | propriétaire, membres, invitations, sièges |
| POST | /team/invitations | propriétaire, admin | `{email, role}` → 201 `{invitation, invite_url, email_sent}` ; 409 email déjà inscrit / sièges atteints |
| POST | /team/invitations/:id/resend | propriétaire, admin | nouveau lien (l’ancien est invalidé) |
| DELETE | /team/invitations/:id | propriétaire, admin | annule l’invitation |
| PATCH | /team/members/:id | propriétaire, admin | `{role}` |
| DELETE | /team/members/:id | propriétaire, admin | retire le membre et son identifiant |
| GET | /invitations/:token | public | `{email, role, account_name, expires_at}` ; 404 inconnue, expirée ou utilisée |
| POST | /invitations/:token/accept | public | `{name, password (min 8)}` → 201 `{token, user}` ; limité par IP |
| GET | /audit | propriétaire, admin | `?page&limit&search&actor_id&from&to` → `{items, total, retention_days}` |
| GET | /audit/export | propriétaire, admin | CSV (mêmes filtres) |
| PUT | /audit/settings | propriétaire, admin | `{retention_days}` (1–3650, défaut 365) |
| GET | /branding | tous | réglages de marque blanche + `active` |
| PUT | /branding | propriétaire, admin | `{hide_powered_by, powered_by_text, powered_by_url, app_name, logo_url}` |

## Tests

```bash
TEST_DATABASE_URL=… npm test           # suite du cœur (dont l’édition communautaire)
TEST_DATABASE_URL=… npm run test:ee    # licence, équipe, permissions, isolation, audit, marque blanche
npm run typecheck:ee                   # tsc -p ee/api && tsc -p ee/web
npm run check:core                     # le cœur sans ee/
```

## Prochaines étapes (non réalisées)

- **SSO / SAML / OIDC** : connexion des membres via le fournisseur d’identité de l’entreprise (nouvelle fonction
  `sso`), provisionnement SCIM.
- **Sous-comptes d’agence** : un compte agence qui crée et administre des comptes clients, avec bascule d’un compte
  à l’autre, modèles partagés et marque blanche par client (nouvelle fonction `agency`). Demande de lever la règle
  « un membre = un compte ».
- Inviter une personne qui a déjà un compte Scalo (choix du compte à la connexion).
- Journal d’audit : connexions et échecs de connexion, détail des champs modifiés, envoi vers un SIEM.
- Révocation de licences (liste d’identifiants révoqués) et sièges au niveau de l’instance.
