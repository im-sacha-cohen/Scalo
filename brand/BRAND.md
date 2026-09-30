# Scalo — charte de marque

> Funnels, emails, contacts. **Built to scale.**

## Nom
- Toujours **Scalo** dans le texte (majuscule), **scalo** en minuscules uniquement dans le logo.
- Domaine visé : `tryscalo.com` (libre au 2026-09-29 — à acheter). Marques EUIPO/USPTO classes 9, 35, 42 : non vérifiées.

## Logo
Symbole « Les marches » : trois pilules en escalier qui dessinent un S et montent vers la pilule lime — la montée pas à pas, du visiteur au client.

| Fichier | Usage |
|---|---|
| `logo/scalo-logo.svg` | Logo principal, fond clair |
| `logo/scalo-logo-dark-bg.svg` | Fond sombre (ink / photo sombre) |
| `logo/scalo-logo-mono-ink.svg` / `-mono-white.svg` | Impression 1 couleur, gravure, partenaires |
| `logo/scalo-icon.svg` | App icon, avatar, favicon (carré indigo) |
| `logo/scalo-symbol-light-bg.svg` / `-dark-bg.svg` | Symbole seul sans carré |
| `logo/scalo-wordmark.svg` | Mot seul (quand le symbole est déjà présent) |
| `logo/made-with-scalo-badge.svg` | Badge sur les pages publiques des clients |

Règles : zone de protection = hauteur d'une pilule tout autour · taille mini 20 px (symbole) / 80 px (logo complet) · ne jamais déformer, recolorer hors palette, ajouter d'ombre ni de dégradé · la pilule lime ne va jamais sur fond clair (utiliser la version `light-bg`, pilule haute en ink).

## Couleurs

| Rôle | Token | Hex |
|---|---|---|
| Primaire | `indigo-500` | `#5B4BFF` |
| Survol | `indigo-600` | `#4A38E8` |
| Ink (texte, fonds sombres) | `indigo-950` | `#0E0B2B` |
| Accent signature | `lime-400` | `#C6F432` |
| Surface | `indigo-50` | `#F6F5FF` |
| Succès / Alerte / Erreur / Info | — | `#12B76A` / `#F79009` / `#F04438` / `#2E90FA` |

Échelle complète dans `tokens.css`.
- Blanc sur indigo 500 = 5,4:1 (AA) · lime sur ink = 15:1.
- **Lime jamais en texte sur fond clair.** ≤ 5 % de la surface d'un écran.
- Pas de dégradés violet→rose, pas de glow : aplats uniquement. Les grandes zones sombres sont en **ink**, pas en violet.

## Typographie
- **Plus Jakarta Sans** 700/800 — titres, interlettrage −3 %, interligne 1,05–1,1.
- **Inter** 400/500 — interface et texte courant.
- **JetBrains Mono** — code, IDs, URLs.
Toutes gratuites (Google Fonts), latin étendu (FR, ES, DE, PT, PL…).

## Ton
Direct, concret, chaleureux. Tutoiement en français, « you » en anglais. On dit ce que fait l'outil, chiffres à l'appui. Pas de « leverage », « seamless », « 10x », pas de points d'exclamation.

Accroches : *Funnels, emails, contacts. Built to scale.* · *Sell more. Juggle less.* · *From first click to loyal customer.*

## Images OG (1200 × 630)
| Fichier | Usage |
|---|---|
| `og/og-default` | Accueil, pages sans image dédiée |
| `og/og-funnels`, `og-emails`, `og-contacts` | Pages fonctionnalités |
| `og/og-blog-template` | Modèle blog — titre généré automatiquement |
| `og/og-customer-funnel-example` | Pages publiques clients : couleurs du client + badge « Made with Scalo » (retirable en offre payante) |

Marge de sécurité 80 px, titre ≤ 8 mots en 2 lignes max, logo en haut à gauche.

## Favicons & réseaux
- `favicon/favicon.ico` (16/32/48), `favicon.svg`, `apple-touch-icon.png` (180), `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` (PWA).
- `social/avatar` (400 × 400), `social/banner-1500x500` (X / LinkedIn).
