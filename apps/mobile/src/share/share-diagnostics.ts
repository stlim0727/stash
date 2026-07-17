import { Platform } from 'react-native';
import { ShareIntentModule } from 'expo-share-intent';

import {
  buildShareAttemptDiagnostics,
  parseShareAttemptDiagnostics,
  serializeShareAttemptDiagnostics,
  SHARE_DIAGNOSTICS_PREF_KEY,
  type ShareAttemptDiagnostics,
  type ShareAttemptInput,
} from '@/domain/share-diagnostics';
import { recordLog } from '@/observability/log-buffer';
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

/**
 * Recover the native module's own durable breadcrumbs of the last intent(s)
 * it saw (Android only — see `recordDurableDebug` and `recordDurableAnyIntent`
 * in the patched `expo-share-intent` module). The equivalent live `onDebugLog`
 * event is lost whenever no JS listener happens to be subscribed at the exact
 * instant it fires — the leading theory for why prior sendEvent-only
 * instrumentation (Sentry STASH-2K, STASH-2M) kept showing zero evidence
 * despite shipping. Recovers TWO breadcrumbs: one scoped to recognized share
 * actions only, and one recorded unconditionally at every native entry point
 * (Sentry STASH-2T follow-up) — the latter can distinguish "nothing reached
 * the Activity" from "something arrived but wasn't recognized as a share."
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
    const value = await ShareIntentModule?.getLastNativeShareDebug('');
    if (value) {
      recordLog('info', `[share] native debug (durable): ${value}`);
    }
  } catch {
    // Best-effort — a session without this recovered breadcrumb is still usable.
  }
  // Separate, UNCONDITIONAL breadcrumb (Sentry STASH-2T follow-up): the one
  // above only exists if a share action reached handleShareIntent — this one
  // is recorded at every native entry point regardless, so a report can tell
  // "nothing reached the Activity" from "something arrived but wasn't
  // recognized as a share" from "a share arrived and was processed."
  try {
    const anyValue = await ShareIntentModule?.getLastNativeAnyIntentDebug('');
    if (anyValue) {
      recordLog('info', `[share] native debug, any intent (durable): ${anyValue}`);
    }
  } catch {
    // Best-effort — see above.
  }
}
