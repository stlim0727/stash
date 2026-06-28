---
name: screenshot
description: >-
  Take a real screenshot of a Stash screen by rendering the actual app code via
  the Expo web export + headless Chromium — no emulator or simulator. Use when
  asked to screenshot, capture, or show the real app/a screen (e.g. "screenshot
  the inbox", "show the settings screen", "capture the review screen in dark
  mode"). Renders the live component tree with the first-run mock seed in ~1 min,
  so it is more faithful than the `ui-preview` skill (which hand-draws an
  approximate SVG) but faster than the `android-screenshots` CI emulator. Not a
  substitute for true native fidelity — Android-native layout bugs (chip
  clipping, text measurement, safe-area) only show on the emulator; for those use
  the `android-screenshots` workflow.
---

# Real screenshot (Expo web export → headless Chromium)

Renders the **actual app** — the real component tree, theme, copy, and the
first-run mock data — in a headless browser and saves a PNG. No emulator, no
Metro server, no device.

This is the middle rung of three:

| Tool | Fidelity | Speed | Use when |
|---|---|---|---|
| `ui-preview` | approximate (hand-drawn SVG) | seconds | quick sanity check of spacing/copy |
| **`screenshot` (this)** | real web render of app code | ~1 min | "show me the real screen" |
| `android-screenshots` CI | true native (Android emulator + Maestro) | ~15 min | catching Android-native layout bugs before merge |

## What is faithful vs. not

- **Faithful**: the real React component tree, theme palette, layout numbers,
  copy/labels, icons (real Ionicons), and the seeded sample bookmarks/folders/tags.
- **Not faithful** (it's a browser, not Android): native shadows, true
  safe-area insets, Android `ScrollView`/text-measurement behaviour, and font
  rendering. **Do not use it to verify Android-native clipping** — that is what
  the emulator CI exists for.

## Steps

Run everything from the repo root.

1. **Build the web export** (skip if `apps/mobile/dist/` already exists and is
   current — reusing it is the biggest speed win):

   ```bash
   [ -f apps/mobile/dist/index.html ] || (cd apps/mobile && CI=1 pnpm exec expo export --platform web)
   ```

   Force a fresh build after code changes by deleting `apps/mobile/dist` first.

2. **Ensure the browser driver is installed** (once per checkout; it lands in
   this skill's gitignored `node_modules`, so it does not touch the repo deps):

   ```bash
   [ -d .claude/skills/screenshot/node_modules/playwright-core ] || \
     npm --prefix .claude/skills/screenshot install --no-save playwright-core@1.56.0
   ```

   Chromium itself is the environment's pre-installed build under
   `$PLAYWRIGHT_BROWSERS_PATH` (the script resolves it; it prefers the faster
   `headless_shell`). Do **not** run `playwright install`.

3. **Render.** Defaults to the Inbox (`/`) in light theme at a phone viewport:

   ```bash
   node .claude/skills/screenshot/render.mjs --route inbox --theme light --out /tmp/inbox.png
   ```

   Then `Read` the PNG to look at it. A blank frame means the page never
   rendered — check the `[pageerror]` lines the script prints.

4. **Deliver** with `SendUserFile`, and state it's a web render (caveats above).

5. **Clean up** the throwaway export so it never lands in a PR (the skill's
   `node_modules` stays, gitignored, for fast reruns):

   ```bash
   rm -rf apps/mobile/dist
   ```

## Options

- `--route` — `inbox`/`/`, `settings`, `review`, `add`, `trash`, `browse-tags`,
  `report`, or any raw exported path. (Bookmark detail needs a real id; navigate
  by clicking a card if you need it.)
- `--theme light|dark` — default `light`. Light is the cleanest because the
  static export prerenders light; dark works via a recolor pass (see below).
- `--out PATH` — output PNG (default `/tmp/stash-<route>-<theme>.png`).
- `--width` / `--height` / `--scale` — viewport + DPR (default `390×844@2`).
- `--full` — full-page (scrolling) screenshot instead of just the viewport.

## Why two fixups live in the driver (don't "fix" them away)

The Expo **web** export has two quirks that are render-only artifacts, not app
bugs — both are correct on native. The script patches them so the PNG matches
what a device shows:

1. **Wordmark sizing** — RN-web ignores the wordmark `<Image>`'s
   `aspectRatio`+`height` and lays it out at full intrinsic width, hiding the
   inline saved-count and the brand. The script pins it and overlays the same
   asset.
2. **Dark-theme hydration** — the static HTML is prerendered light, and that
   baked container background survives hydration, so dark mode renders a light
   container behind dark cards. The script recolors elements still carrying the
   light background (`apps/mobile/src/theme.ts` → `light.background` #f7f9fc) to
   the dark background (#0b1220). If the palette changes, update those two
   constants at the top of `render.mjs`.
