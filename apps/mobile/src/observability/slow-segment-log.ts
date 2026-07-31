/**
 * A tiny ring buffer of recent *synchronous* JS-thread segments that ran long
 * enough to be felt as a freeze.
 *
 * This exists to close the hard limitation stated in `loop-stall-watchdog.ts`:
 * that watchdog can prove the JS loop was blocked for N ms, but by the time its
 * late tick runs the blocking frames are already unwound, so its report carries
 * only coarse correlated state. Sentry STASH-K arrived exactly that way —
 * "stalled ~3096ms (syncing=true queue=685)" — enough to place the stall inside
 * a sync pass over a large queue, not enough to name the code that blocked.
 *
 * The fix is to have the suspect regions time *themselves*. Every entry here is
 * a span with no `await` in it, so its duration IS JS-thread block time — the
 * same quantity the watchdog measures from the outside. A segment of ~3000ms
 * recorded moments before a ~3000ms stall report is direct attribution, not a
 * correlation; an empty list is informative too, since it rules the
 * instrumented regions out.
 *
 * Kept deliberately cheap (two clock reads per measured region, and a bounded
 * array) so it can stay armed in release builds, where React's own Profiler is
 * compiled out. Dependency-free for the same reasons as `log-buffer.ts`: it
 * loads under the Node test runner and can be called from store/sync code
 * without import cycles.
 */

/** Segments shorter than this are dropped. Comfortably below the watchdog's
 *  3s stall bound (so the blocker is always captured) but above ordinary
 *  per-frame work, which keeps the buffer from filling with noise during a
 *  long bulk import. */
export const SLOW_SEGMENT_THRESHOLD_MS = 500;

/** How many segments to retain. Small on purpose: only the ones adjacent to a
 *  stall are useful, and the report has to stay a single readable line. */
export const MAX_SLOW_SEGMENTS = 8;

/** Segments older than this are not described — a stall is explained by what
 *  ran just before it, and a minute-old segment would be misleading. Matches
 *  the watchdog's report cooldown. */
export const SLOW_SEGMENT_WINDOW_MS = 60_000;

export interface SlowSegment {
  /** Stable, non-identifying region label (never user content). */
  label: string;
  durationMs: number;
  /** Wall clock at which the segment finished. */
  endedAt: number;
}

const segments: SlowSegment[] = [];

/**
 * Record one measured region, keeping it only if it crossed the threshold.
 * Callers pass an already-computed duration so a region can be bracketed with
 * two timestamps without restructuring it into a closure.
 */
export function recordSlowSegment(label: string, durationMs: number, endedAt = Date.now()): void {
  if (!(durationMs >= SLOW_SEGMENT_THRESHOLD_MS)) {
    return;
  }
  segments.push({ label, durationMs: Math.round(durationMs), endedAt });
  if (segments.length > MAX_SLOW_SEGMENTS) {
    segments.splice(0, segments.length - MAX_SLOW_SEGMENTS);
  }
}

/**
 * Time a synchronous region and record it if slow. Returns whatever `run`
 * returns; a throw still records the (partial) duration and propagates, so an
 * instrumented region never changes behavior.
 */
export function measureSyncSegment<T>(label: string, run: () => T, now: () => number = Date.now): T {
  const startedAt = now();
  try {
    return run();
  } finally {
    const endedAt = now();
    recordSlowSegment(label, endedAt - startedAt, endedAt);
  }
}

/**
 * Compact one-line summary of the segments inside the recent window, newest
 * last — e.g. `react-cycle 2900ms 120ms ago`. Empty string when there is
 * nothing to report, so callers can choose their own "none" wording.
 */
export function describeRecentSegments(
  now = Date.now(),
  windowMs = SLOW_SEGMENT_WINDOW_MS,
): string {
  return segments
    .filter((segment) => now - segment.endedAt <= windowMs)
    .map(
      (segment) =>
        `${segment.label} ${segment.durationMs}ms ${Math.max(0, now - segment.endedAt)}ms ago`,
    )
    .join(', ');
}

/** A copy of the retained segments, oldest first. */
export function getSlowSegments(): SlowSegment[] {
  return segments.slice();
}

export function clearSlowSegments(): void {
  segments.length = 0;
}
