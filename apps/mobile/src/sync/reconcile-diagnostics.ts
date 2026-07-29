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
  /** Bulk create chunks processed this session. */
  chunksProcessed: number;
  /** Total create-sync completions seen (bulk chunks + single-create fallback). */
  entriesCompleted: number;
  /** Of those, how many triggered a `createNeedsReconcileUpdate` follow-up. */
  entriesReconciled: number;
  /** Cumulative count of which field(s) tripped the check — a completion can
   *  count toward more than one reason, so these don't sum to `entriesReconciled`. */
  reasonTally: Record<string, number>;
  updatedAt: string;
}

const state: Omit<ReconcileDiagnostics, 'updatedAt'> = {
  chunksProcessed: 0,
  entriesCompleted: 0,
  entriesReconciled: 0,
  reasonTally: {},
};

export function recordReconcileChunk(
  completed: number,
  reconciled: number,
  reasonCounts: Record<string, number>,
): void {
  state.chunksProcessed += 1;
  state.entriesCompleted += completed;
  state.entriesReconciled += reconciled;
  for (const [reason, count] of Object.entries(reasonCounts)) {
    state.reasonTally[reason] = (state.reasonTally[reason] ?? 0) + count;
  }
}

export function getReconcileDiagnostics(): ReconcileDiagnostics | undefined {
  if (state.chunksProcessed === 0) {
    return undefined;
  }
  return {
    ...state,
    reasonTally: { ...state.reasonTally },
    updatedAt: new Date().toISOString(),
  };
}

/** Test-only: reset accumulated state between test cases. */
export function resetReconcileDiagnostics(): void {
  state.chunksProcessed = 0;
  state.entriesCompleted = 0;
  state.entriesReconciled = 0;
  state.reasonTally = {};
}
