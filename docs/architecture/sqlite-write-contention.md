# SQLite write contention: the recurring "fan-out onto one actor" bug

`src/storage/sqlite-connection.ts` serializes every native call through a
single connection actor (`serialize()`), one at a time. Any bulk write path
that fans multiple calls out onto it — via `Promise.all`, or a `for` loop that
looks sequential but doesn't actually `await` each call before firing the
next — turns a large backlog into dozens of simultaneous native calls piling
up behind that one queue. The tell in logs/diagnostics is `"sqlite tail wait
(depth N)"` climbing into the tens, with multi-second stalls.

This has recurred five times. Each time, the fix is the same: make the loop
genuinely sequential (`await` each call before starting the next).

1. **STASH-3B** — bulk import's local write loop.
2. **STASH-3N (first)** — the startup orphaned-queue-entry reconciliation
   (`reconcileOrphanedQueueEntries`'s re-enqueue), a large backlog of orphaned
   entries uploaded via `Promise.all` meant dozens of simultaneous native
   calls on every launch. Fixed by wrapping the re-enqueue in a sequential
   `for` loop (see the comment at its call site in `store/bookmarks.tsx`).
3. **STASH-3N (second)** — found by grepping for the same pattern right after
   fixing the above: `syncNow`'s "synced leftover" id-swap reconciliation
   looked sequential (a `for` loop) but never awaited each call before firing
   the next.
4. **STASH-3Y** — found via STASH-3Y's own new diagnostics
   (`src/sync/reconcile-diagnostics.ts`, `storage.sqliteContention`).
   `store/bookmarks.tsx`'s bulk-create reconcile follow-up
   (`applyBulkCreateChunkResults`'s `followUpUpdates`/`deletedMidFlightIds`
   persist, itself added earlier in the same investigation) fired
   `repository.updateBookmark`/`deleteBookmark` per reconciled entry via an
   un-awaited `for` loop — up to a chunk's worth
   (`BULK_CREATE_SYNC_CHUNK_SIZE` = 50) of simultaneous calls per chunk. A
   real report showed severe contention (`maxDepth: 20`, `waitCount: 101`)
   and zero completed reconcile diagnostics all session, consistent with this
   being the dominant contributor. Fixed by:
   - Making both loops sequential within a chunk.
   - Awaiting that sequential chain from inside `applyBulkCreateChunkResults`
     itself (not fire-and-forget), so the outer per-chunk loop can't start the
     next chunk's own persist chain concurrently with this one — otherwise a
     multi-chunk bulk import could still stack one overlapping write per
     in-flight chunk.
   - Re-reading each bookmark from `bookmarksRef.current` immediately before
     its write, not the snapshot captured when the chunk started — sequential
     writes take real wall-clock time, and a user edit landing on a later
     entry while an earlier entry's write is still in flight must not be
     clobbered by that now-stale full-row snapshot.
   - Persisting each row durably before queueing its own follow-up mutation
     (not after) — enqueueing all of a chunk's mutations before any of the
     durable writes land means a crash between the two leaves a queue entry
     whose local row was never actually updated/deleted, which self-heals
     wrong on restart (a stale row for updates; a resurrected row for
     deletes, since deletes only remove the row once the corresponding queue
     entry actually syncs).
5. **STASH-57** — `sync/account-transition.ts`'s real-account-switch/logout
   drop path (`applyAccountTransition`) fanned `repository.deleteBookmark`
   out over the previous account's full local cache via `Promise.all`, plus a
   second `Promise.all` removing their queue entries. On a large library
   (this report: 703 local bookmarks) that's ~700+ simultaneous native calls.
   Written in the very commit that authored this doc's original "4 times" —
   it just wasn't caught by that pass. A report showed `maxDepth: 744,
   maxWaitMs: 31845, waitCount: 843` — the worst instance recorded so far.
   Fixed the same way: both loops made sequential.

5. **bli9833 import backlog** — found via a device diagnostics report showing
   `maxDepth: 22`, `maxWaitMs: 1582`, `waitCount: 51` during a ~300-bookmark
   JSON import, plus a Supabase spot-check showing the imported bookmarks'
   tags/collections landing on the server at only a few per check-in. A
   variant of this bug class: `syncTagOps` and `syncPendingImportCollections`
   in `store/bookmarks.tsx` were **already** genuinely sequential
   (`for...await`, one network call at a time) — the fan-out wasn't
   concurrency, it was each iteration re-serializing and persisting the
   *entire* remaining queue/catalog (`repository.setMeta(PENDING_TAG_OPS_KEY,
   JSON.stringify(next))`, `repository.replaceTagData(next)`) instead of just
   its own delta. A ~300-entry backlog meant ~300 full-array SQLite writes
   competing with the main sync queue's own writes for the one connection —
   same "tail wait depth" symptom, but from redundant write *size and count*
   rather than un-awaited concurrency. Fixed by giving `applyTagOps`/
   `applyTagData` a `{ persist: false }` option so the loop updates the
   in-memory ref/state per-op (cheap) but persists to SQLite exactly once
   after the whole batch settles; `syncPendingImportCollections` was changed
   the same way, inlined (it didn't go through a shared `apply*` helper).
   **Being already sequential does not make a bulk loop safe** — check
   for O(n) full-state persistence per iteration too.

**Before adding any new bulk write path**, grep for `Promise.all` **and**
un-awaited calls inside `for` loops that touch `repository.*`. Also check
whether each iteration persists only its own delta, or redundantly
re-serializes/writes the whole collection it belongs to.

**Diagnosing a new report**: `storage.sqliteContention.labels` (added for
Sentry STASH-5R) names the repository/session-storage method(s) queued on the
connection actor at the moment the running max last advanced, e.g.
`"replaceBookmark:20, getBookmark:1, pull:2"` — every `connection.run(...)`
call site passes its own method name as a label (`sqlite-connection.ts`'s
`run`/`serialize`). A bare depth/wait number only proves contention happened;
the label breakdown says whether it's one runaway un-awaited loop (one label
dominating the count, matching this doc's pattern) or several independently-
sequential pipelines simply overlapping on a large library (several labels
each with a small count). Also: `report.tsx`'s `recentLogLines` used to keep
only the *first* `MAX_TAIL_WAIT_ENTRIES` "sqlite tail wait" log lines it saw,
so an early mild burst (e.g. a startup reopen) could use up the cap before a
much more severe wait later in the same session ever got a slot — it now
keeps the most severe ones regardless of order.
