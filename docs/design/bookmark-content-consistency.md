# Bookmark content types — UX consistency (link / note / image) — FULL SPEC

Status: **specced, Phase 1 buildable now; Phase 2 NEEDS USER GREENLIGHT before
build** (schema-affecting — see §5)
Owner: Product & UX (review), Domain/Sync (Phase 2 feasibility)
Surface: `apps/mobile/src/app/add.tsx`, `apps/mobile/src/app/bookmark/[id].tsx`,
`apps/mobile/src/app/index.tsx`, `apps/mobile/src/share/share-intent-handler.tsx`,
`apps/mobile/src/store/bookmarks.tsx`, `apps/mobile/src/domain/types.ts`
Related: `docs/api/bookmarks.md`, `docs/design/ux-spec.md`,
`docs/design/keepory-next-gen-ux-brainstorm.md`

---

## 1. Why this exists

User-reported symptom: bookmark UX feels scattered ("중구난방"). The request
was to review whether Stash should go beyond saving links — letting a bookmark
also be a Markdown note, a shared image, or a natural combination of all
three — without simply allowing every possible combination.

Investigation (product-ux-designer review, this branch) found the data model
already supports three content types (`ContentType = 'url' | 'article' |
'image' | 'video' | 'text' | 'unknown'`, plus a separate `notes` annotation
field) — the scattered feeling isn't a missing-feature problem, it's that each
type was added at a different time, by reacting to what the OS share sheet
happened to send, with no shared UI contract between them.

## 2. Current state — concrete inconsistencies

1. **Capture entry points are asymmetric.** The manual Add screen
   (`add.tsx` L31, L144-171) only offers Link/Memo tabs — no way to attach an
   image by opening the app directly. An image bookmark can currently only be
   created via the OS share sheet (`share/share-intent-handler.tsx` L138,
   `pickSharedImage`).
2. **Combining types is an accidental side effect of priority order, not a
   designed feature.** `share-intent-handler.tsx` L183-187 resolves a shared
   payload as `url > image > text` — if a screenshot and a link are shared
   together, the image is silently dropped with no UI indication.
   `store/bookmarks.tsx` `addBookmark` (L2523-2536) treats `image` / `url` /
   `shared_text` as mutually exclusive.
3. **The `notes` field's meaning silently changes by content type.** For
   link/image bookmarks, `notes` is a plain-text caption, edited via a bare
   `TextInput` in `bookmark/[id].tsx` (L1216-1253) with no rendering step. For
   a text memo (`content_type: 'text'`), the body lives in a *different*
   field, `description`, and is parsed and rendered as Markdown via
   `MarkdownBody` (L1210, preview/edit toggle at L1129-1213). Same-looking
   multi-line input, different behavior depending on which tab created it —
   this is the sharpest inconsistency and the most likely source of the
   "산만하다" feeling.
4. **Type badges are half-implemented.** The Inbox card meta line adds a
   "Memo" label only for `content_type === 'text'` (`index.tsx` L2966,
   `t('inbox.memoType')`); there is no equivalent label for image bookmarks.
   (Thumbnails themselves render fine for both — `local_image_uri ??
   preview_image_url`, `index.tsx` L2994/L3120 — so this is a labeling gap,
   not a visual one.)
5. **No product spec ever decided when combining types is allowed.** Image
   support was added reactively (to not lose a shared screenshot), not
   designed alongside Link/Memo from the start.

## 3. Design options considered

**A — Single entity: "0-1 anchor + one always-Markdown note" (recommended,
narrowed).** A bookmark keeps one anchor (none | link | image | link+image)
plus one note field, always rendered as Markdown regardless of anchor. A pure
memo (no anchor) stays possible. Satisfies the user's "3가지 조합" ask while
still bounding it — an anchor is at most one of each kind, never an
open-ended list.

**B — Keep 3 separate capture modes, unify only the shared UI/Markdown
treatment.** Smallest schema-safe change; does not satisfy the explicit
"조합" ask.

**C — Free multi-block model (Notion-style).** Rejected: conflicts with the
"one pending-queue entry per bookmark" sync invariant (`AGENTS.md`), and
multi-block editors structurally encourage "leave it half-written and come
back," which fights **Capture is sacred**. Also out of proportion to what was
asked (Simplicity first).

## 4. Recommended direction

Option A, narrowed as above. It resolves inconsistency #3 (the sharpest one)
outright by making "note" one concept everywhere instead of two fields with
different rendering rules, and it turns inconsistency #2 (accidental,
silent-drop combining) into a designed, visible capability instead of
removing it.

This is a recommendation for review, not a decision — Phase 2 below requires
explicit greenlight plus domain-sync-engineer sign-off before any schema
change lands.

## 5. Phased plan

### Phase 1 — no schema change, safe to build now

- **Add an image-attach entry point to the manual Add screen.** Today
  opening the app can only produce a Link or Memo; attaching a photo requires
  leaving the app and using OS share. Reuse the existing "local URI first,
  optimistic" image pipeline `store/bookmarks.tsx` already uses for shared
  images (L2641-2691) rather than building a second one.
- **Give image bookmarks the same type-label treatment text memos already
  have** in the Inbox meta line (`index.tsx` L2966) — closes gap #4.
- Both changes are additive UI work with no `Bookmark` schema change and no
  sync-queue shape change, so they carry Phase-1-level risk.

Deliberately **out of Phase 1**: unifying `notes` to render as Markdown.
Investigating the field in `bookmark/[id].tsx` (L1216-1253) during this
review surfaced that `notes` is more entangled than `description` — it drives
focus state (`notesFocused`), a length warning (`notesTooLong`), and is the
landing field for the "use AI summary" action (`ProposedSummary`,
L1255-1265+). Converting it to a Markdown preview/edit toggle like the memo
block is a real behavior change to a field explicitly called out as
user-authored-and-sacred, not a pure rendering tweak — it belongs in Phase 2
review, not a same-session drive-by edit.

### Phase 2 — schema-affecting, needs domain-sync-engineer review first

- Merge `notes`/`description` into one note field, always Markdown, decoupled
  from `content_type`.
- Support a link+image combined anchor (attach an image alongside a URL from
  Add, or from a share that carries both).

Open questions for that review:

1. Is merging `notes`/`description` safe against existing cloud rows and
   older app versions reading the split fields? Most existing plain-text
   `notes` values round-trip fine as Markdown as-is (no markdown metacharacters
   ⇒ renders identically), but this needs to be verified, not assumed.
2. With a link+image anchor, which key wins for dedupe (`url_hash` vs.
   `client_id`) — presumably `url_hash` whenever a URL is present, but this
   needs confirming against `sync/sync-bookmarks.ts`.
3. Does the existing "binary upload before row create" ordering for image
   bookmarks (`docs/api/bookmarks.md`: the server refuses a `content_type:
   image` row without `preview_image_url` already set) extend cleanly to the
   link+image combined case?
4. Any migration that touches existing rows must not bump `updated_at` on
   rows that have no local edit, per the local-only-cosmetic-repair rule in
   `AGENTS.md` — confirm the migration path respects this.

## 6. Next steps

1. Get sign-off on this doc's direction (§4) — in particular Phase 2's scope
   — before scheduling schema work.
2. Phase 1 (Add-screen image attach + Inbox photo label) can be picked up as
   a small, self-contained PR without waiting on Phase 2 review.
3. Phase 2 starts with the domain-sync-engineer review in §5, then a mockup
   pass (`ui-preview` skill) for the combined Add form before handing an
   implementation spec to mobile-ui-engineer.
