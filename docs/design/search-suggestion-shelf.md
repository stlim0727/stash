# Search Suggestion Shelf — Design Spec

Status: **approved direction (Option A), Phase 1 ready to build**
Owner: Product & UX
Surface: Inbox (`apps/mobile/src/app/index.tsx`)
Related: `docs/design/ux-spec.md` §11 (Search & editing), §2 (browse facets); `AGENTS.md`
Mocks: `scratchpad/phase1-shelf.png` (Phase 1 focused-empty, light + dark), `scratchpad/search-assist.png` (earlier exploration: typing-preview + overlay ideas)

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

### 4.3 Typing (Phase 2 preview — note the transition only)

In **Phase 1**, the moment the query becomes non-empty the suggestion shelf
**hides** and the screen behaves exactly as today (the existing debounced
filter + "Matches (N)" section). The browse shelf stays hidden while a query is
present (current behavior is that the browse shelf is always shown; Phase 1 does
**not** change that — see §9 open question Q1).

> **Phase 2 will replace this "hides on first keystroke" behavior** with a live
> in-shelf filter (matching tags/folders/recents narrow as you type). Phase 1
> should structure the component so this is a later swap of the data source, not
> a rewrite (see ticket ST-1's prop shape).

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

## 9. Open questions (need the user before mobile-ui starts)

- **Q1 — Browse shelf while typing.** Today the browse shelf is always visible.
  Phase 1 hides it on focus-empty and restores it on blur. Should the browse
  shelf also hide while a *non-empty query* is being typed (cleaner, search-
  focused) or stay visible (lets the user pre-narrow by facet then search within
  it)? **Recommendation:** keep it visible while typing in Phase 1 (no behavior
  change beyond focus-empty), revisit in Phase 2 when the shelf itself becomes
  the live-filter surface. *Low stakes — flag, default to "keep visible".*
- **Q2 — Clearing recents.** Should Phase 1 ship a way to clear search history
  (a trailing "Clear" chip or a long-press-to-remove on a recent chip)? A paying
  user reasonably expects to delete an embarrassing/stale search.
  **Recommendation:** ship a lightweight **long-press a recent chip → remove just
  that entry** (no destructive confirm needed — it's one search string), and
  defer a bulk "Clear history" to Settings later. Keys are reserved above
  (`search.clearRecentsA11y`). *Worth a yes/no before build.*
- **Q3 — Privacy of recents.** Recent searches persist in the local meta store
  only (never synced, never sent anywhere), consistent with `pref.inbox.sort`.
  Confirm that's the intended privacy posture (it should be — search strings are
  user content). *Default: local-only, never synced.*

---

## 10. Phases 2–4 (outline)

**Phase 2 — Live filter (the shelf reacts to typing).** Replace Phase 1's
"hide on first keystroke" with a live narrowing: as the user types, the shelf's
tag/folder/recent chips filter to those whose names contain the (debounced)
query, reordered best-match-first, so the shelf becomes an autocomplete rail
rather than vanishing. Tapping a filtered tag/folder chip applies the facet;
tapping a "matched recent" re-runs it. The data-source swap is why ST-1 takes its
suggestions as a prop/selector output rather than computing them inline. Keep the
result list live underneath (typing still filters it via the existing debounced
path), so the shelf and the list agree. No new persistence; reuses the same
`useSearchSuggestions` hook with the query threaded in.

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
