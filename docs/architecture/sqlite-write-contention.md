# SQLite write contention: the recurring "fan-out onto one actor" bug

`src/storage/sqlite-connection.ts` serializes every native call through a
single connection actor (`serialize()`), one at a time. Any bulk write path
that fans multiple calls out onto it — via `Promise.all`, or a `for` loop that
looks sequential but doesn't actually `await` each call before firing the
next — turns a large backlog into dozens of simultaneous native calls piling
up behind that one queue. The tell in logs/diagnostics is `"sqlite tail wait
(depth N)"` climbing into the tens, with multi-second stalls.

This has recurred four times. Each time, the fix is the same: make the loop
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

**Before adding any new bulk write path**, grep for `Promise.all` **and**
un-awaited calls inside `for` loops that touch `repository.*`.
