# Agent Handoff — Stash

This file captures the project state and working conventions so any agent (Codex, Claude, or a human) can continue development without re-deriving context. Last updated after Milestone 10 (2026-06-12).

## Current state

**All milestones M0–M10 in `docs/development/milestones.md` are implemented.** M0–M4 are merged to `main` (PR #1–#3) and verified; M5–M10 are code-complete and verified by typecheck/lint/web+iOS bundle/`expo prebuild`, but two kinds of verification can only happen outside this sandbox (see "Remaining verification"):

- **M0** — repo tooling: pnpm workspace, Node 22 policy, root scripts, docs.
- **M1** — Expo SDK 56 app under `apps/mobile` (TypeScript, expo-router). Launches into Inbox; Add Bookmark (modal), Settings, and Bookmark Detail (`bookmark/[id]`) screens exist.
- **M2** — domain types in `apps/mobile/src/domain/types.ts` mirror the snake_case schema in `docs/architecture/data-model.md` 1:1 (intentional, for later Supabase row mapping). Mock data in `src/domain/mock-data.ts`.
- **M3** — local-first manual bookmark creation: `src/store/bookmarks.tsx` (React context). URL validation/normalization in `src/domain/urls.ts`. Saves are optimistic; duplicates reuse the existing bookmark (idempotent, per `docs/api/bookmarks.md`).
- **M4** — durable storage behind the `BookmarkRepository` interface (`src/storage/types.ts`): `repository.native.ts` (SQLite via expo-sqlite) on iOS/Android, `repository.ts` (localStorage, memory during SSR) on web, resolved by Metro platform extensions. New bookmarks enqueue a `local_pending_bookmarks` entry (sync status, retry count, last error); the queue is visible in Settings. All background writes await a shared repository-ready promise, and the startup load merges into optimistic state instead of replacing it (fixes a save-during-load race found in PR #3 review).
- **M5 scaffold** — Supabase env template and setup docs are in place; the app has a lightweight Supabase auth wrapper (hand-rolled REST, no supabase-js dependency) that restores, refreshes (via `grant_type=refresh_token` when the access token nears expiry), or creates an anonymous session when `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` are available. Session creation is single-flighted so concurrent callers cannot mint two anonymous users. Settings reports config/auth state; initial SQL migration creates bookmarks/tags/bookmark_tags/collections/ai_enrichments with owner-scoped RLS policies.
- **M6 scaffold** — `apps/mobile/src/api/bookmarks.ts` implements the documented bookmark API surface against Supabase REST: `createBookmark`, `listBookmarks`, `getBookmark`, `updateBookmark`, `deleteBookmark`, `addTags`, `removeTags`, `updateAIEnrichment`, and `applyAISuggestions`. It scopes every request to the authenticated session user, maps remote rows back to local domain types, archives by default for deletes, keeps AI enrichment separate, and handles URL/tag duplicate conflicts where possible.
- **M7 scaffold** — sync service: `src/sync/sync-bookmarks.ts` uploads queue entries through `createBookmark` (idempotent server-side, so retries cannot duplicate remote rows); the local bookmark row adopts the remote ID via `repository.replaceBookmark`. The store auto-syncs when auth and local data are ready or a new pending entry appears; failed entries record retry count/last error and are retried on the next save or the manual "Sync now" action in Settings, which also shows live sync status.
- **M8 scaffold** — share intake via `expo-share-intent@7` (SDK 56). The `expo-share-intent` config plugin is registered in `app.json` (default text/URL filters; uses the existing `stash` scheme). `src/share/share-intent-handler.tsx` consumes `useShareIntentContext`, extracts a URL from the shared payload (`extractFirstUrl` in `domain/urls.ts` handles text that wraps a link), saves it via the existing `addBookmark` (persist-then-queue, never blocks on network), routes to Inbox, and shows a short non-blocking toast — no full editor. `ShareIntentProvider` wraps the root layout. The native module is a no-op on web.
- **M9** — metadata enrichment placeholder. `src/domain/enrichment.ts` derives title/site_name/favicon_url from the URL (no network, deterministic; a real OpenGraph fetch drops into `deriveMetadata` later). The store runs `enrichInBackground` after each save and over any still-`pending` bookmarks on startup: it is fire-and-forget (capture never blocks), only fills generated fields that are still null (user-typed titles are preserved), and records a `failed`/`skipped` status on error or text-only shares instead of throwing — so enrichment can never break bookmark creation. `metadata_status` transitions pending → complete/failed/skipped. The Detail screen renders the favicon and preview image when present.
- **M10** — MVP polish + release readiness. Archive/unarchive and permanent delete on the Detail screen (store `archiveBookmark`/`deleteBookmark`; repository gained `deleteBookmark`/`removeQueueEntry`; deleting also drops the pending queue entry so it never syncs). Inbox shows loading/empty/error states (`loadError` surfaces a storage-failure banner). Settings shows library counts and app version. Explicit bundle IDs (`com.stash.app`) in `app.json`; `apps/mobile/eas.json` defines development/preview/production build profiles; `docs/development/releasing.md` documents the build/release flow and an internal-build smoke-test checklist.

## Remaining verification (requires resources outside this sandbox)

1. **Native build / on-device (M4 SQLite, M8 share intake)** — the SQLite and share modules cannot run in Expo Go. `pnpm --filter mobile android`/`ios` run `expo run:*` (need Android Studio / Xcode), or use EAS (`eas build --profile preview ...`). `expo prebuild` is validated in CI for both platforms: Android gets the `SEND`/`text/*` intent filter; iOS generates a Share Extension target with app group `group.com.stash.app` (set an Apple DEVELOPMENT_TEAM in Xcode). Smoke-test checklist is in `docs/development/releasing.md`. Android is the lower-friction platform to verify first.
2. **Supabase (M5–M7)** — provide a project URL/key, enable anonymous sign-ins, apply `supabase/migrations/20260611000000_initial_schema.sql`, then verify anonymous session creation/restoration/refresh, RLS-scoped access, API behavior, and end-to-end queue upload (save → entry syncs → bookmark gets remote ID + synced status).

## Post-MVP work completed

- **Test runner** — `pnpm test` runs Node 22's built-in runner with type stripping over `src/**/*.test.ts` (no new runtime deps). Suites cover URL handling, enrichment behavior, and the page-metadata parser. Note: modules under test must use relative `.ts` imports for anything they import at runtime (Node cannot resolve the `@/` alias); Metro handles explicit `.ts` paths fine.
- **Real OpenGraph fetch** — `src/domain/page-metadata.ts` fetches a page (AbortController timeout, HTML-only, size-capped) and parses og:/twitter: meta, `<title>`, and favicon links; `enrichBookmark` prefers fetched values and falls back to URL-derived ones, with the fetcher injectable for offline tests.
- **Archived view** — `/archived` lists archived bookmarks (restorable via detail's Unarchive); reachable from Settings' Library row.

## Possible future work (beyond the current milestone list)

- Sync archive/delete/update mutations to Supabase (the sync service currently only uploads new bookmarks via `createBookmark`; the remote delete on the delete-vs-sync race is the only mutation sent today).
- Tags/collections/AI enrichment are still static mock data in the UI layer (`mock-data.ts`); wire them to the API.

**M5–M7 need Supabase** — provide a project URL/key, enable anonymous sign-ins, apply `supabase/migrations/20260611000000_initial_schema.sql`, and verify anonymous session creation/restoration/refresh, RLS-scoped table access, API behavior, and end-to-end queue upload (save offline → entry syncs → bookmark gets remote ID and synced status).

**Next milestone: M10** (MVP polish and internal release readiness) — empty/loading/error states, finish Settings, archive/delete flows, EAS build config, release docs. M9's enrichment is URL-derived only; a future pass can fetch real OpenGraph metadata in `deriveMetadata`.

## Conventions and commands

- pnpm workspace (`apps/*`, `packages/*`). Node 22, pnpm 10. Run everything from the repo root:
  - `pnpm dev` / `dev:android` / `dev:ios` / `dev:web` — Expo dev server.
  - `pnpm lint` — wraps `scripts/format.mjs --check` (trailing whitespace + final newline only; there is no ESLint config yet).
  - `pnpm typecheck` — `tsc --noEmit` in apps/mobile.
  - `pnpm test` — intentional placeholder; no test runner is set up yet.
- Headless build verification (no emulator needed): `cd apps/mobile && CI=1 pnpm exec expo install --check || true; CI=1 pnpm exec expo export --platform web` (also `--platform ios` to compile the native/Hermes path, which exercises the expo-sqlite code). Delete `dist/` afterwards; it is gitignored.
- Keep user-authored fields separate from generated/AI metadata (core product principle; see `docs/api/bookmarks.md`).

## Environment gotchas (sandboxed/cloud sessions)

- `expo install <pkg>` may fail offline against the Expo versions API. Get the SDK-pinned version locally instead: `node -e "console.log(require('./apps/mobile/node_modules/expo/bundledNativeModules.json')['<pkg>'])"`, then `pnpm add <pkg>@<that version>`.
- `pnpm install` reports two benign peer-dependency warnings (react-native-worklets, @react-native/metro-config).

## Known gaps / follow-ups

- SQLite persistence has not been smoke-tested on a real device/emulator (only compile-verified via the iOS Hermes export). Worth doing once: save a bookmark, restart, confirm it survives.
- Duplicate detection only checks in-memory state; a save made while the startup load is in flight could miss a stored duplicate (cosmetic: creates a second entry rather than losing data).
- Tags, collections, and AI enrichments are still static mock data (`mock-data.ts`); they become real in M5/M6.
- `bookmarks` SQLite table stores the full record as a JSON column plus `created_at`/`is_archived` columns; promote fields to real columns when M6 query needs grow.
