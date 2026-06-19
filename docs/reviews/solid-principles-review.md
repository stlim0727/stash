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
4. A second automated reviewer (Codex) reviewed the committed doc and raised two
   corrections, both verified against the code and incorporated: the `syncNow` blocks are
   side-effectful (not "pure"), and partial repository consumers already exist (so the ISP
   no-action conclusion was re-grounded rather than resting on "no partial consumer").

The result below is the **aligned** position, not the original take.

## Verdicts at a glance

| Principle | Verdict | One-line summary |
|-----------|---------|------------------|
| **S**RP | Relatively weakest | Not a "god object" — one overgrown method (`syncNow`) + duplicated bookmark construction. |
| **O**CP | Reasonable | Platform-extension pattern is real OCP; the genuine gap is duplicated `Bookmark` literals, not switch statements. |
| **L**SP | Good | Both repository impls substitute cleanly; saved partly by environment, not just by code. |
| **I**SP | Mixed (low priority) | Fat repository interface; partial consumers exist (`preferences.ts` is meta-only) but harm is low — at most type meta-only call sites against a narrow `MetaStore`. |
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
small, but it is **not** a "pure" extraction. Both candidate blocks are side-effectful:

- leftover-reconciliation (`:1039-1066`) calls `setBookmarks`, `setQueue`,
  `repository.replaceBookmark`, and `repository.removeQueueEntry`.
- the account-transition **apply** loop (`:1215-1257`) allocates IDs (`makeLocalId`),
  records logs, mutates React state (`setBookmarks`/`setQueue`), and writes
  `replaceBookmark`/`enqueue`/`deleteBookmark`. Only its *planner* (`planAccountTransition`)
  is pure and already extracted.

So the extraction must take one of two honest shapes — never a bare "pure helper":

1. **Extract only the pure planning data.** Like `planAccountTransition`, compute a plan
   (which leftovers need an identity swap; which entries/rows to drop) as a pure function
   returning data, and leave the side-effectful apply (state + repository writes) inline in
   the context. This is the lower-risk, higher-value half.
2. **Or extract a side-effectful helper with injected callbacks.** Move the whole block to
   `sync/` but pass the repository and the `setBookmarks`/`setQueue` setters (or a small
   effects object) in, so the side effects are explicit at the boundary, not hidden under a
   "pure" label.

Either way it shaves ~100 lines from `syncNow` without touching the interleaved upload loop.

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
meta KV + enrichments cache + tag data, 18 methods). **Partial consumers already exist** —
the earlier draft's "exactly one consumer pattern" claim was wrong:

- `storage/preferences.ts` uses only `getMeta`/`setMeta` (the meta KV subset), and its own
  comment says it is "kept separate… so UI preferences don't widen that API."
- `syncQueueEntry` and `pullRemoteChanges` each receive a `BookmarkRepository` but exercise
  different method subsets.

So the no-action conclusion can't rest on "no partial consumer exists." It rests instead on
**where the dependency is and what splitting would cost**:

- `preferences.ts` calls the concrete `repository` singleton (it imports the module, not the
  interface type), so it takes on no over-wide *type* dependency today; a narrow
  `MetaStore`-typed accessor would tidy it but changes no behavior.
- `syncQueueEntry`/`pullRemoteChanges` consume structural subsets of the full interface,
  which TypeScript's structural typing already tolerates without harm.
- Both impls are single classes that share one SQLite handle / `open()`-coalescing
  invariant; physically splitting them buys nothing and risks fragmenting that invariant.
- The codebase already demonstrates the preferred lazy alternative — a **call-site role
  interface** (`PullApi`, `sync/pull-bookmarks.ts:22`) narrowing the fat impl per consumer.

**Action:** low priority. The one concrete, behavior-neutral tidy worth considering is
typing `preferences.ts` (and similar meta-only call sites) against a narrow `MetaStore`
interface rather than the whole repository. Full four-way segregation of the producer
remains speculative generality. API input types (`CreateBookmarkInput`, `UpdateBookmarkInput`,
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
2. **Slim `syncNow`'s two inline blocks** — leftover-reconciliation (`:1039-1066`) and the
   account-transition apply loop (`:1215-1257`). These are **side-effectful** (state +
   repository writes), so extract them as *either* a pure planner returning data (apply stays
   inline, like `planAccountTransition`) *or* a `sync/` helper with injected repository/setter
   callbacks — never a "pure" helper. Shaves ~100 lines from `syncNow` without disturbing the
   interleaved upload loop or the shared tombstone/in-flight/ref coordination state.

Deliberately **not** doing: a `SyncOrchestrator` returning a delta stream (would externalize
tightly-coupled mutable coordination state across a module boundary), or four-way segregation
of `BookmarkRepository` (partial consumers exist but the harm is low; at most type meta-only
call sites against a narrow `MetaStore`).
