import {
  buildShareAttemptDiagnostics,
  parseShareAttemptDiagnostics,
  serializeShareAttemptDiagnostics,
  SHARE_DIAGNOSTICS_PREF_KEY,
  type ShareAttemptDiagnostics,
  type ShareAttemptInput,
} from '@/domain/share-diagnostics';
import { getPreference, setPreference } from '@/storage/preferences';

/**
 * Durable read/write for the "last share attempt" diagnostics record (see
 * `domain/share-diagnostics.ts`). Backed by the same meta store as other
 * preferences so a report filed in a later app session — after the failed
 * share's own session has already ended — can still show what that share
 * contained.
 *
 * Every operation is best-effort: diagnostics must never throw into — or
 * delay — the share path. Capture is sacred.
 */

let cached: ShareAttemptDiagnostics | undefined;

/** Record a just-finished share attempt. Fire-and-forget on purpose — the
 *  share path must not wait on this write. */
export function recordShareAttempt(input: ShareAttemptInput): void {
  const record = buildShareAttemptDiagnostics(input);
  cached = record;
  void setPreference(SHARE_DIAGNOSTICS_PREF_KEY, serializeShareAttemptDiagnostics(record)).catch(() => {
    // Best-effort — never let diagnostics bookkeeping interfere with capture.
  });
}

/**
 * Load the durable record into the in-memory cache. Call once at startup so a
 * report filed in a fresh session can still see the last attempt, even though
 * `getShareDiagnostics` itself stays synchronous for the report screen.
 */
export async function hydrateShareDiagnostics(): Promise<void> {
  try {
    const stored = parseShareAttemptDiagnostics(await getPreference(SHARE_DIAGNOSTICS_PREF_KEY));
    if (stored) {
      cached = stored;
    }
  } catch {
    // Best-effort — a report screen without this context is still useful.
  }
}

/** The last recorded share attempt, if any. */
export function getShareDiagnostics(): ShareAttemptDiagnostics | undefined {
  return cached;
}
