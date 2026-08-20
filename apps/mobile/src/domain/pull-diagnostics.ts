/**
 * Durable "recent pull attempts" record (see `sync/pull-diagnostics.ts`).
 *
 * A pull failure today leaves no trace once the app restarts or the page
 * reloads: `observability/log-buffer.ts`'s ring buffer resets, and nothing
 * else records *why* a given pull didn't bring a row in. That gap turned an
 * ordinary transient pull failure (image bookmark cloud sync, PR #752/#753)
 * into a multi-hour trace across pull logic, watermark timestamps, parsing,
 * storage, and rendering — all clean — because there was no durable evidence
 * of what earlier pull attempts actually did. This record survives a
 * restart/reload by living in the durable meta store, so a later report (or
 * the diagnostics screen) can show the last few attempts instead of just the
 * current session's.
 *
 * Bounded to `MAX_PULL_ATTEMPTS` entries (newest first) — no unbounded
 * growth, same constraint every other diagnostics module in this repo
 * follows.
 *
 * Pure data — no React, no storage, no native imports — so the Node test
 * lane can exercise it directly.
 */

export const PULL_DIAGNOSTICS_PREF_KEY = 'pref.sync.recentPulls';

/** Keep only the newest few attempts — enough to spot a pattern, never enough
 *  to grow unbounded. */
export const MAX_PULL_ATTEMPTS = 5;

/** Mirrors `pull-bookmarks.ts`'s `fullRefreshReason` local. */
export type PullFullRefreshReason = 'user_changed' | 'empty_real_cache_same_user' | null;

export type PullAttemptOutcome = 'success' | 'failure';

export interface PullAttemptInput {
  /** The watermark used for this pull's incremental fetch, or `null` when it
   *  was a full refresh. */
  since: string | null;
  fullRefreshReason: PullFullRefreshReason;
  /** `remoteRows.length` — absent (0) when the pull failed before the fetch
   *  resolved. */
  remoteRowCount: number;
  outcome: PullAttemptOutcome;
  /** Present only when `outcome === 'failure'`. */
  errorMessage?: string;
  durationMs: number;
}

export interface PullAttemptDiagnostics extends PullAttemptInput {
  timestamp: string;
}

/** Build a record from a just-finished pull attempt, capping/normalizing fields. */
export function buildPullAttemptDiagnostics(input: PullAttemptInput): PullAttemptDiagnostics {
  const outcome: PullAttemptOutcome = input.outcome === 'failure' ? 'failure' : 'success';
  return {
    since: typeof input.since === 'string' && input.since ? input.since : null,
    fullRefreshReason:
      input.fullRefreshReason === 'user_changed' || input.fullRefreshReason === 'empty_real_cache_same_user'
        ? input.fullRefreshReason
        : null,
    remoteRowCount: Math.max(0, Math.floor(input.remoteRowCount) || 0),
    outcome,
    ...(outcome === 'failure' && typeof input.errorMessage === 'string' && input.errorMessage
      ? { errorMessage: input.errorMessage }
      : {}),
    durationMs: Math.max(0, Math.round(input.durationMs) || 0),
    timestamp: new Date().toISOString(),
  };
}

/** Prepend a new attempt and cap the history to `MAX_PULL_ATTEMPTS`, newest first. */
export function appendPullAttemptDiagnostics(
  history: PullAttemptDiagnostics[],
  attempt: PullAttemptDiagnostics,
): PullAttemptDiagnostics[] {
  return [attempt, ...history].slice(0, MAX_PULL_ATTEMPTS);
}

/**
 * Parse a stored history. Returns `[]` for anything missing or malformed, and
 * silently drops individual entries that don't look like a valid attempt
 * record, so a single corrupt entry can't hide the rest.
 */
export function parsePullDiagnosticsHistory(raw: string | null | undefined): PullAttemptDiagnostics[] {
  if (!raw) {
    return [];
  }
  try {
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) {
      return [];
    }
    const entries: PullAttemptDiagnostics[] = [];
    for (const item of data) {
      const parsed = parseAttempt(item);
      if (parsed) {
        entries.push(parsed);
      }
    }
    return entries.slice(0, MAX_PULL_ATTEMPTS);
  } catch {
    return [];
  }
}

function parseAttempt(data: unknown): PullAttemptDiagnostics | null {
  if (!data || typeof data !== 'object') {
    return null;
  }
  const record = data as Partial<PullAttemptDiagnostics>;
  if (typeof record.timestamp !== 'string' || !record.timestamp) {
    return null;
  }
  if (record.outcome !== 'success' && record.outcome !== 'failure') {
    return null;
  }
  return {
    since: typeof record.since === 'string' && record.since ? record.since : null,
    fullRefreshReason:
      record.fullRefreshReason === 'user_changed' || record.fullRefreshReason === 'empty_real_cache_same_user'
        ? record.fullRefreshReason
        : null,
    remoteRowCount:
      typeof record.remoteRowCount === 'number' && Number.isFinite(record.remoteRowCount)
        ? Math.max(0, Math.floor(record.remoteRowCount))
        : 0,
    outcome: record.outcome,
    ...(record.outcome === 'failure' && typeof record.errorMessage === 'string' && record.errorMessage
      ? { errorMessage: record.errorMessage }
      : {}),
    durationMs:
      typeof record.durationMs === 'number' && Number.isFinite(record.durationMs)
        ? Math.max(0, Math.round(record.durationMs))
        : 0,
    timestamp: record.timestamp,
  };
}

export function serializePullDiagnosticsHistory(history: PullAttemptDiagnostics[]): string {
  return JSON.stringify(history);
}
