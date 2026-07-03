/**
 * Reporting-only watchdog for JS event-loop stalls (the "button press does
 * nothing for several seconds" freeze).
 *
 * React Native runs `onPress` handlers and the React reconciler on the JS
 * thread, so a jammed JS loop leaves the UI unresponsive while the *native*
 * main thread keeps rendering — which is exactly why the native crash/hang
 * detectors miss it: Android ANR and iOS app-hang both watch the main thread,
 * not the JS thread (Sentry STASH-H). The three existing watchdogs are all
 * narrow and work-scoped — the hydration load (`hydration-watchdog.ts`), a
 * single DB unit (`storage/sqlite-connection.ts`), the iOS UI thread — so a
 * general multi-second stall of the loop itself, unattached to any awaited
 * unit, reaches monitoring only as fuzzy in-app "it froze" feedback.
 *
 * This arms a self-rescheduling heartbeat that measures how late each tick
 * arrives (the overshoot IS the stall length) and records an `error`-level log
 * once per stall so it reaches crash monitoring via the console→Sentry bridge
 * (`log-buffer` → `sentry.ts`). Like its siblings it is observe-only: it never
 * aborts or changes anything.
 *
 * HARD LIMITATION: this detects and contextualizes the stall but cannot capture
 * the *stack* of the blocking JS code — by the time the late tick runs, the
 * synchronous blocker has already returned. It reports when/how-long plus coarse
 * correlated state (see `describe`); capturing the offending frames needs the
 * Hermes sampling profiler, a separate/heavier decision.
 *
 * Pure and dependency-injected (clock + reporters) so it runs under the Node
 * test runner with a fake clock and no React.
 */

import { recordLog } from '@/observability/log-buffer';

/** Heartbeat cadence: how often the tick reschedules itself. ~1s gives roughly
 *  second-granularity detection at negligible steady-state cost (two clock
 *  reads per tick). */
export const DEFAULT_LOOP_STALL_INTERVAL_MS = 1_000;

/** A tick arriving more than this late past its schedule is treated as a stall.
 *  Sits deliberately in the gap between ordinary sub-second cold-start/GC jank
 *  we must NOT report and the multi-second freeze users actually feel — below
 *  the SQLite work bound (5s) and hydration bound (10s), above the iOS app-hang
 *  bar (2s) which is an aggressive UI metric on a platform this doesn't target. */
export const DEFAULT_LOOP_STALL_THRESHOLD_MS = 3_000;

/** After a report, further over-threshold ticks are suppressed for this long, so
 *  a pathological screen that stalls repeatedly can't flood monitoring — at most
 *  one loop-stall event per minute per session. */
export const DEFAULT_LOOP_STALL_COOLDOWN_MS = 60_000;

/** A tick this far past schedule is almost certainly the OS having frozen the
 *  process (backgrounding/doze) rather than a genuine JS-thread jam — a real
 *  freeze is single-digit seconds. Treated as a suspension artifact (recorded at
 *  `info`, never `error`), the backstop for when an AppState `background` pause
 *  didn't fire before the OS suspended us. */
export const DEFAULT_LOOP_STALL_SUSPICION_MS = 30_000;

export interface LoopStallWatchdogDeps {
  /** Override the heartbeat cadence (ms). */
  intervalMs?: number;
  /** Override the stall bound (ms). */
  thresholdMs?: number;
  /** Override the post-report suppression window (ms). */
  cooldownMs?: number;
  /** Override the suspension backstop (ms). */
  backgroundSuspicionMs?: number;
  /** Coarse, non-identifying state read at fire time — counts/booleans/phase
   *  strings ONLY, never user content (titles, URLs, notes, search text). */
  describe?: () => string;
  /** Injected clock for tests; defaults to `Date.now`. */
  now?: () => number;
  /** Injected timer for tests; defaults to the global `setTimeout`. */
  schedule?: (callback: () => void, ms: number) => unknown;
  /** Injected canceller for tests; defaults to the global `clearTimeout`. */
  cancel?: (handle: unknown) => void;
  /** Injected stall reporter; defaults to an `error`-level `recordLog` (which the
   *  Sentry bridge forwards as an exception). */
  report?: (message: string) => void;
  /** Injected suspension reporter; defaults to an `info`-level `recordLog`
   *  (buffer only — never a Sentry exception). */
  reportSuspension?: (message: string) => void;
}

export interface LoopStallWatchdog {
  /** Stop measuring while the app is backgrounded (wire to AppState
   *  `background`), so the frozen-then-resumed gap is never misread as a stall. */
  pause(): void;
  /** Resume measuring on return to the foreground (wire to AppState `active`);
   *  rebaselines so the paused gap does not count. */
  resume(): void;
  /** Stop all future ticks. Idempotent — safe to call more than once. */
  disarm(): void;
}

/**
 * Arm the heartbeat. Returns a controller to `pause`/`resume` on AppState
 * transitions and `disarm` on teardown.
 */
export function armLoopStallWatchdog(deps: LoopStallWatchdogDeps = {}): LoopStallWatchdog {
  const intervalMs = deps.intervalMs ?? DEFAULT_LOOP_STALL_INTERVAL_MS;
  const thresholdMs = deps.thresholdMs ?? DEFAULT_LOOP_STALL_THRESHOLD_MS;
  const cooldownMs = deps.cooldownMs ?? DEFAULT_LOOP_STALL_COOLDOWN_MS;
  const backgroundSuspicionMs = deps.backgroundSuspicionMs ?? DEFAULT_LOOP_STALL_SUSPICION_MS;
  const now = deps.now ?? Date.now;
  const schedule =
    deps.schedule ??
    ((callback, ms) => {
      const handle = setTimeout(callback, ms);
      // In Node (the jest/test lane) unref the heartbeat so a pending tick never
      // keeps the process alive; a no-op in the RN runtime, where setTimeout
      // returns a number.
      (handle as { unref?: () => void }).unref?.();
      return handle;
    });
  const cancel =
    deps.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const report = deps.report ?? ((message) => recordLog('error', message));
  const reportSuspension = deps.reportSuspension ?? ((message) => recordLog('info', message));
  const { describe } = deps;

  let disarmed = false;
  let paused = false;
  let handle: unknown = null;
  // Expected arrival of the next tick; the overshoot past it is the stall length.
  let expected = now() + intervalMs;
  // `-Infinity` so the first stall always clears the cooldown gate.
  let lastReportAt = -Infinity;

  const tick = (): void => {
    if (disarmed || paused) {
      // A stray tick after disarm/pause (already-queued timer) must stay silent.
      return;
    }
    const actual = now();
    const delta = actual - expected;
    if (delta > backgroundSuspicionMs) {
      // Almost certainly OS suspension, not a JS jam — never an `error`.
      reportSuspension(
        `js event loop tick arrived ~${delta}ms late — treated as OS suspension (backgrounding/doze), not reported as a stall`,
      );
    } else if (delta > thresholdMs && actual - lastReportAt >= cooldownMs) {
      lastReportAt = actual;
      const detail = describe ? ` (${describe()})` : '';
      report(
        `js event loop stalled ~${delta}ms — the JS thread was blocked past ${thresholdMs}ms so input/press handling was frozen${detail}; ` +
          'reporting only (nothing aborted). Note: the blocking stack is already unwound and cannot be captured here',
      );
    }
    // Rebaseline off *now* so the immediate catch-up tick after a stall is not
    // itself misread as a second stall.
    expected = now() + intervalMs;
    handle = schedule(tick, intervalMs);
  };

  handle = schedule(tick, intervalMs);

  return {
    pause() {
      if (disarmed || paused) {
        return;
      }
      paused = true;
      if (handle !== null) {
        cancel(handle);
        handle = null;
      }
    },
    resume() {
      if (disarmed || !paused) {
        return;
      }
      paused = false;
      expected = now() + intervalMs;
      handle = schedule(tick, intervalMs);
    },
    disarm() {
      if (disarmed) {
        return;
      }
      disarmed = true;
      if (handle !== null) {
        cancel(handle);
        handle = null;
      }
    },
  };
}
