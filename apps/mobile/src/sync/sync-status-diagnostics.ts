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
}

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
      // A failure-only session (nothing has synced yet, e.g. reported
      // during an outage) must still produce a snapshot — see
      // `activeFailures`'s own doc comment.
      state.updatedAt = new Date().toISOString();
    }
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

export function getSyncStatusDiagnostics(): SyncStatusDiagnostics | undefined {
  if (state.updatedAt === null) {
    return undefined;
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
