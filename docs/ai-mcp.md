[← Retour au README](../README.md)

# IA native et serveur MCP

## Génération par IA (Claude)

Scalo utilise l’[API Claude](https://platform.claude.com/docs) d’Anthropic avec **votre propre clé** (« apportez votre clé ») : soit `ANTHROPIC_API_KEY` pour toute l’instance, soit une clé par compte dans **Paramètres → IA** (chiffrée en base, jamais réaffichée ; elle est prioritaire sur celle de l’instance). Sans clé, les boutons IA expliquent comment en ajouter une. Les appels sont facturés par Anthropic ; le **journal d’usage** (Paramètres → IA) liste chaque génération et les jetons consommés.

- **Tunnels → Générer avec l’IA** : un brief (offre, cible, ton, langue, objectif capture / vente / webinaire) → un tunnel complet (capture, vente, remerciement) fait de blocs de l’éditeur, entièrement modifiable.
- **Emails → Générer avec l’IA** : une campagne de N emails avec leurs délais (créée sans déclencheur : rien ne part tant que vous ne l’activez pas) ou un brouillon de newsletter.
- **Éditeur** : « Améliorer avec l’IA » sous le texte des blocs Titre et Texte (reformuler, raccourcir, plus persuasif, traduire). **Test A/B de l’objet** : « Proposer des objets ».
- Garde-fous : le modèle ne renvoie qu’un plan JSON validé strictement ; c’est le serveur qui construit les blocs (jamais de HTML ni de code personnalisé généré), les textes sont nettoyés puis échappés au rendu ; l’IA n’invente ni prix ni témoignage (emplacements entre crochets à compléter) ; 30 générations par heure et par compte (`AI_RATE_LIMIT_PER_HOUR`), délai maximal de 3 minutes, messages d’erreur lisibles (clé invalide, crédit épuisé, refus…).

## Connecter Claude (serveur MCP)

L’API expose un serveur [MCP](https://modelcontextprotocol.io) sur `POST <PUBLIC_URL>/mcp` (Streamable HTTP) : Claude — ou tout client MCP — peut lister / chercher / créer / mettre à jour des contacts, gérer leurs tags, lire les segments, les tunnels et leurs statistiques, les newsletters et les campagnes, inscrire un contact à une campagne et enregistrer un achat. Chaque outil passe par l’API publique `/api/v1` avec les mêmes scopes et les mêmes règles.

1. **Développeurs → Nouvelle application** : type *Confidentielle*, les scopes à accorder (+ `offline_access`), adresse de redirection `https://claude.ai/api/mcp/auth_callback`. Notez le `client_id` et le `client_secret`.
2. Dans Claude : Paramètres → Connecteurs → connecteur personnalisé, URL `https://votre-domaine/mcp`, puis le `client_id` / `client_secret` dans les paramètres avancés. Claude vous envoie sur l’écran d’autorisation Scalo.
3. Révocation à tout moment dans Paramètres → Applications connectées.

Le serveur doit être joignable en HTTPS depuis Internet pour claude.ai. L’authentification réutilise le serveur d’autorisation OAuth 2.0 : sans jeton, `/mcp` répond `401` avec `WWW-Authenticate: Bearer … resource_metadata="…/.well-known/oauth-protected-resource"` (RFC 9728), ce qui permet au client de découvrir le serveur d’autorisation. Il n’y a **pas d’enregistrement dynamique de client** (RFC 7591) : seules les applications créées dans Développeurs peuvent se connecter. Derrière un reverse proxy qui sert lui-même le front, transmettez aussi `/mcp` et `/.well-known/` à l’API (rien à faire avec l’image Docker, où l’API sert tout).

```bash
# vérifier la découverte
curl -i -X POST https://votre-domaine/mcp            # 401 + WWW-Authenticate
curl https://votre-domaine/.well-known/oauth-protected-resource
```
