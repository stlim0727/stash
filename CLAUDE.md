# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Stash is a mobile bookmark app (React Native + Expo, Supabase backend) inspired by Raindrop.io, with an inbox-first UI and a capture-from-any-app share flow. See `README.md` for product direction and `AGENTS.md` for the detailed, continuously-updated project state and per-milestone implementation notes — **read `AGENTS.md` first** when picking up work; it is the source of truth for what is done and why.

## Commands

pnpm workspace, **Node 22, pnpm 10**. Run everything from the repo root:

- `pnpm dev` (and `dev:android` / `dev:ios` / `dev:web`) — Expo dev server for `apps/mobile`.
- `pnpm lint` — runs `format:check` (whitespace/final-newline only — there is no ESLint config) **and** `lint:env` (`scripts/check-static-env.mjs`, which enforces how `EXPO_PUBLIC_*` env vars may be referenced). `pnpm format` auto-fixes formatting.
- `pnpm typecheck` — `tsc --noEmit` in `apps/mobile`.
- `pnpm test` — two lanes: the mobile **Node-runner** logic tests **plus** `test:functions` (Supabase edge-function tests under `supabase/functions/**/*.test.ts`).
- `pnpm test:components` — jest-expo + React Native Testing Library for hooks/components.
- `pnpm verify:supabase` — 16-check end-to-end script against a live Supabase project; needs `EXPO_PUBLIC_SUPABASE_URL` + `EXPO_PUBLIC_SUPABASE_ANON_KEY` and anonymous sign-ins enabled.

Test lanes are split by extension (run a single file by passing the path):

- **`src/**/*.test.ts`** — pure logic, via Node's built-in runner (`--experimental-transform-types`, `@/` alias resolved by `scripts/register-alias.mjs`). Use fakes, no React.
- **`src/**/*.test.tsx`** — jest, for hooks/components. Lives under `src/__tests__/` so expo-router never treats tests as routes. RNTL v14: `render`/`renderHook`/`fireEvent` are async — `await` them and wrap state changes in `await act(async () => …)`.

Headless build check (no emulator): `cd apps/mobile && CI=1 pnpm exec expo export --platform web` (use `--platform ios` to exercise the native/Hermes + expo-sqlite path); delete the gitignored `dist/` afterward.

## Architecture

Monorepo (`apps/*`, `packages/*`) — currently one app, `apps/mobile` (Expo SDK 56, RN 0.85, expo-router, TypeScript). Routes live in `apps/mobile/src/app`. Key layers under `apps/mobile/src`:

- **`domain/`** — pure, platform-free logic and types. `types.ts` mirrors the snake_case Postgres schema (`docs/architecture/data-model.md`) 1:1 on purpose, for direct row mapping. URL handling (`urls.ts`), metadata enrichment (`enrichment.ts`, `page-metadata.ts`), search, and pending-mutation engines live here and are heavily unit-tested.
- **`storage/`** — durable persistence behind the `BookmarkRepository` interface. Platform is chosen by **Metro platform extensions**: `repository.native.ts` (expo-sqlite) on iOS/Android, `repository.ts` (localStorage / in-memory during SSR) on web. New/changed bookmarks enqueue entries in a local pending queue carrying a sync `operation` (create/update/delete), one entry per bookmark (newer mutations supersede older).
- **`store/bookmarks.tsx`** — React context that orchestrates the **local-first** model: saves/edits are optimistic and persisted immediately, then queued; nothing blocks on the network. Capture must never be broken by enrichment or sync.
- **`api/bookmarks.ts`** — the documented bookmark API surface (`docs/api/bookmarks.md`) implemented against **Supabase REST directly (no `supabase-js`)**, scoped to the authenticated user.
- **`supabase/`** — hand-rolled auth client (anonymous-first sessions, single-flighted creation, refresh/restore) and **browser PKCE OAuth** (Apple/Google) in `oauth.ts` (pure) + `run-oauth.ts` (the one auth file allowed to import native modules).
- **`sync/`** — uploads the queue (server-side idempotent so retries can't duplicate), then incremental pull by `updated_at` watermark; last-write-wins except rows with queued local work. `account-transition.ts` plans anonymous→real (carry over) vs real A→real B (replace) to prevent data loss on account switch (see `docs/architecture/sync-account-switching.md`).
- **`share/`** — `expo-share-intent` capture: extract a URL from the shared payload, save via the normal store path, toast, route to Inbox — no editor. No-op on web.

Backend: `supabase/migrations` (owner-scoped RLS) and `supabase/functions` edge functions (`ai-enrich`, `feedback-bridge`).

## Core conventions

- **Keep user-authored fields separate from generated/AI metadata.** This is the central product principle (`docs/api/bookmarks.md`): enrichment and sync only fill generated fields that are still null and must never overwrite user-typed values.
- **Capture is sacred** — saves are local-first and optimistic; enrichment and sync are fire-and-forget and record a failed/skipped status instead of throwing.
- Duplicate saves are idempotent (reuse the existing bookmark); deletes archive by default.
- Domain types stay snake_case to mirror the DB; only reference `EXPO_PUBLIC_*` env vars in the ways `lint:env` permits.

## Branch / release notes

- **Branch strategy: trunk-based + release branches** (`docs/development/branching.md`). `main` is the trunk (next release, currently `0.2.x`); `release/0.1.x` is the maintenance line for `0.1.*` patches. Base each change on the line it ships in — 0.2.x features → `main`; 0.1.x bug fixes → `release/0.1.x`, then **cherry-pick the fix forward into `main`**. Never merge `main` into a release branch.
- **Pull requests: open as regular (non-draft) PRs, not drafts.**
- CI (`.github/workflows/ci.yml`) runs lint, typecheck, and tests on every PR.
- Installable Android APK without an EAS account: the `android-apk.yml` workflow (`expo prebuild` → Gradle `assembleRelease`, debug-signed standalone, arm64-v8a only). Trigger/output mapping and the MCP/`gh` invocation steps are documented in `AGENTS.md`. EAS profiles for store builds live in `apps/mobile/eas.json`; release flow in `docs/development/releasing.md`.
