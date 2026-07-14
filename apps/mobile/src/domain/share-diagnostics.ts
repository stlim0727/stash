/**
 * Durable "last share attempt" record (see `share/share-diagnostics.ts`).
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
 * Pure data — no React, no storage, no native imports — so the Node test lane
 * can exercise it directly.
 */

export const SHARE_DIAGNOSTICS_PREF_KEY = 'pref.share.lastAttempt';

export type ShareAttemptResult = 'created' | 'duplicate' | 'invalid';

const VALID_RESULTS = new Set<ShareAttemptResult>(['created', 'duplicate', 'invalid']);

const MAX_MIME_TYPES = 5;

export interface ShareAttemptInput {
  hasUrl: boolean;
  hasText: boolean;
  hasImage: boolean;
  fileCount: number;
  fileMimeTypes: string[];
  result: ShareAttemptResult;
}

export interface ShareAttemptDiagnostics extends ShareAttemptInput {
  updatedAt: string;
}

/** Build a record from a just-finished share attempt, capping/normalizing fields. */
export function buildShareAttemptDiagnostics(input: ShareAttemptInput): ShareAttemptDiagnostics {
  return {
    hasUrl: input.hasUrl === true,
    hasText: input.hasText === true,
    hasImage: input.hasImage === true,
    fileCount: Math.max(0, Math.floor(input.fileCount) || 0),
    fileMimeTypes: input.fileMimeTypes.filter((m) => typeof m === 'string').slice(0, MAX_MIME_TYPES),
    result: VALID_RESULTS.has(input.result) ? input.result : 'invalid',
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Parse a stored record. Returns `null` for anything missing, malformed, or
 * carrying an unrecognized result, so callers can treat "no record" and
 * "unreadable record" identically.
 */
export function parseShareAttemptDiagnostics(
  raw: string | null | undefined,
): ShareAttemptDiagnostics | null {
  if (!raw) {
    return null;
  }
  try {
    const data = JSON.parse(raw) as Partial<ShareAttemptDiagnostics> | null;
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
    };
  } catch {
    return null;
  }
}

export function serializeShareAttemptDiagnostics(value: ShareAttemptDiagnostics): string {
  return JSON.stringify(value);
}
