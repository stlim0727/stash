import { Platform } from 'react-native';
import { ShareIntentModule } from 'expo-share-intent';

import {
  appendShareAttemptHistory,
  buildShareAttemptDiagnostics,
  markShareAttemptHistoryPersisted,
  parseShareAttemptHistory,
  serializeShareAttemptHistory,
  SHARE_DIAGNOSTICS_PREF_KEY,
  type ShareAttemptDiagnostics,
  type ShareAttemptInput,
} from '@/domain/share-diagnostics';
import { recordLog } from '@/observability/log-buffer';
import { getPreference, setPreference } from '@/storage/preferences';

/**
 * Durable read/write for the recent share-attempt diagnostics history (see
 * `domain/share-diagnostics.ts`). Backed by the same meta store as other
 * preferences so a report filed in a later app session — after the failed
 * share's own session has already ended — can still show what that share
 * contained. Keeps a short ring of attempts rather than just the latest, so a
 * report filed right after a *successful retry* still carries evidence of the
 * earlier failed attempt instead of only the working one (Sentry STASH-67).
 *
 * Every operation is best-effort: diagnostics must never throw into — or
 * delay — the share path. Capture is sacred.
 */

let cached: ShareAttemptDiagnostics[] = [];
let writeChain = Promise.resolve();

function persist(history: ShareAttemptDiagnostics[]): void {
  writeChain = writeChain
    .then(() => setPreference(SHARE_DIAGNOSTICS_PREF_KEY, serializeShareAttemptHistory(history)))
    .catch(() => {
      // Best-effort - never let diagnostics bookkeeping interfere with capture.
    });
}

/** Record a just-finished share attempt. Fire-and-forget on purpose — the
 *  share path must not wait on this write. */
export function recordShareAttempt(input: ShareAttemptInput): void {
  const record = buildShareAttemptDiagnostics(input);
  cached = appendShareAttemptHistory(cached, record);
  persist(cached);
}

/** Correlate the repository write outcome with the native/JS share attempt. */
export function recordSharePersistence(attemptId: string | undefined, durable: boolean): void {
  const next = markShareAttemptHistoryPersisted(cached, attemptId, durable);
  if (!next) {
    return;
  }
  cached = next;
  persist(cached);
}

/**
 * Load the durable history into the in-memory cache. Call once at startup so a
 * report filed in a fresh session can still see recent attempts, even though
 * `getShareDiagnostics`/`getShareDiagnosticsHistory` themselves stay
 * synchronous for the report screen.
 */
export async function hydrateShareDiagnostics(): Promise<void> {
  try {
    cached = parseShareAttemptHistory(await getPreference(SHARE_DIAGNOSTICS_PREF_KEY));
  } catch {
    // Best-effort — a report screen without this context is still useful.
  }
}

/** The most recent share attempt, if any. */
export function getShareDiagnostics(): ShareAttemptDiagnostics | undefined {
  return cached[cached.length - 1];
}

/** The recent share-attempt history (oldest first), for correlating a
 *  reported failure against attempts that happened before the latest. */
export function getShareDiagnosticsHistory(): ShareAttemptDiagnostics[] {
  return cached;
}

/**
 * Recover the native module's durable journal for its most recent share
 * attempts (Android only; see `ShareIntentDebugJournal` in the patched
 * module). It records timestamps and lifecycle phases, never shared content.
 * The equivalent live `onDebugLog` event is
 * lost whenever no JS listener happens to be subscribed at the exact instant
 * it fires — the leading theory for why prior sendEvent-only instrumentation
 * (Sentry STASH-2K, STASH-2M) kept showing zero evidence despite shipping.
 *
 * Read-and-clear on the native side, so call this ONLY from the report
 * screen, right when diagnostics are actually collected — never at app
 * startup. Native `SharedPreferences` already persists the value across
 * restarts on its own; consuming it at every startup would clear it during
 * an ordinary app open that never leads to a report, losing it before a
 * later report screen (this session or a subsequent one) gets a chance to
 * recover it (caught in PR review on this same change).
 */
export async function hydrateNativeShareDebugLog(): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }
  try {
    const value = await ShareIntentModule?.getNativeShareDebugJournal('');
    if (value) {
      recordLog('info', `[share] native journal (durable): ${value}`);
    }
  } catch {
    // Best-effort — a session without this recovered breadcrumb is still usable.
  }
}
