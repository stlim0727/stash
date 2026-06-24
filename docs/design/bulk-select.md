# Inbox — Multi-select + bulk actions (C2) — FULL SPEC

Status: **specced, NEEDS USER GREENLIGHT before build** (size + it is
interaction-defining — see §11)
Owner: Product & UX
Surface: Inbox (`apps/mobile/src/app/index.tsx`), the optimistic store
(`src/store/bookmarks.tsx`), the pending queue (`src/storage/`, `src/sync/`)
Related: single-item Undo at `index.tsx` ~L798 (`trashBookmark` + `showToast`
with an Undo action); the long-press ActionSheet (`menuActions`); `ActionSheet`
(`src/ui/ActionSheet.tsx`); `CaptureToast` (`src/ui/capture-toast.tsx`)
Mock: `scratchpad/bulk-select.png` (selection mode: action bar + selected/unselected
cards + single bulk Undo toast, light mode — approximate, theme-faithful)
Size: **big bet** — new selection-mode state machine + an action bar + batch
mutations through the optimistic queue + a batch Undo.

---

## 1. Why this exists

Today every action is one bookmark at a time: open the long-press menu, move OR
trash OR tag, repeat. For a paying user clearing an inbox of 30 links after a
weekend of capturing, that's 30 long-presses. Raindrop-class apps let you
**select a handful and act once**: move five into a folder, trash the noise,
batch-tag a research cluster. This is the single biggest "this feels like a real
product, not a demo" lever left in the Inbox.

The make-or-break: it must feel **light to enter and leave** (one gesture in, one
tap out, nothing modal trapping you) and the bulk trash must be **as forgiving as
a single trash** — one Undo for the whole batch, not N toasts.

---

## 2. Entering and exiting selection mode

### Enter

**Long-press a card** enters selection mode with that card pre-selected. This
reuses the gesture users already know (long-press today opens the action menu),
and "press-and-hold to start selecting" is the platform-standard mail/photos
idiom — no new affordance to teach.

> **Decision (needs the user's nod, §11):** long-press now has two possible
> meanings — open the single-item ActionSheet (today) vs. enter selection mode.
> **Recommendation: long-press enters selection mode (with the pressed card
> selected); the per-card overflow `•••` button keeps the single-item
> ActionSheet.** The overflow menu is already the discoverable single-item path
> (every card has it; AGENTS notes it was added precisely so actions aren't
> hidden behind a long-press), so moving long-press to "select" loses nothing and
> the two intents stop competing. A secondary entry — a "Select" item at the
> **bottom** of the overflow ActionSheet — gives a non-gesture path for
> discoverability and accessibility.

While in selection mode, **tapping a card toggles its selection** (it no longer
opens Detail); the open-link `↗` button and the overflow `•••` are **suppressed**
on the cards (the whole card is now a checkbox target). The selection tick
(filled accent circle when selected, hairline ring when not) sits top-right of
each card where the `•••`/badge sits in normal mode.

### Exit

Selection mode ends — and the normal header/cards return — when:

- the user taps **✕ Cancel** in the action bar (explicit exit), or
- the **last selected item is deselected** (selecting down to zero auto-exits —
  an empty selection bar is a dead end; dropping out is kinder than stranding a
  "0 selected" bar), or
- a **bulk action completes** (move / tag / trash all clear the selection and
  exit back to the normal Inbox), or
- the user navigates away (Detail/Settings) — selection mode does not persist
  across navigation; it's an in-the-moment mode.

Android hardware **Back** exits selection mode (consume the back press, like the
existing `cloudReturnRef` back handler) rather than leaving the app — selection
mode is the top "thing to back out of."

---

## 3. The selection action bar

**Where it sits:** it **replaces the hero + search + browse cluster** inside the
same absolutely-positioned `Animated.View` header (`styles.header`, the
collapsing cluster). It does **not** stack below them. Reasons: (a) the hero /
search / sort are irrelevant while selecting, so swapping them for the action bar
keeps the screen focused on the task; (b) reusing the same measured header view
means `headerHeight`/`onLayout` and the list `paddingTop` re-flow exactly as they
do for the shelf swap today — no new measurement path, no native hit-test risk
(the same trap §3 of `search-suggestion-shelf.md` warns about). The cards list
underneath stays live and scrollable; the bar collapses on scroll like the
header does today (or, simpler and acceptable for v1, pin it — engineer's call,
pinning is calmer for a task bar).

**Layout (top to bottom), from the mock:**

```
[ ✕   ·····  N selected  ·····  Select all ]      ← top row
[  ▭ Move   |   ⌗ Tag   |   🗑 Trash  ]            ← action row (segmented pill)
```

Top row:
- **✕** (left) — Cancel / exit selection mode. `accessibilityLabel =
  t('inbox.select.cancelA11y')`.
- **"N selected"** (center, bold) — the live count, `t('inbox.select.count',
  { count })`. This is the selection-count display; it updates optimistically on
  every toggle.
- **Select all** (right, accent text) — selects every item in the **current
  view** (the `visible` list — i.e. respecting the active facet/search, NOT the
  whole library; selecting only what's on screen is the predictable scope).
  When everything visible is already selected, this label flips to **Clear** /
  **Deselect all** (`t('inbox.select.selectAll')` ↔ `t('inbox.select.clear')`)
  so the control is always meaningful.

Action row — a single segmented pill (reuses `palette.surface`/`border` like the
sort/view pills), three equal segments:
- **Move** (`folder-outline`) → opens the **move ActionSheet** (the existing
  `menuMode === 'move'` collection list, incl. "Inbox (no collection)"), applied
  to **all selected**.
- **Tag** (`pricetag-outline`) → opens a **tag ActionSheet/sheet** to add or
  remove a tag across the selection (§4).
- **Trash** (`trash-outline`, **danger color** `palette.danger`) → bulk trash
  (§5). It is the only destructive action, so it carries the danger tint and sits
  rightmost (away from the thumb's resting Move/Tag).

When **nothing is selected** the action row is **disabled/dimmed** (50% opacity,
non-tappable) — but per §2 we auto-exit at zero, so this state is only momentarily
visible during the deselect-to-zero transition. Don't build a rich empty
action-bar state; it should never linger.

---

## 4. The three bulk actions

All three are **local-first and optimistic** — they reshape on-screen state
immediately and enqueue the underlying mutations (capture-is-sacred extends to
edits: a bulk action must never block on the network).

### Move (to collection)
Opens the existing move sheet. Picking a collection (or "Inbox (no collection)")
calls `assignCollection(id, collectionId)` for **each selected id** — but routed
through a **batch** path so it's one optimistic state update + one queue flush,
not N re-renders (§7). On apply: selection clears, mode exits, a confirmation
toast `t('inbox.select.moved', { count })` ("3 moved to {Folder}") shows. No Undo
required for Move (it's non-destructive and trivially reversible by moving back);
keep it simple.

### Tag (add / remove)
Opens a small sheet listing the library's existing tags plus a "create" affordance
(reuse `TagField`/tag-suggestion vocabulary). Two modes via the sheet:
- **Add tag to all selected** — adds the tag to each selected bookmark that
  doesn't have it (idempotent; already-tagged items are unchanged).
- **Remove tag from all selected** — shown for tags that ≥1 selected item carries.

Each maps to the existing local-first `addTagsToBookmark` / `removeTagFromBookmark`
optimistic path, batched (§7). **Constraint:** tagging requires a synced remote
identity (per AGENTS — a brand-new not-yet-synced bookmark can't be tagged yet).
So if the selection includes not-yet-synced items, apply to the ones that can and
surface a calm note in the confirmation toast: `t('inbox.select.tagPartial',
{ applied, skipped })` ("Tagged 4 · 1 will tag after it syncs"). Do **not** block
the whole action on the laggards. Confirmation toast on success:
`t('inbox.select.tagged', { count })`.

### Trash (the critical one — single Undo)
See §5.

---

## 5. Bulk trash + the single Undo toast (the critical requirement)

The existing single-item trash (index.tsx ~L798) trashes one bookmark and floats
**one** Undo toast that restores it. Bulk trash must mirror this **exactly, but
for the whole batch with ONE toast** — never N stacked toasts, never N separate
Undos.

Flow:
1. User taps **Trash** with N items selected.
2. **Optimistically remove all N** from the Inbox in one state update (they
   vanish together — see §7; no per-item flicker, no staggered disappearance).
3. Selection clears, selection mode exits.
4. **One** `CaptureToast` shows: `t('toast.trashedCount', { count })` ("3 moved
   to Trash") carrying a single **Undo** action (`common.undo`).
5. **Undo restores all N** in one batch (`restoreBookmark` for each id, batched),
   re-inserting them where they were. The toast then dismisses.

Notes:
- The `CaptureToast` already supports an inline action and stays up longer
  (5000ms) when it carries one — enough time to reach Undo. **No new toast
  component is needed**; only a new plural string and a batch-restore handler.
- The Undo closure must capture the **exact set of trashed ids** (snapshot at
  trash time), so a restore restores precisely that batch even if the user has
  since selected/trashed something else. If a second bulk trash happens before
  the first toast dismisses, the second toast **replaces** the first (the
  CaptureToast is single-slot) — and the first batch is **already committed to
  Trash** (recoverable from Settings → Trash), so no data is lost; only the
  *one-tap* Undo for the first batch is superseded. Acceptable: Trash itself is
  the durable safety net; the toast is the convenience layer.
- **No destructive confirm Alert for bulk trash.** Trash is recoverable (it
  archives, doesn't permanent-delete) and the Undo + the Trash screen are the
  two safety nets. A confirm dialog on every bulk trash would tax the hot path;
  the single-item trash has no confirm either, so bulk shouldn't grow one. (The
  permanent "Empty Trash" in the Trash screen keeps its confirm — that one is
  irreversible.)

---

## 6. States (every one)

| State | Action bar | Cards | Notes |
|---|---|---|---|
| **Not in selection mode** | hidden (normal hero/search/browse header) | normal cards (Detail on tap, `↗`, `•••`) | today's Inbox, unchanged. |
| **Entering (1 selected)** | shown, "1 selected", actions enabled | pressed card shows filled tick + accent ring | the long-press target is selected. |
| **N selected** | "N selected", actions enabled | selected cards ringed+ticked, others show empty ring | tapping toggles. |
| **Select-all** | "All N selected", right control reads **Clear** | every visible card ticked | scope = current view (facet/search-respecting), not whole library. |
| **Nothing selected (transient)** | actions dimmed/disabled, then **auto-exit** | — | never lingers; deselecting the last item drops out of mode. |
| **Bulk move/tag applied** | exits to normal header | items re-filed/tagged optimistically | confirmation toast (no Undo for move/tag; partial-tag note if some unsynced). |
| **Bulk trash applied** | exits to normal header | N items vanish together | **one** Undo toast (§5). |
| **Undo bulk trash** | (already exited) | N items reappear in place | toast dismisses. |
| **Abort (Cancel / Back / navigate away)** | exits to normal header | nothing mutated | selection discarded, no side effects. |
| **Empty / filtered to zero** | n/a | selection mode can't be entered (no cards to long-press) | first-run onboarding / zero-result states are untouched. |

Dark mode: entirely theme-driven (`usePalette()`), reusing the same tokens as the
sort/view pills, the `Chip`, and the cards; the only color literal is the danger
tint already in the palette (`palette.danger`). No hardcoded colors.

---

## 7. The two interactions that make or break the feel

1. **Batched optimistic mutation — one state update, not N.** The whole point is
   "act once." If a 6-item bulk trash re-rendered the list six times and the
   cards disappeared one-by-one over a few hundred ms, it would read as a slow,
   janky cascade — the opposite of powerful. The selected items must **leave (or
   change) together in a single commit**, with the list re-laying-out once.
   Likewise a bulk move/tag is one optimistic patch + one queue flush. This is a
   **domain-sync-engineer** requirement (§9): a batch path through the optimistic
   store/queue, not a `forEach` over the single-item handlers from the UI. Within
   ~100ms of the tap the selection is gone and the result is on screen.

2. **One Undo for the whole batch.** Already covered in §5, but it's the
   emotional core: bulk trash is scary precisely because it's bulk. A single,
   forgiving "3 moved to Trash · Undo" makes it feel safe to be aggressive about
   clearing the inbox — which is the behavior we want to encourage. N toasts (or
   no Undo) would make users hesitant, and a hesitant bulk-trash is a useless
   bulk-trash.

If review finds either of these missing or janky, that's a **blocker**.

---

## 8. Microcopy (EN + KO)

New keys (group `inbox.select.*`, plus one shared `toast.*`); add to
`messages.ts` (EN) and `ko.ts` (KO). KO is hand-written, not a calque.

| Key | EN | KO |
|---|---|---|
| `inbox.select.count` | `{count} selected` | `{count}개 선택됨` |
| `inbox.select.selectAll` | `Select all` | `전체 선택` |
| `inbox.select.clear` | `Clear` | `선택 해제` |
| `inbox.select.cancelA11y` | `Cancel selection` | `선택 취소` |
| `inbox.select.enterA11y` | `Select bookmarks` | `북마크 선택` |
| `inbox.select.toggleA11y` | `Select {title}` | `{title} 선택` |
| `inbox.select.move` | `Move` | `이동` |
| `inbox.select.tag` | `Tag` | `태그` |
| `inbox.select.trash` | `Trash` | `휴지통` |
| `inbox.select.moved` | `{count} moved to {name}` | `{count}개를 {name}(으)로 이동함` |
| `inbox.select.tagged` | `Tagged {count}` | `{count}개에 태그 추가함` |
| `inbox.select.tagPartial` | `Tagged {applied} · {skipped} will tag after syncing` | `{applied}개에 태그 추가 · {skipped}개는 동기화 후 적용` |
| `toast.trashedCount` | `{one: Moved to Trash, other: {count} moved to Trash}` | `{other: {count}개 휴지통으로 이동됨}` |

`Undo` reuses `common.undo` ("실행취소"); the trash glyph's danger styling needs
no copy. Plural: only `toast.trashedCount` is count-sensitive in EN (`one`/
`other`); the `{count}` interpolations elsewhere read fine singular in EN and KO
(Korean has no grammatical plural). The Node "ko ⊇ en" parity guard applies.

---

## 9. Who builds what

- **mobile-ui-engineer** — selection-mode state machine in `index.tsx`
  (`selectMode` boolean + `selectedIds: Set<string>`; long-press to enter, tap to
  toggle, ✕/Back/zero/complete to exit), the **selection action bar** rendered
  inside the existing header `Animated.View` (swapping out hero/search/browse),
  the selection tick on cards + suppressing `↗`/`•••`/Detail-on-tap while
  selecting, wiring Move/Tag/Trash to the batch store calls, the single bulk-Undo
  toast wiring, the new i18n keys, and the RNTL tests (enter/toggle/select-all/
  exit, bulk-trash → one toast → undo restores all, bulk-move applies to all).
  This is the larger half.
- **domain-sync-engineer** — the **batch mutation primitives** in the optimistic
  store + pending queue: `trashBookmarks(ids)` / `restoreBookmarks(ids)` /
  `assignCollectionMany(ids, collectionId)` / `addTagToMany` / `removeTagFromMany`,
  each a **single** optimistic state commit that enqueues the per-item operations
  through the existing per-bookmark queue (newer-supersedes-older semantics
  preserved; trash carries `deleted_at`; restore reverses it). The queue already
  models one entry per bookmark — batch just means writing N entries in one pass
  and flushing once, not N flushes. Must keep tagging gated on remote identity
  (skip+report unsynced items, don't block). **No new server endpoints** — these
  reuse the existing create/update/delete idempotent sync.
- **Product/UX (me)** — this spec, the mock, and the pre-merge sign-off
  (walk the real flow: does the batch leave together within ~100ms? is there
  exactly one Undo? does Cancel/Back abort cleanly with no mutation? dark mode?).

---

## 10. Sign-off checklist (Product/UX, before merge)

- [ ] Long-press enters selection mode with that card selected; overflow `•••`
      still opens the single-item sheet; a "Select" entry exists for discovery.
- [ ] Action bar swaps in inside the header cluster; `headerHeight`/list padding
      re-flow; chips/buttons hittable on Android (no dead-touch).
- [ ] "N selected" updates optimistically on every toggle; Select all scopes to
      the current view and flips to Clear when all-selected.
- [ ] Bulk trash removes all N **together** in one commit (no staggered
      disappearance), within ~100ms.
- [ ] Exactly **one** Undo toast for the batch; Undo restores **all N** in place;
      a superseding bulk trash doesn't lose data (Trash is the safety net).
- [ ] Move applies to all selected + exits + confirmation toast; Tag applies to
      all (skipping+noting unsynced) + confirmation.
- [ ] Cancel / Back / navigate-away aborts with zero mutation.
- [ ] No bulk-trash confirm Alert (Trash is recoverable + Undo); Empty Trash
      keeps its confirm.
- [ ] Capture-is-sacred: no bulk action blocks on network; all optimistic +
      queued.
- [ ] KO copy reads natural; dark mode correct; nothing hardcoded.
- [ ] Selected-state visuals (accent ring + filled tick) clearly distinct from a
      normal card and from the unselected empty-ring card.

---

## 11. NEEDS USER GREENLIGHT BEFORE BUILD

Flagged explicitly per the brief — this is **interaction-defining and large**, so
it wants an explicit go/no-go, not silent UX ownership:

1. **Long-press = enter selection mode** (vs. keep long-press = single-item
   sheet). This repurposes a gesture users already use today. *Recommendation:
   approve — the overflow `•••` already covers single-item actions, so long-press
   is freed up; this is the platform-standard select gesture.* If the user
   prefers to keep long-press as-is, the fallback is a "Select" entry in the
   overflow sheet as the **only** entry point (less discoverable, but
   non-breaking).
2. **Scope of "Select all" = current view** (facet/search-filtered visible list),
   not the entire library. *Recommendation: approve — selecting what's on screen
   is predictable; "select 400 hidden items" is a footgun.*
3. **No confirm dialog on bulk trash** (rely on Undo + Trash). *Recommendation:
   approve — matches single-item trash and keeps the hot path fast; the data is
   recoverable.*
4. **Ship order:** Trash + Move first (highest value, simplest), Tag as a fast
   follow if the batch-tag sheet adds scope. *Recommendation: approve a phased
   build so the big bet lands incrementally.*

All four are mine to recommend, but they shape the core interaction and the size,
so they are the user's call to confirm. Nothing below the line above gets built
until that go/no-go.
