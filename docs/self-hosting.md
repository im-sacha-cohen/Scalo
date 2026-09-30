[← Retour au README](../README.md)

# Auto-hébergement avec Docker

Une instance complète tient en trois conteneurs, décrits dans [`docker-compose.prod.yml`](../docker-compose.prod.yml) :

| Service | Rôle | Données persistantes (volumes) |
|---|---|---|
| `app` | l’API, le worker d’envoi et l’application web compilée, dans un seul processus (image construite depuis le [`Dockerfile`](../Dockerfile), utilisateur non root) | `uploads` : médiathèque et fichiers de leçon |
| `db` | PostgreSQL 16 | `pgdata` |
| `caddy` | HTTPS automatique (Let’s Encrypt) pour votre domaine, certificats à la demande pour les domaines personnalisés, en-têtes de sécurité | `caddy_data`, `caddy_config` : certificats |

Seul `caddy` est exposé (ports 80 et 443). L’application n’est joignable qu’à travers lui, la base uniquement depuis le réseau interne.

## Prérequis

- Un serveur Linux avec Docker Engine et le plugin Compose v2 (testé avec Compose 2.31). 1 vCPU et 1 Go de mémoire suffisent pour démarrer.
- Un nom de domaine (par exemple `app.exemple.fr`) dont l’enregistrement DNS `A` / `AAAA` pointe vers le serveur.
- Les ports 80 et 443 ouverts (443/udp en plus pour HTTP/3).

## Installation

```bash
git clone https://github.com/im-sacha-cohen/Scalo.git scalo && cd scalo
cp .env.example .env
./scripts/generate-secrets.sh --write        # génère JWT_SECRET, ENCRYPTION_KEY et POSTGRES_PASSWORD dans .env
# puis, dans .env :  SCALO_DOMAIN=app.exemple.fr
docker compose -f docker-compose.prod.yml up -d
```

Trois valeurs sont à renseigner dans `.env` : `SCALO_DOMAIN`, `JWT_SECRET` et `POSTGRES_PASSWORD` (le script remplit les deux dernières, plus `ENCRYPTION_KEY` ; sans lui : `openssl rand -hex 48`). Le reste est fixé par le fichier compose : `DATABASE_URL`, `PUBLIC_URL` (`https://SCALO_DOMAIN`), `TRUST_PROXY=1`, `UPLOAD_DIR`, `AUTO_MIGRATE=true`. Toutes les autres variables de `.env` sont transmises à l’application (voir [Configuration](configuration.md)).

Le premier démarrage construit l’image (quelques minutes), crée la base, applique les migrations et obtient le certificat. Vérifiez :

```bash
docker compose -f docker-compose.prod.yml ps          # app et db : « healthy »
curl https://app.exemple.fr/api/health                # {"ok":true,"db":"up"}
docker compose -f docker-compose.prod.yml logs -f app
```

### Créer votre compte, puis fermer les inscriptions

Ouvrez `https://app.exemple.fr/register` et créez votre compte. Il n’y a pas de compte par défaut ni de mot de passe initial.

Tant que `ALLOW_SIGNUPS` n’est pas défini, n’importe qui peut créer un compte sur votre instance. Pour une instance personnelle, ajoutez dans `.env` :

```
ALLOW_SIGNUPS=false
```

puis `docker compose -f docker-compose.prod.yml up -d`. Les inscriptions publiques sont alors refusées dès qu’un compte existe. Vous pouvez mettre cette ligne dès l’installation : le tout premier compte d’une instance vide peut toujours être créé — créez-le donc sans attendre après le premier démarrage.

### Envoi des emails

L’instance n’envoie rien tant qu’un serveur SMTP n’est pas configuré dans **Paramètres** (par compte). Sans SMTP, les emails restent visibles dans Emails → Suivi des envois. Voir [Emails et délivrabilité](emails.md) pour SPF, DKIM, DMARC et les webhooks de plaintes.

### Domaines personnalisés des tunnels

Rien à configurer côté serveur. L’utilisateur ajoute son domaine dans la fiche du tunnel et crée un `CNAME` vers `SCALO_DOMAIN` (ou la valeur de `CUSTOM_DOMAIN_TARGET`). À la première visite, Caddy demande à l’application si le domaine est vérifié (`GET /api/domains/allowed`) et n’obtient un certificat que dans ce cas : un nom de domaine quelconque pointé vers votre serveur ne déclenche aucune émission de certificat et ne reçoit jamais l’application. Détails : [Tunnels → Domaines personnalisés](funnels.md#domaines-personnalisés).

## Sauvegarde et restauration

```bash
./scripts/backup.sh                 # → backups/scalo-<date UTC>/db.dump + uploads.tar.gz
./scripts/backup.sh /mnt/sauvegardes
./scripts/restore.sh backups/scalo-20260930-072850
```

- `backup.sh` fait un `pg_dump` (format personnalisé) et une archive du volume des fichiers, sans arrêter l’instance, puis vérifie que les deux fichiers sont lisibles. Planifiez-le (cron) et copiez le dossier hors du serveur.
- `restore.sh` **remplace** la base et les fichiers par ceux de la sauvegarde : il arrête l’application, recrée la base, restaure, puis redémarre (les migrations manquantes sont appliquées au démarrage). Il demande une confirmation (`--yes` pour l’éviter).
- Conservez aussi une copie de `.env` en lieu sûr : sans `JWT_SECRET` / `ENCRYPTION_KEY`, les clés (Stripe, IA) stockées chiffrées en base sont illisibles et devront être saisies à nouveau.

Les scripts utilisent le projet Compose par défaut ; les variables standard `COMPOSE_FILE`, `COMPOSE_PROJECT_NAME` et `COMPOSE_ENV_FILES` permettent d’en viser un autre.

## Mise à jour

```bash
./scripts/backup.sh
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

L’image est reconstruite, l’application redémarre et applique les migrations en attente (sous verrou en base). Lisez les notes de version avant une mise à jour majeure. Pour revenir en arrière : `git checkout <version précédente>`, puis `./scripts/restore.sh <sauvegarde>` — une base migrée n’est pas garantie compatible avec une version antérieure du code.

Pour appliquer les migrations dans une étape séparée plutôt qu’au démarrage, mettez `AUTO_MIGRATE=false` dans `.env`, puis :

```bash
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml run --rm app node --import tsx src/migrate-cli.ts latest
docker compose -f docker-compose.prod.yml up -d
```

(`… src/migrate-cli.ts status` liste les migrations appliquées.)

## Variantes

**Essai en local.** `SCALO_DOMAIN=localhost`, `SCALO_HTTP_PORT=8080`, `SCALO_HTTPS_PORT=8443` dans `.env` : Caddy sert `https://localhost:8443` avec un certificat auto-signé (avertissement du navigateur attendu).

**Reverse proxy existant (Nginx, Traefik, load balancer).** N’utilisez pas le service `caddy` : démarrez `app` et `db` seulement, publiez le port 4000 de `app` sur l’interface locale avec un fichier `docker-compose.override.yml`, et faites suivre tout le trafic vers ce port en transmettant l’en-tête `Host` d’origine (exemples dans [Tunnels](funnels.md#domaines-personnalisés)). Définissez `SCALO_PUBLIC_URL` si l’URL publique n’est pas `https://SCALO_DOMAIN`.

```yaml
# docker-compose.override.yml
services:
  app:
    ports: ["127.0.0.1:4000:4000"]
```

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.override.yml up -d app db
```

**PostgreSQL hébergé.** Remplacez `DATABASE_URL` du service `app` dans un fichier d’override et ne démarrez pas `db` (voir [Configuration](configuration.md#postgresql-hébergé-supabase-neon-rds-scaleway)).

**Image sans l’édition Entreprise.** Le dossier `ee/` est inclus dans l’image s’il est présent et reste inactif sans clé de licence. Pour une image strictement AGPL, supprimez `ee/` avant `docker compose build`, ou définissez `SCALO_DISABLE_EE=1` dans `.env` (côté API).

**Sans Docker.** `npm ci && npm run build`, puis `NODE_ENV=production AUTO_MIGRATE=true npm start -w api` derrière votre reverse proxy : l’API sert `web/dist` d’elle-même en production (`WEB_DIST`).

## Sécurité : ce que fait la configuration fournie

- HTTPS partout, redirection HTTP → HTTPS, `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy` par défaut ; l’écran de consentement OAuth n’est pas encadrable (`X-Frame-Options: DENY`).
- `TRUST_PROXY=1` : l’application voit l’adresse réelle du visiteur (limites anti-brute-force par IP) et ne fait confiance qu’au proxy placé devant elle. Ne publiez pas le port 4000 sur Internet.
- `NODE_ENV=production` : l’application refuse de démarrer avec un `JWT_SECRET` faible ou par défaut.
- Un hôte inconnu reçoit une page 404, jamais l’application ni l’API.
- Les fichiers statiques du front sont servis avec un cache long uniquement pour les fichiers au nom haché (`/assets/*`) ; `index.html` est toujours revalidé.

## Limites

- Une seule instance applicative : le worker d’envoi tourne dans le même processus que l’API. Les fichiers sont sur un volume local (pas de stockage objet).
- Les sauvegardes ne sont ni chiffrées ni envoyées hors du serveur par les scripts : à vous de le faire.
- Le mot de passe PostgreSQL est fixé à la création du volume `pgdata` ; le changer ensuite dans `.env` ne le change pas dans la base (`ALTER USER scalo PASSWORD …` d’abord).
