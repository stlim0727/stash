# Settings — Activity status redesign (jitter, compact strip, diagnostics)

> Historical design. The compact chip presentation was superseded on
> 2026-08-05 by [Settings background-processing counters](settings-processing-counters.md).

Status: **specced, ready for mobile-ui-engineer**
Owner: Product & UX
Surface: `apps/mobile/src/app/settings.tsx` — the "Account & sync" card's
sync-breakdown rows (`syncStages` / `showSyncBreakdown`), currently under the
Account section header
Related: `docs/design/search-suggestion-shelf.md` §6 (reveal/dismiss timing
precedent, `Animated` not Reanimated), STASH-4W (sync pipeline breakdown,
PR #670), the AI backlog counter fix (commit `88ff0b1`)
Size: small (remove one stage from the breakdown, replace 1–3 stacked `Row`s
with one compact chip strip, add show/hide hysteresis)
Preview: hand-drawn before/after comparison generated via the `ui-preview`
skill (English glosses — the sandbox has no Korean-capable font — but spacing,
card height, and chip fit are drawn from the real theme/layout constants).
Confirms the compact strip visibly shortens the card versus stacked rows and
that two chips fit on one line with room to spare.

---

## 1. What's actually wrong (root-caused, not just described)

The current breakdown renders up to three conditional `Row`s under the sync
headline: `uploading`, `fetchingInfo`, `aiSuggestions` (`settings.tsx:795-817`,
`984-1034`). Reading the code against the real user report:

**The "duplicate row" the user saw is not a display bug — the `uploading`
stage is *structurally* redundant with the headline in every state it can ever
appear in.** The headline's `syncSummary` (`settings.tsx:741-751`) already
encodes the exact same upload count in all three of its non-empty branches:
`pausedWaiting` ("일시 정지됨 · N개 대기"), `syncing` ("N개 항목 동기화 중…"),
and `waiting` ("N개 항목 업로드 대기 중"). The only state where upload count is
0 is `allBackedUp`/`localOnly`, and a 0 count never renders the stage anyway
(`.filter(stage => stage.count > 0)`). So **whenever the `uploading` stage
would show a number, the headline is already showing that same number a few
pixels above it** — there's no state where the sub-row adds information. The
existing code even carries a comment acknowledging this exact tension (a
"solo uploading" stage is suppressed) but doesn't go far enough — it still
shows the duplicate the moment a *second* stage (metadata or AI) is also
non-zero, which is exactly the screenshot the user filed.

**Fix: drop the `uploading` stage from the breakdown entirely.** Its job is
already fully done by the headline. This isn't a display tweak, it's cutting
dead information — and it also collapses the max stage count from 3 to 2,
which directly helps the "compact" ask (§3) and removes the biggest source of
row-mount/unmount churn (§2).

The **jitter** itself (rows appearing/disappearing as counts flap 0↔1) is a
UI-side amplifier on top of a count-instability bug domain-sync-engineer owns
separately. Regardless of when/whether that root cause is fixed, the UI must
stop translating every transient flap into a full-height row insert/remove —
that's a UI responsibility on its own merits (§2).

## 2. Layout: replace stacked rows with one compact chip strip

**Structural change:** replace the `syncStages.map(...)` block that renders
0–3 full-height `Row`s (each ~58px, icon + two-line text + divider) with a
**single, fixed-position "activity strip"** directly under the sync headline
row — one shorter row (~50px) containing 0–2 small pill chips laid out
horizontally, not stacked vertically.

Why this kills the jitter at the layout level (independent of the count
debounce in §2.1): today, each pipeline getting/losing work changes *which
rows exist*, and each row is a full block-level element with its own height,
so the whole card (and everything below it in the ScrollView) shifts by a
multiple of ~58px per flap. In the redesign, individual chips enter/leave a
single flex row whose own row slot is comparatively short and whose neighbors
(chips) reflow *within* that one row — collapsing worst-case shift from
"up to 174px, three times over" (three rows independently flapping) to, at
most, one strip mount/unmount transition (§2.1) or a same-row chip reflow
that never touches anything outside the strip.

**Placement & sizing** (see preview):
- Sits directly below the sync headline row, still inside the same `Card`.
- Left inset matches the headline's *text* column, not its icon — i.e.
  `paddingLeft` = `iconWrap` width (32) + row gap (12) + row's own
  `paddingHorizontal` (14) = **58px** from the card edge. This reads as "a
  detail of the Sync row" rather than a new independent row with its own
  icon slot.
- Row height ~50px (8px vertical padding + chip's own 34px height + 8px), a
  deliberate reduction from a full `Row`'s 58px.
- No divider below it — it's the last element in the card (`Row`'s `last`
  prop moves from `!showSyncBreakdown` to `!showActivityStrip`, same
  mechanism, new name).
- If the strip has nothing to show, it renders nothing (no empty reserved
  slot) — same behavior as today for the common "all backed up" case, so nothing
  changes for the majority-of-the-time happy path.

**Chips**: reuse the existing `Chip` component (`@/ui/Chip`) rather than
building new pill styling — it already has exactly this shape (icon + label +
muted `· count`, pill outline, `default`/`quiet` variants using
`palette.border`/`palette.surface`/`palette.textSecondary`).

| Chip | icon | label (reuse existing i18n keys) | count source |
|---|---|---|---|
| Metadata | `document-text-outline` | `settings.syncBreakdown.fetchingInfo.label` ("정보 가져오는 중" / "Fetching info") | `diagnosticStats.metadata.todo` |
| AI | `hourglass-outline` | `settings.syncBreakdown.aiSuggestions.label` ("AI 추천" / "AI suggestions") | `aiCount` (unchanged: `activeBlocked`/`activeUnblocked` per existing gating logic) |

No new copy strings are needed for the normal case — pass the label as
`children` and the number via `Chip`'s `count` prop (renders `label · count`
in the established muted-secondary style), which also **visually shortens**
the text versus today's full sentence rows ("정보 가져오는 중: 12개" → chip
"정보 가져오는 중 · 12"). Component render, not just presentation choice: use
`variant="default" quiet` (subdued, non-interactive-looking) — **not**
`accent`/`selected`, which read as tappable/primary and these chips are pure
status display with no `onPress`.

**AI-quota-reached is a distinct state, give it a distinct look, not just
text.** Today's `valueQuotaReached` copy variant ("· 할당량 초과") stays too
subtle once shrunk into a small chip's secondary-color count text — a
blocked/actionable state deserves to be visually distinguishable from "still
working," not just differently worded. When `aiQuotaReached` is true:
- Render the AI chip with `icon="timer-outline"` instead of
  `hourglass-outline` (already the icon used by the existing
  `aiQuotaExceeded` row elsewhere in Settings — consistent glyph for "you're
  waiting on a timer, not active work").
- Use `highlightSoft`/`highlight` tinted background+border (the same soft-gold
  token the palette already reserves for this register, e.g. Folder View's
  tile coloring) instead of the neutral `border`/`surface` pair — a plain but
  real color signal that this chip means "blocked," not "processing."
- Drop the numeric `count` in this state and put the reason in the label text
  instead: reuse `settings.syncBreakdown.aiSuggestions.valueQuotaReached`'s
  *reason*, rephrased to a standalone chip label, e.g. "AI 추천 · 할당량 초과"
  (label text includes the reason; do not pass a `count`, since "how many
  items" is not the useful fact once the user is blocked — "why blocked" is).

**Overflow / wrap fallback (be honest about width limits):** at typical
device widths with the real (short) Korean copy, two chips fit one line with
room to spare (confirmed in the preview at 340px card width using
English-length glosses, which are *wider* than the real Korean strings). But
this can't be guaranteed for every width × Dynamic Type combination. Set
`flexWrap: 'wrap', rowGap: 8` on the strip's container so that if it ever
can't fit, it wraps to a **second line within the same strip container**
(bounded max 2 lines) rather than clipping or forcing horizontal scroll. This
preserves the "no full-row jitter" guarantee even in the worst case — a
2-line wrap is still a single, self-contained, low element, not new stacked
`Row`s pushing the rest of the card down by a full row height each. Run this
wrap reflow through the same `LayoutAnimation` call as chip insert/remove
(§2.1) so a wrap transition (e.g. from large system font) also animates
instead of snapping.

### 2.1 Animation & hysteresis spec (kills the flap-driven flicker)

Two independent mechanisms, both required:

**A. Debounced visibility per chip — "show instantly, hide patiently."**
Each chip's visibility is driven by a debounced boolean, not the raw
`count > 0`:
- **Show edge (0 → positive): no delay.** New work appearing should feel
  immediate — this is the same "capture is sacred" responsiveness principle
  applied to status feedback: don't make a real state change feel laggy.
- **Hide edge (positive → 0): delay ~2000ms**, and reset the timer if the
  count goes positive again before it elapses. This is the actual fix for
  "카운트가 1이 0되었다 1되었다" — a genuine rapid flap (sub-second to a few
  seconds, whatever domain-sync-engineer's root-cause turns out to be) never
  surfaces as a visible mount/unmount, because the chip only *actually*
  disappears after 2 full seconds of the count staying at zero. 2s is
  imperceptible as "laggy" for a background status indicator (nobody stares
  at Settings waiting for a chip to vanish) but comfortably absorbs a flap
  storm.
- Implement as one small reusable piece (e.g. a `useDebouncedFlag(raw: boolean,
  { hideDelayMs: 2000 })` hook) used identically for both chips — don't
  special-case per pipeline.
- **Scope discipline:** this hysteresis applies to chip *presence* only, not
  to the displayed *number*. If the count itself changes value while the chip
  stays mounted (12 → 11), just re-render the new number immediately — a
  changing digit inside a chip that isn't moving is normal, expected feedback
  and causes no layout shift worth smoothing. Do not build a second smoothing
  layer for the number; that would be solving a problem nobody reported.

**B. Animate the transitions that do happen**, so even a real (non-flappy)
mount/unmount/reflow reads as a reveal, not a jump-cut:
- Strip mount/unmount (0 chips visible ↔ first chip becomes visible): fade +
  height transition, matching the existing precedent in
  `SearchSuggestionShelf` (`Animated.timing` on a container, ~140ms reveal /
  ~120ms dismiss — this repo does not have Reanimated, use core `Animated`
  for consistency, not a new dependency).
- Chip insert/remove/reflow within the strip (one chip appears/disappears
  while the strip itself stays mounted, or the wrap fallback kicks in):
  `LayoutAnimation.configureNext(LayoutAnimation.create(180, 'easeInEaseOut',
  'opacity'))` called immediately before the state update that changes which
  chips are debounced-visible. This is the standard low-effort RN way to
  animate a flex-row child's insertion/removal with automatic sibling reflow,
  and is simpler here than hand-rolled `Animated.Value` width interpolation
  per chip. **Verify on the Android emulator** — New Architecture (Fabric,
  which this app runs under RN 0.85) supports `LayoutAnimation` without the
  old `UIManager.setLayoutAnimationEnabledExperimental` flag, but confirm the
  actual on-device feel before shipping; fall back to a manual `Animated`
  crossfade per chip if it's inconsistent.

## 3. Compact single-line spec (concrete visual answer)

Confirmed by the preview: this is exactly what §2's chip strip already does
— the "compact multi-counter, one line" ask **is** the redesign in §2, not a
separate treatment. To restate the concrete visual answer explicitly for
implementation:

- One horizontal row, two chips max (`Info`/metadata, `AI`), 10px gap between
  chips, no divider, ~50px row height.
- Each chip: 13px icon, 13px/700-weight label, count rendered via `Chip`'s
  built-in muted `· N` suffix (not baked into the label string) — this is
  what makes it read as compact rather than a shrunk sentence.
- No full label sentences ("정보 가져오는 중: 12개") inside the compact form —
  those exact phrases stay as the `Chip`'s `label` prop verbatim (reusing the
  existing i18n key content, just re-hosted from a `Row`'s `value` into a
  `Chip`'s `children`), the `· count` is what's new/shorter.

## 4. Diagnostics section: keep separate, do not merge or relocate

**Recommendation: no change to the Developer-mode Diagnostics section** — not
its position, not its numbers, not proximity to Activity status. Reasoning:

1. **The two counts are intentionally different facts**, not the same fact
   shown twice. Activity status = deduplicated, blocked-aware, user-relevant
   "how much *unblocked* work is left" (excludes permanently-unsyncable URLs,
   collapses AI's four local source-sets via `activeUnblocked`/`activeBlocked`
   Set-union so a bookmark counted in two sources isn't double-counted, and
   folds in the server-side backlog blind-spot fix from commit `88ff0b1`).
   Diagnostics = raw `todo`/`done` per pipeline, deliberately *not*
   deduplicated or blocked-aware, because its entire purpose is exposing the
   literal internal state for debugging — collapsing it to match the
   user-facing number would defeat the reason it exists. domain-sync-engineer
   already declined to merge these into one summed figure for the same
   reason (upload/metadata/AI have different possible user actions); that
   reasoning applies equally to *visual* merging, because a merged card
   invites reading the two numbers as comparable even when their footnote
   says not to.
2. **Diagnostics is deliberately buried** behind the `settings.developer`
   toggle specifically so raw internals stay out of the 99% of users who
   never touch it. Moving it — or even just visually relocating it — next to
   a normal-user-facing card partially defeats that separation: the small
   fraction of users who *do* open Developer mode would now see two
   similar-shaped counters sitting close together and have to resolve the
   difference via a footnote, which is a worse reading experience than two
   counters that are visibly in different registers (one in a plain user
   card near the top, one in a monospace-feeling raw diagnostics block near
   the bottom, already captioned as raw).
3. **The impulse likely traces to the *actual* duplicate**, not a genuine
   need to compare the two sections. The user's own screenshot and complaint
   were about the *headline vs. `uploading` row* duplicate (§1) — once that's
   gone and the breakdown is a clean compact strip, the visual "why do I see
   overlapping numbers twice on this screen" trigger that prompted the
   grouping suggestion should mostly disappear on its own. I'd rather ship
   §1–§3, let the user re-evaluate with the redundancy actually gone, and
   revisit merging only if the ask persists once the real duplicate is fixed.
4. If, after that, there's still a real desire for a debugging shortcut from
   Activity status → raw pipeline numbers, the lower-risk version is a single
   optional footnote under the Activity card, shown **only when Developer
   mode is already on**: "자세한 원시 수치는 아래 진단 섹션에서 확인할 수
   있어요" / "See raw per-pipeline counts in Diagnostics below." That's a
   pointer, not a merge — keeps the semantic separation, adds discoverability
   only for the audience that's already opted into seeing internals. Treat as
   optional/deferred, not part of this pass.

## 5. i18n changes

No new keys required for the base chip strip — reuses
`settings.syncBreakdown.fetchingInfo.label` and
`settings.syncBreakdown.aiSuggestions.label` (EN + KO already present in
`messages.ts`/`ko.ts`). `settings.syncBreakdown.uploading.*` keys become
unused once the `uploading` stage is removed — leave them in the i18n files
(don't delete keys as a side effect of this change; that's a separate
cleanup call, not required for this ticket) unless mobile-ui-engineer's own
lint flags unused keys as an error.

One new key needed for the quota-reached chip label (§2, distinct from the
existing sentence-form `valueQuotaReached`, which reads wrong once `count` is
dropped from that state):

| Key | EN | KO |
|---|---|---|
| `settings.syncBreakdown.aiSuggestions.chipQuotaReached` | `AI suggestions · quota reached` | `AI 추천 · 할당량 초과` |

## 6. Sign-off checklist (Product/UX, before merge)

- [ ] The `uploading` stage is gone from the breakdown entirely — confirm by
      triggering a real sync with only uploads pending: the headline shows
      the count and **no** second row/chip repeats it.
- [ ] Metadata-pending and AI-pending render as chips in one strip, not
      stacked full rows; strip sits left-aligned under the headline's text
      column (58px inset), no divider below it.
- [ ] Force a rapid 0↔1 flap on one pipeline's count (dev-only toggle or
      mock) and confirm the chip does **not** blink out — it should stay
      visible through the flap and only truly hide after ~2s of sustained
      zero.
- [ ] New chip mount, chip removal (after real settle-to-zero), and the whole
      strip's first appearance/disappearance all animate (fade/height or
      LayoutAnimation reflow) — no instant snap/jump in the ScrollView.
- [ ] AI-quota-reached renders as a visually distinct (tinted, timer icon,
      no count) chip, not the same neutral pill with different text.
- [ ] Force a 2-chip overflow (large system font / narrow width) and confirm
      it wraps to a second line inside the strip, animated, rather than
      clipping, horizontally scrolling, or reintroducing stacked-row jitter.
- [ ] Developer-mode Diagnostics section is untouched — same position, same
      raw numbers, same footnote.
- [ ] Dark mode: chip border/background uses `palette.border`/`palette.card`
      (or `highlightSoft` for the quota state) correctly — check both themes.
- [ ] KO copy reads natural; reused strings match their existing usage
      elsewhere in Settings (no new tone).
