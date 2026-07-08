---
name: screenshot
description: >-
  Take a real screenshot of a Stash screen by rendering the actual app code via
  the Expo web export + headless Chromium — no emulator or simulator. Use when
  asked to screenshot, capture, or show the real app/a screen (e.g. "screenshot
  the inbox", "show the settings screen", "capture the review screen in dark
  mode"). By default it renders whatever state the app boots into (a fresh
  export is the empty first-run state); pass data flags (--count/--seed/--data)
  to inject bookmarks/tags/collections/AI suggestions so screens render with
  content. Renders the live component tree in about a minute, more faithful than
  `ui-preview` but faster than Android emulator screenshots. Not a substitute
  for true native fidelity; Android layout bugs still need emulator/device
  verification.
---

# Real screenshot (Expo web export → headless Chromium)

Renders the **actual app** — the real component tree, theme, and copy — in a
headless browser and saves a PNG. No emulator, no Metro server, no device.

This is the middle rung of three:

| Tool | Fidelity | Speed | Use when |
|---|---|---|---|
| `ui-preview` | approximate (hand-drawn SVG) | seconds | quick sanity check of spacing/copy |
| **`screenshot` (this)** | real web render of app code | ~1 min | "show me the real screen" |
| `android-screenshots` CI | true native (Android emulator + Maestro) | ~15 min | catching Android-native layout bugs before merge |

## Two modes

- **Default** — render whatever state the app boots into. A *fresh* export is the
  **empty first-run state** (the app ships no sample seed), so content screens
  come out blank. Live network, so a Supabase pull / remote images can load.
- **Injected** — pass any data flag (`--count`/`--seed`/`--tags`/`--collections`/
  `--archived`/`--data`) to prime `localStorage` **before the app boots** so the
  screen renders with the bookmarks/tags/collections/AI-suggestions you choose.
  Use this whenever an empty screen would be useless: a full Inbox, the Review
  queue, a filled folder, search results.

### How injection works (don't "fix" it away)

On web, `apps/mobile/src/storage/repository.ts` loads from `localStorage`:
`stash.bookmarks`, `stash.tagData`, `stash.enrichments`, and only re-seeds the
(empty) sample when `stash.seeded !== "1"`. In injected mode `render.mjs` writes
all of those in a Playwright **init script that runs before any app script**,
with `stash.seeded` set so the app keeps the injected rows. It also **aborts
every non-localhost request**, which (a) stops the Supabase pull that would
otherwise replace the injected tag data wholesale, and (b) stops remote
images/fonts from stalling `networkidle` — so injected renders are fully offline
and deterministic (same `--seed` → same pixels). Shapes mirror `domain/types.ts`.

## What is faithful vs. not

- **Faithful**: the real React component tree, theme palette, layout numbers,
  copy/labels, icons (real Ionicons), and any injected/seeded content.
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
   SKILL_DIR="${SKILL_DIR:-.codex/skills/screenshot}"
   [ -d "$SKILL_DIR/node_modules/playwright-core" ] || \
     npm --prefix "$SKILL_DIR" install --no-save playwright-core@1.56.0
   ```

   Chromium itself is the environment's pre-installed build under
   `$PLAYWRIGHT_BROWSERS_PATH` (the script resolves it; it prefers the faster
   `headless_shell`). Do **not** run `playwright install`.

3. **Render.** Defaults to the Inbox (`/`) in light theme at a phone viewport;
   add data flags to fill the screen:

   ```bash
   # empty first-run state
   SKILL_DIR="${SKILL_DIR:-.codex/skills/screenshot}"
   node "$SKILL_DIR/render.mjs" --route inbox --theme light --out /tmp/inbox.png
   # with injected sample data
   node "$SKILL_DIR/render.mjs" --route inbox --count 8 --seed 3 --out /tmp/inbox.png
   ```

   Then use Codex's local image viewer to inspect the PNG. A blank frame means the page never
   rendered — check the `[pageerror]` lines the script prints.

4. **Deliver** by reporting the PNG path or attaching it if the current Codex
   surface supports file attachments, and state it's a web render (caveats
   above; note when the data is injected/sample).

5. **Clean up** the throwaway export so it never lands in a PR (the skill's
   `node_modules` stays, gitignored, for fast reruns):

   ```bash
   rm -rf apps/mobile/dist
   ```

## Options

Route / theme / viewport:

- `--route` — `inbox`/`/`, `settings`, `review`, `add`, `trash`, `browse-tags`,
  `report`, or any raw exported path. (Bookmark detail needs a real id; navigate
  by clicking a card if you need it.)
- `--theme light|dark` — default `light`. Light is the cleanest because the
  static export prerenders light; dark works via a recolor pass (see below).
- `--out PATH` — output PNG (default `/tmp/stash-<route>-<theme>.png`).
- `--width` / `--height` / `--scale` — viewport + DPR (default `390×844@2`).
- `--full` — full-page (scrolling) screenshot instead of just the viewport.
- `--click SELECTOR` — click an element before capturing, to reach a state that only exists after a tap (a lens/filter, an expanded menu, an opened modal). RN-web maps `testID` → `data-testid`, so use `--click '[data-testid="new-suggestions-banner"]'`. Best paired with a data flag so the thing to tap actually renders.

Data (any of these switches on injected mode):

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
few generated items get these), folder/tag filters, and search. Generated
bookmarks leave `preview_image_url` null on purpose (no remote fetch offline);
supply your own via `--data` with `data:`-URI images if you need thumbnails.

## The dark-theme fixup in the driver (don't "fix" it away)

The Expo **web** export prerenders the static HTML in light, and that baked
container background survives hydration — so dark mode renders a light container
behind dark cards. The script recolors elements still carrying the light
background (`apps/mobile/src/theme.ts` → `light.background` #f7f9fc) to the dark
background (#0b1220). If the palette changes, update those two constants at the
top of `render.mjs`. This is a render-only web artifact (correct on native).

> ⚠️ **Lesson — verify Image sizing against a device, not this preview.** An
> earlier version also patched a wordmark `<Image>` that the web export laid out
> at full intrinsic width, and this doc wrongly called it "correct on native."
> It was **not**: the same `height`+`aspectRatio`-in-a-flex-row pattern blew the
> wordmark up to fill the screen on a real Android build (rc11/rc12). The source
> now sets an explicit `width`+`height` (so both web and native are correct) and
> the fixup is gone. Treat any "the web preview hides/mangles an element"
> situation as a possible **real** layout bug until a device or the
> `android-screenshots` emulator says otherwise — don't assume the browser is
> the only thing that's wrong.
