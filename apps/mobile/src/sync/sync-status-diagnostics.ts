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
  /** When the last event was recorded (not when this snapshot was read) —
   *  so a report filed long after the last sync activity doesn't make stale
   *  data look freshly updated. */
  updatedAt: string;
}

interface FailureEpisode {
  failedAt: number;
  errorKind: string;
}

// Keyed by local_id, bounded by however many entries are currently mid-retry
// in the live sync queue — never grows unboundedly the way a per-event log
// would.
const inFlightFailures = new Map<string, FailureEpisode>();

const state: Omit<SyncStatusDiagnostics, 'updatedAt'> & { updatedAt: string | null } = {
  syncedAfterFailureByKind: {},
  syncedWithoutFailure: 0,
  maxFailureToSyncedMs: 0,
  updatedAt: null,
};

/**
 * Record one sync queue entry's resulting status for this pass — called
 * unconditionally from `applySyncEntryResult` for every entry a sync pass
 * processes, whatever the result's `removeEntry`/branching outcome (this
 * function only reads `result.entry.sync_status`, which sync-bookmarks.ts
 * sets to 'failed'/'synced' before any of that branching runs).
 *
 * Statuses other than 'failed'/'synced' (e.g. the transient 'syncing' set
 * just before the attempt) are no-ops — only a resolved outcome is evidence.
 */
export function noteSyncEntryStatus(
  localId: string,
  status: string,
  errorKind?: string | null,
): void {
  if (status === 'failed') {
    // Keep the FIRST failure's timestamp/kind — a retry that keeps failing
    // must not reset the clock on how long this bookmark has looked failed
    // to the user, and the kind that first surfaced the failure is more
    // informative than whichever kind the latest retry happens to report.
    if (!inFlightFailures.has(localId)) {
      inFlightFailures.set(localId, { failedAt: Date.now(), errorKind: errorKind ?? 'unknown' });
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

export function getSyncStatusDiagnostics(): SyncStatusDiagnostics | undefined {
  if (state.updatedAt === null) {
    return undefined;
  }
  return {
    syncedAfterFailureByKind: { ...state.syncedAfterFailureByKind },
    syncedWithoutFailure: state.syncedWithoutFailure,
    maxFailureToSyncedMs: state.maxFailureToSyncedMs,
    updatedAt: state.updatedAt,
  };
}

/** Test-only: reset accumulated state between test cases. */
export function resetSyncStatusDiagnostics(): void {
  inFlightFailures.clear();
  state.syncedAfterFailureByKind = {};
  state.syncedWithoutFailure = 0;
  state.maxFailureToSyncedMs = 0;
  state.updatedAt = null;
}
