---
name: ui-preview
description: >-
  Generate a fast, approximate PNG preview of a React Native / Expo UI change
  without an emulator, simulator, or browser. Hand-draws the component as SVG
  from the repo's real theme palette and layout constants, then rasterizes with
  @resvg/resvg-js. Use when asked to preview, visualize, mock, or "show what it
  looks like" for a screen/component change and approximate fidelity is fine
  (e.g. "preview the settings card", "what does this look like in dark mode").
  Not for pixel-accurate or true native fidelity — for that use an emulator or
  an EAS/APK build.
---

# Approximate UI preview (SVG → PNG)

A fast way to *see* a React Native UI change in this repo when an emulator,
simulator, or even a headless browser would be too slow. It is an
**approximation**: you redraw the component by hand as an SVG using the real
palette and layout numbers from the source, then rasterize to a PNG. Takes a
few seconds and needs no device.

## When this is the right tool

- The user wants a quick visual sanity check of a layout/structure/copy change.
- "Approximate is fine" — they don't need pixel-accuracy.
- The change is mostly composition: cards, rows, dividers, spacing, buttons,
  text. (Complex animations, gradients, real photos, or exact icon glyphs are
  where the approximation gets weakest.)

If they need native fidelity, point them at an emulator (`pnpm dev` → Expo Go),
or the `android-apk.yml` workflow (see `AGENTS.md`), instead.

## What stays faithful vs. stylized

- **Faithful** (read straight from source): colors, spacing/padding, corner
  radii, font sizes/weights, the actual copy/labels, which rows/buttons appear
  in each state, divider placement.
- **Stylized** (don't trust for fidelity): icon glyphs (drawn as simple
  stand-ins, not the real Ionicons), the exact font (uses a system font like
  DejaVu Sans, not the app font), and native shadows / safe-area insets.

Always state these caveats when you deliver the image.

## Workflow

1. **Read the real values.** Pull the palette from `apps/mobile/src/theme.ts`
   (both `light` and `dark` live there) and the layout constants + copy from the
   component's `StyleSheet` and JSX. Don't guess — wrong numbers make the
   preview misleading, which is worse than no preview.

2. **Enumerate the states.** A good preview shows each meaningful state side by
   side (e.g. signed-out / signed-in / not-configured; empty / populated;
   light / dark). This is where the preview earns its keep.

3. **Install the rasterizer** without mutating app dependencies. Use a temporary
   or skill-local npm prefix (`@resvg/resvg-js` is lightweight, no browser):
   ```bash
   PREVIEW_DEPS="${PREVIEW_DEPS:-/tmp/stash-ui-preview-deps}"
   npm --prefix "$PREVIEW_DEPS" install --no-save @resvg/resvg-js
   ```
   Import it from the generated script with `createRequire`, or set
   `NODE_PATH="$PREVIEW_DEPS/node_modules"` before running. Do not add it with
   `pnpm --filter mobile add`; preview tooling should not touch
   `apps/mobile/package.json` or `pnpm-lock.yaml`.

4. **Check fonts exist** (resvg renders text using system fonts; with none,
   text comes out blank): `fc-list | head`. DejaVu Sans is typically present —
   set `font-family="DejaVu Sans"` in the SVG.

5. **Generate.** Copy `render-template.mjs` (next to this file) into
   `apps/mobile/`, edit the `PALETTE` and `STATES`/`panel(...)` drawing to match
   the component, and run it. It writes a 2×-scaled PNG to `/tmp`.

6. **Deliver** by reporting the PNG path or attaching it if the current Codex
   surface supports file attachments, with a caption that names it an
   approximation.

7. **Clean up so you don't pollute a PR.** This tooling is throwaway:
   ```
   rm -f apps/mobile/<your-script>.mjs
   rm -rf "${PREVIEW_DEPS:-/tmp/stash-ui-preview-deps}"
   ```
   Before deleting or restoring anything else, check `git status --short` and
   preserve unrelated user/task edits. Never use cleanup commands that discard
   existing changes to `apps/mobile/package.json` or `pnpm-lock.yaml`.

## Gotchas learned the hard way

- **Module resolution**: `ERR_MODULE_NOT_FOUND` for `@resvg/resvg-js` means the
  `.mjs` is outside the workspace that has the dep. Move it into `apps/mobile/`.
- **Blank text** in the PNG → no usable system font; install one or pick a
  `font-family` that `fc-list` confirms exists.
- **Crisp output**: render at 2× via `new Resvg(svg, { fitTo: { mode: 'width',
  value: totalWidth * 2 } })`.
- **Vertical centering**: SVG `<text>` sits on its baseline; nudge `y` by
  ~0.35×fontSize below the intended center to vertically center a line.

See `render-template.mjs` for a working scaffold (SVG helpers, a stylized
circular-arrow icon, pill buttons, and a multi-state panel layout).
