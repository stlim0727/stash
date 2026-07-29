/**
 * A tiny, dependency-free, session-lifetime accumulator for the STASH-3Y
 * ("queue count bounces/grows during a big bulk sync") investigation.
 *
 * `observability/log-buffer.ts`'s rotating 300-entry ring buffer is the right
 * place for a qualitative trace, but under heavy sync activity it can rotate
 * fast enough (the storage layer's own "sqlite tail wait" logging included)
 * that a single feedback report's last-80-lines snapshot never actually
 * contains a completed chunk's summary line. This module instead keeps one
 * small, cumulative-since-launch object — no per-event growth, so it can
 * never itself be a source of memory/log bloat — that always reflects the
 * whole session regardless of how much unrelated log noise happened in
 * between. Surfaced in the feedback diagnostics context alongside the logs,
 * not instead of them.
 *
 * Remove once STASH-3Y's actual cause is confirmed and fixed.
 */

export interface ReconcileDiagnostics {
  /** Bulk create chunks processed this session (the single-create fallback
   *  path does not count here — see `recordSingleCreateCompletion`). */
  chunksProcessed: number;
  /** Total create-sync completions seen (bulk chunks + single-create fallback). */
  entriesCompleted: number;
  /** Of those, how many triggered a `createNeedsReconcileUpdate` follow-up. */
  entriesReconciled: number;
  /** Cumulative count of which field(s) tripped the check — a completion can
   *  count toward more than one reason, so these don't sum to `entriesReconciled`. */
  reasonTally: Record<string, number>;
  /** When the last event was recorded (not when this snapshot was read) —
   *  so a report filed long after the last sync activity doesn't make stale
   *  data look freshly updated. */
  updatedAt: string;
}

const state: Omit<ReconcileDiagnostics, 'updatedAt'> & { updatedAt: string | null } = {
  chunksProcessed: 0,
  entriesCompleted: 0,
  entriesReconciled: 0,
  reasonTally: {},
  updatedAt: null,
};

function recordEntries(completed: number, reconciled: number, reasonCounts: Record<string, number>): void {
  state.entriesCompleted += completed;
  state.entriesReconciled += reconciled;
  for (const [reason, count] of Object.entries(reasonCounts)) {
    state.reasonTally[reason] = (state.reasonTally[reason] ?? 0) + count;
  }
  state.updatedAt = new Date().toISOString();
}

/** A completed bulk-create chunk (`applyBulkCreateChunkResults`). */
export function recordReconcileChunk(
  completed: number,
  reconciled: number,
  reasonCounts: Record<string, number>,
): void {
  state.chunksProcessed += 1;
  recordEntries(completed, reconciled, reasonCounts);
}

/** A single create completed via the non-bulk fallback path — counts toward
 *  `entriesCompleted`/`entriesReconciled` like a bulk chunk's entries would,
 *  but never increments `chunksProcessed` (it isn't one). */
export function recordSingleCreateCompletion(
  needsReconcile: boolean,
  reasonCounts: Record<string, number>,
): void {
  recordEntries(1, needsReconcile ? 1 : 0, reasonCounts);
}

export function getReconcileDiagnostics(): ReconcileDiagnostics | undefined {
  if (state.updatedAt === null) {
    return undefined;
  }
  return {
    chunksProcessed: state.chunksProcessed,
    entriesCompleted: state.entriesCompleted,
    entriesReconciled: state.entriesReconciled,
    reasonTally: { ...state.reasonTally },
    updatedAt: state.updatedAt,
  };
}

/** Test-only: reset accumulated state between test cases. */
export function resetReconcileDiagnostics(): void {
  state.chunksProcessed = 0;
  state.entriesCompleted = 0;
  state.entriesReconciled = 0;
  state.reasonTally = {};
  state.updatedAt = null;
}
