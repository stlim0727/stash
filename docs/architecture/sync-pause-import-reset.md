# Sync, pause, import, and reset — how they interact

Three separate features touch the same "is something happening right now"
question, and they used to disagree with each other. This documents the
model after the STASH-3K/3M/3J fixes (PRs #605, #606, #607, #608) so the
next change doesn't re-open one of the same races.

## The three "busy" signals

| Signal | What it means | Who sets it | Who checks it |
| --- | --- | --- | --- |
| `syncInFlight` (ref) | A real network operation — upload, pull, or the reset RPC — is running. | `syncNow`, `resetLibrary` | `syncNow`, `resetLibrary` |
| `localCreateFlushesInFlight` (ref) | `importBookmarks`'s sequential local durable-write loop (`insertBookmark` + `enqueue`, one row at a time) is running. **No network involved.** | `importBookmarks` | `syncNow`, `resetLibrary` |
| `syncPausedRef` (ref, mirrors `syncPaused` state) | The user explicitly paused sync (Settings → Pause sync). | `setSyncPaused` | `syncNow` only |

`isSyncing` (React state) and `isResettingLibrary` are the *rendered* view of
`syncInFlight`; they exist for the UI, not as independent guards.

Two of these are deliberately **not** the same flag: import writes are local
and fast-ish; sync/reset are network calls. Conflating them would either
block import behind a slow network round-trip it doesn't need, or (the two
bugs below) let them race each other.

## Scenario matrix

| Scenario | Behavior | Why |
| --- | --- | --- |
| **Import right after cold start / sign-in** | Refused (`ImportSummary.notReady: true`) while `bookmarksRef.current === null` (initial load not done) or `isSyncing` (first cloud pull still running). Settings shows "still loading, try again". | Dedup reads `bookmarksRef.current`. Before the load/first pull lands, that snapshot is empty or incomplete, so every already-existing bookmark looks new and gets durably re-created — this was the STASH-3K/3M "561 → 1122" doubling. See "History" below. |
| **Import while paused** | Runs normally — writes locally, does **not** upload. This is the intended use of pause: let a big import land locally, review it, delete what you don't want, then unpause. | Pause only gates `syncNow`'s network phases; the import loop itself never checks `syncPausedRef` (it has nothing to send). |
| **Import finishes while paused** | Its own completion handler still schedules a `syncNow()` call (via the existing 50ms retry-on-finish path), but that call immediately hits the pause guard and no-ops (aside from the lightweight account-mismatch check below). | `syncNow`'s pause branch is unconditional — it doesn't know or care why it was invoked. |
| **Account switch while paused** | Still reconciled immediately: a cheap check (`repository.getMeta(SYNCED_USER_ID_KEY)` vs. the current session) runs on every paused `syncNow` call, and only if it detects an actual mismatch does it run the (rare, self-terminating) drop/re-home logic. | A real A→B account switch must never leave A's cached bookmarks on screen under B's session just because sync happens to be paused — that would turn the pause toggle into a cross-account data leak. This check deliberately uses `syncInFlight` as its only lock (never `isSyncing`/`setIsSyncing`): flipping `isSyncing` on every no-op paused pass would retrigger the auto-sync effect (which re-fires whenever `isSyncing` changes) forever, since a paused queue can never drain to satisfy its "still pending" condition. |
| **Reset while paused** | Runs normally — reset doesn't check `syncPausedRef` at all. | Reset is the deliberate "wipe everything" escape hatch; there's no reason to let a paused review block it. |
| **Reset while a sync is uploading/pulling** | Refused (`{ok: false, reason: 'busy'}}`). | Can't let an in-flight upload land data concurrently with (or after) the wipe. |
| **Reset while an import is still flushing locally** | Also refused (`{ok: false, reason: 'busy'}`), same message. | Without this, `clearAllData()` + `setBookmarks([])`/`setQueue([])` would complete, and the import's still-running loop would keep calling `insertBookmark`/`enqueue` for its remaining items — silently repopulating the just-cleared library. This was the "reset doesn't clear the queue in one shot" bug. See "History". |
| **Pausing mid-sync (sync already started before pause was toggled)** | The in-flight run keeps going for its *current* chunk/entry, but the bulk-create chunk loop, the per-entry loop, and the pull each re-check `syncPausedRef` between steps and stop as soon as they see it — it doesn't wait for the whole run to finish. | An already-sent network request can't be un-sent; re-checking between steps is the closest thing to "stop now" that's actually safe. |
| **Unpausing** | `setSyncPaused(false)` clears any stale `syncPendingRef` flag first, then calls `syncNow()` directly. | Without clearing the flag, the direct call's own `finally` block would still see it set and schedule a *second*, redundant sync 50ms later. |

## Implementation pointers

- **`src/store/bookmarks.tsx`**
  - `importBookmarks` — the `notReady` guard sits at the top, before the
    dedup `seen` set is built. `localCreateFlushesInFlight` is incremented
    right after the optimistic state update and decremented in the flush's
    `.finally()`.
  - `syncNow` — guard order is `syncInFlight` → `localCreateFlushesInFlight`
    → `!auth.session` → `syncPausedRef` (the paused branch does its own
    lightweight account-mismatch check, see `reconcileAccountTransition`)
    → the real upload/pull work. The bulk-create loop and the per-entry loop
    each `break` on `syncPausedRef.current`; the pull is wrapped in
    `if (!syncPausedRef.current)`.
  - `reconcileAccountTransition` — extracted so it can be called both from
    `syncNow`'s normal pre-pull position and from the paused branch. See
    `docs/architecture/sync-account-switching.md` for what the plan itself
    does (rehome/drop).
  - `resetLibrary` — guard order is `syncInFlight` → `localCreateFlushesInFlight`
    → `!auth.session`, then the remote RPC, then the local clear.
  - `setSyncPaused` — persists the pref (`pref.sync.paused` meta key),
    updates the ref synchronously (so the very next check sees it), and on
    unpause clears `syncPendingRef` before calling `syncNow()` directly.
- **`src/app/settings.tsx`** — the only caller of `importBookmarks`; handles
  `summary.notReady` with a dedicated alert before falling through to the
  normal imported/duplicates/skipped messaging.

## History

- **STASH-3K** / **STASH-3M** (exact repeat): a user's library doubled
  (`561 → 1122`) after a bulk HTML import. Reproduced directly with a test
  that gates the fake repository's initial load / the pull's remote-fetch to
  force each race deterministically — both confirmed to fail against the
  unguarded code (one producing an actual duplicate row in durable storage)
  before the `notReady` guard was added. Fixed in #607.
- **STASH-3J**: `resetLibrary`'s remote RPC failed with "function not found
  in schema cache" — a migration/deploy-ordering issue (the RPC existed in
  the repo but hadn't been applied to the live database yet), not a code
  bug. Confirmed resolved by querying the live database directly once the
  migration was applied; no code change was needed.
- **Reset-vs-import race** (reported right after #607 shipped the pause
  feature): resetting while an import was still flushing locally let the
  import's straggler writes repopulate the just-wiped library. Reproduced
  with a test (gate `insertBookmark`, start an import, call `resetLibrary`
  mid-flush) before adding the `localCreateFlushesInFlight` check. Fixed in
  #608.
- **A hot-loop near-miss while fixing the account-isolation case**: the
  first attempt at running `reconcileAccountTransition` from the paused
  branch flipped `isSyncing` unconditionally on every paused pass, which
  hot-looped the auto-sync effect (caught by a test that hung instead of
  failing). The fix — using `syncInFlight` alone, never `isSyncing`, for
  that check — is called out explicitly in the scenario table above so it
  doesn't get "simplified" back into the hang.
- **STASH-3H/3E/3F/3Q/3R/3S/3T/3V/3X (one root cause, many-looking symptoms)**:
  a whole day's flood of "561 bookmark import stuck / duplicated" reports
  traced back to one bug in `applyBulkCreateChunkResults`: it gated clearing
  the queue / marking bookmarks synced on `result.removeEntry`, but
  `syncCreateQueueEntryBatch` (`sync/sync-bookmarks.ts`) never sets that
  field — every result it returns is already a completed create (a batch
  failure throws for the whole call instead of returning a per-entry retry
  state, unlike `syncQueueEntry`'s update/delete paths, which genuinely need
  `removeEntry`). A successful bulk upload of 2+ pending creates was a
  silent no-op: the queue stayed `pending` forever, so the auto-sync effect
  immediately re-ran the same upload again — forever, roughly once a
  second, visible in Sentry as endless `pull: ... remoteRows=N` /
  `sync: uploading N pending create(s)` pairs. Predates this whole
  incident's day — present since bulk sync shipped in #602 — and went
  unnoticed because zero store-level tests ever mocked bulk `createBookmarks`
  (every existing sync test only exercised the single-entry `syncQueueEntry`
  path). Fixed in #621, which also: reorders `applyBulkCreateChunkResults`
  to persist durably before touching in-memory state (a durable-write
  failure must never clear the in-memory queue ahead of confirmation); gives
  a failed bulk chunk proper retry accounting (`sync_status: 'failed'`,
  incremented `retry_count`/`last_error`, health-escalation check) instead of
  silently resetting to its prior status; and keeps every not-yet-tried
  bulk-eligible entry out of the per-entry fallback loop when a chunk fails,
  so an endpoint outage during a 561-item import can't cascade into hundreds
  of sequential single-create requests in the same run.
