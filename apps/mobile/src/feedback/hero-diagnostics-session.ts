/**
 * A live snapshot of the Inbox hero/collapsing-header render state, written by
 * `InboxScreen` on every relevant state change and read once when a feedback
 * report is opened (`FloatingReportButton`). Every prior "hero not visible"
 * Sentry report (STASH-1X, STASH-2G, STASH-2P) arrived with `screenshot:
 * absent` and no capture of this state, so root cause had to be guessed from
 * sync/auth logs alone. This gives the next report a direct, timely read of
 * what the hero was actually doing, without waiting on the screenshot capture
 * (which can itself race the report-open timeout under heavy sync load).
 */

export interface HeroDiagnosticsSnapshot {
  collapsed: boolean;
  heroHeight: number;
  collapsibleHeight: number;
  wordmarkLoaded: boolean;
  wordmarkFailed: boolean;
  showWordmarkFallback: boolean;
}

let snapshot: HeroDiagnosticsSnapshot | null = null;

export function setHeroDiagnosticsSnapshot(next: HeroDiagnosticsSnapshot | null): void {
  snapshot = next;
}

export function getHeroDiagnosticsSnapshot(): HeroDiagnosticsSnapshot | null {
  return snapshot;
}
