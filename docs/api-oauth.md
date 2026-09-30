[← Retour au README](../README.md)

# Fournisseur OAuth 2.0 (applications tierces)

L’application est un **serveur d’autorisation OAuth 2.0** : des applications tierces (intégrations type Zapier, scripts, partenaires) obtiennent un accès **délégué** au compte d’un utilisateur, avec son consentement, sans jamais connaître son mot de passe. (La connexion « avec Google / GitHub » n’existe pas : on se connecte à scalo par email + mot de passe.)

## Concepts

- **Application (client)** : enregistrée par un utilisateur dans **Développeurs** (menu du compte, ou Paramètres → Développeurs). Elle reçoit un `client_id` (`scalo_app_…`) et, si elle est **confidentielle** (serveur), un `client_secret` (`scalo_cs_…`, affiché une seule fois, stocké haché, régénérable). Une application **publique** (SPA, mobile, CLI) n’a pas de secret et doit utiliser PKCE.
- **URL de redirection** : liste enregistrée, **comparaison exacte**. `https://` obligatoire (`http://localhost` / `127.0.0.1` acceptés pour le dev), pas de fragment ni de joker, schémas personnalisés autorisés pour les apps natives (`com.exemple.app:/callback`).
- **Scopes** : ce que l’application peut faire, validés par l’utilisateur sur l’écran de consentement.

| Scope | Accès |
|---|---|
| `profile` | nom et email du compte (`GET /api/v1/me`) |
| `contacts:read` | lire les contacts, leurs tags, la liste des tags |
| `contacts:write` | créer (upsert par email), modifier, supprimer des contacts |
| `tags:write` | ajouter / retirer des tags (déclenche les campagnes liées au tag) |
| `funnels:read` | tunnels, étapes et statistiques |
| `emails:read` | newsletters et campagnes + statistiques |
| `campaigns:write` | inscrire un contact à une campagne |
| `purchases:write` | enregistrer un achat (`POST /api/v1/purchases`, déclenche les automatisations « Achat ») ; créer le contact s’il n’existe pas demande aussi `contacts:write` |
| `sales:read` | lire les produits, leurs offres et les commandes (`GET /api/v1/products`, `/api/v1/orders`) |
| `offline_access` | obtenir un refresh token (sinon : jeton d’accès seul, 1 h) |

## Endpoints

| Endpoint | Rôle |
|---|---|
| `GET /.well-known/oauth-authorization-server` | métadonnées (RFC 8414) |
| `GET /oauth/authorize` | demande d’autorisation (`response_type=code`, `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge` + `code_challenge_method=S256`, `prompt=consent` optionnel) → écran de consentement `/oauth/consent` |
| `POST /oauth/token` | `grant_type=authorization_code` (code + `redirect_uri` + `code_verifier`) ou `refresh_token` (`scope` plus restreint possible). Authentification : `client_secret_basic`, `client_secret_post`, ou `client_id` seul (public) |
| `POST /oauth/revoke` | révocation (RFC 7009) ; un refresh token révoque toute l’autorisation |
| `POST /oauth/introspect` | introspection (RFC 7662), applications confidentielles, leurs propres jetons uniquement |
| `/api/v1/*` | API publique, `Authorization: Bearer scalo_at_…` (voir [SPEC.md](../SPEC.md#api-publique-v1)) |

Pas de flux *implicit* ni *password* ni *client_credentials*. En dev, le proxy Vite transmet `/oauth/authorize|token|revoke|introspect` et `/.well-known/` à l’API ; `/oauth/consent` reste une page du front.

## Exemple (curl)

```bash
# 1. PKCE : code_verifier aléatoire + challenge S256
VERIFIER=$(openssl rand -base64 48 | tr -d '=+/\n' | cut -c1-64)
CHALLENGE=$(printf %s "$VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')

# 2. Ouvrir dans le navigateur (l'utilisateur se connecte et clique « Autoriser »)
echo "http://localhost:5173/oauth/authorize?response_type=code&client_id=$CLIENT_ID\
&redirect_uri=http%3A%2F%2Flocalhost%3A5173%2Foauth%2Ftest-callback&scope=profile%20contacts%3Aread%20offline_access\
&state=xyz123&code_challenge=$CHALLENGE&code_challenge_method=S256"
# → http://localhost:5173/oauth/test-callback?code=scalo_ac_…&state=xyz123&iss=http%3A%2F%2Flocalhost%3A5173

# 3. Échanger le code (60 s, usage unique)
curl -X POST http://localhost:5173/oauth/token -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d grant_type=authorization_code -d code=$CODE \
  --data-urlencode redirect_uri=http://localhost:5173/oauth/test-callback -d code_verifier=$VERIFIER
# {"access_token":"scalo_at_…","token_type":"Bearer","expires_in":3600,"refresh_token":"scalo_rt_…","scope":"profile contacts:read offline_access"}

# 4. Appeler l'API
curl "http://localhost:5173/api/v1/contacts?limit=10" -H "Authorization: Bearer $ACCESS_TOKEN"

# 5. Rafraîchir (rotation : gardez le NOUVEAU refresh_token), puis révoquer
curl -X POST http://localhost:5173/oauth/token -u "$CLIENT_ID:$CLIENT_SECRET" -d grant_type=refresh_token -d refresh_token=$REFRESH_TOKEN
curl -X POST http://localhost:5173/oauth/revoke -u "$CLIENT_ID:$CLIENT_SECRET" -d token=$REFRESH_TOKEN
```

La page **Développeurs → (application) → Tester le flux** génère l’URL d’autorisation (state, PKCE) et ces commandes pré-remplies. En dev, l’URL de redirection `http://localhost:5173/oauth/test-callback` affiche le code reçu (page absente du build de production).

## Côté utilisateur

**Paramètres → Applications connectées** : applications autorisées (scopes, date, dernière utilisation) et **Révoquer l’accès** (tous les jetons invalidés immédiatement, consentement oublié). Le consentement est mémorisé par (utilisateur, application) : une nouvelle demande avec les mêmes scopes (ou moins) ne réaffiche pas l’écran, sauf `prompt=consent`. Supprimer une application révoque tous ses jetons ; retirer un scope à une application s’applique aussitôt aux jetons existants.

## Sécurité (RFC 9700)

- Jetons opaques aléatoires (32 octets) préfixés (`scalo_at_`, `scalo_rt_`, `scalo_ac_`, `scalo_cs_`, `scalo_ar_` — faciles à détecter en cas de fuite), **stockés en SHA-256** uniquement ; secret client comparé en temps constant.
- Accès 1 h ; refresh 30 jours glissants avec **rotation** : présenter un refresh token déjà utilisé révoque toute la famille (vol détecté). Code 60 s, usage unique, lié au client, à la `redirect_uri`, au challenge PKCE, à l’utilisateur et aux scopes ; rejouer un code révoque les jetons émis avec lui.
- `client_id` et `redirect_uri` validés **avant** toute redirection : sinon page d’erreur, jamais de redirection vers une URL non enregistrée. Les autres erreurs reviennent à l’application avec `error`, `state` et `iss` (RFC 9207). Aucun jeton dans une URL (sauf le code).
- PKCE S256 obligatoire pour les applications publiques (méthode `plain` refusée) ; `code_verifier` envoyé sans challenge → refusé.
- Écran de consentement non encadrable : l’API envoie `X-Frame-Options: DENY` + `frame-ancestors 'none'` sur ses pages ; le serveur Vite (dev / preview) les ajoute sur `/oauth/consent`, et l’API fait de même quand elle sert le front compilé (`WEB_DIST`, cas de l’image Docker) ; **si un autre serveur sert le front, configurez-les sur ce serveur** (au moins pour `/oauth/consent`) ; la page refuse aussi de s’afficher dans un cadre.
- L’API de consentement (`POST /api/oauth/consent`) s’authentifie par l’en-tête `Authorization` (pas de cookie) : pas de CSRF possible.
- CORS `*` sans cookies sur `/oauth/token`, `/oauth/revoke`, `/.well-known/…` et `/api/v1` (applications web publiques).
- Limites (compteurs en base) : 60 appels / min par client et IP sur `/oauth/token` et `/oauth/revoke`, 300 / min sur `/oauth/introspect`, 120 requêtes / min par autorisation (application + compte) sur `/api/v1` (en-têtes `X-RateLimit-Limit/Remaining/Reset`, `429` + `Retry-After`).
- Nettoyage toutes les 15 min : demandes expirées (> 1 h), codes et jetons expirés depuis plus d’un jour.

## Mise à jour d’une base existante

La migration `0004_oauth_provider` supprime les tables de l’ancienne connexion Google/GitHub (`user_identities`, `auth_login_codes`, `auth_link_tickets`) et remet `users.password_hash` en `NOT NULL`. Elle **refuse de s’appliquer** s’il reste des comptes sans mot de passe (créés via Google/GitHub) : supprimez-les (`DELETE FROM users WHERE password_hash IS NULL;`) ou recréez la base puis `npm run seed`. `npm run migrate:down` revient à l’état précédent (tables recréées vides).

## Protection anti-brute-force

Compteurs en base (`auth_attempts`, fenêtres fixes de 15 min, mise à jour atomique) : les limites valent pour toutes les instances de l'API.

| Action | Limite | Réponse |
|---|---|---|
| `POST /api/auth/login` | 5 échecs par email **et** 20 échecs par IP | `429` + `Retry-After` (secondes) + message en français. Une connexion réussie remet à zéro le compteur de l'email (et ne compte pas pour l'IP) |
| `POST /api/auth/register` | 20 inscriptions par IP | idem |
| Mot de passe d'une étape protégée (`POST /p/…/unlock`) | 10 essais par IP et par étape | page « Trop de tentatives » (429) |

Pendant un blocage, même le bon mot de passe est refusé jusqu'à la fin de la fenêtre. Derrière un proxy, configurez `TRUST_PROXY`, sinon toutes les requêtes semblent venir de l'IP du proxy. Les compteurs expirés sont purgés toutes les 15 min. Limites du fournisseur OAuth et de l’API publique : voir « Sécurité (RFC 9700) » ci-dessus.
