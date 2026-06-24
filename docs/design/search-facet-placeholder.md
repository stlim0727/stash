# Inbox — Facet-scoped search placeholder (B4)

Status: **specced, ready for mobile-ui-engineer**
Owner: Product & UX
Surface: Inbox search field (`apps/mobile/src/app/index.tsx`, the `searchWrap` `TextInput`)
Related: `docs/design/search-suggestion-shelf.md` (focus-empty shelf), `docs/design/ux-spec.md` §2 (browse facets)
Size: micro (one computed placeholder + 2 i18n keys)

---

## 1. Why this exists

A user can narrow the Inbox to a folder or tag via the browse shelf, *then*
search. Today the search field always reads the generic `Search titles, tags,
folders` regardless of the active facet, so the "I'm searching **inside** this
folder" relationship is invisible — the user can't tell whether their query
spans the whole library or just the narrowed set. (It searches the narrowed set:
`filterBookmarks` runs over `facetFiltered`.)

Making the placeholder read **"Search in {Name}"** while a facet is active makes
narrow-then-search **discoverable and reassuring** — the field itself confirms
the scope. It's a one-line change with an outsized clarity payoff.

## 2. Behavior

The placeholder is a pure function of the **active facet** (`filter`), evaluated
where `placeholder={t('inbox.searchPlaceholder')}` is set on the search
`TextInput`:

| Active facet (`filter.kind`) | Placeholder |
|---|---|
| `all` (default) | `Search titles, tags, folders` — **unchanged**, the existing `inbox.searchPlaceholder`. No scoping. |
| `collection` | `Search in {Name}` where `{Name}` = the collection's name (`getCollection(filter.id)?.name`). |
| `tag` | `Search in {Name}` where `{Name}` = the tag name **with a `#` prefix** (e.g. `Search in #design`) — matches how tags read everywhere else in the app. |
| `uncollected` | `Search in Uncollected` (a fixed label, not a bookmark name). |

The scoped form reuses **one** key, `inbox.searchPlaceholderScoped`, with a
`{name}` param. The caller supplies the already-decorated name:

- collection → the bare collection name,
- tag → `#${tagName}`,
- uncollected → `t('inbox.searchPlaceholderUncollected')`.

So only **two** new keys are needed (the scoped template + the Uncollected
label); the `#` and the collection name are interpolated by the caller, never
translated.

### Exact copy (EN + KO)

| Key | EN | KO |
|---|---|---|
| `inbox.searchPlaceholder` (existing, **All** — unchanged) | `Search titles, tags, folders` | `제목·태그·폴더 검색` |
| `inbox.searchPlaceholderScoped` (new) | `Search in {name}` | `{name}에서 검색` |
| `inbox.searchPlaceholderUncollected` (new) | `Uncollected` | `컬렉션 없음` |

Worked examples:

- Folder named **Design** → EN `Search in Design` / KO `Design에서 검색`
- Tag **design** → EN `Search in #design` / KO `#design에서 검색`
- Uncollected → EN `Search in Uncollected` / KO `컬렉션 없음에서 검색`

KO note: `{name}에서 검색` ("search within {name}") is the natural Korean phrasing
for scoped search — the particle `에서` ("in/within") attaches cleanly to a name,
a `#tag`, or `컬렉션 없음`, so one template covers all three facet kinds without
particle-juggling. `컬렉션 없음` reuses the exact wording already used for the
Uncollected facet chip (`inbox.filterNoCollection`), so the two read as the same
concept. (We could literally reuse `inbox.filterNoCollection` instead of adding
`searchPlaceholderUncollected`; a dedicated key is specified so a future tweak to
the chip label can't silently change the placeholder — but reusing
`filterNoCollection` is an acceptable engineer's call if they prefer one fewer
key. Flag either way in review.)

## 3. Revert behavior

The placeholder is **derived from `filter`, not stored** — so it reverts for
free. When the facet clears (user taps the **All** chip, or the active facet
disappears and the existing effect resets `filter` to `ALL_FILTER`, see the
`filter`/`chips` reconciliation effect in `index.tsx`), the placeholder
re-evaluates to the default `inbox.searchPlaceholder` on the next render. No
extra clear logic, no stale scope. Compute it inline (a small `useMemo` keyed on
`[filter, t, getCollection, getTagsForBookmark]`, or a plain helper called in
render) — do **not** introduce placeholder state.

## 4. Must not fight the focus-empty suggestion shelf

This is the one interaction to get right. The placeholder and the suggestion
shelf are **independent and complementary** — they must not collide:

- The placeholder is purely the `TextInput`'s `placeholder` prop. It shows
  whenever the field is **empty**, focused or not.
- The suggestion shelf shows on **focus + empty query** and offers recents /
  tags / folders.

Both can be true at once (focused, empty, facet active): the field reads
**"Search in Design"** *and* the shelf offers jump-to chips below it. That's
correct and additive — the placeholder states the current scope; the shelf
offers a way to change it. **The placeholder must not suppress, resize, or
re-gate the shelf, and the shelf must not alter the placeholder.** Specifically:

- Do **not** tie the placeholder to `searchFocused` — it depends only on
  `filter`. (A scoped placeholder while blurred is also useful: it labels the
  field's scope at rest.)
- Tapping a **tag/folder suggestion** applies a facet and **clears the query**
  (existing `onPickSuggestion`). The placeholder then re-derives to the new
  scope on the next render — no special-casing needed; it rides the `filter`
  change automatically.
- The placeholder change must not affect `headerHeight` measurement — it's text
  inside an existing fixed-layout input, so the header's `onLayout` is
  unaffected. (Confirm no line-wrap: the scoped strings are short; the input is
  single-line.)

## 5. i18n keys to add

Add to `messages.ts` (EN) and `ko.ts` (KO), in the Inbox group near
`inbox.searchPlaceholder`:

- `inbox.searchPlaceholderScoped` — `Search in {name}` / `{name}에서 검색`
- `inbox.searchPlaceholderUncollected` — `Uncollected` / `컬렉션 없음`

The Node "every `ko` key exists in `en`" guard enforces parity. No plural forms
(no `count`).

## 6. Sign-off checklist (Product/UX, before merge)

- [ ] All facet → unchanged `Search titles, tags, folders` (no scoping).
- [ ] Folder facet → `Search in {folder name}`; tag facet → `Search in #tag`;
      uncollected → `Search in Uncollected`.
- [ ] Clearing the facet (All chip, or auto-reset) reverts the placeholder with
      no stale scope.
- [ ] Focus-empty: the scoped placeholder and the suggestion shelf coexist; the
      placeholder neither hides nor resizes the shelf.
- [ ] KO reads natural (`{name}에서 검색`), `컬렉션 없음` matches the chip wording.
- [ ] No placeholder state introduced; it's derived from `filter`.
- [ ] Dark mode + RTL-safe (placeholder color is `palette.textSecondary`, unchanged).
