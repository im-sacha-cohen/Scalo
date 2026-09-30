[← Retour au README](../README.md)

# Tunnels : domaines personnalisés, tests A/B, statistiques, pixels, RGPD, partage

Tout se règle dans la fiche d’un tunnel (`/funnels/:id`), onglets **Étapes**, **Statistiques**, **Domaines**, **Suivi et RGPD**, **Partage**. Contrat d’API détaillé : [SPEC.md](../SPEC.md#croissance-des-tunnels-domaines-ab-statistiques-pixels-rgpd-partage).

## Domaines personnalisés

1. **Domaines** → saisir `offre.mondomaine.fr` (URL collée, majuscules, accents acceptés : normalisé en minuscules / punycode ; IP et domaine de l’application refusés ; un domaine n’appartient qu’à un seul tunnel, tous comptes confondus).
2. Chez le registraire : **CNAME** `offre.mondomaine.fr → <CUSTOM_DOMAIN_TARGET>` (sous-domaine) **ou**, pour un domaine racine / derrière un proxy (Cloudflare…), un **TXT** `_scalo.offre.mondomaine.fr = scalo-verify=<jeton>` plus un ALIAS / A vers le serveur.
3. **Vérifier** : statut *En attente* → *Vérifié* (ou *Erreur* avec l’explication). Une panne DNS lors d’une revérification ne coupe pas un domaine déjà vérifié.

Le tunnel est alors servi sur `https://offre.mondomaine.fr/` (étape choisie, par défaut la première) et `https://offre.mondomaine.fr/<étape>` ; formulaires, mots de passe, bandeau cookies et images de la médiathèque fonctionnent sur le domaine, `/p/<slug>` continue de fonctionner. Sur un domaine personnalisé, **rien d’autre** n’est servi (ni l’app, ni `/api`, ni un autre tunnel), et un hôte inconnu reçoit une page 404.

**Reverse proxy.** Avec l’installation Docker fournie (`docker-compose.prod.yml`), tout ce qui suit est déjà en place : voir [Auto-hébergement](self-hosting.md). Pour un autre montage : l’API doit recevoir l’en-tête `Host` d’origine (Caddy le transmet par défaut ; Nginx : `proxy_set_header Host $host;`). Avec `TRUST_PROXY`, Express lit `X-Forwarded-Host` : le proxy doit alors l’écraser (Caddy le fait ; Nginx : `proxy_set_header X-Forwarded-Host $host;`), sinon il serait falsifiable. Certificats TLS à la demande avec **Caddy**, limités aux domaines vérifiés grâce à `GET /api/domains/allowed?domain=…` (200 / 404) :

```caddyfile
{
  on_demand_tls {
    ask http://127.0.0.1:4000/api/domains/allowed
  }
}

app.scalo.fr {
  # le front (build Vite) servi par Caddy + l'API. Plus simple : laissez l'API servir le front (WEB_DIST, voir
  # docs/configuration.md) et remplacez ce bloc par un seul `reverse_proxy 127.0.0.1:4000`.
  @api path /api/* /p/* /t/* /u/* /c/* /m/* /a/* /uploads/* /oauth/authorize /oauth/token /oauth/revoke /oauth/introspect /.well-known/* /mcp
  reverse_proxy @api 127.0.0.1:4000
  root * /srv/scalo/web/dist
  try_files {path} /index.html
  file_server
}

# tous les autres domaines (domaines personnalisés) : certificat à la demande, tout vers l'API
https:// {
  tls {
    on_demand
  }
  reverse_proxy 127.0.0.1:4000
}
```

Avec **Nginx** (sans TLS à la demande : certificats gérés à part, ex. certbot par domaine, ou un proxy TLS en amont) :

```nginx
server {
  listen 443 ssl default_server;          # hôtes non listés ailleurs = domaines personnalisés
  ssl_certificate     /etc/ssl/scalo/$ssl_server_name.crt;
  ssl_certificate_key /etc/ssl/scalo/$ssl_server_name.key;
  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

## Tests A/B de pages

Sur une étape : **Nouvelle variante** (copie de la page), **Modifier** ouvre l’éditeur sur la variante (`?variant=<id>`, sélecteur « Original / Variante B » dans la barre du haut), poids du trafic par version, **Lancer le test**. Chaque visiteur est affecté une fois (cookie 90 jours) ; ses vues uniques et ses inscriptions sont attribuées à sa version (et c’est le formulaire de sa version — tag, campagne, double opt-in — qui s’applique). Résultats : visiteurs, optins, conversion, écart avec l’original et verdict prudent (test z à deux proportions, affiché seulement à partir de 100 visiteurs par version et 10 inscriptions). **Mettre en pause** : tout le monde voit l’original. **Déclarer gagnante** : son contenu remplace la page et le test se termine. L’aperçu propriétaire accepte `&variant=<id>`.

## Statistiques par source

Chaque visite enregistre l’attribution **au premier contact** du visiteur (paramètres `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term` de la première URL, sinon le site référent), conservée 30 jours dans un cookie du tunnel et reportée sur l’inscription et sur le contact (`contacts.source`, jamais écrasé). Onglet **Statistiques** : 7 / 30 / 90 jours / tout, par source, support, campagne, site référent ou variante A/B, avec le détail par étape. Exemple de lien : `https://offre.mondomaine.fr/?utm_source=facebook&utm_medium=cpc&utm_campaign=lancement`.

## Pixels et bandeau cookies

**Suivi et RGPD** : identifiants **Meta Pixel**, **Google Analytics 4** (`G-…`) et **Google Tag Manager** (`GTM-…`), validés strictement ; le serveur génère le code officiel (`PageView` sur toutes les pages, `Lead` / `generate_lead` sur la page qui suit une inscription). Le **code de suivi** libre de la page (`headCode`) est inchangé. Avec le **bandeau cookies** activé, aucun code de suivi n’est chargé avant « Accepter » ; « Refuser » est aussi visible qu’« Accepter », le choix est gardé 6 mois (cookie par tunnel), et le bandeau fonctionne sans JavaScript. Votre `headCode` peut lire `window.scaloConsent` (`granted`, `denied`, `unknown`) ou écouter `document.addEventListener('scalo:consent', e => e.detail.status)`.

## Pages légales

**Suivi et RGPD → Pages légales** : « Mentions légales », « Politique de confidentialité », « Conditions générales de vente » ajoutées en un clic, pré-remplies avec le nom d’expéditeur, l’adresse et l’email des **Paramètres** ; tout le reste est signalé par `[À compléter : …]`. Ce sont des modèles à relire, pas un conseil juridique. Option **pied de page** avec les liens sur toutes les pages ; ces pages ne sont jamais utilisées comme « étape suivante ». La politique de confidentialité devient le lien du bandeau cookies.

## Export, import et partage

- **Partage → Exporter** : fichier JSON versionné (`scalo-funnel` v1) avec étapes, pages, variantes, règles d’accès (jamais le mot de passe), réglages de suivi ; tags par nom ; campagnes email non incluses. **Tunnels → Importer** : validation stricte (2 Mo max), nouvelle adresse, avertissements (mot de passe à redéfinir, test A/B à relancer).
- **Lien de partage** : `https://<app>/share/scalo_sh_…` (256 bits aléatoires, stocké haché, affiché une seule fois, régénérable, révocable). Le destinataire voit un aperçu en lecture seule et peut **Importer dans mon compte** (connexion requise) : copie indépendante, sans contacts ni statistiques. Les images de la médiathèque restent servies depuis le compte d’origine (`/uploads/…`, publiques) : si son propriétaire les supprime, elles disparaissent aussi de la copie.

## Éditeur de pages et d’emails

Builders : sections, colonnes, 24 types de blocs, édition en ligne, médiathèque (images dans `UPLOAD_DIR`, par défaut `api/uploads/`), 7 modèles de pages, 4 modèles d'emails et une bibliothèque de sections — voir « Modèle de contenu » dans [SPEC.md](../SPEC.md).
