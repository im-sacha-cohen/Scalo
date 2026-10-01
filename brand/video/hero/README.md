# Démo du hero — boucle muette

18 s, 1200 × 960 (5:4), 30 i/s, sans son, en boucle. Affichée dans le hero de la landing (`HeroDemo` dans `web/src/pages/landing/LandingPage.tsx`) en lecture automatique ; les visiteurs qui demandent moins d'animations (`prefers-reduced-motion`) voient l'illustration fixe `HeroStairs` à la place.

Quatre étapes, rappelées par la barre du haut : **Build** (on glisse un formulaire dans la page), **Publish** (la page passe en ligne sur `yourbrand.com`), **Capture** (une visiteuse s'inscrit, la fiche contact apparaît avec son tag), **Follow up** (les trois e-mails de la séquence partent seuls). La première et la dernière image sont identiques (panneau vide) pour que la boucle soit invisible.

| Fichier | Usage |
|---|---|
| `web/public/video/scalo-hero-demo.webm` / `.mp4` | Vidéo du site (VP9 proposé en premier, H.264 en repli), environ 0,7 Mo chacune |
| `web/public/video/scalo-hero-demo.jpg` | Affiche, image à 11 s |
| `scene.html` | Animation pilotée par `render(t)` |

## Régénérer

Mêmes prérequis que `../README.md` (polices dans `../fonts`, `ln -s "$(command -v ffmpeg)" ffmpeg` dans ce dossier).

```bash
cd brand/video/hero
W=1200 H=960 node ../render.mjs video v_hero.mp4
W=1200 H=960 node ../render.mjs stills 11 && ffmpeg -i still-11.png -q:v 3 ../../../web/public/video/scalo-hero-demo.jpg
ffmpeg -i v_hero.mp4 -an -c:v libx264 -preset slow -crf 21 -pix_fmt yuv420p -movflags +faststart ../../../web/public/video/scalo-hero-demo.mp4
ffmpeg -i v_hero.mp4 -an -c:v libvpx-vp9 -b:v 0 -crf 34 -row-mt 1 ../../../web/public/video/scalo-hero-demo.webm
```
