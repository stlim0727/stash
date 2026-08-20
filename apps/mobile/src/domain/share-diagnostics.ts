/**
 * Durable share-attempt diagnostics (see `share/share-diagnostics.ts`).
 *
 * `logs` (the in-memory ring buffer) and `storage` diagnostics both reset on
 * every app restart, so when a share silently fails and the user reopens the
 * app later to file a report, the diagnostics attached to that report only
 * describe the *current* session — never the share itself (Sentry STASH-27,
 * STASH-2A: both reports carried nothing but unrelated startup noise). This
 * record survives a restart by living in the durable meta store, so the next
 * report can show what the share actually contained — never the URL/text/
 * title themselves, only shape (booleans, counts, MIME types).
 *
 * A single "last attempt" record is overwritten by whatever share happens
 * next, so a report filed after a *second, successful* retry can no longer
 * show what went wrong on the first (Sentry STASH-67: a user's first share
 * silently failed, the second saved fine, and the filed report — sent right
 * after the success — carried only the working attempt). The native journal
 * hit the same "evidence overwritten before a report captures it" problem
 * and was widened from a single slot to a 20-entry ring (STASH-2T/STASH-2V);
 * `shareAttemptHistory` applies the same fix on the JS side, keeping the last
 * few attempts instead of just the latest.
 *
 * Pure data — no React, no storage, no native imports — so the Node test lane
 * can exercise it directly.
 */

export const SHARE_DIAGNOSTICS_PREF_KEY = 'pref.share.lastAttempt';

export const MAX_SHARE_ATTEMPT_HISTORY = 10;

export type ShareAttemptResult = 'created' | 'duplicate' | 'invalid';

const VALID_RESULTS = new Set<ShareAttemptResult>(['created', 'duplicate', 'invalid']);

const MAX_MIME_TYPES = 5;

export interface ShareAttemptInput {
  attemptId?: string;
  receivedAt?: string;
  hasUrl: boolean;
  hasText: boolean;
  hasImage: boolean;
  fileCount: number;
  fileMimeTypes: string[];
  result: ShareAttemptResult;
  /**
   * Milliseconds between the share landing in JS (`receivedAt`) and the store
   * finishing its cold-start load, i.e. how long the share sat waiting before
   * it could be processed. Present only when the share actually had to wait
   * (a genuinely cold app) — near-zero/absent means the store was already
   * loaded. Distinguishes a slow-cold-start race from a share that never
   * reached this code at all (Sentry STASH-2T/STASH-2V: "shared but failed
   * to save", no toast, Inbox just sat there).
   */
  loadWaitMs?: number;
}

export interface ShareAttemptDiagnostics extends ShareAttemptInput {
  updatedAt: string;
  durable?: boolean;
  persistedAt?: string;
}

/** Build a record from a just-finished share attempt, capping/normalizing fields. */
export function buildShareAttemptDiagnostics(input: ShareAttemptInput): ShareAttemptDiagnostics {
  return {
    ...(typeof input.attemptId === 'string' && input.attemptId
      ? { attemptId: input.attemptId }
      : {}),
    ...(typeof input.receivedAt === 'string' && input.receivedAt
      ? { receivedAt: input.receivedAt }
      : {}),
    hasUrl: input.hasUrl === true,
    hasText: input.hasText === true,
    hasImage: input.hasImage === true,
    fileCount: Math.max(0, Math.floor(input.fileCount) || 0),
    fileMimeTypes: input.fileMimeTypes.filter((m) => typeof m === 'string').slice(0, MAX_MIME_TYPES),
    result: VALID_RESULTS.has(input.result) ? input.result : 'invalid',
    ...(typeof input.loadWaitMs === 'number' && Number.isFinite(input.loadWaitMs) && input.loadWaitMs >= 0
      ? { loadWaitMs: Math.round(input.loadWaitMs) }
      : {}),
    updatedAt: new Date().toISOString(),
  };
}

/** Shared validation/normalization for one already-parsed history entry.
 *  Returns `null` for anything missing, malformed, or carrying an
 *  unrecognized result. */
function normalizeShareAttempt(
  data: Partial<ShareAttemptDiagnostics> | null | undefined,
): ShareAttemptDiagnostics | null {
  if (!data || typeof data.result !== 'string' || !VALID_RESULTS.has(data.result as ShareAttemptResult)) {
    return null;
  }
  if (typeof data.updatedAt !== 'string' || !data.updatedAt) {
    return null;
  }
  return {
    hasUrl: data.hasUrl === true,
    hasText: data.hasText === true,
    hasImage: data.hasImage === true,
    fileCount:
      typeof data.fileCount === 'number' && Number.isFinite(data.fileCount)
        ? Math.max(0, Math.floor(data.fileCount))
        : 0,
    fileMimeTypes: Array.isArray(data.fileMimeTypes)
      ? data.fileMimeTypes.filter((m): m is string => typeof m === 'string').slice(0, MAX_MIME_TYPES)
      : [],
    result: data.result as ShareAttemptResult,
    updatedAt: data.updatedAt,
    ...(typeof data.attemptId === 'string' && data.attemptId ? { attemptId: data.attemptId } : {}),
    ...(typeof data.receivedAt === 'string' && data.receivedAt ? { receivedAt: data.receivedAt } : {}),
    ...(typeof data.durable === 'boolean' ? { durable: data.durable } : {}),
    ...(typeof data.persistedAt === 'string' && data.persistedAt ? { persistedAt: data.persistedAt } : {}),
    ...(typeof data.loadWaitMs === 'number' && Number.isFinite(data.loadWaitMs) && data.loadWaitMs >= 0
      ? { loadWaitMs: Math.round(data.loadWaitMs) }
      : {}),
  };
}

/**
 * Parse a stored history of recent attempts (oldest first, capped at
 * `MAX_SHARE_ATTEMPT_HISTORY`). Returns `[]` for missing, malformed, or
 * pre-history data (e.g. the old single-record format this key used to
 * hold) so callers can treat "no history" and "unreadable history"
 * identically — this diagnostics feature must never throw.
 */
export function parseShareAttemptHistory(raw: string | null | undefined): ShareAttemptDiagnostics[] {
  if (!raw) {
    return [];
  }
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) {
      return [];
    }
    return data
      .map((entry) => normalizeShareAttempt(entry))
      .filter((entry): entry is ShareAttemptDiagnostics => entry !== null)
      .slice(-MAX_SHARE_ATTEMPT_HISTORY);
  } catch {
    return [];
  }
}

export function serializeShareAttemptHistory(history: ShareAttemptDiagnostics[]): string {
  return JSON.stringify(history);
}

/** Append a just-finished attempt, capping the history at `MAX_SHARE_ATTEMPT_HISTORY`. */
export function appendShareAttemptHistory(
  history: ShareAttemptDiagnostics[],
  record: ShareAttemptDiagnostics,
): ShareAttemptDiagnostics[] {
  const next = [...history, record];
  return next.length > MAX_SHARE_ATTEMPT_HISTORY
    ? next.slice(next.length - MAX_SHARE_ATTEMPT_HISTORY)
    : next;
}

/**
 * Add the durable-write outcome to the most recent history entry matching
 * `attemptId`. Returns `null` when nothing matches, so the caller can skip
 * the write instead of persisting an unchanged history.
 */
export function markShareAttemptHistoryPersisted(
  history: ShareAttemptDiagnostics[],
  attemptId: string | undefined,
  durable: boolean,
): ShareAttemptDiagnostics[] | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].attemptId === attemptId) {
      const next = history.slice();
      next[i] = { ...next[i], durable, persistedAt: new Date().toISOString() };
      return next;
    }
  }
  return null;
}
