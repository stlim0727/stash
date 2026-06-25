/**
 * Web/default no-op. There is no native SQLite handle to release when a browser
 * tab is hidden — the web repository uses localStorage/in-memory — so background
 * lifecycle management is a no-op here. The native variant
 * (`sqlite-app-lifecycle.native.ts`) wires AppState.
 */
export function registerForBackgroundClose(_close: () => void): void {
  // Intentionally empty on web.
}
