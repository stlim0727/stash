import { AppState, type AppStateStatus } from 'react-native';

type CloseHandler = () => void;

const handlers = new Set<CloseHandler>();
let subscribed = false;

/**
 * Register a SQLite connection's `closeCurrent` to fire when the app enters the
 * background. Android invalidates native DB handles while backgrounded, so
 * proactively closing here — and letting the next operation lazily reopen —
 * means we rarely operate on an already-dead handle, instead of only recovering
 * after the `prepareAsync` NullPointerException. This complements the in-band
 * self-healing in SqliteConnection; it doesn't replace it (a handle can still
 * die between a foreground op and the next).
 *
 * We react only to a genuine `background` transition, not the `inactive` flicker
 * iOS emits for the control centre / notification shade / biometric prompts —
 * closing on those would churn the connection needlessly.
 */
export function registerForBackgroundClose(close: CloseHandler): void {
  handlers.add(close);
  if (subscribed) {
    return;
  }
  subscribed = true;
  AppState.addEventListener('change', (state: AppStateStatus) => {
    if (state !== 'background') {
      return;
    }
    for (const handler of handlers) {
      try {
        handler();
      } catch {
        // Best-effort; a failing close must never crash the lifecycle listener.
      }
    }
  });
}
