/**
 * Reporting-only watchdog for cold-start hydration (the store's durable load).
 *
 * The Inbox renders a loading state until the startup load settles. If that
 * load wedges — the Android background-handle SQLite stall documented in
 * AGENTS.md, or any `await` that never resolves — the screen stays stuck on a
 * half-loaded state with no crash and no event, surfacing only as fuzzy in-app
 * "screen frozen" feedback (Sentry STASH-F). This arms a one-shot timer when
 * hydration begins and, if it is not disarmed in time, records an `error`-level
 * log so the stall reaches crash monitoring via the console→Sentry bridge
 * (`log-buffer` → `sentry.ts`).
 *
 * Like the SQLite work watchdog (`storage/sqlite-connection.ts`) it is
 * observe-only: it never aborts, retries, or changes the load. The load keeps
 * running and disarms the watchdog once it finally settles (success OR terminal
 * failure). It fires at most once.
 *
 * Scope: this catches the *hydration-never-settles* failure mode (the load hangs
 * → `isLoading` never clears). A load that completes but leaves a cosmetically
 * wrong render disarms the watchdog normally — so if a "stuck screen" recurs
 * *without* this firing, that itself narrows the diagnosis to the render/derived
 * state rather than the durable load.
 *
 * Pure and dependency-injected (timer + reporter) so it runs under the Node test
 * runner with a fake clock and no React.
 */

import { recordLog } from '@/observability/log-buffer';

/** Cold-start hydration completes in well under a second on the local SQLite DB
 *  (each read is sub-ms; even a large library is far below this). The generous
 *  bound only trips on a genuine wedge, never on a merely-slow start, so it can
 *  never spam events. */
export const DEFAULT_HYDRATION_TIMEOUT_MS = 10_000;

export interface HydrationWatchdogDeps {
  /** Override the stall bound (ms). Defaults to {@link DEFAULT_HYDRATION_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Coarse, non-identifying phase read at fire time — counts/phase strings
   *  ONLY, never user content (titles, URLs, search text). */
  describe?: () => string;
  /** Injected timer for tests; defaults to the global `setTimeout`. */
  schedule?: (callback: () => void, ms: number) => unknown;
  /** Injected canceller for tests; defaults to the global `clearTimeout`. */
  cancel?: (handle: unknown) => void;
  /** Injected reporter for tests; defaults to an `error`-level `recordLog`
   *  (which the Sentry bridge forwards as an exception). */
  report?: (message: string) => void;
}

/**
 * Arm the watchdog. Returns a `disarm` function to call once hydration settles.
 * Calling `disarm` after the timer has already fired, or more than once, is a
 * safe no-op — the first of {fire, disarm} wins.
 */
export function armHydrationWatchdog(deps: HydrationWatchdogDeps = {}): () => void {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_HYDRATION_TIMEOUT_MS;
  const schedule = deps.schedule ?? ((callback, ms) => setTimeout(callback, ms));
  const cancel =
    deps.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const report = deps.report ?? ((message) => recordLog('error', message));
  const { describe } = deps;

  let settled = false;
  const handle = schedule(() => {
    if (settled) {
      return;
    }
    settled = true;
    const detail = describe ? ` (${describe()})` : '';
    report(
      `app hydration still incomplete after ${timeoutMs}ms — the cold-start durable load has not settled${detail}; ` +
        'the Inbox is stuck on its loading state (reporting only — the load is left to finish, never aborted)',
    );
  }, timeoutMs);

  return () => {
    if (settled) {
      return;
    }
    settled = true;
    cancel(handle);
  };
}
