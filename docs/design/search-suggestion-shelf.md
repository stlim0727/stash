# Search Suggestion Shelf — Design Spec

Status: **Phase 1 built & merged (`claude/search-functionality-issue-0w993x`); Phase 2 (live filter) specced & ready to build — see §13**
Owner: Product & UX
Surface: Inbox (`apps/mobile/src/app/index.tsx`)
Related: `docs/design/ux-spec.md` §11 (Search & editing), §2 (browse facets); `AGENTS.md`
Mocks: `scratchpad/phase1-shelf.png` (Phase 1 focused-empty, light + dark), `scratchpad/phase2-shelf.png` (Phase 2 typing-with-matches, light + dark), `scratchpad/search-assist.png` (earlier exploration: typing-preview + overlay ideas)

---

## 1. Why this exists

Today the Inbox search field is a bare text input. On focus the user faces an
empty box and a soft keyboard, with no hint of what's searchable or what they've
searched before. Raindrop-class apps make search feel *fast and guided* — you
tap into the field and the app already offers your most likely next move.

The **suggestion chip shelf** is that guided layer: on focus with an empty
query, a single horizontally-scrolling row of chips appears directly under the
field, offering the three things a paying user most often wants to jump to:

1. **Recent searches** they've run before (clock icon)
2. **Their top tags** (`#` prefix — user-authored)
3. **Their top folders** (folder-outline icon — user-authored)

One tap either **fills the query** (recents) or **applies a facet filter**
(tags/folders) — turning a cold search box into a warm shortcut shelf.

This shelf reuses the exact vocabulary the existing **browse shelf** already
established (`Chip`, `FacetChip`, `folder-outline`, `#`-prefixed tags), so it
reads as a natural extension of a pattern the user already knows, not a new
mechanism.

---

## 2. Product principles this must honor (non-negotiable)

- **Capture is sacred / read-only.** The shelf is built **entirely from
  already-loaded in-memory data** (`inbox`, `getTagsForBookmark`, `collections`,
  and the recent-searches list persisted in the meta store). Focusing the field
  or typing a key **must never trigger a network fetch, a sync, or an
  enrichment**. It is a pure projection of state the screen already holds.
- **User-authored fields stay sacred.** The shelf surfaces **only**:
  - the user's **own recent search strings**,
  - **user-applied tags** (the same `buildTagCloud` input the browse shelf and
    cloud already use — tags actually attached to bookmarks), and
  - **user folders** (collections that contain at least one inbox bookmark).
  It must **never** surface AI-suggested-but-unaccepted tags, a model's proposed
  collection name, or any generated field dressed as a user value. There is no
  "did you mean" / AI layer in Phase 1 — that's Phase 3, and it carries its own
  distinct, clearly-generated styling (mirroring the existing `showSiteChip`
  outlined-neutral rule, never the filled accent chips).

---

## 3. Where it lives (the hit-test rule — read this first)

The Inbox header is an **absolutely-positioned, `translateY`-animated cluster**
(`styles.header`, `zIndex: 10`) that slides up as the list scrolls. The browse
shelf already lives **inside** that cluster, immediately after the `sortRow`.

> **The suggestion shelf MUST be rendered inside the same `Animated.View`
> header cluster, directly under `styles.searchWrap`** — not as a floating
> overlay positioned over the list.

Reasoning: a separately-positioned overlay reintroduces exactly the native
hit-test trap flagged in `index.tsx` (the "tag-cloud chips go dead after
narrowing to a folder on Android" breadcrumb trail around line 645). Anything
that floats over the `Animated.FlatList` outside the header's own view tree
risks unhittable touches on Android. By living **inside** the header cluster the
shelf:

- translates with the header (it's part of the same transform),
- inherits the header's opaque background and z-order,
- and its chips reach JS the same way the browse-shelf chips do.

**Header height grows by the shelf's height while focused.** The header measures
itself via `onLayout` → `setHeaderHeight`, and the list's `paddingTop` keys off
`headerHeight`. Because the shelf mounts/unmounts inside the cluster, the
existing `onLayout` already re-measures and the list padding re-flows. The one
caveat (see §6 Animation) is that we want this height change to feel like a
smooth reveal, not a jump.

**Mutual exclusion with the browse shelf.** The browse shelf (facet filters) and
the suggestion shelf occupy the same slot conceptually. Rule:

- **Field focused + empty query → show the suggestion shelf, hide the browse
  shelf.** (The user is in "search intent" mode; offer searches, not the
  persistent facet bar.)
- **Field blurred (or non-empty query) → show the browse shelf as today.**

This keeps the header from stacking two chip rows and keeps each mode's row
meaning unambiguous.

---

## 4. Visual states

All spacing/tokens below reuse existing constants. The shelf row reuses
`styles.shelf` / `styles.shelfContent` (minHeight 42, `marginTop: 8`,
`paddingHorizontal: 16`, `gap: 8`, `alignItems: 'center'`) — the same floor that
keeps a horizontal `ScrollView` from collapsing on Android and lets a chip grow
to taller system fonts. Chips are the existing `Chip` component.

### 4.1 Focused-empty (the Phase-1 state — shelf shown)

Layout, top to bottom inside the header cluster:

```
[ hero: Stash wordmark · tagline · "128 saved" · settings ]
[ searchWrap: TextInput — FOCUSED ]
[ shelf affordance label: "JUMP TO" (uppercase, textSecondary, 11pt) ]   ← optional, see §5
[ suggestion shelf: ◷ recent · ◷ recent · #tag · #tag · ▭ folder · ▭ folder  → scrolls ]
[ (sortRow + browse shelf are HIDDEN in this state) ]
```

- The **affordance label** is the same `styles.sortCaption` treatment already
  used for "Browse" (`fontSize 13, weight 600, uppercase, letterSpacing 0.5`) —
  but one notch smaller (11pt) so it reads as a quiet section hint, not a
  control. Sits at `paddingHorizontal: 16` to align with the chips.
- The **shelf** is a single horizontal `ScrollView` (`horizontal`,
  `showsHorizontalScrollIndicator={false}`), `testID="search-suggestion-shelf"`,
  reusing `styles.shelf`/`styles.shelfContent`.
- **Chip families and their glyphs** (all `Chip variant="default"`):
  - **Recent search** → `Chip icon="time-outline"`, label = the raw query string
    the user typed (e.g. `디자인`). (`time-outline` is the clock glyph already in
    the codebase's icon vocabulary — see `SORT_ICON.accessed`.)
  - **Top tag** → `Chip` (no icon), label = `#${name}` — identical to the browse
    shelf's tag chips.
  - **Top folder** → `Chip icon="folder-outline"`, label = collection name —
    identical to the browse shelf's collection chips.
- **Ordering within the row:** recents first (most recent → oldest), then top
  tags (by frequency desc, the `buildTagCloud` order), then top folders (by
  bookmark count desc). Recents lead because they are the highest-intent "do this
  again" shortcut; tags/folders are discovery.
- **Right-edge scroll affordance:** the row scrolls horizontally; no explicit
  fade is required (the existing browse shelf doesn't use one). The mock shows a
  fade purely to illustrate overflow — **do not add a gradient component**; the
  partial last chip at the edge is enough signal and matches the browse shelf.
- The **result list underneath** stays live and visible (dimmed only by the
  keyboard, never by the shelf — the shelf is not a scrim).

### 4.2 No-recents-yet (first run / cleared history)

The user has never searched, so the recents group is empty. Behavior:

- **Show the shelf** as long as there is **at least one tag or folder chip**
  (i.e. the same `chips.length > 0` condition the browse shelf already gates on).
  Lead with tags/folders; simply omit the recents segment. No empty-state copy,
  no placeholder chips — an absent group is silently absent.
- **If there are also no tags and no folders** (a brand-new, empty library):
  **render no shelf at all** and no affordance label. The focused field with the
  placeholder `inbox.searchPlaceholder` is the whole experience — same as a fresh
  install's browse shelf, which is also empty. We never show an empty container.

### 4.3 Typing (changed by Phase 2 — full spec in §13)

In **Phase 1 (as built)**, the moment the query becomes non-empty the suggestion
shelf **hides** and the screen behaves exactly as today (the existing debounced
filter + "Matches (N)" section), with the browse shelf remaining visible while a
query is present (§9 Q1).

> **Phase 2 replaces this "hides on first keystroke" behavior** with a live
> in-shelf filter: matching tags/folders/recents narrow as you type and the
> shelf becomes an autocomplete rail rather than vanishing. The component is
> already shaped for this (the builder takes a `query` seam; the hook threads it;
> §13 turns the seam live). See **§13** for the complete Phase-2 spec, states,
> and decisions.

### 4.4 Blurred (hidden)

Field loses focus → suggestion shelf unmounts, browse shelf returns. No
animation requirement beyond §6. Tapping a suggestion chip also blurs/dismisses
the shelf as part of applying it (see §5 interactions).

### 4.5 Dark mode

Fully theme-driven via `usePalette()`; the `Chip` component already maps
`default` variant to `palette.surface` / `palette.border` / `palette.text`, and
selected to `accentSoft`/`accentText`. No hardcoded colors anywhere in the
shelf. Verified in the mock: chips read as quiet outlined pills on the dark
`#0b1220` background, icons inherit `palette.text`. The affordance label uses
`palette.textSecondary`.

---

## 5. Interaction details

### Tap-to-fill vs tap-to-facet rule

| Chip family | Tap action |
|---|---|
| **Recent search** | **Fill the query** — `setQuery(label)`. This runs the normal debounced text search. Keeps the keyboard up so the user can edit. Does **not** apply a facet. |
| **Top tag** | **Apply the tag facet** — `setFilter({ kind: 'tag', id })`, then **clear the query** (`setQuery('')`) and **blur** the field so the shelf closes and the facet-filtered list shows. Identical end-state to tapping that tag in the browse shelf. |
| **Top folder** | **Apply the collection facet** — `setFilter({ kind: 'collection', id })`, clear query, blur. |

Rationale: a recent **search** is a free-text query the user wants to re-run and
maybe tweak → fill, keep editing. A tag/folder is a **destination** → apply it
and get out of the way (mirrors the browse shelf exactly, so there's one mental
model for "tag chip = filter").

When a tag/folder chip applies a facet it must also reset the cloud-drill
context like the browse shelf does: `cloudReturnRef.current = null` (and drop out
of `cloud` view mode to `card` if currently in cloud, matching `renderChip` /
the routed-facet effect). Reuse the existing `renderChip` filter-apply path
where possible.

### On submit (keyboard "search"/return)

The user typed a query and hit return. Record it: **trim**, ignore if empty or a
duplicate of the most recent entry, then **prepend** to the recent-searches list
(dedupe case-insensitively, cap at **8**, drop the oldest). Submitting does not
otherwise change behavior — the debounced search already reflects the text. This
is the **only** write path for recents; we do **not** record on every keystroke
(that would fill history with prefixes).

### Dedupe & counts

- **Recents:** max **8** stored, max **6** shown in the shelf. Case-insensitive
  dedupe on the trimmed string; a re-search moves the entry to the front rather
  than adding a second.
- **Top tags:** take the top **8** by frequency from `buildTagCloud(...)` over
  the inbox's user tags.
- **Top folders:** take the top **8** collections by inbox-bookmark count.
- **Cross-family de-noise:** if a recent-search string is *exactly* a tag name
  or folder name already shown as a chip, still show both — they do different
  things (re-run text search vs. apply facet) and the icons disambiguate them,
  matching how the browse shelf already lets a `#tag` and a like-named folder
  coexist. (No extra logic needed.)
- **Total visible cap:** the row scrolls, so there is no hard total cap, but as a
  sane default render at most **6 recents + 8 tags + 8 folders**. Ordering keeps
  the highest-intent items first so the visible (un-scrolled) portion is the most
  useful.

### Accessibility

- Each chip is `accessibilityRole="button"`.
- Recent: `accessibilityLabel = t('search.recentChipA11y', { query })`.
- Tag: reuse the tag semantics — label announces `#name` (the visible label is
  fine; optionally `t('search.tagChipA11y', { name })`).
- Folder: `accessibilityLabel = t('search.folderChipA11y', { name })`.
- The shelf `ScrollView` gets `accessibilityLabel = t('search.shelfA11y')` so a
  screen reader announces the region's purpose ("Search suggestions").

---

## 6. Focus / blur animation

The collapsing header already has a calm, native-driver translate feel. The
shelf reveal should match that register — **a brief, soft reveal, not a bounce.**

- **On focus (empty query):** mount the shelf and the browse shelf unmounts in
  the same frame. Animate the shelf's **opacity 0→1 over ~140ms, ease-out**, and
  let the header's height change settle naturally as the cluster re-lays-out.
  140ms matches the existing `useDebouncedValue(query, 140)` rhythm and reads as
  "instant but intentional." Feedback is well within the ~100ms perceived-latency
  budget because the mount itself is synchronous; the fade is polish.
- **On blur:** opacity 1→0 over ~120ms, then unmount; browse shelf fades back in.
  Keep it slightly faster than the reveal so dismissals feel snappy.
- **Do not animate translateX or height of individual chips.** Keep it to a
  single container opacity to avoid fighting the header's existing
  `translateY` transform (two simultaneous transforms on the cluster is where
  jank and measurement races creep in).
- **Measurement:** because the shelf changes the cluster height, ensure
  `onLayout` → `setHeaderHeight` still fires after the mount (it will — the shelf
  is a child of the measured `Animated.View`). The list `paddingTop` reflowing by
  the shelf's ~70px is acceptable and expected; it happens once on focus and once
  on blur. If reviewers see the list "jump," fall back to animating the shelf
  container's `height` alongside opacity (LayoutAnimation.easeInEaseOut) — but
  start with opacity-only and measure.

Implementation note: a single `Animated.Value` driven by `Animated.timing`
(JS-or-native-driver opacity) on the shelf wrapper is enough. Don't reach for a
gesture/spring library.

---

## 7. Microcopy (EN + KO)

Hand-written natural Korean (not a calque of the English). Proposed i18n keys
(group: `search.*`, added to `src/i18n/messages.ts` and `src/i18n/ko.ts`):

| Key | EN | KO | Notes |
|---|---|---|---|
| `search.shelfAffordance` | `Jump to` | `바로가기` | The quiet section label above the shelf. "바로가기" = "shortcut/quick link", natural for "jump to". Uppercased in EN by style, KO renders as-is. |
| `search.shelfA11y` | `Search suggestions` | `검색 추천` | a11y region label on the ScrollView. |
| `search.recentGroupA11y` | `Recent searches` | `최근 검색` | Used if/when recents get a sub-grouping label (not shown in Phase 1, but reserve the key). |
| `search.recentChipA11y` | `Search again for "{query}"` | `"{query}" 다시 검색` | a11y for a recent chip. |
| `search.tagChipA11y` | `Filter by tag {name}` | `태그 {name}(으)로 거르기` | a11y for a tag chip. `(으)로` handles the Korean particle for both vowel/consonant endings gracefully. |
| `search.folderChipA11y` | `Filter by folder {name}` | `{name} 폴더 보기` | a11y for a folder chip. "폴더 보기" = "view the folder" — more natural than a literal "filter by". |
| `search.clearRecentsA11y` | `Clear recent searches` | `최근 검색 지우기` | Reserve for the Phase-1 "clear history" affordance if added (see §9 Q2); otherwise unused until then. |

The visible chip **labels** themselves are not new copy: recents show the raw
query, tags show `#${name}`, folders show the collection name — all
user-authored content, never translated.

KO tone check: "바로가기" and "최근 검색" are the standard terms Korean apps use
(e.g. browser quick-links, search history). "{name} 폴더 보기" reads like a
native app action, not a translated string.

---

## 8. Field-separation rule (explicit)

The shelf is a **user-authored-only** surface. It pulls from exactly three
sources, all of which are things the user did:

1. `recentSearches` — strings the user typed and submitted (persisted locally).
2. `buildTagCloud(...)` over **applied** tags — tags the user attached to
   bookmarks (the same input the browse shelf and tag cloud already trust).
3. Collections that contain ≥1 inbox bookmark — folders the user created/used.

It must **never** include:

- AI-suggested tags that haven't been accepted (`pendingSuggestions` output),
- a model's `suggested_collection_name`,
- generated site names, titles, or any `metadata_status`-derived value.

If/when generated suggestions enter this surface (Phase 3 "did you mean"), they
**must** be visually distinct — outlined/neutral, never the filled accent meta
chip — mirroring the existing `showSiteChip` rule in `index.tsx` (the site chip
is deliberately styled `borderColor: palette.border` / `backgroundColor:
palette.surface` so it "never reads as a user-typed value"). Phase 1 has no such
chips, so there is no styling ambiguity to manage yet — but the boundary is
stated here so it isn't crossed later by accident.

---

## 9. Open questions — RESOLVED (locked at Phase-1 sign-off)

All three questions below were resolved before mobile-ui built Phase 1. Each is
now implemented as stated.

- **Q1 — Browse shelf while typing. RESOLVED: keep it VISIBLE while typing.**
  Phase 1 hides the browse shelf only in the focused-EMPTY state (where the
  suggestion shelf takes its slot) and restores it on blur. While a *non-empty*
  query is being typed the browse shelf stays visible (lets the user pre-narrow
  by facet then search within it) — no behavior change beyond focus-empty. The
  suggestion-vs-browse mutual exclusion (§3) therefore applies only to the
  focused-empty state. Revisit in Phase 2, when the shelf itself becomes the
  live-filter surface. *Implemented: `showShelf = chips.length > 0 &&
  !showSuggestions`, and `showSuggestions` requires `query.trim() === ''`.*
- **Q2 — Clearing recents. RESOLVED: INCLUDE long-press-to-remove in Phase 1.**
  Long-pressing a recent chip removes just that one entry (no destructive
  confirm — it's a single search string); a bulk "Clear history" in Settings is
  deferred. The reserved a11y key (`search.clearRecentsA11y`) stays for that
  later bulk control; the per-chip remove uses `search.removeRecentA11y`.
  *Implemented via `removeRecent` + the shelf's `onRemoveRecent` long-press.*
- **Q3 — Privacy of recents. RESOLVED: LOCAL-ONLY, never synced.** Recent
  searches persist solely in the local meta store (`pref.search.recents`),
  consistent with `pref.inbox.sort` — never enqueued, uploaded, or sent
  anywhere. Search strings are user content and stay on-device. *Implemented:
  load/persist via `getPreference`/`setPreference` only; nothing touches the
  sync queue.*

---

## 10. Phases 2–4 (outline)

**Phase 2 — Live filter (the shelf reacts to typing). → FULLY SPECCED in §13.**
Replace Phase 1's "hide on first keystroke" with a live narrowing: as the user
types, the shelf's tag/folder/recent chips filter to those whose names contain
the (debounced) query, reordered best-match-first, so the shelf becomes an
autocomplete rail rather than vanishing. Tapping a filtered tag/folder chip
applies the facet; tapping a "matched recent" re-runs it. The data-source swap is
why ST-1 takes its suggestions as a prop/selector output rather than computing
them inline. Keep the result list live underneath (typing still filters it via
the existing debounced path), so the shelf and the list agree. No new
persistence; reuses the same `useSearchSuggestions` hook with the query threaded
in. **The implementation-ready section — every state, ranking, microcopy, and
the ticket breakdown — is §13 below.**

**Phase 3 — "Did you mean" ribbon (generated, clearly distinct).** When a query
returns **zero or few** results, offer a thin recovery ribbon above the empty
state suggesting a close user tag/folder ("Did you mean **#design**?") and,
optionally, a normalized/typo-corrected query. Critically, **anything generated
or fuzzy-matched here renders in the distinct outlined-neutral style** (never the
filled accent chip), per §8 / the `showSiteChip` precedent, so the user always
knows a value was app-proposed, not theirs. This is the first surface allowed to
show app-derived suggestions, and only as an explicit, labeled recovery — it
never pre-empts the user's literal query.

**Phase 4 — Optional full-screen search overlay.** For power users / large
libraries, a dedicated search mode (tapping the field expands to a full-screen
overlay with grouped sections — "Recent", "Tags", "Folders", "Results" — and
generous tap targets), explored in the earlier `search-assist.png` runner-up.
This is opt-in polish, gated on Phase 1–2 proving the inline shelf, and must
still obey the same source/field-separation rules. Likely a separate route or a
modal so it doesn't entangle the collapsing-header transform. Treat as a
stretch; only pursue if testers ask for more search real estate.

---

## 11. Phase 1 ticket breakdown (for mobile-ui-engineer)

Build order is top-to-bottom; each has a clear test lane.

**ST-1 — `SearchSuggestionShelf` component**
`apps/mobile/src/ui/SearchSuggestionShelf.tsx`. Presentational: takes
`suggestions` (the array of `{ kind: 'recent' | 'tag' | 'folder', key, label,
icon?, filter? }`), `onPick(suggestion)`, and renders the horizontal `ScrollView`
+ `Chip`s exactly per §4.1, reusing `styles.shelf`/`shelfContent` tokens and the
affordance label. No data logic inside — it's fed by ST-2. `testID="search-
suggestion-shelf"`; each chip carries a stable `testID` (`suggestion-recent-*` /
`suggestion-tag-*` / `suggestion-folder-*`). Opacity-reveal `Animated.Value`
lives here (§6). Lane: covered via ST-5 RNTL tests (no standalone logic to
unit-test).

**ST-2 — `useSearchSuggestions` selector hook + pure builder**
Pure builder `apps/mobile/src/domain/search-suggestions.ts`
(`buildSearchSuggestions({ recents, tagCounts, folders })` → ordered, deduped,
capped suggestion list per §5) — **Node lane** (`search-suggestions.test.ts`):
test ordering (recents→tags→folders), caps (6/8/8), case-insensitive recent
dedupe, the no-recents and empty-library cases, and that it never emits a
generated/AI value (it can't — it only takes user inputs; assert the input
contract). The thin hook `useSearchSuggestions()` in
`apps/mobile/src/hooks/` wires `recentSearches` (ST-3) + `buildTagCloud` over
inbox tags + collection-by-count into the builder, memoized. Shape the builder
to accept an optional `query` arg now (unused in Phase 1, the Phase-2 seam) so
Phase 2 doesn't reshape the signature.

**ST-3 — Recent-searches persistence (mirror `pref.inbox.sort`)**
Pure engine `apps/mobile/src/domain/recent-searches.ts`
(`RECENT_SEARCHES_PREF_KEY = 'pref.search.recents'`, `parseRecents` /
`serializeRecents` (JSON string array), `addRecent(list, query)` with trim,
case-insensitive dedupe-to-front, cap 8) — **Node lane**
(`recent-searches.test.ts`). Load/persist via the existing
`getPreference`/`setPreference` (`src/storage/preferences.ts`) exactly like the
sort pref is loaded in `index.tsx` (a `recentsLoaded` ref guard so the initial
empty default doesn't clobber stored values before they load). Never synced.

**ST-4 — `index.tsx` wiring**
Add `searchFocused` state; `onFocus`/`onBlur` on the search `TextInput`;
`onSubmitEditing` → `addRecent` + persist. Render `<SearchSuggestionShelf>`
inside the header cluster **directly after `styles.searchWrap`** (§3), gated on
`searchFocused && query.trim() === '' && suggestions.length > 0`. Hide the
`sortRow`+browse-shelf when the suggestion shelf is shown (mutual exclusion, §3).
`onPick` implements the fill-vs-facet rule (§5), reusing the `renderChip`
filter-apply path (incl. `cloudReturnRef.current = null` and cloud→card drop).
Verify `headerHeight` re-measures (it should, shelf is inside the measured view).

**ST-5 — i18n keys**
Add the `search.*` keys from §7 to `src/i18n/messages.ts` (EN source) and
`src/i18n/ko.ts` (KO). The Node lane's existing "every `ko` key exists in `en`"
guard will enforce parity.

**ST-6 — RNTL tests** (`src/__tests__/`, `.test.tsx`, jest lane)
In `inbox-screen.test.tsx` (or a new `search-suggestion-shelf.test.tsx`):
- focusing the empty field shows `search-suggestion-shelf` and hides the browse
  shelf;
- the shelf contains a recent chip (seed via the fake repo's `__setMeta` for
  `pref.search.recents`, the pattern the unseen-suggestions test already uses), a
  `#tag` chip, and a folder chip;
- tapping a recent chip fills the query (`setQuery`) and keeps focus;
- tapping a tag chip applies the tag facet and clears the query;
- submitting a query records it to recents (assert persisted meta);
- empty library → no shelf rendered;
- blurring hides the shelf and restores the browse shelf.

---

## 12. Sign-off checklist (Product/UX, before merge)

- [ ] Shelf lives inside the header cluster; chips are hittable on Android (walk
      the real flow, watch the `chip tap` breadcrumb fires).
- [ ] Focus reveal feels soft (~140ms), no list "jump" that reads as a bug.
- [ ] No fetch/sync/enrichment fires on focus or keystroke (capture-is-sacred).
- [ ] Only user-authored values appear — no AI/generated chips.
- [ ] Dark mode: chips/labels read correctly, nothing hardcoded.
- [ ] Recents persist across app restart and never sync.
- [ ] KO copy reads natural to a native speaker (not calque).
- [ ] Empty library and no-recents-yet states show no empty container.

---

# Phase 2 — Live filter as you type (implementation-ready)

## 13. Phase 2 spec

Status: **specced, ready for mobile-ui-engineer.** Builds on the merged Phase 1
wiring (`searchFocused`, `useSearchSuggestions(recents, query?)`,
`buildSearchSuggestions({ …, query? })`, the deferred-blur-hide, `onPickSuggestion`).
Mock: `scratchpad/phase2-shelf.png` (typing-with-matches, light + dark).

### 13.1 What Phase 2 changes (one sentence)

When the field is focused **and a query is being typed**, the suggestion shelf
**stays mounted** and shows the user's tags/folders/recents **filtered to those
that match the query** (best-match-first) — turning the shelf into an
autocomplete rail that sits above the live results, instead of vanishing on the
first keystroke as in Phase 1.

Everything else from Phase 1 — placement inside the header cluster, the
fill-vs-facet tap rule, recents persistence, field-separation, the reveal
animation — is **unchanged and reused**. Phase 2 is a *gating + data-source*
change, not a rewrite.

### 13.2 Decision 1 — Typing-state layout (revisits §9 Q1)

**The three surfaces and their relationship.** There are three header-region
surfaces that can occupy the slot under the search field: the **suggestion
shelf**, the **browse/facet shelf + sortRow**, and (always, below the header) the
**live results list**. The rule:

| Field state | Suggestion shelf | Browse shelf + sortRow | Results list |
|---|---|---|---|
| **Blurred** | hidden | **shown** (today's default) | full inbox / active facet |
| **Focused + empty query** | **shown** (Phase-1 focus-empty: recents + top tags + top folders) | hidden | full inbox (unchanged) |
| **Focused + typing, ≥1 match** | **shown, query-filtered** (matched recents + matching tags + matching folders, best-match-first) | **hidden** | live-filtered "Matches (N)" |
| **Focused + typing, 0 shelf matches** | **hidden** | hidden | live-filtered "Matches (N)" (or zero-result state) |

**This reverses the Phase-1 Q1 ruling for the typing state, on purpose.** Phase 1
kept the browse shelf visible while typing (so you could pre-narrow by facet then
search within it). In Phase 2 the suggestion shelf *becomes* the live-filter
surface while typing, so the browse shelf would now be the **second chip row** —
exactly the "two stacked chip rows in the header" we forbade in §3. We therefore
extend the **mutual exclusion** rule to cover the whole focused state:

> **While the field is focused, at most one chip row shows under it** — the
> suggestion shelf when there is something to suggest (empty-focus *or* a query
> with matches), the browse shelf never. The browse shelf returns only on blur.
> Concretely: `showShelf = chips.length > 0 && !searchFocused` (Phase 1 had
> `&& !showSuggestions`; Phase 2 widens the suppressor to the whole focused
> state so the browse row can't reappear in the typing-no-match case).

Why this is the right product call (not just the tidy one):

- **Thumb-reachability / no stacking.** The header is an absolutely-positioned
  collapsing cluster; stacking suggestion + browse rows pushes the results list
  down ~70px and puts two competing chip rows under the keyboard. One row keeps
  the hot path (read results, tap a chip) within thumb reach.
- **The "pre-narrow by facet then type" use case is preserved, just reordered.**
  The user can still tap a facet first (from the blurred browse shelf) **then**
  focus and type — the query then filters *within* that facet via the existing
  results path. What they lose is applying a *new* facet mid-type, which is rare
  and now better served by the shelf itself surfacing the matching tag/folder as
  an autocomplete chip ("type `des` → tap **#design**").
- **"Jump to a tag/folder" stays distinct from "open a bookmark."** The shelf
  chip is a *destination/filter* (horizontal pills, `#`/folder glyph, applies a
  facet); a results row is a *bookmark* (vertical card, opens the detail). Phase
  2 makes this contrast load-bearing — see Decision 3.

### 13.3 Decision 2 — What gets filtered, ranked, and capped

`buildSearchSuggestions({ recents, tagCounts, folders, query })` becomes
**query-aware**. The matching must be **identical to the results search** so the
shelf and the "Matches (N)" list never disagree about whether something matches.

**Matching (reuse the exact search normalization).** Phase 2 filters each
candidate name by the same per-token normalization the results use
(`collectionMatchKey` / `domain/search.ts`'s `normalizeToken`): NFKC + lowercase
+ strip non-alphanumerics, tokenized on whitespace, **all query terms must match
(AND)**, each term a **substring** of the candidate's normalized form. This means
`des` matches `#design` and the `Design` folder; `design sys` matches `Design
System` (both tokens hit); a stray symbol token (`c++`) simply finds no
tag/folder and the shelf hides — consistent with results.

> Implementation note: factor the per-candidate predicate so the builder and the
> results path share one matcher. The cleanest seam is a small exported
> `matchesQuery(candidateName, query)` in `domain/search.ts` (or a `queryTerms`
> export reused by the builder) so there is a **single** normalization source of
> truth. Do **not** re-implement normalization inside `search-suggestions.ts`.

**What is matched per family:**

- **Tags** — match against the bare tag name (not the `#` prefix). `des` →
  `#design`. The `#` is presentation only.
- **Folders** — match against the collection name. `des` → `Design`.
- **Recents** — match against the raw recent string. Show a recent **only if it
  matches the query** (it's a prefix-or-substring of an earlier search). A recent
  that *equals* the current query text is dropped (you're already typing it —
  re-offering it is noise).

**Recents while typing — DECISION: keep matching recents, drop non-matching
ones.** Two defensible options were on the table: (a) drop recents entirely once
typing starts, or (b) keep only recents that match. **We choose (b).** Rationale:
a matching recent is the single highest-intent autocomplete — "you typed `des`,
you searched `design system` before, tap to complete it." Dropping all recents
would throw away the best shortcut exactly when it's most useful. Non-matching
recents are noise mid-type and are filtered out. Cap matching recents at **3**
while typing (down from 6 in the empty state) so they never crowd out the
tag/folder destinations, which are the more actionable Phase-2 affordance.

**Ranking (best-match-first, within and across families).** Empty-state ordering
was recents → tags → folders, each by recency/frequency. Typing ordering is
**relevance-tiered**, because an autocomplete rail must put the likeliest
completion first:

1. **Within each family, rank by match quality then by the existing signal:**
   - **Exact normalized match** (candidate normalized == query normalized) first,
   - then **prefix match** (candidate starts with the query),
   - then **substring match** (query appears later in the candidate),
   - ties broken by the Phase-1 signal (recency for recents, frequency/count for
     tags, count for folders), then alpha.
2. **Across families, keep the Phase-1 family order: recents → tags → folders.**
   We deliberately do **not** interleave families by score. Reason: the
   *meaning* of each family (re-run a search vs. apply a tag vs. open a folder)
   is more important to keep grouped and predictable than squeezing out a
   marginally higher cross-family score. The icons + grouping let the eye skip to
   the family it wants; a score-shuffled rail where a folder jumps ahead of a tag
   on one keystroke and behind it on the next feels jittery. (Prefix-over-
   substring *within* a family is enough relevance signal to feel smart.)

**Caps while typing:** recents **3**, tags **8**, folders **8** (tags/folders
unchanged from empty-state caps; the row still scrolls so there's no hard total).
The visible un-scrolled portion is the most relevant by construction.

**No-suggestion-match state — DECISION: hide the shelf, show only results.** If
the query matches **zero** recents, tags, and folders, render **no shelf and no
affordance label** (the same "never show an empty container" rule as §4.2). The
focused field + the live "Matches (N)" results (or the zero-result state) are the
whole experience. There is no "no suggestions" placeholder copy — an absent rail
is silently absent, and the results list already communicates the query's effect.
(This is also why the §13.2 gating uses `!searchFocused`, not `!showSuggestions`,
to suppress the browse shelf: in the no-match typing state *neither* chip row
shows.)

### 13.4 Decision 3 — Interaction (shelf chip vs. results row)

**Tap actions are unchanged from Phase 1 (§5) and reuse `onPickSuggestion`
verbatim:**

- **Matched recent → fill the query** (`setQuery(recent)`), keep focus/keyboard
  so the user can keep editing. (It replaces the partial text with the full
  earlier search — classic autocomplete completion.)
- **Matching tag → apply the tag facet**, clear the query, blur (so the shelf
  closes onto the facet-filtered list). Identical end-state to the browse shelf.
- **Matching folder → apply the collection facet**, clear query, blur.

The `applySuggestionFacet` path (reset `cloudReturnRef`, drop cloud→card,
`setFilter`) and the synchronous-hide + `clearBlurHide()` already handle the
dismissal correctly; **no `onPick` changes are needed for Phase 2.**

**Why a user taps a shelf chip vs. scrolls the results (the affordance must stay
distinct).** This is the make-or-break interaction of Phase 2:

- **Tap a shelf chip = "narrow the whole list to this facet" / "complete my
  search."** It's a *navigational/filtering* move: I want *everything* tagged
  `#design`, not this one card. One tap, the list reshapes, I'm done. The chip is
  a destination.
- **Scroll/tap the results = "I can see the specific bookmark I want."** It's a
  *retrieval* move: the thing I'm hunting is right there; open it.

These must never feel redundant. They aren't: the shelf chip operates on the
*set* (apply `#design` as a facet → persists as the active filter, survives
clearing the query), while a results row operates on *one item*. The mock makes
this legible — horizontal pills with tag/folder glyphs (filter the set) above
vertical bookmark cards (open one). The "why it matched" accent-soft tag chip
*on* a result card (`#design` promoted, from the existing `searchTerms` path) is a
third, distinct thing: a read-only badge explaining the match, **not** tappable as
a facet. Keep these three visually separated; if review finds them muddy, that's
a blocker (see §13.9).

### 13.5 Decision 4 — Perf / feel

Phase 2 **adds no per-keystroke cost** beyond a memoized projection:

- **Suggestions recompute off the DEBOUNCED query, not the raw input.** Thread
  `debouncedQuery` (the existing `useDebouncedValue(query, 140)`) into
  `useSearchSuggestions(recents, debouncedQuery)`. The TextInput still echoes the
  raw `query` instantly (typing never feels laggy); the shelf re-filters on the
  same ~140ms cadence as the results list, so **shelf and results update in the
  same frame** and never momentarily disagree. This is the single most important
  feel decision: a shelf that filtered off the raw query would update one frame
  ahead of the results and read as a flicker.
- **The filter is a memoized pure projection.** `buildSearchSuggestions` already
  runs inside two `useMemo`s keyed on `[recents, tagCounts, folders, query]`;
  adding the query predicate keeps it O(tags + folders + recents) per debounced
  change — trivial against the cap-bounded inputs. No new state, no effect, no
  fetch. Capture-is-sacred holds: **typing triggers no network/sync/enrichment**,
  exactly as Phase 1.
- **Focus/blur/deferred-hide machinery is preserved unchanged.** The
  `blurHideTimer` deferred-hide (so a chip tap resolves before the native blur
  unmounts the shelf), `clearBlurHide()` on re-focus/unmount, and the
  opacity-reveal `Animated.Value` in `SearchSuggestionShelf` all carry over with
  no edit. The shelf now *stays mounted* across the empty→typing transition
  (rather than unmounting on first keystroke), so the reveal animation plays
  **once** on focus and the typing transition is a pure content swap — no
  re-mount, no re-fade, which feels calmer than Phase 1's mount/unmount churn
  would have on every clear.

### 13.6 Visual states (every one)

All reuse Phase-1 tokens (`styles.shelf`/`shelfContent`, the `Chip` component,
the affordance label). No new components, no new colors.

- **Typing-with-matches** (the headline state; mock `phase2-shelf.png`). Field
  focused with text; `JUMP TO` label; shelf shows query-filtered chips
  best-match-first (matched recent(s) → matching tags → matching folders); browse
  shelf + sortRow hidden; live "Matches (N)" results below with the existing
  matched-tag accent badges. The partial last chip signals horizontal overflow
  (no gradient, per §4.1).
- **Typing-no-matches.** Field focused with text; **no shelf, no label, no browse
  shelf**; just the live "Matches (N)" results (or the existing zero-result empty
  state if N=0). The header is the field alone — calm, not a void.
- **Focus-empty (UNCHANGED from Phase 1 §4.1).** Recents + top tags + top folders,
  full caps (6/8/8). Phase 2 must not regress this; the only code touching it is
  the gating widen, which still evaluates the same for empty query.
- **Blurred (UNCHANGED, §4.4).** Shelf gone, browse shelf back.
- **Dark mode.** Theme-driven via `usePalette()`; verified in the mock — filtered
  chips read as quiet outlined pills on `#0b1220`, the matched-tag badge uses
  `accentSoft`/`accentText`, the affordance label `textSecondary`. Nothing
  hardcoded (the shelf component already has zero literal colors).

### 13.7 Microcopy (EN + KO)

Phase 2 introduces **no new visible strings** in the happy path — the affordance
label stays `search.shelfAffordance` ("Jump to" / "바로가기") and chip labels are
user content (raw recent, `#tag`, folder name), never translated. The existing
a11y keys (`recentChipA11y`, `tagChipA11y`, `folderChipA11y`, `shelfA11y`,
`removeRecentA11y`) apply unchanged to the filtered chips.

**One new key**, reserved for a future a11y/section refinement and used to
announce that the rail is now a *filtered* set (so a screen-reader user knows the
shelf narrowed to their query rather than showing top items):

| Key | EN | KO | Notes |
|---|---|---|---|
| `search.shelfFilteredA11y` | `Suggestions matching “{query}”` | `“{query}” 검색 추천` | Optional override for the ScrollView `accessibilityLabel` when a query is active (swap in place of `search.shelfA11y` while typing). KO: "“{query}” 검색 추천" = "search suggestions for {query}" — natural, mirrors the empty-state "검색 추천". |

KO tone check: "“{query}” 검색 추천" reuses the already-approved "검색 추천"
("search suggestions") with the query quoted in front, exactly how a Korean app
would phrase "results/suggestions for X". No calque. This is a11y-only; it is the
**only** copy Phase 2 adds, and it is optional polish — ship without it if the
generic `shelfA11y` reads fine in testing, but the key is reserved so parity is
clean. (The Node lane's "every `ko` key exists in `en`" guard applies.)

### 13.8 Field-separation & capture-is-sacred (still non-negotiable)

Phase 2 changes only *which* user-authored items show (it filters them) — it
**adds no new source.** The shelf still draws from exactly the three §8 sources:
the user's own recents, applied tags (`buildTagCloud`), and used folders.
Filtering is a pure substring match over those user-authored names; **no AI,
generated, fuzzy, or "did you mean" value enters here** — that remains Phase 3,
which carries its own distinct outlined-neutral styling (§8). The query predicate
must **never** be relaxed into fuzzy/typo-tolerant matching in Phase 2; it is an
*exact* (normalized-substring) filter so that what the shelf shows is provably a
thing the user authored that literally contains their query. Capture-is-sacred:
the whole feature is a memoized pure projection — **focus and every keystroke fire
zero network/sync/enrichment**.

### 13.9 Phase-2 sign-off checklist (Product/UX, before merge)

- [ ] Typing filters the shelf to matching tags/folders/recents, best-match-first,
      and the set agrees with the "Matches (N)" results (same matcher).
- [ ] Shelf and results update on the **same** debounced frame — no one-frame
      flicker where the shelf leads the list.
- [ ] No second chip row ever appears while focused (browse shelf stays gone
      across empty / typing-match / typing-no-match).
- [ ] Typing-no-match shows neither shelf nor browse shelf — field-only header,
      no empty container, no placeholder copy.
- [ ] Shelf stays mounted across empty→typing (reveal plays once; no re-fade
      churn on each clear/keystroke).
- [ ] Tapping a filtered tag/folder applies the facet + clears + blurs (Phase-1
      behavior intact); tapping a matched recent fills + keeps focus.
- [ ] Shelf chip (filter the set) reads as clearly distinct from a results row
      (open one bookmark) and from the on-card matched-tag badge (read-only).
- [ ] Capture-is-sacred: no fetch/sync/enrichment on any keystroke.
- [ ] Only user-authored, literally-matching values appear — no fuzzy/AI/generated
      suggestions leak in.
- [ ] Dark mode reads correctly; nothing hardcoded.
- [ ] Focus-empty (Phase-1) state is not regressed.

### 13.10 Phase-2 ticket breakdown (for mobile-ui-engineer)

Small, since Phase 1 left the seams in place. Build top-to-bottom.

**ST2-1 — Shared matcher in `domain/search.ts` (Node lane).**
Export a single normalized-substring predicate so the builder and the results
path share one normalization source of truth. Either expose the existing
`queryTerms`-style tokenizer or add `matchesQuery(candidateName: string, query:
string): { matched: boolean; rank: 'exact' | 'prefix' | 'substring' | 'none' }`
built on `normalizeToken`/`collectionMatchKey` (NFKC + lowercase + strip
non-alphanumerics, AND across whitespace tokens, substring per token). Tests
(`search.test.ts` or a new `query-match.test.ts`): `des`→`#design` prefix,
`design sys`→`Design System` (two-token AND), no-match on `xyz`, symbol token
finds nothing, exact-vs-prefix-vs-substring ranking is correctly classified.
**Do not duplicate normalization in `search-suggestions.ts`.**

**ST2-2 — `buildSearchSuggestions` query filtering + ranking (Node lane).**
In `domain/search-suggestions.ts`, when `query.trim() !== ''`: filter each family
with ST2-1's matcher; for **recents** keep only matches, drop a recent that
equals the query, cap **3**; for **tags/folders** keep matches, cap 8/8. Sort
within each family by match rank (exact → prefix → substring) then the existing
signal (recency / count) then alpha; keep cross-family order recents → tags →
folders. When `query` is empty, behavior is **exactly Phase 1** (no change).
Extend `search-suggestions.test.ts`: typing filters to matches; ranking
(prefix before substring; frequency tiebreak); recents cap 3 + drop-equal-query;
no-match → empty array; empty query → unchanged Phase-1 output; still never emits
a non-user value (input contract).

**ST2-3 — Hook: thread the debounced query (component lane via ST2-5).**
`useSearchSuggestions(recents, debouncedQuery)` — the signature already accepts
`query`; just ensure the **debounced** value is passed and the `useMemo` deps
include it (they do: `[recents, tagCounts, folders, query]`). No structural change.

**ST2-4 — `index.tsx` gating.**
- Pass `debouncedQuery` to the hook: `useSearchSuggestions(recentSearches,
  debouncedQuery)`.
- Change `showSuggestions` to drop the empty-query requirement:
  `const showSuggestions = searchFocused && suggestions.length > 0;`
  (suggestions are now empty when a non-empty query matches nothing, so this same
  condition cleanly yields the typing-no-match "hide shelf" state).
- Widen the browse-shelf suppressor to the whole focused state:
  `const showShelf = chips.length > 0 && !searchFocused;` (was `&& !showSuggestions`).
- The sortRow gate (`{showSuggestions ? null : (…)}`) already hides the sortRow
  when the shelf shows; confirm it still reads right in the typing-no-match case
  (both hidden is correct).
- `onPickSuggestion`, `applySuggestionFacet`, the deferred-blur-hide, and
  `onSubmitEditing → recordRecent` are **unchanged**. Verify `headerHeight`
  re-measures across the empty↔typing content swap (the shelf stays mounted, only
  its children change, so `onLayout` fires on the child-count change).

**ST2-5 — i18n.**
Add `search.shelfFilteredA11y` to `messages.ts` (EN) and `ko.ts` (KO) per §13.7
(optional to wire into the ScrollView label, but add the key for parity). The
Node "ko ⊇ en" guard enforces it.

**ST2-6 — RNTL tests** (`src/__tests__/`, `.test.tsx`, jest lane). Extend the
Phase-1 search-shelf test file:
- **typing→filtered shelf:** seed a `#design` tag, a `Design` folder, a
  `databases` tag, and a `design system` recent; type `des`; assert the shelf is
  still shown, contains `suggestion-tag-…#design`, the `Design` folder, the
  `design system` recent, and **does NOT** contain `databases`;
- ordering: the matching recent appears before the matching tag before the folder;
- **typing-no-match:** type `zzz`; assert `search-suggestion-shelf` is **not**
  rendered and `browse-shelf` is also **not** rendered (focused);
- tapping the filtered `#design` chip applies the tag facet + clears the query
  (reuses Phase-1 assertion);
- tapping the matched recent fills the query and keeps focus;
- shelf and results agree: with `des` typed, a bookmark tagged `#design` is in the
  results and `databases`-only bookmarks are not;
- focus-empty still shows the full unfiltered shelf (Phase-1 regression guard).

### 13.11 Decisions to confirm with the user before build

These are mine to own per the brief, but two are worth an explicit nod because
they change an already-shipped Phase-1 behavior or touch product feel:

1. **Reversing Q1 for the typing state (browse shelf hidden while typing).**
   Phase 1 *deliberately* kept the browse shelf visible while typing (§9 Q1,
   "locked"). Phase 2 hides it (§13.2) to avoid two stacked chip rows. This is the
   right call for the autocomplete-rail model, but it **overrides a previously
   locked decision**, so flag it for the user to confirm rather than silently
   reverse. *(Recommendation: approve the reversal.)*
2. **Recents while typing: keep matching, cap 3 (vs. drop entirely).** A
   reasonable product could argue recents are clutter mid-type and tags/folders
   are the real autocomplete. I chose keep-matching-cap-3 (§13.3) because a
   matching recent is the highest-intent completion. Low-risk, easily flipped to
   "drop recents while typing" if testers find them noisy — worth a one-line
   confirm. *(Recommendation: ship keep-matching; revisit if testing dislikes it.)*

Not needing confirmation (clearly within UX ownership): the relevance ranking,
the no-match hide-the-shelf state, debounced-query sourcing, and the shared
matcher.
