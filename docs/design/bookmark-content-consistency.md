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
3. **Memo bodies and annotations are distinct but consistently edited.** The
   Detail screen already renders both through `MemoEditor`: `description` uses
   `description_format` and `notes` uses `notes_format`, preserving each
   field's `plain` or `markdown` semantics. This is not a rendering gap to fix.
   The remaining product question is whether two separately authored text
   surfaces are clear enough in the combined-anchor UI; their storage and
   format provenance must remain distinct.
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

**A — Single entity: "0-1 anchor + existing formatted text fields"
(recommended, narrowed).** A bookmark keeps one anchor (none | link | image |
link+image). Its primary memo body and optional annotation remain distinct,
including each field's existing `plain`/`markdown` format metadata. A pure memo
(no anchor) stays possible. This satisfies the user's "3가지 조합" ask while
still bounding it — an anchor is at most one of each kind, never an open-ended
list — without introducing an unnecessary text-field migration.

**B — Keep 3 separate capture modes, unify only the shared UI/Markdown
treatment.** Smallest schema-safe change; does not satisfy the explicit
"조합" ask.

**C — Free multi-block model (Notion-style).** Rejected: conflicts with the
"one pending-queue entry per bookmark" sync invariant (`AGENTS.md`), and
multi-block editors structurally encourage "leave it half-written and come
back," which fights **Capture is sacred**. Also out of proportion to what was
asked (Simplicity first).

## 4. Recommended direction

Option A, narrowed as above. The existing `MemoEditor` and format fields already
provide a shared rendering/editing contract while preserving distinct meanings.
The remaining work turns inconsistency #2 (accidental, silent-drop combining)
into a designed, visible capability instead of removing it.

This is a recommendation for review, not a decision — Phase 2 below requires
explicit greenlight plus domain-sync-engineer sign-off before any schema
change lands.

## 5. Phased plan

### Phase 1 — no schema change, safe to build now

- **Add a native-only image-attach entry point to the manual Add screen.** Today
  opening the app can only produce a Link or Memo; attaching a photo requires
  leaving the app and using OS share. Reuse the existing "local URI first,
  optimistic" image pipeline `store/bookmarks.tsx` already uses for shared
  images (L2641-2691) rather than building a second one. Do not expose this on
  web until web has durable local persistence and a working binary upload path;
  the current web image-store keeps a transient source URI and cannot upload.
  The manual Add flow must await a durability result that specifically confirms
  both the image copy and bookmark-row insert before showing success or
  navigating away. Do not reuse the current aggregate
  `AddBookmarkResult.persisted` unchanged: an enqueue failure after those local
  writes must report "saved locally, sync pending" and retain/reconcile the
  pending row, not invite a retry that creates a second image bookmark. Expose
  separate local-persistence and enqueue outcomes (or equivalent typed states)
  so only a failed image copy/row insert is treated as a failed save.
- **Give image bookmarks the same type-label treatment text memos already
  have** in the Inbox meta line (`index.tsx` L2966) — closes gap #4.
- Both changes are additive UI work with no `Bookmark` schema change and no
  sync-queue shape change, so they carry Phase-1-level risk on native.

No text-field migration is proposed: `MemoEditor`, `description_format`, and
`notes_format` already give both fields explicit plain/Markdown behavior.

### Phase 2 — schema-affecting, needs domain-sync-engineer review first

- Support a link+image combined anchor (attach an image alongside a URL from
  Add, or from a share that carries both). Store a user attachment separately
  from generated page preview metadata (for example, dedicated remote/local
  attachment fields plus explicit provenance); `preview_image_url` remains
  reserved for generated OpenGraph/page previews. Metadata refresh must never
  clear or replace the attachment, and permanent deletion must clean up its
  uploaded object independently of `content_type`.
- Preserve accompanying user-authored share text for URL and URL+image
  captures. A shared helper used by both native share intake and web `/add`
  must strip every URL token represented by the anchor, including composite
  values such as `Caption https://example.com`; the current web equality-only
  check is insufficient. Store any remaining caption or selected quote in
  `notes` with `notes_format: 'plain'`. An empty remainder must not create an
  annotation, and capture must never copy an echoed URL into a user-authored
  text field. On a duplicate URL, attach the incoming annotation only when the
  existing `notes` is empty; identical text is a no-op, and conflicting text
  preserves the existing user-authored note while reporting that the new
  caption was not applied. Apply the same policy to local and concurrent remote
  duplicate branches.

Open questions for that review:

1. A link+image anchor uses `url_hash` as its identity whenever a URL is
   present. On a duplicate URL, the incoming image is an update to the existing
   bookmark rather than a second bookmark: attach it when the existing row has
   no image; when it already has one, an interactive Add flow must ask whether
   to replace it, while a non-interactive share keeps the existing image and
   reports that outcome instead of silently claiming the new image was saved.
   Any uploaded-but-unattached binary must be cleaned up. Confirm the exact
   update/cleanup transaction against `sync/sync-bookmarks.ts` and the upload
   API before implementation.
2. What additive attachment fields and compatibility window let older clients
   continue using generated `preview_image_url` safely while newer clients
   upload, sync, render, replace, and permanently delete user attachments?
3. Does the existing "binary upload before row create" ordering for image
   bookmarks (`docs/api/bookmarks.md`: the server refuses a `content_type:
image` row without `preview_image_url` already set) extend cleanly to the
   link+image combined case?
4. Any cloud migration that transforms existing rows **must bump `updated_at`**
   (or deliberately force a full client refresh) so incremental pull clients
   receive the transformed values. The no-timestamp-bump rule in `AGENTS.md`
   applies to local-only cosmetic repair, not server-side schema/data
   migration. The rollout must also account for queued local edits so the
   migration cannot win over newer user-authored content.

## 6. Next steps

1. Get sign-off on this doc's direction (§4) — in particular Phase 2's scope
   — before scheduling schema work.
2. Phase 1 (Add-screen image attach + Inbox photo label) can be picked up as
   a small, self-contained PR without waiting on Phase 2 review.
3. Phase 2 starts with the domain-sync-engineer review in §5, then a mockup
   pass (`ui-preview` skill) for the combined Add form before handing an
   implementation spec to mobile-ui-engineer.
