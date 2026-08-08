# Agent Handoff: Stash

This file is the fast-start context for agents working in this repo. It should
stay readable: keep durable project facts here, and move deep implementation
history into docs or PR notes when possible. When editing this file, follow
`docs/development/maintaining-agents-md.md`.

Last updated: 2026-07-29 (root-caused and fixed the bulk-create sync path never clearing the queue, and the STASH-3Y reconcile follow-up's SQLite fan-out — see Known Traps).

## Successor Agent Orientation

Read this first if you are a new agent taking over Stash from a previous one.
None of the prior agent's conversational context survives; only committed files
do. This file, `CLAUDE.md`, `docs/`, `.claude/skills` mirrored as
`.codex/skills`, and `.claude/agents` are your inherited memory. Start here:

- **Read order, not authority:** start with this file, then `CLAUDE.md`, then
  `docs/`, then the code, but prose can lag the tree, so **the source wins
  wherever they disagree.** Verify facts against their sources: commands from
  `package.json`, schema from migrations, deploy behavior from workflow config,
  and branch/PR/tag/CI state from git and GitHub. `CLAUDE.md` "Working
  principles" governs how to reason; the rest of this file governs what is true
  about the app.
- **Your toolbelt is already built; use it, don't reinvent it.** Operational
  procedures are encoded as skills in `.claude/skills` and mirrored under
  `.codex/skills`: `versioning`/`rc-build` for builds,
  `play-store-release` for Google Play submission, `web-deploy`/`web-preview`
  for Cloudflare, `supabase-migration` for schema, `circleci-logs` for CI
  failures, `review-pr`/`pr-ready-check` for PR gates, `update-agents-md`/`retro`
  to keep this memory fresh, `screenshot`/`ui-preview` for visuals,
  `user-bookmark-summary` for live DB status, and `fetch-sentry-issues` for
  Sentry checks and issue listing. The release
  procedure itself lives in `docs/development/releasing.md`. Change both skill
  mirrors together or the toolbelts drift. Prefer these over ad-hoc steps.
- **What is verified vs assumed vs stale** (do not trust silence as proof):
  - Native SQLite + share-intent have **never been verified on a real device**;
    this is the highest-risk unknown. `rc-build` builds the APK and QA checklist,
    but it does not install or exercise the APK. Proving the native path still
    needs a human to install it and run the device smoke checklist in
    `docs/development/releasing.md`.
  - Supabase smoke last passed **2026-06-12**. `pnpm verify:supabase` (needs
    creds) covers schema, REST/bookmark API, and RLS only; it never calls
    `/functions/v1/*`, so it can go green while an edge function is undeployed
    or stale. After any `supabase/functions` change, deploy it and smoke the
    function separately.
  - Milestone status in `docs/development/milestones.md` is **historical**; the
    app is well past it. Do not infer current state from the milestone list.
- **In-flight when this was last edited (2026-07-23):** no open PRs. The most
  recent merges were the inbox search-open/close saga (#566, #567, #569 — see
  the `domain/header-collapse.ts` Known Traps entry) and a graph view
  pan/zoom timing fix (#561). Reconcile against the live open-PR list; some
  may have opened since.
- **Sentry DB sync (2026-07-18):** Organization `self-463` and project `stash` confirmed. **RULE:** Sentry must always be considered available. If Sentry MCP tools are not configured or fail, you MUST proactively query the Sentry API directly using the `SENTRY_AUTH_TOKEN` from `.env.local` (either by writing a quick Node/curl script or using the local helper `pnpm sentry:issue <id>`). Never rely on local docs to look up active Sentry issues, and do not give up if MCP is down.
- **Sentry → GitHub issue sync (2026-07-28):** `.github/workflows/sentry-github-sync.yml` runs `scripts/sentry-to-github-issues.mjs` every 6h (and on manual dispatch) to mirror unresolved Sentry issues into GitHub issues titled `STASH-N: <title>`. It's idempotent — dedupes by searching GitHub for the shortId already in a title before creating, so no separate "last synced" state is kept; a run just files whatever doesn't have an issue yet. Needs repo secret `SENTRY_AUTH_TOKEN` (optional `SENTRY_ORG`/`SENTRY_PROJECT`, default `self-463`/`stash`); `GITHUB_TOKEN` is the Actions-provided token. Runs on GitHub Actions only (not ported to CircleCI) — CircleCI has no working scheduler on this project's plan, and the job needs `GITHUB_TOKEN` to create issues, which only Actions provides. Manual one-off run: `pnpm sentry:sync-github-issues [--dry-run] [--limit N]`.
- **The invariants below are load-bearing, not FYI.** "Capture is sacred,"
  user-authored vs generated fields, and "a local cosmetic repair must never bump
  `updated_at` or enqueue sync" have each been re-broken by agents who skimmed
  them. Read "Behavioral Invariants" and "Known Traps" before touching sync,
  enrichment, or storage.

## Project Snapshot

Stash is an Expo SDK 56 bookmark app in `apps/mobile`, using TypeScript,
expo-router, local-first storage, Supabase sync, and Cloudflare Workers static
web hosting.

All milestones M0-M10 in `docs/development/milestones.md` are implemented, and
the repo has substantial post-MVP work beyond that list. Treat milestone merge
status as historical context; verify current branch/PR state from git/GitHub.
Native SQLite/share-intent behavior still needs real-device verification.

Key product state:

- Inbox, Add Bookmark, Settings, Detail, Trash, tag browsing, search, sort, and
  card/compact/list layouts exist, along with Report, Review, Graph, and auth
  callback routes.
- Manual saves and share captures are local-first. Bookmark creation is
  optimistic, durable, idempotent, and queues sync work.
- The app supports English/Korean i18n, Sentry-backed observability, local image
  capture/storage, and Supabase Edge Functions for AI enrichment, public API,
  API keys, and feedback bridging.
- Domain types intentionally mirror the Supabase snake_case schema in
  `apps/mobile/src/domain/types.ts`.
- Generated metadata and AI enrichment are kept separate from user-authored
  fields.
- Trash replaced user-facing archive. Active lists exclude `deleted_at != null`
  and legacy `is_archived = true` rows.
- Search highlights title and URL matches via `src/ui/HighlightedText.tsx`;
  filtering remains owned by `src/domain/search.ts`.
- `last_accessed_at` is local-only and powers the "Recently opened" sort. It
  must never enqueue sync work or bump `updated_at`.

## Architecture Map

- App routes: `apps/mobile/src/app`.
- Store: `apps/mobile/src/store/bookmarks.tsx`.
- Domain logic: `apps/mobile/src/domain`.
- Storage interface: `apps/mobile/src/storage/types.ts`.
- Native storage: `repository.native.ts` using SQLite.
- Web storage: `repository.ts` using localStorage, with memory fallback for SSR.
- Supabase REST API client: `apps/mobile/src/api/bookmarks.ts`.
- Auth/session wrapper: `apps/mobile/src/supabase`.
- Upload sync: `apps/mobile/src/sync/sync-bookmarks.ts`.
- Pull sync: `apps/mobile/src/sync/pull-bookmarks.ts`.
- Share intake: `apps/mobile/src/share`.
- UI components: `apps/mobile/src/ui`.
- Supabase migrations/functions: `supabase`.

## Behavioral Invariants

These are "do not break" rules, not just implementation notes.

### Sync And Auth

- Queue entries carry an `operation`: `create`, `update`, or `delete`.
- One queue entry per bookmark should represent the latest pending mutation.
- Upload happens before pull on startup and "Sync now".
- Pull is incremental by `updated_at` watermark with a 5-minute overlap.
- Last-write-wins applies except for rows with queued local work.
- Pull also replaces the local tag/link/collection snapshot, then re-layers
  pending local tag ops.
- Account transitions matter:
  - anonymous -> real carries local rows over as pending creates.
  - real A -> real B replaces the local cache.
  - real -> anonymous preserves local data and must not wipe the cache.
- Expired real sessions enter `session_expired`; do not mint a fresh anonymous
  user or run destructive sync while there is no real session.
- Anonymous sessions must never run the remote-deletion diff; anonymous data is
  single-device, so an empty remote set is not evidence that local rows vanished
  elsewhere.
- Signing in must trigger `syncNow` based on changed `auth.userId`, even when
  the local queue is empty.
- Sync, a bulk import's local-write flush, "Pause sync", and "Reset library"
  each have their own "is this busy" signal (`syncInFlight`,
  `localCreateFlushesInFlight`, `syncPausedRef`, `isResettingLibrary`) and
  they don't all check each other the same way on purpose — see
  `docs/architecture/sync-pause-import-reset.md` for the full interaction
  matrix before touching any of the four.
- **Bookmark ids are stable from capture, never renamed — EXCEPT a server-side
  duplicate hit (STASH-3Q) and account rehoming, both below.** `makeBookmarkId()`
  (`store/bookmarks.tsx`) mints a real UUID at creation time, and it's sent
  to the server as the row's own primary key (`CreateBookmarkInput.id` →
  `api/bookmarks.ts`'s `createBody.id`) instead of letting Postgres assign one
  — so a FRESH create's response echoes the SAME id the client already has.
  This replaced an earlier "local-\* placeholder → server-assigned UUID" model
  whose local→remote id-swap (`swapBookmarkId`, `planLeftoverReconciliation`,
  `reconcileStrandedSyncedDuplicates`, the `syncQueueEntry` legacy id-shape
  guard) was the root of an entire class of bugs (STASH-3B/3N/3P). **That
  swap machinery has since been removed entirely** (#612, a deliberately
  separate follow-up to the id-stabilization PR, #611) — accepting the edge
  case that a device already stuck with a stuck pre-#611 `local-*` bookmark
  loses its self-heal path. `EntrySyncResult.bookmarkReplacement` (the
  `{previousId, bookmark}` rename signal) is now `bookmarkUpdate?: Bookmark`
  (fields change, never the id), and `completeCreateSyncBatch` does a plain
  in-place update instead of a DELETE+INSERT rename.
  `resolveAliasedId`/`idAliases` and `repository.replaceBookmark` are the
  **one exception, kept on purpose**: anonymous→real account carry-over
  (`sync/account-transition.ts`) still mints a genuinely new id when
  rehoming a bookmark into a different account, independent of create-sync,
  so that id-change path (and the alias map background tasks resolve
  through) is still live. `hasRemoteIdentity` (id-SHAPE check: real UUID vs.
  `local-…`/`bookmark-…`) is consequently also DOWNGRADED to a seed-data
  check only — it no longer means "has this synced" (every id looks like a
  real UUID now, synced or not). For "has this bookmark ever been confirmed
  synced" — which several self-heal/account-transition/tag/enrichment gates
  need, including telling a never-synced row apart from one that's merely
  `pending` again because of a later, still-uploading edit — use
  `Bookmark.ever_synced` (set once at the first confirmed sync, in
  `sync-bookmarks.ts` and `remoteToBookmark`, never cleared) alongside
  `sync_status === 'synced'`, combined with `hasRemoteIdentity` to still
  exclude seed/sample rows (which are marked `sync_status: 'synced'` locally
  without ever being a real cloud row). `store/bookmarks.tsx`'s `hasSyncedOnce`
  is the canonical helper for this combined check — reuse it rather than
  re-deriving the logic. **Any code path that flips a bookmark's
  `sync_status` away from `'synced'` must also stamp `ever_synced: true`** in
  the same update (see `applyBookmarkUpdate`) — skipping this silently makes
  the row indistinguishable from a fresh, never-synced create the next time
  anything checks `hasSyncedOnce`.
- **STASH-3Q: a create that resolves as a server-side duplicate MUST adopt the
  EXISTING row's id, not keep its own.** `api/bookmarks.ts`'s `createBookmark`
  dedupes on canonical URL (or `client_id` for URL-less notes) and returns
  `{ bookmark_id: existing.id, status: 'duplicate' }` — a genuinely different
  id than the one the client sent, unlike a fresh insert. Missing this (the
  #611/#612 "ids never change" assumption held for fresh inserts, but nobody
  re-audited the pre-existing dedupe branch against it) marks the local row
  synced under an id Postgres has no row for; the next pull then fetches the
  real existing row separately and the library doubles ("561 -> 1047").
  `EntrySyncResult.originalLocalId`/`CreateSyncCompletion.originalLocalId`
  (`sync/sync-bookmarks.ts`, `storage/types.ts`) carry the old id so the
  caller (`rekeyBookmarkIdentity` in `store/bookmarks.tsx`) can re-key
  tag/AI-retry state and `idAliases` the exact same way account rehoming
  does — this is the ONE other case (besides rehoming) a bookmark's id ever
  changes post-capture, so both must call the same re-key helper. **Storage
  gotcha the fix itself tripped over**: adopting a brand-new-to-this-device
  id must use `insertBookmark`, not `updateBookmark` — the web/localStorage
  backend's `updateBookmark` only replaces a row already stored under that id
  (not an upsert, unlike native's SQLite `INSERT OR REPLACE`), so it silently
  no-ops for an id this device never wrote before.
- **A sync-queue entry stuck failing escalates to Sentry automatically once,
  at 3 retries** — `crossedHealthEscalationThreshold` (`sync/sync-bookmarks.ts`)
  is checked in `applySyncEntryResult` (`store/bookmarks.tsx`) and reports via
  `reportSyncQueueHealthEscalation` (`observability/sentry.ts`) so a systemic
  sync problem (API outage, schema drift) surfaces without an in-app feedback
  report. Fires once per entry at the crossing, not on every retry past it —
  don't add a second ad hoc report for the same condition elsewhere.

### Metadata

- `src/domain/page-metadata.ts` fetches OpenGraph/Twitter/title/favicon data
  with timeout, HTML-only checks, size caps, and injectable fetchers for tests.
- The fetcher identifies as `StashBot/1.0` first and retries once with a browser
  UA only when a site refuses the request or serves an empty shell.
- Naver Map place pages may need a server-rendered sibling from
  `previewSourceUrl`.
- URL-derived fallback titles live in `src/domain/url-title.ts`.
- `title_is_derived` is local-only and records generated-vs-real title
  provenance.
- Backfill in `src/domain/title-backfill.ts` is purely local and cosmetic. It
  must not re-fetch, bump `updated_at`, or enqueue sync work.

### Share Capture

- Share intake uses `expo-share-intent@7`; the config plugin is registered in
  `app.json`.
- Toast-mode share capture awaits durable persistence before dismissing.
- Android toast-mode dismisses Stash via `dismissAfterShare` after recording a
  pending confirmation when a new bookmark was actually saved.
- iOS/web cannot self-dismiss; they fall through to an in-app toast and Inbox.
- Pending confirmation is drained by `share-confirm-handler.tsx` on cold start
  or background-to-active resume and must never navigate unless the user taps
  "View".
- A durable "last share attempt" record (`domain/share-diagnostics.ts` +
  `share/share-diagnostics.ts`, meta-store backed, hydrated at startup) is
  recorded after every share resolves — shape only (`hasUrl`/`hasText`/
  `hasImage`, file MIME types, save result), never content. It exists because
  the in-app log ring buffer and storage diagnostics are in-memory only: a
  "Report a problem" filed in a later app session (after a silently-failed
  share's own process already ended) used to show only that session's own
  unrelated startup noise, never the share itself (Sentry STASH-2A/STASH-27).
  Check `getShareDiagnostics()` / the report's `shareAttempt` field before
  assuming a recurring share complaint needs another blind native-intent
  patch — STASH-1Z/STASH-25 (sqlite preflight) and STASH-21 (Shorts text
  intents) were each guessed from user description alone with no way to
  confirm the fix actually addressed what failed.

### Analytics

- Privacy-safe PostHog analytics uses a strict event allowlist and key sanitizer (`src/analytics/sanitize.ts`).
- New allowlisted events must be defined in the `EVENT_CATALOG` (`src/analytics/events.ts`).
- The `capture_completed` event measures bookmark save result and durable persistence latency (`persistence_ms`) from share captures without leaking user content or identifiers.
- Capturing analytics must be fire-and-forget; never await analytics operations or network calls in primary save, dismiss, or navigation paths.

### Trash And Delete

- User-facing delete moves bookmarks to Trash by setting `deleted_at`.
- The REST `api.deleteBookmark` contract still archives by default with
  `is_archived`. Do not change `verify:supabase` to expect `deleted_at` unless
  intentionally changing that REST API contract.

## Web Hosting

- Production web runs on Cloudflare Workers at `keepory.app`.
- Build command is `bash scripts/web-build.sh` via `wrangler.toml`.
- The build stamps commit/branch provenance so Settings can show the deployed
  build.
- SPA routing uses Workers asset not-found handling. Do not add a Pages-style
  `_redirects` catch-all; it can rewrite JS bundles.
- Branch previews use Cloudflare Preview URLs on the same Worker:
  `https://<branch-slug>-keepory7.stlim0727.workers.dev`.
- For headless browser work, target a local `expo export` served on localhost.
  Chromium in the sandbox may fail against deployed HTTPS URLs; use `curl` for
  deployed smoke checks.

## Common Commands

Run from the repo root unless noted.

```sh
pnpm dev
pnpm dev:android
pnpm dev:ios
pnpm dev:web
pnpm lint
pnpm typecheck
pnpm test
pnpm test:components
```

Command notes:

- Node 22 and pnpm 10 are the expected toolchain.
- `pnpm lint` is the CI lint. It runs format check, static env checks, and
  overlay elevation checks.
- Expo release bundles only inline static `process.env.EXPO_PUBLIC_NAME` reads.
  Do not use computed `process.env[key]` for mobile public env vars.
- Do not run `pnpm lint` inside `apps/mobile`; that invokes `expo lint`, which
  has a known red baseline and may generate unwanted ESLint files/lockfile
  churn.
- `pnpm test` runs the mobile Node logic tests plus Supabase function tests.
- `pnpm test:components` runs the jest-expo React Native component/hook lane and
  accepts a single file path.
- To run one Node `.test.ts` file:

```sh
cd apps/mobile
node --experimental-transform-types --import ../../scripts/register-alias.mjs --test src/domain/<file>.test.ts
```

Headless Expo export checks:

```sh
cd apps/mobile
CI=1 pnpm exec expo install --check || true
CI=1 pnpm exec expo export --platform web
CI=1 pnpm exec expo export --platform ios
```

Delete `apps/mobile/dist/` afterwards; it is gitignored.

## Collaboration And PR Workflow

- When an agent makes repository changes that are meant to persist or be shared,
  it should open a PR unless there is a clear reason not to. Clear reasons
  include an explicit user request not to publish, missing credentials or PR
  tools, unrelated working-tree changes that cannot be isolated, investigation
  with no durable change, or secrets/private artifacts that must not be
  committed. When not opening a PR, state the concrete reason.
- Open PRs as ready for review by default. Use draft only when the user asks or
  the work is knowingly incomplete.
- After opening or updating a PR, keep watching while active for CI failures and
  human review activity. Ignore routine bot/status comments such as deploy
  preview success messages.
- When posting manual GitHub comments, PR bodies, or review replies through a
  user's GitHub credentials, explicitly identify the note with the agent's actual identity
  (e.g., Antigravity, Claude, Codex, etc.) so it is clear which AI assistant authored it
  and is not mistaken for the human account owner. Do not duplicate that label
  on platform-generated or automatically-triggered bot comments that already
  identify their source.
- If CI is green and no human review activity appears for 5 minutes, either ask
  the user to merge or merge directly for small, well-tested, low-risk changes.
- Do not auto-merge PRs that change Supabase migrations/functions,
  auth/session/sync deletion behavior, Cloudflare deploy config, or release
  workflows. Report status and ask.
- If CI fails or a human review appears, stop the auto-merge path, inspect it,
  and either address it or report the blocker.
- When a commit addresses a review comment, post a short reply on that thread
  referencing the fixing commit.

## Verification Status

- Last known full Supabase smoke verification was 2026-06-12 with
  `pnpm verify:supabase` against `https://stzutoejnhzxzhjsjtsi.supabase.co`.
  Treat that as historical confidence, not proof that newer migrations/functions
  are live.
- To re-run Supabase verification, provide `EXPO_PUBLIC_SUPABASE_URL` and
  `EXPO_PUBLIC_SUPABASE_ANON_KEY`.
- Native SQLite and share-intent behavior cannot be verified in Expo Go. Use
  Android Studio/Xcode via `pnpm --filter mobile android` or
  `pnpm --filter mobile ios`, or use EAS preview builds.
- Android is the lower-friction device verification target. Follow the smoke
  checklist in `docs/development/releasing.md`.

## Android APK Without EAS

Use `.github/workflows/android-apk.yml` for standalone Android test APKs. This
job stays on GitHub Actions because native release builds exceed the available
CircleCI Docker memory class; normal CI remains on CircleCI.

Outputs:

- A blank workflow `version` input or a hyphenated tag like `v0.1.7-rc8`
  refreshes the rolling `dev` prerelease and publishes `stash-dev-android.apk`.
  A blank input is no longer an unlabeled build: the workflow's "Determine
  build version" step computes the next `vX.Y.Z-rcN` itself from
  `apps/mobile/app.json`'s version and the last `dev` release's self-recorded
  label — same target version as the last build bumps only the rc number, a
  new target version (an `app.json` bump) starts that version's rc1.
- A clean `vX.Y.Z` tag publishes a stable/latest versioned release.

Trigger manually from GitHub Actions, or push a `v*` tag. The APK is arm64-v8a
only, debug-signed, standalone, and includes build provenance in Settings.

## Known Traps

- **`applyBulkCreateChunkResults` (`store/bookmarks.tsx`) must never gate
  queue-clearing on `EntrySyncResult.removeEntry`** — `syncCreateQueueEntryBatch`
  never sets it (every result it returns is already a completed create; a
  batch failure throws instead of returning a per-entry retry state). Gating
  on it silently no-oped every bulk sync, the root cause of a whole day's
  flood of "561 import stuck/duplicated" Sentry reports (STASH-3H through
  3X). Fixed in #621; full postmortem and the lesson about trusting a pure
  function's unit tests over its caller's actual behavior live in
  `docs/architecture/sync-pause-import-reset.md`.
- Supabase migrations can be applied without deploying Edge Functions. Changes
  under `supabase/functions` require a manual
  `supabase functions deploy <name>`; deleted source does not remove a deployed
  function, so use `supabase functions delete <name>`. See
  `docs/development/releasing.md`.
- `createBookmark` sends `client_id`; the migration
  `20260621000002_bookmarks_client_id.sql` must exist before deploying code that
  writes it.
- Cloud `url_hash` is canonicalized now. Older rows may have stale hashes; use
  `pnpm dedupe:supabase` with `SUPABASE_SERVICE_ROLE_KEY` when needed.
- Never run `pnpm dedupe:supabase --apply` without explicit user confirmation.
  It uses `SUPABASE_SERVICE_ROLE_KEY`, bypasses RLS, and may touch all users
  unless `--user=<uuid>` is provided.
- AI enrichment upserts require the live unique constraint on
  `ai_enrichments(bookmark_id)`. Missing migrations produce opaque 400s unless
  diagnostics are checked.
- `ai-enrich` reuses the user's existing tags to curb tag fragmentation. When
  ranking tags by usage, count links on **active** bookmarks only (`deleted_at
  is null and is_archived = false`): trash is a soft delete so `bookmark_tags`
  links persist, and `removeTags` leaves an orphan `tags` row — a naive
  `bookmark_tags(count)` resurfaces tags the user already cleared. See
  `docs/design/library-organizing.md`.
- `setBookmarks(updater)` may run asynchronously. Do not compute a work list
  inside the reducer and read it immediately after calling `setBookmarks`.
- Full-row storage writes should re-read the freshest row immediately before
  writing when multiple effects might touch the same bookmark.
- The SQLite bookmark table stores the full record as JSON plus a few indexed
  columns. Promote fields only when query needs require it.
- `expo install <pkg>` may fail offline against the Expo versions API. Read the
  SDK-pinned version locally from
  `apps/mobile/node_modules/expo/bundledNativeModules.json`.
- `pnpm install` currently reports benign peer-dependency warnings for
  `react-native-worklets` and `@react-native/metro-config`.
- Bot review threads can remain `is_outdated:false` after fixes. Verify each
  open thread against the current code before deciding it is addressed.
- If a compound git command is denied, earlier parts did not run either. Re-fetch
  and verify SHAs before building or deploying from `main`.
- In-app feedback reports (Sentry tag `logger: feedback-bridge`, `source:
  in-app-feedback`) carry **no Sentry breadcrumbs** — `trackBreadcrumb` writes
  are attached to a captured exception's session, not to a user-typed feedback
  submission. Don't spend a round-trip checking `get_sentry_resource`
  (`resourceType: breadcrumbs`) for one of these; it 404s. The `context.logs`/
  `context.storage`/`context.syncReconcile`/`context.shareAttempt` fields in
  the report body are the only evidence, and all but `shareAttempt` are
  in-memory-only (reset on app restart) — `syncReconcile`
  (`src/sync/reconcile-diagnostics.ts`) is a cumulative-since-launch
  create-sync reconcile summary, `storage.sqliteContention` a matching
  cumulative SQLite tail-wait summary — so verify they actually date from the
  failure before trusting them as proof of what happened.
- A bulk import running before the initial load/first cloud pull settles
  durably re-creates every existing bookmark as a fresh duplicate (dedup
  reads an incomplete in-memory snapshot) — this reproduced twice in
  production as an exact library doubling before `importBookmarks` grew a
  `notReady` refusal. Reset also used to race an in-flight import's local
  write loop the same way (wipes, then the import's stragglers repopulate
  it). Both guards, plus how "Pause sync" fits in, are one connected model —
  see `docs/architecture/sync-pause-import-reset.md` before changing any of
  the four busy-state flags it documents.
- Fanning multiple calls out onto the single-connection SQLite actor
  (`src/storage/sqlite-connection.ts`) — via `Promise.all`, or a `for` loop
  that never awaits each call before firing the next — stacks dozens of
  simultaneous native calls behind one serialized queue ("sqlite tail wait
  (depth N)" climbing into the tens is the tell). Recurred four times
  (STASH-3B, twice under STASH-3N, STASH-3Y); grep for that shape before
  adding any new bulk write path. See
  `docs/architecture/sqlite-write-contention.md` for the full history and
  each fix.
- **Historical (pre-#611/#612), for context if this ever resurfaces**: back
  when a create renamed a bookmark's local-\* id onto a server UUID, two
  synced-bookmark self-heal passes in `store/bookmarks.tsx`'s bootstrap
  effect each covered a different half of "the rename didn't finish before
  the app died," and neither noticed the other's gap: `reconcileOrphanedQueueEntries`
  skips any bookmark already marked `sync_status: 'synced'` (assumes nothing
  left to drive), and the now-removed `planLeftoverReconciliation` was driven
  by iterating the QUEUE — a synced-leftover entry removed before its id swap
  durably landed (or never created) left nothing to iterate. A local-id row
  stuck in exactly that state — `sync_status: 'synced'`, no queue entry, an
  already-synced remote-id twin with the same canonical URL sitting right
  next to it — was invisible to both passes and survived as a permanent
  duplicate Inbox card that reappeared every relaunch (Sentry STASH-3P,
  "561 -> 781 -> 970" after a 561-bookmark import). The now-removed
  `reconcileStrandedSyncedDuplicates` in `sync/sync-bookmarks.ts` was the
  third self-heal pass added to cover that specific gap. All three id-rename
  concepts (the rename itself, and the self-heal passes built around it) are
  now gone — see the stable-id entry above — since #611 stopped bookmarks
  from ever being renamed in the first place, making the whole gap moot for
  anything created since. `reconcileOrphanedQueueEntries` is the one pass
  still live, now generalized around `ever_synced` rather than id shape.
- On web (RN-web/CSS stacking rules), a sibling with **any** explicit
  `position` + positive `zIndex` paints above **all** `zIndex:auto`/unset
  siblings in the same stacking context, regardless of DOM/mount order — so
  giving only the *moving* layer a `zIndex` (to control its own paint order
  relative to content behind it) does not guarantee a *different*, unpositioned
  sibling (e.g. a "pinned" element with no explicit stacking) stays visually on
  top of it. To keep A above B, both need competing explicit values (via
  `overlayLayer(z)` — see `ui/layering.ts`), not just B. Caught on the web-only
  pinned-hero layer in `app/index.tsx` (STASH-2G, PR #504): the collapsible
  content got `zIndex: 1` for its own reasons, which then unexpectedly painted
  over the pinned hero mid-transition until the hero was also given
  `position: relative` + a higher `zIndex`.
- `domain/header-collapse.ts` (the web-only collapsing-header state that
  replaced `Animated.diffClamp`, STASH-2G/PR #504) took **three** Codex review
  rounds to get right, each one only fixing the exact scroll sequence the
  previous comment described. See the "Replace a stateful animation/hysteresis
  primitive" bullet in `CLAUDE.md`'s Working principles before touching this
  file again — the durable fix was modeling the anchor as `diffClamp`'s actual
  invariant (track the running min/max since the last flip), not "the offset
  where the current state began."
  - Follow-on saga in `app/index.tsx` (STASH-33 through STASH-37, PRs #566/
    #567/#569 — inbox search open/close on web): the root cause of "tap the
    search icon, the field opens then immediately closes/never focuses" was
    the underlying `FlatList`'s `keyboardDismissMode="on-drag"` firing on
    incidental scroll/drag from the *opening* gesture itself — indistinguishable
    from a real blur, so the existing (correct) empty-query auto-close fired.
    Fixed with a short timed suppression window after `openSearch()`, not by
    guessing at focus/blur timing (two earlier theories — `flushSync` for
    synchronous focus, and CSS-transition suppression — were tested against
    real STASH reports and proven insufficient before this one was found).
  - `openSearch` pins the header expanded for the duration of the search
    session and must snapshot **every** value the eventual restore depends on
    — not just the collapse state. PR #566 restored only from
    `INITIAL_HEADER_COLLAPSE_STATE`, which discarded a reveal already in
    effect before search opened (closing search collapsed a row the user had
    legitimately just revealed, PR #569). The fix snapshots the real
    pre-search `HeaderCollapseState` in `openSearch` and resumes the
    hysteresis from it on close — and PR #569 itself first shipped without
    also snapshotting the collapsible wrapper's measured **height** (Codex PR
    review catch): that height differs between the search-open layout
    (search input, no sort/browse row) and the normal layout the header
    reverts to, so restoring against the live (search-open) height compared
    the pre-search anchor against the wrong threshold for scroll deltas that
    straddle the two. General lesson: when a UI mode pins/suppresses state and
    you snapshot-and-restore across it, snapshot the whole computation's
    inputs together, not just the headline state.
  - A button whose own icon/meaning toggles based on which element currently
    has focus (the search open/✕ toggle) needs `onMouseDown` `preventDefault`
    on web (PR #567) — react-native-web's `Pressable` forwards unrecognized
    props like `onMouseDown` straight to the host DOM node. Without it, a
    mousedown on the button blurs the still-focused input *before* the click
    fires; with any real (non-instant) gap between mouse-down and mouse-up,
    an empty-query auto-close-on-blur can run first and flip the button back
    to its other state, so the click that follows does the opposite of what
    the user pressed. Only reproduced with a real held-then-released click in
    headless Chromium — an instant synthetic `.click()` never gave the
    deferred close a chance to run first, which is why it eluded PR #566's
    own repro.
- Graph view (`app/graph.tsx`) pan/zoom-release snap-back flash on Android
  (PR #561): resetting the `Animated` transform to identity right after
  scheduling a new baked `viewBox` raced React's async state commit against
  the synchronous `Animated` update, so one frame rendered the reset
  transform against the still-old `viewBox` — a visible snap back before the
  re-render landed and snapped forward to the real view. Fixed by deferring
  the reset to a `useLayoutEffect` keyed on the `viewBoxRect`, so both changes
  commit in the same frame. A same-reference `setViewBoxRect` call (a
  same-object bake with nothing new) is a React no-op that won't re-fire an
  effect keyed on that object — key this class of effect on a monotonic token
  bumped alongside the state write instead, not the object itself.

## Future Work

- Verify native SQLite and share-intent flows on a real Android device.
- Re-run Supabase verification after sync/query changes when credentials are
  available.
- Encrypt local bookmark storage for production builds; see
  `docs/architecture/local-data-encryption.md`.
- Add image bookmark cloud upload with Supabase Storage.
- Library-level AI organizing ("Tidy Up" / consolidate tags) is deferred; the
  spec and productization direction live in `docs/design/library-organizing.md`.
  Grade any candidate model with `scripts/tag-merge-eval` before shipping.
  Phase-1 tag cleanup is done for `totohero` (296→232) and pending for the other
  two libraries.
- Consider a hard server-side version gate through an Edge Function proxy; the
  current `app_config.min_app_version` gate is client-side only.
