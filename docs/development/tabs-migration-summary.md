# `(tabs)` navigation migration — summary (feature-complete)

Status as of 2026-07-05. The bottom-`(tabs)` navigation migration is **feature-complete on the `claude/keepory-tabs-migration` branch**. Per direction, the whole migration is developed on this one branch and **not merged to `main` piecemeal** — it merges as a single reviewed unit when ready. (An earlier attempt to land the tab shell directly in `main` via #358 was intentionally reverted in #360.) This doc doubles as the eventual merge-PR body; the buildable plan it executed is in `tabs-migration-plan.md`.

## What shipped (PR1–PR6, all on the branch)

| Step | Change |
|---|---|
| **PR1** | expo-router bottom-`(tabs)` shell — `Inbox · Library · Tags`, anchored rounded-top bar (Variant B). Inbox moved to `(tabs)/index.tsx` (URL `/` unchanged); `add`/`settings`/`bookmark/[id]`/`report`/`trash`/`review`/`graph` stay parent-stack modals/pushes **over** the tabs. |
| **PR2** | Extracted the Inbox's inline facet-pill UI into a reusable `src/ui/FacetPills.tsx` — pure refactor, byte-identical behavior. |
| **PR3** | **Library** tab — the "everything you've kept" browse home (never empties): collection rows with content-fingerprint subtitles (`{N} items · last added {relative} · {topSite when ≥2 share}`, real data only), an "All items" row; tap → Inbox scoped to that collection. Pure, Node-tested `collection-fingerprint.ts`. |
| **PR4** | **Tags** tab — the whole-library topic index: frequency-ranked tag list with counts; tap → Inbox scoped to that tag. Reuses the existing `countTagsForBookmarks`/`buildTagCloud` domain functions; `browse/tags.tsx` untouched (still the Inbox's browse-by-tag drill-in). |
| **PR5** | Shared `TabHeaderActions` cluster (search + settings top-right on all three tabs; the Inbox's lone gear consolidated in). Neutral **un-triaged count badge** on the Inbox tab — muted (`palette.border`), **never a red alert**, **hidden entirely at zero** — a queue that can reach inbox-zero, per the "no debt number" bet. Pure `countUntriaged` helper. |
| **PR6** | The **✨ Suggested review lens** — AI-suggestion review is a transient `{kind:'suggested'}` Inbox filter, not a `/review` screen. Tapping the suggestions banner enters a "Reviewing suggestions" scope (X / hardware-back to exit) filtering to items with pending suggestions. One `hasPendingReview` predicate backs the banner count, the per-card ✨ badge, and the lens, so they can't disagree. `review.tsx` stays reachable from Settings as the fallback. |

## Design decisions honored
- **Three dwell tabs** (`Inbox · Library · Tags`), search + settings as top-right icons, **no "You" tab**, **no Search tab** — search is the icon.
- **Inbox = a queue that reaches zero** (neutral count, hidden at 0); **Library = a shelf that never empties**. Same data, two jobs.
- **Per-section controls, not a global pill row** — each tab keeps its own left side; only the right-actions cluster is shared.
- **AI review is a lens, not a tab or a blocking queue.**

## Verification
Every step verified green on the branch: `tsc --noEmit`, root `pnpm lint` (format/env/overlay), the web export (`expo export --platform web`), and the component + domain test lanes — **~290 `test:components` tests** plus the pure-logic Node lane (`collection-fingerprint`, `untriaged`-via-badge, `filter`). Branch CircleCI (`ci`) is green. Real web renders of all three tabs + the lens were reviewed.

## Deliberately deferred (follow-ups, not blockers)
- **Ambient suggestion chips** — the doc's layer-1 "swipe-away suggestion chips on every card" is not built; PR6 shipped only the lens. Natural next feature.
- **Retrieval-taps metric** — the guardrail from the design review (instrument median taps from cold-open to opening a target bookmark via Library/Tags, using the existing breadcrumb infra) is **not yet wired**. Worth adding to prove the nav lowers taps-to-find before/after merge.
- **Search destination** — search is currently the icon → the Inbox's existing inline search; the fuller "search as a place with recent history, scoped by facet" is a later enhancement.
- **Floating bar (Variant A)** — shipped as the anchored Variant B; the floating look is a later pure-visual upgrade (custom `tabBar` + `paddingBottom = barHeight + insets.bottom`). `TAB_BAR_HEIGHT` is already exported for it.
- **Native on-device verification** — all validation so far is web render + Node/RNTL tests. Safe-area, the collapsing header per tab, and tab-bar layout should be checked on the emulator / an APK before shipping (web fidelity ≠ native).
- **Minor cleanup** — `inbox.settingsA11y` i18n key is now unused (its gear moved into the cluster).

## Merging
When ready, this branch merges to `main` as **one PR** (not piecemeal), reviewed as a whole.
