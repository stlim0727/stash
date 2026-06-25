# Settings — Clear search history (A3)

Status: **specced, ready for mobile-ui-engineer**
Owner: Product & UX
Surface: Settings (`apps/mobile/src/app/settings.tsx`), Inbox focus-empty shelf
Related: `docs/design/search-suggestion-shelf.md` §9 Q2 (deferred bulk control), §7 (reserved key `search.clearRecentsA11y`)
Size: micro (one Settings row + one Alert + one store call)

---

## 1. Why this exists

The suggestion shelf records every submitted search into a local recents list
(`pref.search.recents`, max 8). Phase 1 shipped per-chip long-press removal, but
**no bulk clear** — the reserved `search.clearRecentsA11y` key was left for
exactly this. A paying user who has searched private terms (a name, a medical
query) needs a single, findable "wipe my search history" control. Per-chip
removal is a tidy-up; this is the privacy escape hatch.

## 2. Where the row sits

In the **Preferences** group, **after** the Language row (which is currently
`last`). The group already holds Share-behavior + Language; recents-clearing is
the same "your-app-behavior" register, so it belongs here rather than spawning a
new section.

Concretely in `settings.tsx`, inside the `{/* Preferences … */}` `<Group>`:

1. Share-behavior row (unchanged)
2. Language row — **remove its `last` prop**
3. **NEW**: Clear-search-history row — carries `last`

Row props:

- `icon="time-outline"` — the same clock glyph the shelf uses for recent chips,
  so the row visually ties to the thing it clears.
- `label = t('settings.search.clearLabel')`
- `value = t('settings.search.clearValue', { count })` where `count` is the
  current recents length (loaded the same way `index.tsx` loads
  `RECENT_SEARCHES_PREF_KEY`).
- `accessibilityLabel` = the reserved `t('search.clearRecentsA11y')` (the `Row`
  component currently passes `label` as the a11y label; for this row pass the
  reserved key explicitly so screen readers say "Clear recent searches").
- `onPress` → the confirm Alert (below). **When `count === 0`, render the row
  disabled** (`onPress={undefined}`, value reads "No recent searches") so we
  never offer to clear an empty history — no empty-action dead tap.

## 3. Confirm Alert

A destructive-but-cheap action: one search string per entry, nothing synced,
nothing recoverable but nothing precious. A single confirm (not a typed
double-confirm) is right. Use the native `Alert.alert` (mirror the Trash
"Empty Trash" pattern; on web fall back to `confirm()` like `confirmDelete` in
`index.tsx`).

| Part | EN | KO |
|---|---|---|
| Title | `Clear search history?` | `검색 기록을 지울까요?` |
| Body | `This removes your recent searches on this device. Your bookmarks and tags aren’t affected.` | `이 기기의 최근 검색을 삭제합니다. 북마크와 태그에는 영향을 주지 않습니다.` |
| Cancel button | `Cancel` (reuse `common.cancel`) | `취소` |
| Confirm button | `Clear` (destructive) | `지우기` |

The body line is load-bearing: it reassures (bookmarks/tags untouched) and scopes
it (this device) so the user isn't afraid they're deleting saved content. KO is
hand-written, not a calque — "검색 기록을 지울까요?" is how a Korean app phrases a
history-clear confirm.

New i18n keys (group `settings.search.*`; add to `messages.ts` EN + `ko.ts`):

| Key | EN | KO |
|---|---|---|
| `settings.search.clearLabel` | `Clear search history` | `검색 기록 지우기` |
| `settings.search.clearValue` | `{count} recent searches` | `최근 검색 {count}개` |
| `settings.search.clearEmpty` | `No recent searches` | `최근 검색 없음` |
| `settings.search.clearConfirmTitle` | `Clear search history?` | `검색 기록을 지울까요?` |
| `settings.search.clearConfirmBody` | `This removes your recent searches on this device. Your bookmarks and tags aren’t affected.` | `이 기기의 최근 검색을 삭제합니다. 북마크와 태그에는 영향을 주지 않습니다.` |
| `settings.search.clearConfirm` | `Clear` | `지우기` |

`clearConfirmTitle` is also used as the web `confirm()` string. The confirm
button reuses `settings.search.clearConfirm`; cancel reuses `common.cancel`. The
a11y label reuses the already-reserved `search.clearRecentsA11y` (do **not** add
a new a11y key). KO plural: Korean has no grammatical plural, so
`clearValue`/`clearEmpty` are single forms.

## 4. After-state

On confirm:

1. Persist an empty list: `setPreference(RECENT_SEARCHES_PREF_KEY, serializeRecents([]))`.
2. Reflect it in the row immediately: the local `count` → 0, so the row flips to
   the disabled "No recent searches" state in the same render (optimistic — no
   spinner; clearing local storage is instant and the write is fire-and-forget
   with `.catch(() => {})` like the other prefs).

**Inbox consequence (the important part):** the next time the user focuses an
empty search field, the recents group of the suggestion shelf is now empty. Per
`search-suggestion-shelf.md` §4.2, the shelf **silently omits the absent recents
group and leads with tags/folders** — and if there are also no tags/folders, it
**renders no shelf and no affordance label at all** (never an empty container).
No new Inbox code is needed; the existing focus-empty gating already handles a
zero-length recents list. There is no "history cleared" toast — the disabled row
and the now-tag/folder-only shelf are confirmation enough.

## 5. Store / persistence touchpoints (for the engineer — spec, not code)

- **Settings owns the row only.** It loads `RECENT_SEARCHES_PREF_KEY` via
  `getPreference` (same load + `recentsLoaded`-style guard the Inbox uses) to
  drive `count`, and on confirm writes the empty list via `setPreference` +
  `serializeRecents([])` (both from `@/domain/recent-searches` /
  `@/storage/preferences`). Local-only; **never enqueue or sync** (recents are
  user content that stays on-device, per §9 Q3).
- **Inbox already re-reads on focus.** The Inbox loads recents into
  `recentSearches` state on mount and persists changes back; it does not
  subscribe to the meta store, so a clear performed in Settings is reflected on
  the Inbox the next time that screen mounts/loads (returning from Settings
  re-runs the load effect). If a future change keeps the Inbox mounted behind
  Settings, lift recents to a tiny shared store; **not required for this ticket** —
  navigating Settings→Inbox already re-loads.

## 6. Sign-off checklist (Product/UX, before merge)

- [ ] Row sits last in Preferences; clock icon; disabled + "No recent searches"
      when the list is empty.
- [ ] Confirm Alert copy matches §3 (EN + KO); KO reads natural to a native
      speaker; body reassures bookmarks/tags are untouched.
- [ ] After clear, the row flips to the empty state instantly (optimistic).
- [ ] Returning to the Inbox and focusing the empty field shows no recents (and
      no empty container if there are also no tags/folders).
- [ ] Nothing is enqueued/synced; the write is local-only and fire-and-forget.
- [ ] Dark mode reads correctly (theme-driven row, native Alert).
