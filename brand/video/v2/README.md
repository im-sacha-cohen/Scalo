# Film v2 — « le parcours d'Ana »

37 s, 1920 × 1080, 30 i/s. Version alternative du film de lancement (`../`), volontairement à l'opposé : fond clair, un seul plan continu, on suit une visiteuse (Ana) le long d'une ligne — clic, inscription, e-mails, appel, achat — puis vue d'ensemble et « mille autres comme elle ». Voix off anglaise féminine (Epidemic Sound, voix « Clark », vitesse normale), musique calme synthétisée à 96 BPM. N'est pas affiché sur le site.

| Fichier | Usage |
|---|---|
| `scalo-film-v2.mp4` | Film (H.264), sous-titré sur toutes les phrases |
| `scene.html` | Animation pilotée par `render(t)` ; `LINES` = début, durée et texte de chaque phrase |
| `music.py` | Musique et carillons d'événements synthétisés en numpy (aucune licence tierce) → `music.wav` |
| `mix.py` | Cale les phrases (`SEGS`, mêmes débuts que `LINES`), baisse la musique sous la voix, normalise → `mix.wav` |
| `voice/l1.mp3` … `l9.mp3` | Prises de voix brutes, une par phrase du script |

La carte de fin (logo, « Funnels, emails and contacts, in one place. », Start free) est sans voix : la génération des deux dernières phrases a échoué côté Epidemic Sound.

## Régénérer

Mêmes prérequis que `../README.md` (polices dans `../fonts`, `ln -s "$(command -v ffmpeg)" ffmpeg` dans ce dossier).

```bash
cd brand/video/v2
node ../render.mjs video v_cap.mp4            # "?captions=0" en 3ᵉ argument pour une version sans sous-titres
python3 music.py && python3 mix.py
ffmpeg -i v_cap.mp4 -i mix.wav -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart scalo-film-v2.mp4
```
