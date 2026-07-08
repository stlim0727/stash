# Agent Handoff: Stash

This file is the fast-start context for agents working in this repo. It should
stay readable: keep durable project facts here, and move deep implementation
history into docs or PR notes when possible. When editing this file, follow
`docs/development/maintaining-agents-md.md`.

Last updated: 2026-07-09.

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
- A clean `vX.Y.Z` tag publishes a stable/latest versioned release.

Trigger manually from GitHub Actions, or push a `v*` tag. The APK is arm64-v8a
only, debug-signed, standalone, and includes build provenance in Settings.

## Known Traps

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

## Future Work

- Verify native SQLite and share-intent flows on a real Android device.
- Re-run Supabase verification after sync/query changes when credentials are
  available.
- Encrypt local bookmark storage for production builds; see
  `docs/architecture/local-data-encryption.md`.
- Add image bookmark cloud upload with Supabase Storage.
- Add sync-queue health escalation when retry counts cross a threshold.
- Consider a hard server-side version gate through an Edge Function proxy; the
  current `app_config.min_app_version` gate is client-side only.
