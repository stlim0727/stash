# Web Inbox Visual Polish Onboarding

_Team onboarding, 2026-07-07. Context: after the desktop-web blur fix and the
Inter/Pretendard/system-font trials, the accepted direction is system UI with
lighter web-only weights (#408). The next meaningful visual gains should come
from layout and spacing, not another global typeface swap._

## What We Learned

- The original desktop-web problem was real rendering softness from broad
  transforms/composited surfaces. Fixing that made text and thumbnails sharper.
- Global font changes did not solve the remaining visual discomfort:
  - Pretendard improved Korean fit but made bold titles/chips feel too chunky.
  - System UI was crisper, but dense `700`/`800` weights still felt loud.
  - The accepted preview kept system UI and lightened dense web-only weights.
- The remaining issue is mostly composition: too much visual weight arrives at
  once from thumbnails, bold titles, tags, and a long folder shelf.

## Current Typography Decision

- Web text should use the native system UI stack from
  `apps/mobile/src/share/pwa-head.web.ts`.
- Do not reintroduce a global webfont as the first response to "the UI feels
  heavy." Global font swaps are expensive to judge, can regress Korean/English
  balance, and still leave the dense grid problem intact.
- If text feels too loud, tune weight/size locally and preview it on Cloudflare
  before merging. Keep native/APK typography unchanged unless explicitly testing
  native.

## Next Visual Work Should Be Layout/Spacing

Prioritize preview branches for these, one at a time.

**Card rhythm:** increase vertical breathing room between the shelf and the
first card row; revisit image height/crop so thumbnails feel less abrupt; check
whether short text-only cards should span less visual height or use a different
preview placeholder.

**Hierarchy:** reduce competition between card title, URL, tag chips, and open
button; consider showing fewer metadata chips in card mode, or making tags
quieter; keep the title readable, but avoid making every card title the dominant
object on the screen.

**Folder shelf:** keep the row useful, but reduce its perceived loudness when
many chips are visible. Prefer spacing, count treatment, and active-state
adjustments before adding more controls.

**Density:** treat desktop card mode as a scanning surface, not a marketing
grid. Make changes in small previewable slices; compare screenshots against the
current production state.

## Execution Playbook

Use this order when picking up the next visual pass. Do not combine these into
one broad redesign PR; each item should be easy to preview, reject, or keep.

### Pass 1: Card Rhythm

**Goal:** make the first viewport feel less compressed without reducing the
number of useful cards too much.

**Likely files:** `apps/mobile/src/app/index.tsx`, especially Inbox header,
list padding, card image, and card body styles.

**Try first:**

- Add a little vertical air between the folder shelf and first card row.
- Tune card preview image height/crop by a small amount, not a full card
  redesign.
- Keep the three-column desktop grid intact unless the preview proves the grid
  itself is the problem.

**Acceptance check:** on a desktop browser, the top row should feel calmer, but
the app should still read as a dense bookmark tool rather than a spacious
landing page.

### Pass 2: Card Hierarchy

**Goal:** reduce competition inside each card after the title weight fix.

**Likely files:** `apps/mobile/src/app/index.tsx`, plus shared chip components
only if a repeated token style is the problem.

**Try first:**

- Make metadata chips quieter before removing them.
- Consider fewer visible tags in card mode if every card looks equally loud.
- Keep the URL/open action scannable; do not hide the user's path to the source.

**Acceptance check:** a tester should be able to name the card's title first,
then metadata second. Tags should not compete with the title.

### Pass 3: Folder Shelf Loudness

**Goal:** keep the folder/filter row useful while making it less visually
dominant when many chips are present.

**Likely files:** `apps/mobile/src/ui/Chip.tsx`,
`apps/mobile/src/app/index.tsx`, and `apps/mobile/src/ui/ShelfEdges.tsx` if edge
affordances are part of the issue.

**Try first:**

- Soften count treatment or inactive chip contrast.
- Tune chip padding/gap only within stable dimensions; avoid hover/label changes
  that shift layout.
- Leave the active chip clearly discoverable.

**Acceptance check:** the shelf should still explain the current scope at a
glance, but it should not be the first thing the eye keeps returning to.

### Pass 4: Empty/Short Card Rhythm

**Goal:** make text-only or short-preview cards stop creating awkward visual
holes in the grid.

**Likely files:** `apps/mobile/src/app/index.tsx`; storage/domain code should
not be needed.

**Try first:**

- Adjust text-only card treatment, placeholder height, or card body rhythm.
- Keep masonry-like unevenness acceptable; do not invent a new layout engine for
  this pass.

**Acceptance check:** a short item such as a plain article link should feel like
an intentional compact card, not a broken missing thumbnail.

## Verification Checklist For Each Preview

- Open a PR and use the Cloudflare Workers preview URL; do not test visual
  experiments on production `main`.
- Smoke routes with curl: `/`, `/settings`, `/bookmark/abc`, and
  `/manifest.webmanifest` should return `200`.
- Inspect at desktop width first, then a phone-width viewport to ensure cards,
  chips, and toolbar controls still fit.
- Compare against current production with the same saved data where possible.
- Run `corepack pnpm --filter mobile typecheck`.
- Run a focused component test only if the change touches behavior or shared
  component contracts; pure spacing tweaks usually do not need broad tests.

## Stop Conditions

- Stop and ask for visual review after one coherent preview pass.
- Stop if the proposed fix requires changing sync, storage, auth, or metadata
  semantics; visual polish should stay in UI/layout code.
- Stop if the change starts becoming a navigation redesign. That belongs in the
  broader next-gen UX track, not this polish lane.

## Preview Rule

For visual experiments, use a Cloudflare Workers preview first:

1. Branch and open a PR.
2. Wait for the Workers preview URL.
3. Share the preview for browser inspection.
4. Merge only after the visual direction is accepted.

Production `main` should receive the confirmed result, not serve as the test
surface.
