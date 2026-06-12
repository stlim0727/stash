# Agent Handoff — Stash

This file captures the project state and working conventions so any agent (Codex, Claude, or a human) can continue development without re-deriving context. Last updated after Milestone 6 API scaffolding (2026-06-11).

## Current state

Milestones 0–4 from `docs/development/milestones.md` are **complete** and merged to `main` (PR #1, #2, #3). Milestone 5 is scaffolded but still needs real Supabase project credentials before acceptance criteria can be verified. Milestone 6 API code is scaffolded on top of that unverified Supabase bootstrap:

- **M0** — repo tooling: pnpm workspace, Node 22 policy, root scripts, docs.
- **M1** — Expo SDK 56 app under `apps/mobile` (TypeScript, expo-router). Launches into Inbox; Add Bookmark (modal), Settings, and Bookmark Detail (`bookmark/[id]`) screens exist.
- **M2** — domain types in `apps/mobile/src/domain/types.ts` mirror the snake_case schema in `docs/architecture/data-model.md` 1:1 (intentional, for later Supabase row mapping). Mock data in `src/domain/mock-data.ts`.
- **M3** — local-first manual bookmark creation: `src/store/bookmarks.tsx` (React context). URL validation/normalization in `src/domain/urls.ts`. Saves are optimistic; duplicates reuse the existing bookmark (idempotent, per `docs/api/bookmarks.md`).
- **M4** — durable storage behind the `BookmarkRepository` interface (`src/storage/types.ts`): `repository.native.ts` (SQLite via expo-sqlite) on iOS/Android, `repository.ts` (localStorage, memory during SSR) on web, resolved by Metro platform extensions. New bookmarks enqueue a `local_pending_bookmarks` entry (sync status, retry count, last error); the queue is visible in Settings. All background writes await a shared repository-ready promise, and the startup load merges into optimistic state instead of replacing it (fixes a save-during-load race found in PR #3 review).
- **M5 scaffold** — Supabase env template and setup docs are in place; the app has a lightweight Supabase auth wrapper (hand-rolled REST, no supabase-js dependency) that restores, refreshes (via `grant_type=refresh_token` when the access token nears expiry), or creates an anonymous session when `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` are available. Session creation is single-flighted so concurrent callers cannot mint two anonymous users. Settings reports config/auth state; initial SQL migration creates bookmarks/tags/bookmark_tags/collections/ai_enrichments with owner-scoped RLS policies.
- **M6 scaffold** — `apps/mobile/src/api/bookmarks.ts` implements the documented bookmark API surface against Supabase REST: `createBookmark`, `listBookmarks`, `getBookmark`, `updateBookmark`, `deleteBookmark`, `addTags`, `removeTags`, `updateAIEnrichment`, and `applyAISuggestions`. It scopes every request to the authenticated session user, maps remote rows back to local domain types, archives by default for deletes, keeps AI enrichment separate, and handles URL/tag duplicate conflicts where possible.
- **M7 scaffold** — sync service: `src/sync/sync-bookmarks.ts` uploads queue entries through `createBookmark` (idempotent server-side, so retries cannot duplicate remote rows); the local bookmark row adopts the remote ID via `repository.replaceBookmark`. The store auto-syncs when auth and local data are ready or a new pending entry appears; failed entries record retry count/last error and are retried on the next save or the manual "Sync now" action in Settings, which also shows live sync status.

## Next step: verify M5–M7 against Supabase

Provide a Supabase project URL/key, enable anonymous sign-ins, apply `supabase/migrations/20260611000000_initial_schema.sql`, and verify: anonymous session creation/restoration/refresh, RLS-scoped table access, API behavior, and end-to-end queue upload (save offline → entry syncs → bookmark gets remote ID and synced status). After that, proceed to M8 (share intake prototype) per the milestones doc.

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
