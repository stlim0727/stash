# SOLID principles review — Stash mobile app

**Scope:** `apps/mobile/src` (domain, storage, store, api, supabase, sync, share layers).
**Status:** Analysis only — no code changes in this PR. Captures an aligned position
reached after an initial assessment was challenged by an independent adversarial review.

> This document is intentionally open for further review. The "Agreed refactor set"
> at the end is a proposal, not a commitment.

## How this review was produced

1. An initial SOLID assessment was written from a full read of the core seams.
2. An **independent reviewer pass** (a separate agent with fresh context, instructed
   to disagree, not validate) challenged every claim against the code.
3. The two positions were reconciled. Where the original claims were wrong or
   overstated, they were revised; one reviewer overstatement was corrected back.

The result below is the **aligned** position, not the original take.

## Verdicts at a glance

| Principle | Verdict | One-line summary |
|-----------|---------|------------------|
| **S**RP | Relatively weakest | Not a "god object" — one overgrown method (`syncNow`) + duplicated bookmark construction. |
| **O**CP | Reasonable | Platform-extension pattern is real OCP; the genuine gap is duplicated `Bookmark` literals, not switch statements. |
| **L**SP | Good | Both repository impls substitute cleanly; saved partly by environment, not just by code. |
| **I**SP | Mixed (no action) | Fat repository interface, but single consumer/impl — YAGNI; codebase already shows the lazy fix. |
| **D**IP | Strongest | Interface-based seams throughout sync; one caveat at the top-level context. |

---

## S — Single Responsibility · relatively weakest

**Aligned conclusion:** SRP is the weakest of the five, but the original "god object,
extract a `SyncOrchestrator`" framing was wrong on both diagnosis and prescription.

### What's actually true

The heavy logic is *already* decomposed into pure, injected, tested modules:

- `syncQueueEntry`, `reconcileOrphanedQueueEntries`, `isSyncable` — `sync/sync-bookmarks.ts`
- `pullRemoteChanges` — `sync/pull-bookmarks.ts`, which already takes injected deps and
  **returns deltas** (`result.upserts / deletions / enrichments / tagData`) that the
  context merely applies (`store/bookmarks.tsx:1280-1308`).
- `planAccountTransition` — `sync/account-transition.ts`
- the `pending-tags` engine — `domain/pending-tags.ts`

So `store/bookmarks.tsx` is an **orchestration seam** wiring pure logic to React state,
not an undifferentiated blob. Line count was conflated with "reasons to change."

### Why the original "SyncOrchestrator returning deltas" fix was the riskiest idea

`syncNow` (`store/bookmarks.tsx:1017-1318`) performs **interleaved** optimistic
`setState` calls mid-loop (per-entry UI updates) while reading shared mutable
coordination state:

- `deletedIds` tombstones — read at `:1079`, `:1098`, `:1274`
- the `syncInFlight` in-flight guard
- the `*Ref` "latest mirror" refs (`bookmarksRef`, `queueRef`, `pendingTagOpsRef`, `tagDataRef`)

The mid-flight-delete handling (`:1098-1118`) is the crux: a delete landing *during* an
upload must undo rows `syncQueueEntry` just wrote, best-effort-delete the remote row, and
enqueue a durable delete — all reading and writing that shared state in a precise order.
Extracting this into a module that "returns deltas" would require inventing a delta-*stream*
protocol to replace what is currently ordered `setState` calls. That trades a long-but-linear
function for a worse cross-module coordination problem.

### The genuine, low-risk move

`syncNow` is a real method-level liability (five phases in ~300 lines). The honest fix is
small: extract the two already-near-pure inline blocks —

- leftover-reconciliation (`:1039-1066`)
- the account-transition **apply** loop (`:1215-1257`) — the *planner* is already extracted

— into `sync/` helpers, shaving ~100 lines without touching the interleaved upload loop.

### Secondary SRP leak (minor, defensible)

`getTagsForBookmark` / `getCollection` / `getEnrichment` (`:455-492`) bake a `mock*`
fixture fallback into runtime display logic, not just init seeding. Small leak; defensible
given the "samples behave like cloud rows" design intent.

---

## O — Open/Closed · reasonable

- **Real OCP:** the `BookmarkRepository` + Metro platform-extension pattern means adding a
  platform is a *new file*, not edits to callers. `deriveMetadata` (`domain/enrichment.ts`)
  is explicitly documented for drop-in replacement.
- **Corrected from the original take:** `sortParam` (`api/bookmarks.ts:154-166`) and
  `syncQueueEntry`'s operation branch are **exhaustive switches over closed unions** —
  exemplary, not OCP violations. Calling them smells was over-application.
- **The real gap:** the new-`Bookmark` literal (~20 fields) is hand-spelled in two sites
  that can drift — `addBookmark` (`store/bookmarks.tsx:521-546`) and `importBookmarks`
  (`:617-638`). (The account-rehome path at `:1221` is a *spread* of the existing row, and
  the API `createBody` at `api/bookmarks.ts:206-225` is a deliberately different remote
  shape — so the duplication is narrower than "four places," but real.) A
  `createLocalBookmark()` domain factory centralizes "what a fresh bookmark looks like."

---

## L — Liskov Substitution · good

Both implementations honor the `BookmarkRepository` contract and swap at build time with no
caller branching. Verdict stands, with sharpened reasoning:

- The interface documents `replaceBookmark` as an **atomic** identity swap
  (`storage/types.ts:36`). Native wraps delete+insert in `withTransactionAsync`
  (`storage/repository.native.ts`); the web impl does two array operations
  (`storage/repository.ts`). The web impl cannot honor the documented atomicity guarantee —
  it is saved by web having no concurrency, not by the code. So "honors the same contract"
  is too strong; "good, saved by environment" is the honest framing.

---

## I — Interface Segregation · mixed, no action

The `BookmarkRepository` interface is genuinely multi-concern (bookmarks + sync queue +
meta KV + enrichments cache + tag data, 18 methods). But:

- There is exactly **one consumer pattern and one impl per platform.** Splitting into
  `BookmarkStore + SyncQueue + MetaStore + CacheStore` is speculative generality and would
  fragment the shared SQLite connection-management invariant in the native class.
- The codebase already demonstrates the correct lazy alternative: a **call-site role
  interface** (`PullApi`, `sync/pull-bookmarks.ts:22`) narrowing the fat impl where a
  partial consumer exists.

**Action:** none, until a partial consumer actually appears — then declare a narrow reader
interface at that call site. API input types (`CreateBookmarkInput`, `UpdateBookmarkInput`,
etc., `api/bookmarks.ts:44-85`) are already well segregated.

---

## D — Dependency Inversion · strongest

- `sync` functions depend on the `BookmarkRepository` *interface* and the `BookmarkApi`
  *type*, both passed as parameters — not imported singletons.
- `BookmarkApi` injects its transport via constructor with a default
  (`api/bookmarks.ts:174-177`).
- Best single example: `pullRemoteChanges`'s narrow `PullApi` role interface
  (`sync/pull-bookmarks.ts:22`).

**Caveat:** the React context itself imports the **concrete** `repository` singleton
(`store/bookmarks.tsx:43`), so the top-level policy module is bound to a concrete instance;
inversion holds for the sync functions, not the context. Strongest principle, but not
"textbook DIP throughout" — testing the context requires module mocking rather than injection.

---

## Agreed refactor set (proposal)

Two low-risk, high-value changes — explicitly **not** the original "SyncOrchestrator + split
the repository into 4 interfaces":

1. **`createLocalBookmark()` domain factory** — dedupe the two full `Bookmark` literals in
   `addBookmark` and `importBookmarks`. Centralizes the fresh-bookmark shape so adding a
   nullable column can't silently leave a site unset.
2. **Extract two inline `syncNow` blocks** — move leftover-reconciliation (`:1039-1066`) and
   the account-transition apply loop (`:1215-1257`) into pure `sync/` helpers. Shaves ~100
   lines from `syncNow` without disturbing the interleaved upload loop or the shared
   tombstone/in-flight/ref coordination state.

Deliberately **not** doing: a `SyncOrchestrator` returning a delta stream (would externalize
tightly-coupled mutable coordination state across a module boundary), or splitting
`BookmarkRepository` into four interfaces (YAGNI; use a call-site role interface if a partial
consumer appears).
