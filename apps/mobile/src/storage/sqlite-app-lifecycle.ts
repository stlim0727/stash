/**
 * Web/default no-op. There is no native SQLite handle to release when a browser
 * tab is hidden — the web repository uses localStorage/in-memory — so background
 * lifecycle management is a no-op here. The native variant
 * (`sqlite-app-lifecycle.native.ts`) wires AppState.
 */
export function registerForBackgroundClose(_close: () => void): void {
  // Intentionally empty on web.
}

/**
 * Web twin of the native foreground-state registration, wired to the Page
 * Visibility API. Browsers throttle (and eventually suspend) timers in a hidden
 * tab, so a heartbeat returning after a tab switch would otherwise look like a
 * multi-second JS stall and false-report to Sentry. Pausing while hidden and
 * rebaselining on return mirrors the native AppState pause/resume, so the
 * loop-stall watchdog stays honest on web without losing genuine-stall coverage.
 */
export function registerForForegroundState(handler: {
  onBackground?: () => void;
  onForeground?: () => void;
}): () => void {
  // No document during SSR / non-DOM environments — nothing to pause on.
  if (typeof document === 'undefined') {
    return () => {};
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      handler.onBackground?.();
    } else if (document.visibilityState === 'visible') {
      handler.onForeground?.();
    }
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
