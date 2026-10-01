# Film de lancement — motion design

36 s, 1920 × 1080, 30 i/s, voix off anglaise, musique « No Money On My Mind (Instrumental Version) » de Lvly (Epidemic Sound, 120 BPM). Affiché sur la home page (section `Film` de `web/src/pages/landing/LandingPage.tsx`).

Style : typographie cinétique plein cadre, coupes sur le beat, « punch » caméra sur chaque temps, deux impacts (drop sur « Meet Scalo », coup final sur le logo), éclatement de pastilles aux couleurs de la marque.

| Fichier | Usage |
|---|---|
| `web/public/video/scalo-presentation.mp4` | Version du site (H.264), sous-titres dynamiques sur les phrases longues |
| `web/public/video/scalo-presentation.webm` | Même version en VP9 / Opus, proposée en premier au navigateur |
| `web/public/video/scalo-presentation.jpg` | Affiche (poster) du lecteur |
| `scalo-film-no-captions.mp4` | Master sans sous-titres (réseaux sociaux, salons, montage) |
| `scene.html` | Animation : 9 plans pilotés par `render(t)`, rendu image par image |
| `render.mjs` | Rendu Playwright → ffmpeg |
| `track.mp3` | Morceau Epidemic Sound, non versionné (à télécharger depuis le compte Epidemic Sound). Lu à partir de sa 7ᵉ seconde |
| `music.py` | `python3 music.py sfx` → `sfx.wav` : bruitages synthétisés en numpy (montée, impacts, transitions) posés sur le morceau. Sans argument : ancienne musique synthétisée (`music.wav`, aucune licence tierce) |
| `mix-filter.txt` | Filtre ffmpeg : découpe la voix en phrases, les cale sur la grille, compresse, mixe avec le morceau et les bruitages (ducking) et normalise à −14 LUFS |
| `voice/v1.mp3` … `v7.mp3` | Prises de voix brutes (Epidemic Sound, voix « Adam », en, vitesse +0,1) |

## Script et grille (120 BPM : 1 temps = 0,5 s)

| Temps | Voix off | Image |
|---|---|---|
| 0,5 | Landing pages here. | « Landing pages / here. » + maquette de page en 3D |
| 2,0 | Emails there. | Plein cadre indigo, enveloppes qui volent |
| 3,0 | Contacts somewhere else. | Fiches contacts qui dérivent |
| 4,5 | Four tools. | 4 tuiles qui tombent sur les temps |
| 5,5 | Four bills. | 4 factures empilées, $146/mo barré |
| 6,5 | Way too much duct tape. | Tuiles scotchées qui tremblent, aspirées au centre, montée |
| **10,0** | **Meet Scalo.** | **Drop** : les 3 pastilles du logo arrivent de 3 côtés, flash, éclatement |
| 11,5 | Funnels, emails and contacts, in one place. | Mots plein cadre, couleurs alternées, puis empilés |
| 14,5 | Drag, drop, publish. | Éditeur en 3D : bloc glissé, bouton Publish → Live |
| 16,5 | Pages that turn visitors into leads, on your own domain. | Compteur visiteurs → leads, URL `yourbrand.com` |
| 20,0 | Every sign-up gets tagged and dropped into the right email sequence. | Inscription → tag → séquence Day 0/2/5, caméra qui suit |
| 24,0 | Automatically. | Mot plein cadre + soulignement lime |
| 25,5 | Your CRM fills itself. | Fiche contact, tags, historique |
| 27,5 | And you see exactly what converts. | Whip pan vers la courbe de conversion + test A/B |
| 30,0 | From first click to loyal customer. | Marches Visitor → Lead → Customer |
| **32,0** | **Scalo.** | **Impact** : les marches deviennent le logo |
| 33,5 | Start free today. | « Built to scale. » + bouton Start free |

Les chiffres affichés sont illustratifs, comme sur la landing page.

## Régénérer

Prérequis : Node ≥ 20 avec `playwright`, Python 3 + `numpy`, `ffmpeg`.

```bash
cd brand/video
mkdir -p fonts && (cd fonts && for p in inter plus-jakarta-sans jetbrains-mono; do npm pack @fontsource/$p && tar xzf fontsource-$p-*.tgz && mv package fontsource-$p; done)
ln -s "$(command -v ffmpeg)" ffmpeg

# aperçu en direct : ouvrir scene.html?play dans un navigateur
node render.mjs stills 10.3,16,24.3           # images fixes still-<t>.png
node render.mjs video v_cap.mp4
node render.mjs video v_nocap.mp4 "?captions=0"

python3 music.py sfx                          # -> sfx.wav
ffmpeg -i voice/v1.mp3 -i voice/v2.mp3 -i voice/v3.mp3 -i voice/v4.mp3 -i voice/v5.mp3 -i voice/v6.mp3 -i voice/v7.mp3 -i track.mp3 -i sfx.wav \
  -/filter_complex mix-filter.txt -map "[out]" -ar 48000 mix.wav
ffmpeg -i v_cap.mp4 -i mix.wav -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart ../../web/public/video/scalo-presentation.mp4
ffmpeg -i ../../web/public/video/scalo-presentation.mp4 -c:v libvpx-vp9 -b:v 0 -crf 33 -row-mt 1 -c:a libopus -b:a 128k ../../web/public/video/scalo-presentation.webm
```

Pour changer une phrase : régénérer la prise, repérer le début et la fin de la phrase (`silencedetect`), mettre à jour son `atrim` dans `mix-filter.txt`, et décaler les temps dans `scene.html` si elle ne tient plus dans son créneau.
