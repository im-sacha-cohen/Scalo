[← Retour au README](../README.md)

# IA native et serveur MCP

## Génération par IA (Claude)

Scalo utilise l’[API Claude](https://platform.claude.com/docs) d’Anthropic avec **votre propre clé** (« apportez votre clé ») : soit `ANTHROPIC_API_KEY` pour toute l’instance, soit une clé par compte dans **Paramètres → IA** (chiffrée en base, jamais réaffichée ; elle est prioritaire sur celle de l’instance). Sans clé, les boutons IA expliquent comment en ajouter une. Les appels sont facturés par Anthropic ; le **journal d’usage** (Paramètres → IA) liste chaque génération et les jetons consommés.

- **Tunnels → Générer avec l’IA** : un brief (offre, cible, ton, langue, objectif capture / vente / webinaire) → un tunnel complet (capture, vente, remerciement) fait de blocs de l’éditeur, entièrement modifiable.
- **Emails → Générer avec l’IA** : une campagne de N emails avec leurs délais (créée sans déclencheur : rien ne part tant que vous ne l’activez pas) ou un brouillon de newsletter.
- **Éditeur** : « Améliorer avec l’IA » sous le texte des blocs Titre et Texte (reformuler, raccourcir, plus persuasif, traduire). **Test A/B de l’objet** : « Proposer des objets ».
- Garde-fous : le modèle ne renvoie qu’un plan JSON validé strictement ; c’est le serveur qui construit les blocs (jamais de HTML ni de code personnalisé généré), les textes sont nettoyés puis échappés au rendu ; l’IA n’invente ni prix ni témoignage (emplacements entre crochets à compléter) ; 30 générations par heure et par compte (`AI_RATE_LIMIT_PER_HOUR`), délai maximal de 3 minutes, messages d’erreur lisibles (clé invalide, crédit épuisé, refus…).

## Connecter Claude (serveur MCP)

L’API expose un serveur [MCP](https://modelcontextprotocol.io) sur `POST <PUBLIC_URL>/mcp` (Streamable HTTP) : Claude — ou tout client MCP — peut lister / chercher / créer / mettre à jour des contacts, gérer leurs tags, lire les segments, les tunnels et leurs statistiques, les newsletters et les campagnes, **rédiger une newsletter, s’envoyer un test et programmer son envoi**, **créer une campagne et ses emails**, inscrire un contact à une campagne et enregistrer un achat. Sans serveur SMTP configuré (Paramètres), les emails ne partent pas réellement : ils restent visibles dans Emails → Suivi des envois. Un Claude connecté avant l’ajout de ces outils doit être déconnecté puis reconnecté pour obtenir le droit `emails:write`. Chaque outil passe par l’API publique `/api/v1` avec les mêmes scopes et les mêmes règles.

1. Dans Claude : Paramètres → Connecteurs → connecteur personnalisé, URL de l’espace de travail affichée dans **Développeurs → Connecter Claude** (`https://votre-domaine/mcp/<numéro de l’espace>`), sans rien d’autre. Avec Claude Code : `claude mcp add --transport http scalo-boutique https://votre-domaine/mcp/<numéro>`.
2. Claude vous envoie sur l’écran d’autorisation Scalo : connectez-vous et acceptez.
3. Révocation à tout moment dans Paramètres → Applications connectées.

Claude s’enregistre tout seul (RFC 7591, `POST /oauth/register`). Cet enregistrement anonyme n’accepte que les adresses de retour de Claude et les adresses locales (`http://localhost`, `http://127.0.0.1`), avec PKCE obligatoire : un site tiers ne peut donc pas se faire passer pour Claude et récupérer une autorisation. Un autre client MCP hébergé passe par **Développeurs → Nouvelle application**, avec son adresse de redirection et ses scopes.

**Espaces de travail.** Une connexion ne donne accès qu’à un seul espace (un business : ses contacts, tunnels, emails, ventes). Avec l’adresse `/mcp/<numéro>`, Claude demande cet espace (paramètre `resource`, RFC 8707) : l’écran d’autorisation l’impose, et l’adresse refuse un jeton d’un autre espace. Pour piloter plusieurs business, ajoutez un connecteur par espace (« Scalo – Boutique », « Scalo – Coaching »…). L’adresse `/mcp` seule reste valable : l’espace se choisit alors sur l’écran d’autorisation, qui n’est jamais passé automatiquement quand la personne a plusieurs espaces.

**Tous les espaces avec un seul connecteur.** Avec l’adresse `/mcp`, l’écran d’autorisation propose aussi « Tous mes espaces » : la connexion couvre chaque espace dont la personne est propriétaire ou administratrice, y compris ceux créés plus tard. Le serveur ne garde pas d’« espace courant » (le même connecteur sert à toutes les conversations) : chaque outil exige alors `workspace_id`, `list_workspaces` donne la liste à jour, les instructions demandent à Claude de faire préciser l’espace puis de s’y tenir, et chaque résultat commence par « Espace de travail : « Boutique » (workspace_id 4) ». Côté API publique, ce jeton choisit l’espace avec l’en-tête `X-Scalo-Workspace` (par défaut : l’espace depuis lequel l’accès a été donné).

Le serveur doit être joignable en HTTPS depuis Internet pour claude.ai. L’authentification réutilise le serveur d’autorisation OAuth 2.0 : sans jeton, `/mcp` répond `401` avec `WWW-Authenticate: Bearer … resource_metadata="…/.well-known/oauth-protected-resource"` (RFC 9728), ce qui permet au client de découvrir le serveur d’autorisation. Derrière un reverse proxy qui sert lui-même le front, transmettez aussi `/mcp`, `/mcp/<numéro>` et `/.well-known/` à l’API (rien à faire avec l’image Docker, où l’API sert tout).

```bash
# vérifier la découverte
curl -i -X POST https://votre-domaine/mcp            # 401 + WWW-Authenticate
curl https://votre-domaine/.well-known/oauth-protected-resource
```
