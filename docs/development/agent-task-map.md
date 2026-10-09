# Agent task map

Start with the matching implementation and test. Paths below are relative to
`apps/mobile/src`; the route/store/API facades preserve existing imports.
Only open the provider when changing shared state or wiring. Only open the
screen when changing composition or interactions across several sections.

| Task | Implementation to read first | Focused component suite / Node file |
| --- | --- | --- |
| Save a link, note, or shared image | `store/bookmarks/use-add-bookmark.ts` | `bookmarks-store`, `add-screen`, `share-intent-handler` |
| Import a library | `store/bookmarks/use-import-bookmarks.ts`, `use-import-outbox-sync.ts` | `mass-import-sync`, `settings-import` |
| Edit fields or refresh previews | `store/bookmarks/use-bookmark-edits.ts` | `bookmarks-store`, `title-backfill-store` |
| Trash / permanent delete | `store/bookmarks/use-delete-commands.ts` | `bookmarks-store`, `collection-store` |
| Reset the library | `store/bookmarks/use-reset-library.ts` | `reset-library`, `sync-paused` |
| Tags / collections | `store/bookmarks/use-tag-commands.ts`, `use-collection-commands.ts`, `use-tag-sync.ts` | `local-first-tags`, `collection-store`, `collection-sync-race` |
| AI request or overflow quota | `store/bookmarks/use-ai-enrichment-request.ts` | `ai-enrichment-requests`, `ai-enrichment-dispatch-and-quota` |
| AI retries / account rekeying | `store/bookmarks/use-ai-retry-bookkeeping.ts`, `use-ai-retry-lifecycle.ts` | `ai-enrichment-retries-and-accounts`, `ai-enrichment-server-queue` |
| Pull-delivered AI completion | `store/bookmarks/use-sync-coordinator.ts` | `ai-enrichment-pull-completion` |
| Bulk-create reconciliation / durability | `store/bookmarks/use-sync-coordinator.ts`, `sync/sync-bookmarks.ts` | `ai-enrichment-bulk-reconciliation`, `ai-enrichment-bulk-durability` |
| Hydration / initial library state | `store/bookmarks/use-library-hydration.ts` | `durable-snapshot`, `splash-readiness`, `logout-cache-clear` |
| Search open/close or focus | `features/inbox/use-inbox-search.ts` | `inbox-screen`, `inbox-back-handler`, `search-suggestion-shelf` |
| Search/facet/folder results | `features/inbox/use-inbox-results.ts`, `domain/search.ts` | `inbox-screen`, `inbox-folder-management`; `domain/search.test.ts` |
| Selection / folder / bulk actions | `features/inbox/use-inbox-selection.ts` | `inbox-multi-select`, `inbox-folder-management` |
| Cards / list / folder rendering | `features/inbox/InboxItemRenderer.tsx`, `presentation.tsx`, `layout.ts` | `inbox-screen`, `inbox-facet-placeholder` |
| Settings account actions | `features/settings/AccountSection.tsx`, `use-account-actions.ts` | `settings-account` |
| Settings activity / sync status | `features/settings/ActivitySection.tsx`, `SettingsScreen.tsx` | `settings-sync-breakdown`, `settings-sync-breakdown-ai-quota` |
| Settings preferences | `features/settings/PreferencesSection.tsx` | `settings-ai-suggestions`, `settings-push-notifications`, `settings-session-replay` |
| Settings import/export/reset | `features/settings/DataSection.tsx`, `use-export-actions.ts`, `use-import-actions.ts`, `use-reset-actions.ts` | `settings-export`, `settings-import`, `reset-library` |
| API create/update/dedupe / image storage | `api/bookmark-writes.ts`, `bookmark-helpers.ts` | `api/bookmarks.test.ts` |
| API reads / pagination | `api/bookmark-reads.ts`, `bookmarks.ts` transport | `api/bookmarks.test.ts`, `sync/pull-bookmarks.test.ts` |
| API tag / collection writes | `api/bookmark-organization.ts` | `api/bookmarks.test.ts` |
| API AI requests / queue / restoration | `api/bookmark-enrichment.ts` | `api/bookmarks.test.ts`, `supabase/client.test.ts` |

## Running focused checks

From the repo root, use actual paths so similarly named suites do not match:

```sh
pnpm test:components --runInBand --runTestsByPath src/__tests__/settings-export.test.tsx
pnpm test:components --runInBand ai-enrichment
```

For one Node suite, run from `apps/mobile`:

```sh
node --experimental-transform-types --import ../../scripts/register-alias.mjs --test src/api/bookmarks.test.ts
```

Before publishing, run the root lint, typecheck, Node/function, and component
lanes specified in `AGENTS.md`. Component acceptance covers both platform
branches exercised by the existing tests; standalone device acceptance remains
separate. A web export verifies bundling, not native device behavior.

## Contracts and state ownership

- The provider owns shared state and live refs. Command hooks receive explicit
  dependencies, preserve callback dependency arrays, and do not own competing
  copies of the same queue, epoch, identity alias, or busy flag.
- Capture, import, edit, delete, and reset have separate hooks: changes to one
  command do not require reading all the others. Reset necessarily clears many
  shared states and has a larger dependency contract.
- `ensureRepositoryReady` lives in `store/bookmarks/repository-ready.ts` and is
  re-exported by the original facade. All callers share the same init promise.
- `store/bookmarks/types.ts` holds the consumer contract. Prefer the relevant
  member/type or a bounded span rather than reading the full contract each time.
- API operation functions receive only the session, transport, and related
  methods they use. The class facade retains public signatures and private
  response validation/pagination. Type-only imports must stay explicitly typed:
  the Node test runner strips TS syntax without inferring unused type imports.
- `__tests__/helpers/ai-enrichment-harness.tsx` registers shared mocks before
  importing the store. Each split suite loads it first and calls its reset in
  `beforeEach`. Mutable auth/foreground fixtures live in `mockHarness`.

## Measuring context cost

Compare representative changes using files/spans read, input tokens, files
changed, and passing focused tests. Record actual agent tokens when available;
line counts are only a discoverability proxy, not a token-savings claim.
The pre-refactor hotspots were: provider 9,545 lines, inbox 4,785, settings
2,149, API 1,829, AI store tests 4,651, and root AGENTS.md 632.
The new task entry points are summarized below; shared contracts and domain
logic may also be needed depending on the change.

| Representative task | Previous containing file (lines) | New primary module (lines) |
| --- | --- | --- |
| Capture behavior | 9,545 | `store/bookmarks/use-add-bookmark.ts` (563) |
| Tag edits | 9,545 | `store/bookmarks/use-tag-commands.ts` (177) |
| Search focus | 4,785 | `features/inbox/use-inbox-search.ts` (247) |
| Settings export | 2,149 | `features/settings/use-export-actions.ts` (122) |
| AI API requests | 1,829 | `api/bookmark-enrichment.ts` (277) |
| Retry regression tests | 4,651 | `__tests__/ai-enrichment-retries-and-accounts.test.tsx` (522) |
