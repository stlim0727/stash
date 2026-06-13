# UX Specification and Status Checklist

The exact, testable behavior of every user-facing flow. Each item carries a
status:

- ✅ implemented and verified (tests / live backend / static render)
- 🔶 implemented, awaiting on-device verification (needs a dev build)
- ⬜ specified but not implemented yet

This document is the source of truth for behavior; `docs/development/milestones.md`
records how we got here. When implementing a ⬜ item, update its status.

## 1. Capture

### 1.1 Manual add (Add Bookmark modal)

- ✅ URL field is auto-focused; keyboard submit saves.
- ✅ Scheme-less input is normalized (`raindrop.io` → `https://raindrop.io/`).
- ✅ Invalid input shows the inline error "Enter a valid web address…" and never
  blocks or clears the form; the error clears on the next keystroke.
- ✅ A valid save returns to Inbox immediately; the bookmark is already visible
  with `sync pending · metadata pending` badges. Saving never waits on network.
- ✅ Saving an already-saved URL reuses the existing bookmark (no duplicate row,
  `last_saved_at` updated) and returns to Inbox.
- ✅ An optional note is stored as the user's private `notes`.

### 1.2 Share intake (OS share sheet)

- 🔶 Sharing a URL (or text containing one) from any app saves it without
  opening an editor; the app shows Inbox plus a ~2s toast "Saved to Stash" /
  "Already in Stash" / "No link found to stash".
- 🔶 The shared page title (when provided by the source app) becomes the
  bookmark's initial title; enrichment fills the title only when none was
  provided.
- ✅ Capture never waits on cloud sync; the payload is persisted locally first.

## 2. Inbox

- ✅ Lists active (non-archived) bookmarks, newest first.
- ✅ Each card: title (falls back to URL), URL, and status badges — sync state
  shown unless `synced`, plus `metadata pending` while enrichment runs.
- ✅ Each card with a URL has an "Open ↗" action that opens the page in the
  system browser without leaving the Inbox; tapping the card body still opens
  Bookmark Detail.
- ✅ Loading state ("Loading your bookmarks…"), empty state ("Nothing saved
  yet…"), and a storage-failure banner (sample data shown, saves may not
  persist) are all distinct.
- ✅ Footer: Add Bookmark (primary), Settings.

## 3. Bookmark detail

- ✅ Shows preview image and favicon when present; title header; URL, title,
  description, notes, tags, collection, site, source app, metadata status,
  sync status, saved-at; AI summary when one exists.
- ✅ When the bookmark has a URL, an "Open link ↗" button opens the page in
  the system browser; a failure to open surfaces a non-blocking inline error.
- ✅ Archive/Unarchive toggles immediately (optimistic) and persists.
- ✅ Delete asks for confirmation, permanently removes the bookmark, and
  returns to the previous screen.
- ✅ Edit title/notes after capture (see §11).

## 4. Archive

- ✅ Archived bookmarks leave the Inbox but remain in the durable store.
- ✅ The Archived screen (Settings → Library) lists them, most recently
  archived first; tapping opens detail where Unarchive restores them.
- ✅ Archiving a cloud-synced bookmark propagates to Supabase (update
  mutation, last write wins); the bookmark shows `sync pending` until it does.

## 5. Delete

- ✅ Deleting a local-only bookmark cancels any pending upload (tombstones).
  If its upload had already created a remote row mid-flight, a durable delete
  is enqueued for that row, so the removal still reaches the cloud even after
  an app exit or a failed request.
- ✅ Deleting a cloud-synced bookmark enqueues a durable delete that survives
  restarts and permanently removes the remote row; a delete enqueued while
  another sync for the same bookmark is in flight always survives.

## 6. Metadata enrichment

- ✅ After a save is visible, the page is fetched in the background and the
  bookmark gains real title / site name / favicon / preview image
  (OpenGraph/Twitter/`<title>`); URL-derived values fill anything the fetch
  could not provide (offline saves still get a sensible title).
- ✅ Enrichment never overwrites user-entered values, never blocks or fails a
  save; status transitions `pending → complete | failed | skipped`.
- ✅ Bookmarks left `pending` by a previous session are enriched on next launch.
- ✅ Once enrichment completes for a cloud-synced bookmark, the generated
  metadata is pushed to Supabase (via an update mutation), so other devices
  receive the enriched title/site/favicon on their next pull rather than the
  bare create-time payload.

## 7. Account and sync (Settings)

- ✅ Anonymous Supabase account is created silently on first launch when the
  app is configured, restored thereafter, and access tokens refresh
  automatically near expiry (including right before each sync run).
- ✅ Settings shows: account state, sync status (counts of items waiting),
  Supabase auth state, library counts (link to Archived), app version, the
  pending queue (per-entry operation, status, retries, last error), and a
  "Sync now" button whenever there is syncable work.
- ✅ Without Supabase configuration the app is fully usable local-only and
  says so.

## 8. Cloud sync — upload (implemented)

- ✅ New bookmarks, archive changes, and deletes upload automatically when
  auth and local data are ready, and on every new save; failures are
  retryable with recorded errors; retries cannot create duplicate remote
  rows (server-side URL dedupe).
- ✅ Verified end-to-end against the live project (`pnpm verify:supabase`,
  16 checks, including RLS isolation between users).

## 9. Cloud sync — download / pull

The other half of sync: remote changes reach the device. Runs after the
upload queue drains — local pending work always wins until uploaded.

- ✅ **Pull trigger**: on app start (once auth and local load are ready), and
  on "Sync now". Never blocks the UI; Inbox updates in place when rows land.
- ✅ **Incremental pull**: fetch remote bookmarks with
  `updated_at > last_pulled_at` (a persisted watermark). New rows are
  inserted locally with `sync_status: synced`; existing rows merge by ID.
- ✅ **Conflict policy**: row-level last-write-wins by `updated_at`, with one
  exception — a local row with queued (unsynced) mutations is never
  overwritten; its queued upload will re-assert it.
- ✅ **Remote deletions**: each pull also fetches the remote ID list and
  removes local synced rows that no longer exist remotely (permanent deletes
  elsewhere propagate). Local-only rows are untouched.
- ✅ **AI enrichment refresh**: the same pull fetches `ai_enrichments`
  changed since the watermark for owned bookmarks and caches them in the
  durable store; Bookmark Detail reads the cached enrichment (cloud rows win
  over seeded samples), so a summary generated or updated in the cloud
  appears on device on the next pull.
- ✅ **Watermark**: stored in the repository meta store; clock skew is
  tolerated by overlapping the watermark by five minutes (idempotent merges
  make re-pulls harmless). The watermark is captured before fetching so
  changes landing mid-pull are re-fetched next time.
- ✅ **Settings**: shows last successful pull time; "Sync now" performs
  upload-then-pull.
- 🔶 Merge/deletion logic is unit-tested; the pull queries were added to
  `pnpm verify:supabase` and await a re-run from a network-capable session.

## 10. Tags and collections

- ✅ Each pull refreshes an authoritative local snapshot of the user's tags,
  tag links, and collections; Detail shows real data (cloud rows win over the
  seeded samples).
- ✅ Add/remove tags from Bookmark Detail: tap a chip's × to remove, type to
  add (creates the tag when new). Requires the cloud connection and a synced
  bookmark; otherwise a hint explains why editing is unavailable.
- ✅ Assign a bookmark to a collection from Detail (chip picker, "Inbox
  (none)" to clear) — local-first: the change applies immediately and queues
  an update mutation. Creating a new collection (and filing the bookmark into
  it) requires the cloud connection.
- ✅ A bookmark filed into a collection while its first upload was in flight
  is reconciled with a follow-up update.
- 🔶 Live verification of the tag/collection queries was added to
  `pnpm verify:supabase` and awaits a re-run from a network-capable session.

## 11. Search and editing

- ✅ Client-side search from the Inbox: case-insensitive over
  title/description/notes/URL; multiple terms AND together; live match count
  and a distinct "no matches" empty state.
- ✅ Edit title and notes from Bookmark Detail: inline inputs with a "Save
  changes" button when dirty. Local-first — saves apply immediately, persist,
  and queue an update mutation for synced bookmarks; clearing a field stores
  null (an emptied title becomes eligible for enrichment again).

## 12. Release readiness

- ✅ CI runs lint, typecheck, the logic test suite (Node test runner), and the
  component test suite (jest-expo + React Native Testing Library) on every PR
  and push to main.
- ✅ EAS build profiles (development/preview/production) and release docs.
- 🔶 On-device smoke test: the 7-step checklist in
  `docs/development/releasing.md` (save, restart-persistence, share intake,
  archive/delete, sync) has not yet been run on a real device.
- ✅ App icons and splash: Stash bookmark-ribbon mark on the brand blue
  (#208AEF) — main icon, Android adaptive foreground/background/monochrome,
  splash glyph, and web favicon (generated; see `apps/mobile/assets/images`).
