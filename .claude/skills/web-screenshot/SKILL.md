---
name: web-screenshot
description: >-
  Screenshot any Stash screen populated with artificially injected data —
  bookmarks, tags, collections, and pending AI suggestions of your choosing —
  instead of the empty first-run state. Renders the real app via the Expo web
  export + headless Chromium (no emulator), priming localStorage before boot.
  Use when asked to "screenshot the inbox with sample bookmarks", "show the
  review screen with suggestions", "capture a full inbox", "mock up the app with
  N saved items", or any screen that needs content to be worth looking at. Data
  is either generated on the fly (`--count`, deterministic `--seed`) or supplied
  from a JSON file (`--data`). Like the `screenshot` skill it is a web render,
  not native — for Android-native layout bugs use `android-screenshots`.
---

# Screenshot with injected data (Expo web export → headless Chromium)

Same engine as the `screenshot` skill, with one addition: it **primes the web
app's `localStorage` before the app boots** so any screen renders with the
bookmarks/tags/collections/AI-suggestions you specify — rather than the empty
state a fresh install shows (the app no longer ships a sample seed).

Use this over `screenshot` whenever an empty screen would be useless: a full
Inbox, the Review queue with pending suggestions, a folder with items, search
results, etc.

## How the injection works (don't "fix" it away)

On web, `apps/mobile/src/storage/repository.ts` loads from `localStorage`:
`stash.bookmarks`, `stash.tagData`, `stash.enrichments`, and only re-seeds the
(empty) sample when `stash.seeded !== "1"`. `render.mjs` writes all of those in
a Playwright **init script that runs before any app script**, with
`stash.seeded` set so the app keeps the injected rows. It also **aborts every
non-localhost request**, which (a) stops the Supabase pull that would otherwise
replace the injected tag data wholesale, and (b) stops remote images/fonts from
stalling `networkidle`. Shapes mirror `domain/types.ts` 1:1.

## Steps

Run everything from the repo root.

1. **Build the web export** (skip if `apps/mobile/dist/` is current — reuse is
   the biggest speed win; delete it to force a fresh build after code changes):

   ```bash
   [ -f apps/mobile/dist/index.html ] || (cd apps/mobile && CI=1 pnpm exec expo export --platform web)
   ```

2. **Ensure the browser driver is installed** (once per checkout; lands in this
   skill's gitignored `node_modules`, so it never touches the repo deps):

   ```bash
   [ -d .claude/skills/web-screenshot/node_modules/playwright-core ] || \
     npm --prefix .claude/skills/web-screenshot install --no-save playwright-core@1.56.0
   ```

   Chromium itself is the environment's pre-installed build under
   `$PLAYWRIGHT_BROWSERS_PATH`. Do **not** run `playwright install`.

3. **Render.** Generated data by default (8 bookmarks, some tagged/filed, a few
   with pending AI suggestions):

   ```bash
   node .claude/skills/web-screenshot/render.mjs --route inbox --count 8 --seed 3 --out /tmp/inbox.png
   ```

   Then `Read` the PNG. A blank frame means the tree never rendered — check the
   `[pageerror]` lines the script prints.

4. **Deliver** with `SendUserFile`, stating it's a web render with injected
   sample data (caveats below).

5. **Clean up** the throwaway export so it never lands in a PR (the skill's
   gitignored `node_modules` stays for fast reruns):

   ```bash
   rm -rf apps/mobile/dist
   ```

## Options

Route / theme / viewport (same as `screenshot`):

- `--route` — `inbox`/`/`, `settings`, `review`, `add`, `trash`, `browse-tags`,
  `report`, or any raw exported path.
- `--theme light|dark` — default `light` (dark uses the same recolor pass).
- `--out PATH`, `--width`/`--height`/`--scale` (default `390×844@2`), `--full`.

Data:

- `--count N` — generate N bookmarks (default 8).
- `--seed S` — PRNG seed; same seed → identical data (default 1).
- `--tags N` / `--collections N` — how many to fabricate (defaults 6 / 3).
- `--archived N` — make N of the items trashed (for the `trash` route).
- `--data FILE.json` — use explicit data instead of generating. Either a full
  bundle `{ bookmarks, tagData: { tags, bookmarkTags, collections }, enrichments }`
  (missing keys default to empty) or a bare `bookmarks` array. See
  `sample-data.json`. When `--data` is set, no generation happens.

Which screens the generated data lights up: Inbox (all items + folder/tag
chips), Review (items carrying pending `enrichments.suggested_tags` — the first
few generated items get these), folder/tag filters, and search.

## What is faithful vs. not

Identical to the `screenshot` skill: **faithful** = the real component tree,
theme, layout numbers, copy, and Ionicons; **not faithful** = native shadows,
true safe-area insets, and Android text-measurement/scroll behaviour. It's a
browser, not Android. **Do not use it to verify Android-native clipping** — that
is what the `android-screenshots` emulator CI is for. Generated bookmarks leave
`preview_image_url` null on purpose (no remote fetch offline); supply your own
via `--data` with `data:`-URI images if you need thumbnails.
