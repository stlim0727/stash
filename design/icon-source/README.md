# App icon source

`generate.py` renders the Stash app-icon asset set from a single source of
truth into `apps/mobile/assets/images/`:

| Output | Size | Notes |
| --- | --- | --- |
| `icon.png` | 1024 | iOS / web app icon (teal gradient + mark) |
| `favicon.png` | 48 | downscaled icon |
| `android-icon-background.png` | 1024 | adaptive-icon background (teal gradient + glow) |
| `android-icon-foreground.png` | 1024 | adaptive-icon foreground (mark, scaled into the safe zone) |
| `android-icon-monochrome.png` | 1024 | themed-icon silhouette ("+" knocked out) |
| `splash-icon.png` | 512 | splash mark on transparent |

The mark is a bookmark ribbon with an amber **+** "save" badge. Palette:
teal gradient `#0D9488 → #10B981`, amber `#FBBF24`, deep-teal `#115E59`
(also set as `android.adaptiveIcon.backgroundColor` and the splash
`backgroundColor` in `app.json`).

Shapes are drawn programmatically with Pillow at 4× supersampling, so the
output is crisp and reproducible — re-run after any tweak:

```sh
pip install Pillow
python3 design/icon-source/generate.py
```
