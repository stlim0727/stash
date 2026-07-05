# `(tabs)` navigation migration — build plan

Plan for moving Keepory from its single-`Stack` navigation to an expo-router bottom-`(tabs)` layout. Design is settled in `docs/design/keepory-next-gen-ux-brainstorm.md` ("Bottom tabs — final shape"); this is the buildable path. Grounded in the code as of 2026-07-05.

## Target

- **Bottom bar = 3 dwell tabs: `Inbox · Library · Tags`**, anchored rounded-top style (Variant B), with a neutral un-triaged count on Inbox that can reach zero (never a red alert badge).
- **Search + Settings = two top-right header icons** (search scoped by the active facet, with recent history; settings opens the existing screen). No "You" tab, no Search tab.
- **Capture FAB** stays. `add`, `settings`, `bookmark/[id]`, `report`, `trash`, `review`, `graph` stay in the **parent** stack, presented as modals/pushes **over** the tabs.
- **Inbox** = current `src/app/index.tsx`. **Library** = new (all kept, browse by collection, content-fingerprint subtitles). **Tags** = adapted from `src/app/browse/tags.tsx`.
- **Per-section pills**: extract inline `FacetChip`/`BrowseChip` into a reusable component fed a chip array by the active tab. No new global pill row.
- **AI-suggestion review** = a transient "✨ Suggested" lens/filter reached from the Inbox banner, not a tab.

## Current-state map (file:line)

- **Routing** — one `Stack` in `src/app/_layout.tsx` (`RootStack`, L47–63). `index` is root (`headerShown:false`, L49). `add` is `presentation:'modal'` (L51); `settings` is `transparentModal` + fade (L52–55); `review`/`report`/`trash`/`browse/tags`/`graph`/`bookmark/[id]` are plain pushes (L56–61). Providers wrap it in `RootLayout` (L66–89).
- **Inbox** (`src/app/index.tsx`) — exits via `router.push('/settings')`, `/add` (FAB), `/browse/tags?scope=…`, `/review`, `/graph`. `FacetChip` interface (L132) + memoized `BrowseChip` (L350) render the browse shelf. Collapsing header via `scrollY` → `Animated.diffClamp` (L614–650); list `paddingBottom: insets.bottom + 96` (~L1800). Back-peel: `useFocusEffect` + Android `BackHandler`, peels query then facet, returns `false` only when un-narrowed (L1174–1193). Facet hand-off consumes `params.tag/collection` + nonce on focus (L767–797). All imports use the `@/` alias (move-safe).

## Target route tree

```
src/app/
  _layout.tsx          # parent Stack — providers UNCHANGED; swap index → (tabs); rest unchanged
  (tabs)/
    _layout.tsx        # <Tabs headerShown:false> + Variant-B bar; exports TAB_BAR_HEIGHT
    index.tsx          # Inbox — moved verbatim
    library.tsx        # NEW
    tags.tsx           # adapted from browse/tags.tsx
  browse/tags.tsx      # KEEP during transition (scoped drill-in still pushed from Inbox)
  add.tsx settings.tsx review.tsx report.tsx trash.tsx graph.tsx bookmark/[id].tsx  # unmoved
```

Parent line: `<Stack.Screen name="index" …>` → `<Stack.Screen name="(tabs)" options={{ headerShown:false }} />`. All other `Stack.Screen`s stay — so they present over the tabs (siblings of the group, not inside it). A `(tabs)` group folder does not change the URL, so Inbox stays `/` and `settings.tsx`'s `usePathname()==='/settings'` check still holds.

## Ordered, independently-shippable steps

| PR | Lands | Files | Verify |
|---|---|---|---|
| **1 — Tab shell** | `git mv index.tsx → (tabs)/index.tsx`; new `(tabs)/_layout.tsx` (Variant-B bar); stub Library/Tags; flip parent line; repath test import; raise Inbox list/FAB padding by `TAB_BAR_HEIGHT` | `_layout.tsx`, `(tabs)/*`, `inbox-screen.test.tsx` | typecheck · `test:components` · `expo export --platform web` · FAB→/add & gear→/settings open over the bar |
| **2 — Extract pills** | Lift `FacetChip`+`BrowseChip` into `src/ui/FacetPills.tsx`; Inbox imports it, behavior identical | `FacetPills.tsx`, `index.tsx` | existing chip/browse-shelf tests |
| **3 — Library tab** | Build `(tabs)/library.tsx` (all kept, by collection, content-fingerprint subtitles) on the store surface + `FacetPills` | `(tabs)/library.tsx` | new `library-screen.test.tsx` |
| **4 — Tags tab** | Port `browse/tags.tsx` into `(tabs)/tags.tsx` (title in-screen, no native header); repoint tag taps to the Inbox tab; keep `browse/tags.tsx` for the scoped push | `(tabs)/tags.tsx` | adapt `browse-tags-screen.test.tsx` |
| **5 — Header icons + count** | Search + settings top-right icons per tab; Inbox neutral un-triaged count that reaches zero | `(tabs)/_layout.tsx`, headers | `tab-bar.test.tsx` (count → 0, not alert-styled) |
| **6 — ✨ Suggested lens** | Turn the Inbox review banner into an in-Inbox `{kind:'suggested'}` filter instead of pushing `/review`; keep `review.tsx` as fallback | `index.tsx` | lens test + `review-screen.test.tsx` |

## Known-hard bits + mitigations

- **(a) Modals over tabs** — already parent-stack siblings; keeping them out of `(tabs)/` is the fix.
- **(b) Back-peel + "root"** — the peel handler runs via `useFocusEffect`, so it only fires while Inbox is focused — keep it. Leave `<Tabs backBehavior>` default (`firstRoute`) so back from Library/Tags lands on Inbox, not app-exit. `inbox-back-handler.test.tsx` guards it.
- **(c) Collapsing math per tab** — `headerShown:false` on `<Tabs>`; inject no shared insets; each tab keeps its own `scrollY`/`diffClamp`. Don't wrap tabs in a shared header.
- **(d) Bar overlaps content** — export `TAB_BAR_HEIGHT`; raise each list's `contentContainerStyle` paddingBottom and lift the FAB above the bar.
- **(e) lint:overlay** — the bar sets `elevation` alongside any `zIndex`; `scripts/check-overlay-elevation.mjs` runs in `pnpm lint`.

## Retrieval-taps metric (the guardrail)

New `src/observability/retrieval.ts`: on cold-open emit a breadcrumb and reset a tap counter; increment on every tab press and facet/collection/tag drill (hook `FacetPills.onSelect` + tab-bar press); when a bookmark opens (`markBookmarkAccessed`, index.tsx ~L1263) emit `trackBreadcrumb('retrieval','open',{ taps, via:'library'|'tags'|'inbox' })`. Median computed offline from the breadcrumb stream — counts only, no PII (matches the "counts-never-names" rule). Purpose: prove Library/Tags lower median taps-to-find vs. today's search-only path, or the nav is just chrome.

## Open item to confirm in PR1

Whether `browse/tags.tsx`'s `router.dismissTo('/')` (L191) still delivers its facet param to the Inbox tab through the tabs navigator. If not, repoint to `router.navigate({ pathname:'/(tabs)', params })` and re-verify the L767–797 consumer fires on tab focus.
