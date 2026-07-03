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
 * Web/default no-op twin of the native foreground-state registration. The share
 * capture path this guards against (Android background-handle thrash) does not
 * exist on web, so the loop-stall watchdog runs unpaused here.
 */
export function registerForForegroundState(_handler: {
  onBackground?: () => void;
  onForeground?: () => void;
}): () => void {
  // Intentionally empty on web.
  return () => {};
}
