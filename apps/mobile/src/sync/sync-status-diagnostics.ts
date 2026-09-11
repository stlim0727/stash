/**
 * A tiny, dependency-free, session-lifetime accumulator for the STASH-69
 * ("saved bookmarks always seem to go through a sync-failure step")
 * investigation.
 *
 * The existing feedback diagnostics (`queueDepth`, `isSyncing`, `lastError`)
 * only show a snapshot at the moment a report is filed — they can't say
 * whether a "failed" status is the rare exception or something every save
 * passes through on the way to `synced`. This module instead tracks, across
 * the whole session, how many bookmarks reached `synced` only after first
 * showing `failed` (and for how long), versus how many synced cleanly on the
 * first attempt — the direct evidence needed to confirm or rule out the
 * "always fails first" claim on the next report.
 *
 * Cumulative-since-launch, like `reconcile-diagnostics.ts` and
 * `storage/diagnostics.ts`'s `sqliteContention` — no per-event growth, only a
 * small fixed-size summary plus one in-flight map bounded by the live queue.
 *
 * Scoped to `create` operations only (Codex review on #765): STASH-69's
 * report is specifically about newly *saved* bookmarks ("저장한 북마크들이"),
 * and an `update`/`delete` queue entry cycling through the same
 * failed→synced path (an ordinary edit retried after a network blip) would
 * otherwise dilute the signal this instrumentation exists to give — a
 * session full of edits could make `syncedWithoutFailure` look reassuring
 * while every actual new-bookmark save was failing first.
 *
 * "Create" isn't quite the same thing as "the user just saved a bookmark",
 * though: `account-transition.ts` also mints `operation: 'create'` entries
 * to re-home a whole previously-synced library onto a new account id — see
 * `excludeFromSyncStatusDiagnostics`.
 */

export interface SyncStatusDiagnostics {
  /** Bookmarks that reached `synced` after showing `failed` at least once
   *  along the way, tallied by the failing attempt's error kind
   *  ('unknown' when no `last_error_kind` was recorded). */
  syncedAfterFailureByKind: Record<string, number>;
  /** Bookmarks that reached `synced` without ever showing `failed`. */
  syncedWithoutFailure: number;
  /** Longest observed span between a bookmark first showing `failed` and it
   *  finally reaching `synced`, in ms. */
  maxFailureToSyncedMs: number;
  /** Bookmarks CURRENTLY showing `failed` and not yet resolved either way —
   *  read live off the in-flight map, not a cumulative tally. The case a
   *  report filed mid-outage (every create failing, none has succeeded yet)
   *  needs most: without it, `syncedAfterFailureByKind`/`syncedWithoutFailure`
   *  both stay at zero and this whole diagnostic looks unpopulated instead of
   *  showing exactly the "always fails" pattern being investigated. */
  activeFailures: number;
  /** When the last event was recorded (not when this snapshot was read) —
   *  so a report filed long after the last sync activity doesn't make stale
   *  data look freshly updated. */
  updatedAt: string;
}

interface FailureEpisode {
  failedAt: number;
  errorKind: string;
  /** When this id was first observed absent from a live set passed to
   *  `getSyncStatusDiagnostics` — undefined while it's present (or before the
   *  first such check). Drives the prune grace period; deliberately NOT
   *  `failedAt` — see that function's comment for why (Codex review on #765,
   *  round 2: an episode open longer than the grace period before a
   *  duplicate-swap remaps it must still get the full grace window from the
   *  moment it actually goes missing, not from whenever it first failed). */
  absentSince?: number;
}

// See getSyncStatusDiagnostics's live-queue pruning: comfortably longer than
// any realistic in-flight identity-transition window (a duplicate-swap's
// remaining repository/network round-trips), short enough that a genuinely
// discarded bookmark's episode still clears within a session. Exported for
// tests only.
export const PRUNE_GRACE_MS = 30_000;

// Keyed by local_id, bounded by however many CREATE entries are currently
// mid-retry in the live sync queue — never grows unboundedly the way a
// per-event log would. Re-keyed alongside the rest of a bookmark's identity
// on account rehoming — see `remapSyncStatusIdentity`.
const inFlightFailures = new Map<string, FailureEpisode>();

// local_ids to silently ignore — see `excludeFromSyncStatusDiagnostics`.
// Bounded by however many rows a rehome carries over (a one-time cost per
// account transition, not a per-save cost), not by session length.
const excludedLocalIds = new Set<string>();

const state: Omit<SyncStatusDiagnostics, 'updatedAt' | 'activeFailures'> & {
  updatedAt: string | null;
} = {
  syncedAfterFailureByKind: {},
  syncedWithoutFailure: 0,
  maxFailureToSyncedMs: 0,
  updatedAt: null,
};

/**
 * Record one sync queue entry's resulting status for this pass. Called
 * unconditionally, before any result-specific branching that could skip or
 * throw, from every place a queue entry's status is actually decided:
 * `applySyncEntryResult` (the regular per-entry retry loop), the bulk-create
 * chunk failure path, the bulk-create chunk SUCCESS path
 * (`applyBulkCreateChunkResults` — a failed chunk's later successful retry
 * goes through here, not the per-entry loop, so without this call an
 * episode opened by the failure path would never close), and the per-entry
 * loop's outer catch (a `syncQueueEntry` throw never produces a `result` at
 * all, so without this call that failure would be invisible to this
 * diagnostic even though it's a real, durably-persisted 'failed' status).
 *
 * A no-op for anything but a `create` operation, a `local_id` marked
 * excluded (see `excludeFromSyncStatusDiagnostics`), or a status other than
 * 'failed'/'synced' (e.g. the transient 'syncing' set just before an
 * attempt) — only a resolved outcome on a new-bookmark save is evidence.
 */
export function noteSyncEntryStatus(
  localId: string,
  status: string,
  operation: string,
  errorKind?: string | null,
): void {
  if (operation !== 'create' || excludedLocalIds.has(localId)) {
    return;
  }

  if (status === 'failed') {
    // Keep the FIRST failure's timestamp/kind — a retry that keeps failing
    // must not reset the clock on how long this bookmark has looked failed
    // to the user, and the kind that first surfaced the failure is more
    // informative than whichever kind the latest retry happens to report.
    if (!inFlightFailures.has(localId)) {
      inFlightFailures.set(localId, { failedAt: Date.now(), errorKind: errorKind ?? 'unknown' });
    }
    // Refreshed on every failed call, first or repeat (Codex review on
    // #765) — a report filed right after a recent retry must not look
    // hours-stale just because the episode itself (failedAt/errorKind)
    // deliberately doesn't reset. Also covers a failure-only session
    // (nothing has synced yet, e.g. reported during an outage) — see
    // `activeFailures`'s own doc comment.
    state.updatedAt = new Date().toISOString();
    return;
  }

  if (status !== 'synced') {
    return;
  }

  const episode = inFlightFailures.get(localId);
  if (episode) {
    inFlightFailures.delete(localId);
    const durationMs = Date.now() - episode.failedAt;
    state.syncedAfterFailureByKind[episode.errorKind] =
      (state.syncedAfterFailureByKind[episode.errorKind] ?? 0) + 1;
    state.maxFailureToSyncedMs = Math.max(state.maxFailureToSyncedMs, durationMs);
  } else {
    state.syncedWithoutFailure += 1;
  }
  state.updatedAt = new Date().toISOString();
}

/**
 * Move an in-flight failure episode from an old local_id to a new one —
 * called alongside `remapAiRetryIdentity` and the rest of
 * `rekeyBookmarkIdentity`'s per-local-id state (Codex review on #765).
 * Without this, a bookmark that failed and was then rehomed during an
 * account transition (duplicate adoption, anonymous→real carry-over) would
 * leak its old-id episode forever (never bounded by the live queue again,
 * since the old id no longer has a queue entry) while its eventual success
 * under the new id gets miscounted as `syncedWithoutFailure`.
 */
export function remapSyncStatusIdentity(idMap: ReadonlyMap<string, string>): void {
  for (const [oldId, newId] of idMap) {
    const episode = inFlightFailures.get(oldId);
    if (episode) {
      inFlightFailures.delete(oldId);
      inFlightFailures.set(newId, episode);
    }
    // An excluded rehome-origin create can also resolve as a server-side
    // duplicate (the single-entry path, not just the bulk one) and get
    // re-keyed onto the adopted id here — the exclusion marker must follow
    // it, or the adopted id's eventual sync is counted as real evidence
    // despite being exactly the migration noise exclusion exists to filter
    // out (Codex review on #765).
    if (excludedLocalIds.has(oldId)) {
      excludedLocalIds.delete(oldId);
      excludedLocalIds.add(newId);
    }
  }
}

/**
 * Mark local_ids as never evidence for this diagnostic, however they
 * eventually sync — for `account-transition.ts`'s carry-over/rehome path
 * (Codex review on #765), which mints fresh `operation: 'create'` entries
 * for an entire previously-synced library (a real report: 561 bookmarks in
 * one rehome) to re-upload it under a new account id. None of that is "the
 * user just saved a bookmark" — counting it would swamp any genuine
 * new-capture signal in `syncedWithoutFailure`/`syncedAfterFailureByKind`
 * with a one-time migration bulk that has nothing to do with STASH-69.
 */
export function excludeFromSyncStatusDiagnostics(localIds: Iterable<string>): void {
  for (const id of localIds) {
    excludedLocalIds.add(id);
    inFlightFailures.delete(id);
  }
}

/**
 * @param liveLocalIds The current sync queue's local_ids (report.tsx has
 *   `queue` in scope already). When given, any tracked failure episode whose
 *   local_id is no longer present is pruned before counting `activeFailures`
 *   — the queue entry is gone with no 'synced'/exclude call ever having run
 *   for it (a permanent delete, an emptied Trash, a library reset), so
 *   without this the episode would otherwise sit in `activeFailures` for the
 *   rest of the session despite there being no bookmark left to resolve it
 *   (Codex review on #765). Omit only for tests exercising the module in
 *   isolation, where `activeFailures` then reflects the raw in-flight map.
 */
export function getSyncStatusDiagnostics(
  liveLocalIds?: ReadonlySet<string>,
): SyncStatusDiagnostics | undefined {
  if (state.updatedAt === null) {
    return undefined;
  }
  if (liveLocalIds) {
    const now = Date.now();
    for (const [localId, episode] of inFlightFailures) {
      // Grace period before an absent id is treated as discarded (Codex
      // review on #765): a duplicate-swap resolution briefly has NEITHER the
      // old id (already removed from the queue) NOR the new adopted id (not
      // yet added — it's an update to an existing row, not a fresh queue
      // entry) present in the live queue while applySyncEntryResult's own
      // later awaits are still in flight and remapSyncStatusIdentity has
      // already moved the episode onto that new id. A read in that narrow
      // window would otherwise prune a real, about-to-resolve episode before
      // its 'synced' call ever lands. That window is milliseconds; a
      // genuinely discarded bookmark (permanent delete, emptied Trash,
      // library reset) never becomes live again, so this only delays its
      // cleanup, it doesn't skip it.
      //
      // Measured from when THIS id was first seen absent, not from
      // `failedAt` (Codex review on #765, round 2) — a real retry can sit in
      // backoff for well over the grace period before a duplicate-swap ever
      // remaps it, and using `failedAt` would make that remap immediately
      // eligible for pruning on the very next read instead of getting its
      // own fresh grace window.
      if (!liveLocalIds.has(localId)) {
        if (episode.absentSince === undefined) {
          episode.absentSince = now;
        } else if (now - episode.absentSince > PRUNE_GRACE_MS) {
          inFlightFailures.delete(localId);
        }
      } else if (episode.absentSince !== undefined) {
        episode.absentSince = undefined;
      }
    }
  }
  return {
    syncedAfterFailureByKind: { ...state.syncedAfterFailureByKind },
    syncedWithoutFailure: state.syncedWithoutFailure,
    maxFailureToSyncedMs: state.maxFailureToSyncedMs,
    activeFailures: inFlightFailures.size,
    updatedAt: state.updatedAt,
  };
}

/** Test-only: reset accumulated state between test cases. */
export function resetSyncStatusDiagnostics(): void {
  inFlightFailures.clear();
  excludedLocalIds.clear();
  state.syncedAfterFailureByKind = {};
  state.syncedWithoutFailure = 0;
  state.maxFailureToSyncedMs = 0;
  state.updatedAt = null;
}
