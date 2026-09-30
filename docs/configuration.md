[← Retour au README](../README.md)

# Variables d'environnement

Lues depuis `.env` à la racine (les variables déjà définies dans l'environnement sont prioritaires). Voir `.env.example`. Avec Docker (`docker-compose.prod.yml`), `DATABASE_URL`, `PUBLIC_URL`, `API_PORT`, `TRUST_PROXY`, `UPLOAD_DIR` et `WEB_DIST` sont fixées par le fichier compose : voir [Auto-hébergement](self-hosting.md).

| Variable | Défaut | Description |
|---|---|---|
| `DATABASE_URL` | — (requis) | `postgres://user:pass@host:port/db` |
| `TEST_DATABASE_URL` | — (requis pour `npm test`) | base dédiée aux tests, créée automatiquement, **vidée à chaque exécution** (doit différer de `DATABASE_URL`) |
| `DATABASE_POOL_MAX` | `10` | taille max du pool de connexions |
| `DATABASE_SSL` | selon `sslmode` de l'URL | `true` pour forcer TLS (`?sslmode=verify-full` vérifie aussi le certificat) |
| `AUTO_MIGRATE` | `true` (hors production) | applique les migrations au démarrage de l'API |
| `ALLOW_SIGNUPS` | `true` | `false` : ferme les inscriptions publiques (`POST /api/auth/register` répond 403) dès qu’un compte existe ; le tout premier compte d’une instance vide peut toujours être créé. Les invitations d’équipe (édition Entreprise) ne sont pas concernées |
| `WEB_DIST` | `web/dist` si `NODE_ENV=production` | dossier du front compilé (`npm run build`) servi par l’API elle-même : fichiers statiques + `index.html` pour les routes de l’application. `false` : jamais (front servi par un autre serveur). Sans effet en développement, où Vite sert le front |
| `JWT_SECRET` | `change-me` | signe sessions, cookies contact, liens de désinscription et d'aperçu. **Obligatoire en production** (≥ 32 caractères aléatoires) |
| `API_PORT` | `4000` | port de l'API |
| `PUBLIC_URL` | `http://localhost:5173` | URL publique utilisée dans les emails (liens, images, tracking) ; c’est aussi l’**émetteur OAuth** (`iss`) et la base des endpoints `/oauth/*` |
| `UPLOAD_DIR` | `api/uploads` | dossier des images de la médiathèque (et, dans `_courses/`, des fichiers de leçon, jamais servis publiquement) |
| `TRUST_PROXY` | désactivé | derrière un reverse proxy / load balancer : nombre de proxys (`1`), `true`, ou adresses/sous-réseaux (`loopback`, `10.0.0.0/8`). Sert à obtenir la vraie IP client (`req.ip`) pour les limites anti-brute-force. Ne l'activez pas si l'API est exposée directement (l'en-tête `X-Forwarded-For` serait falsifiable) |
| `NODE_ENV` | `development` | `production` : secret JWT vérifié, `AUTO_MIGRATE` désactivé par défaut, `--reset` refusé |
| `APP_HOSTS` | — | autres noms d’hôte de l’application elle-même, séparés par des virgules (ex. `api.scalo.fr`). Tout hôte qui n’est ni celui de `PUBLIC_URL`, ni listé ici, ni `localhost` / une IP n’est servi que s’il s’agit d’un **domaine personnalisé vérifié** (voir [Domaines personnalisés](funnels.md#domaines-personnalisés)) |
| `CUSTOM_DOMAIN_TARGET` | hôte de `PUBLIC_URL` | cible du CNAME demandée aux utilisateurs pour leurs domaines personnalisés (ex. `pages.scalo.fr`) |
| `ANTHROPIC_API_KEY` | — | clé API Claude de l’instance (facultative : chaque compte peut enregistrer la sienne dans Paramètres → IA, voir [IA et serveur MCP](ai-mcp.md)) |
| `AI_MODEL` | `claude-opus-5-5` | modèle Claude utilisé par les fonctions IA |
| `AI_TIMEOUT_MS` | `180000` | délai maximal d’une génération |
| `AI_RATE_LIMIT_PER_HOUR` | `30` | appels IA par compte et par heure |
| `ENCRYPTION_KEY` | dérivée de `JWT_SECRET` | chiffre les secrets stockés en base (clés API et clés Stripe des comptes, AES-256-GCM). La changer rend les clés enregistrées illisibles : elles devront être saisies à nouveau |
| `SCALO_LICENSE_KEY` | — | clé de licence de l’édition Entreprise (facultative ; sinon Paramètres → Licence). Voir [Éditions](../README.md#éditions--communautaire-et-entreprise) |
| `SCALO_DISABLE_EE` | — | `1` : ignore le dossier `ee/` (édition communautaire), même s’il est présent |

## PostgreSQL hébergé (Supabase, Neon, RDS, Scaleway…)

1. Créez une base et récupérez sa chaîne de connexion.
2. `DATABASE_URL=postgres://user:pass@host:5432/scalo?sslmode=require` dans `.env` (ou dans l'environnement du serveur).
3. `npm run migrate` (ou démarrez l'API avec `AUTO_MIGRATE=true`), puis éventuellement `npm run seed`.

Le pool envoie `statement_timeout` (15 s) et `idle_in_transaction_session_timeout` comme paramètres de connexion. Si un pooler (PgBouncer, Supavisor…) répond `unsupported startup parameter`, utilisez la connexion directe / le mode *session*, ou ajoutez ces paramètres à `ignore_startup_parameters`.
