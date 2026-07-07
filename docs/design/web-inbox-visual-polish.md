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

## Preview Rule

For visual experiments, use a Cloudflare Workers preview first:

1. Branch and open a PR.
2. Wait for the Workers preview URL.
3. Share the preview for browser inspection.
4. Merge only after the visual direction is accepted.

Production `main` should receive the confirmed result, not serve as the test
surface.
