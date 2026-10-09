# Keepory agent orientation

Last updated: 2026-10-09 (feature and store module boundaries; task-based context).

Keepory (historically named Stash in code) is an Expo SDK 58 / React Native
bookmark app in `apps/mobile`, with local-first storage, Supabase REST sync,
and Cloudflare Workers web hosting. Source wins over dated prose.

## Start here

- Read `CLAUDE.md` for working rules and the relevant row in
  [the task map](docs/development/agent-task-map.md) before opening large files.
- [The detailed agent reference](docs/development/agent-reference.md) preserves
  subsystem rules, known traps, deployment procedures, and incident history.
  Read the matching section before changing sync, storage, auth, or capture.
- Operational procedures live in `.claude/skills`, mirrored in `.codex/skills`.
  Prefer configured MCP tools, then applicable skills, then scripts/CLI. Change
  both skill mirrors together so agent procedures do not drift.
- Verify branch/PR/CI state live when relevant; dated milestones and verification
  reports are historical. Never infer a deployed migration or function from CI.

## Architecture entry points

| Area | Location under `apps/mobile/src` |
| --- | --- |
| Routes | `app/`; Inbox and Settings delegate to `features/` |
| Inbox | `features/inbox/`: screen, search, results, selection, item renderer, layout |
| Settings | `features/settings/`: sections and account/import/export/reset actions |
| React store wiring | `store/bookmarks.tsx`: state, live refs, orchestration |
| Store behavior | `store/bookmarks/`: typed command and lifecycle hooks |
| Pure logic and row types | `domain/`; `types.ts` intentionally uses DB snake_case |
| Durable storage | `storage/types.ts`; `repository.native.ts` (SQLite), `repository.ts` (web/SSR) |
| API | `api/bookmarks.ts` facade; `api/bookmark-*` operation modules |
| Auth and realtime | `supabase/` |
| Queue upload / incremental pull | `sync/sync-bookmarks.ts`, `sync/pull-bookmarks.ts` |
| Share intake | `share/` |
| Reusable UI | `ui/` |

Backend migrations and Edge Functions live under `supabase/` at the repo root.
Keep feature modules outside `app/` so Expo Router cannot treat them as routes.
Keep dependency contracts explicit; do not inject the entire store into a module.

## Critical invariants

- **Capture is sacred:** save optimistically and durably before network work;
  enrichment/sync failures must not throw away captures. Toast-mode dismissal
  must await `persisted === true`. See the reference's Share Capture section.
- User-authored fields and generated metadata are separate. `title_is_derived`
  records title provenance; `metadata_status` alone cannot distinguish a real
  fetched title from a URL fallback. See `domain/url-title.ts`.
- Cosmetic repairs and `last_accessed_at` are local-only: never bump
  `updated_at` or enqueue mutations, or generated data can defeat newer cloud
  data under last-write-wins. See `domain/title-backfill.ts`.
- Maintain one latest pending queue operation per bookmark. Upload before pull;
  pull uses an `updated_at` watermark with a five-minute overlap and protects
  queued local work. Replace organization snapshots, then re-layer pending ops.
  See `sync/pull-bookmarks.ts` and the reference's Sync And Auth section.
- Anonymous → real carries captures as pending creates; real A → real B
  replaces account cache; real → anonymous preserves durable data. Expired
  real sessions must not mint an anonymous replacement or run destructive sync;
  hide account-owned cache until ownership is reconciled. Never-synced captures
  remain accessible. See `docs/architecture/sync-account-switching.md`.
- Anonymous sessions never run remote-deletion diffs: an empty remote snapshot
  is not evidence of deletion on another device. Sign-in must trigger sync on
  changed `auth.userId`, including when the queue is empty. See the same guide.
- Capture UUIDs are stable except server duplicate adoption and account rehoming.
  Both identity changes must rekey queued/tag/AI state atomically and maintain
  aliases for in-flight work. UUID shape is not proof of prior sync: use
  `isBookmarkSyncedOnce`, and preserve `ever_synced` when changing sync status.
  Insert a newly adopted ID on web; `updateBookmark` is not an upsert. See
  `storage/types.ts` and the reference's identity rules.
- Sync, import flushing, pause, and reset have different busy guards. Preserve
  their interaction matrix and reset epochs across modules. See
  `docs/architecture/sync-pause-import-reset.md` before changing any guard.
- A completed bulk-create result clears its create entry independently of
  `removeEntry`. Persist reconcile follow-ups sequentially and reread fresh
  rows before full-row writes; never fan writes out onto the SQLite actor.
  See `docs/architecture/sqlite-write-contention.md` and the sync/reset guide.
- Preserve one-time queue health escalation: ordinary failures at three retries,
  transient transport failures at six; do not alert for unattempted rows or add
  duplicate reports. See `sync/sync-bookmarks.ts`.
- Keep request deadlines active through body reads and retain the longer AI
  request deadline. Reject malformed/non-array snapshots; interpreting missing
  data as an empty remote list can delete local rows. See
  `docs/development/reporting-and-request-traps.md` and `api/bookmarks.ts`.
- UI delete means Trash (`deleted_at`); the REST API's default delete still
  archives (`is_archived`). Preserve both contracts unless explicitly changed.
- Share confirmation drains on cold start/resume and navigates only on a user
  tap. Diagnose durable `shareAttempt` evidence before guessing native fixes;
  most other report diagnostics reset on restart. See the agent reference.
- Analytics uses the event allowlist and sanitizer; never await analytics in
  capture, dismissal, or navigation. See `analytics/events.ts` and `sanitize.ts`.
- Search snapshots both header collapse state and measured height, suppresses
  incidental on-drag dismissal during opening, and preserves web mousedown
  focus handling. See `features/inbox/use-inbox-search.ts` and the reference.

## Commands and checks

Use Node 22 and pnpm 10. Run from the repo root:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm test:components --runInBand
```

- Install dependencies with `pnpm install --frozen-lockfile` if binaries are absent.
- Root lint checks whitespace, static env access, overlay elevation, workflow
  pins, and dependency-cruiser architecture rules. Do not
  invoke the separate `expo lint` lane inside `apps/mobile`.
- Architecture policy and graph reports: see
  [architecture checks](docs/development/architecture-checks.md).
- Component tests are `.test.tsx`; pure Node tests are `.test.ts`. Use focused
  commands in the task map; appending a path to `pnpm test` does not narrow it.
- `EXPO_PUBLIC_*` reads must be statically addressable for release inlining.
- `pnpm dev` and `dev:android` / `dev:ios` / `dev:web` start Expo.
- `pnpm verify:supabase` verifies schema/REST/RLS, not Edge Functions. Deploy and
  smoke changed functions separately. New RPCs/columns must be live before
  dependent client code merges. See
  `docs/development/database-migration-deploy-ordering-retro.md`.
- Never run `pnpm dedupe:supabase --apply` without explicit user confirmation:
  it bypasses RLS and may touch all users. See the agent reference.
- Native SQLite/share-intent needs a standalone build and device smoke; Expo Go
  cannot verify it. Follow `docs/development/releasing.md`.

## Review and operational work

Follow the [reference's PR workflow](docs/development/agent-reference.md#collaboration-and-pr-workflow)
and `docs/design/sync-change-review.md` for sync-related changes. Use a fresh
feature branch, rebase before publishing, run all four gates, open a regular PR,
address reviews/CI/conflicts, and allow the documented bot-review window.
Do not auto-merge migration/function, auth/sync-deletion, deployment, or release
workflow changes. Identify manually posted comments with the actual AI agent.
For Sentry incidents, query MCP first and fall back to the authenticated API;
local incident history is not evidence of current issue state.

Cloudflare hosting, APK build outputs, graph/header traps, verification history,
and deferred product work remain indexed in the detailed agent reference.
Exclude dependency/generated directories from routine searches. Keep this file
an index following `docs/development/maintaining-agents-md.md`.
