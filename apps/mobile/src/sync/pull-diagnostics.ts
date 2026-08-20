import {
  appendPullAttemptDiagnostics,
  buildPullAttemptDiagnostics,
  parsePullDiagnosticsHistory,
  serializePullDiagnosticsHistory,
  PULL_DIAGNOSTICS_PREF_KEY,
  type PullAttemptDiagnostics,
  type PullAttemptInput,
} from '@/domain/pull-diagnostics';
import { getPreference, setPreference } from '@/storage/preferences';

/**
 * Durable read/write for the "recent pull attempts" diagnostics history (see
 * `domain/pull-diagnostics.ts`). Backed by the same meta store as other
 * preferences so a report filed in a later app session — after the pull that
 * failed has already scrolled out of the in-memory log buffer — can still
 * show what the last few pull attempts did.
 *
 * Every operation is best-effort: diagnostics must never throw into — or
 * delay — a pull. Pulls must never be slowed down or broken by this.
 */

let cached: PullAttemptDiagnostics[] = [];
let writeChain = Promise.resolve();

function persist(history: PullAttemptDiagnostics[]): void {
  writeChain = writeChain
    .then(() => setPreference(PULL_DIAGNOSTICS_PREF_KEY, serializePullDiagnosticsHistory(history)))
    .catch(() => {
      // Best-effort - never let diagnostics bookkeeping interfere with sync.
    });
}

/** Record a just-finished pull attempt. Fire-and-forget on purpose — the pull
 *  path must not wait on this write. */
export function recordPullAttempt(input: PullAttemptInput): void {
  const attempt = buildPullAttemptDiagnostics(input);
  cached = appendPullAttemptDiagnostics(cached, attempt);
  persist(cached);
}

/**
 * Load the durable history into the in-memory cache. Call once at startup so
 * a report filed in a fresh session can still see recent pull attempts, even
 * though `getPullDiagnostics` itself stays synchronous for the diagnostics
 * screen.
 */
export async function hydratePullDiagnostics(): Promise<void> {
  try {
    const stored = parsePullDiagnosticsHistory(await getPreference(PULL_DIAGNOSTICS_PREF_KEY));
    if (stored.length > 0) {
      cached = stored;
    }
  } catch {
    // Best-effort — a diagnostics screen without this context is still usable.
  }
}

/** The last recorded pull attempts, newest first. */
export function getPullDiagnostics(): PullAttemptDiagnostics[] {
  return cached;
}
