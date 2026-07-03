import { AppState, type AppStateStatus } from 'react-native';

type CloseHandler = () => void;
interface ForegroundStateHandler {
  onBackground?: () => void;
  onForeground?: () => void;
}

const closeHandlers = new Set<CloseHandler>();
const foregroundStateHandlers = new Set<ForegroundStateHandler>();
let subscribed = false;

function safe(handler: (() => void) | undefined): void {
  if (!handler) {
    return;
  }
  try {
    handler();
  } catch {
    // Best-effort; a failing handler must never crash the lifecycle listener.
  }
}

/**
 * Subscribe once to AppState and dispatch background/foreground transitions. We
 * react only to a genuine `background` transition, not the `inactive` flicker
 * iOS emits for the control centre / notification shade / biometric prompts —
 * acting on those would churn the connection (and the watchdog) needlessly.
 */
function ensureSubscribed(): void {
  if (subscribed) {
    return;
  }
  subscribed = true;
  AppState.addEventListener('change', (state: AppStateStatus) => {
    if (state === 'background') {
      for (const handler of closeHandlers) {
        safe(handler);
      }
      for (const handler of foregroundStateHandlers) {
        safe(handler.onBackground);
      }
    } else if (state === 'active') {
      for (const handler of foregroundStateHandlers) {
        safe(handler.onForeground);
      }
    }
  });
}

/**
 * Register a SQLite connection's `closeCurrent` to fire when the app enters the
 * background. Android invalidates native DB handles while backgrounded, so
 * proactively closing here — and letting the next operation lazily reopen —
 * means we rarely operate on an already-dead handle, instead of only recovering
 * after the `prepareAsync` NullPointerException. This complements the in-band
 * self-healing in SqliteConnection; it doesn't replace it (a handle can still
 * die between a foreground op and the next).
 */
export function registerForBackgroundClose(close: CloseHandler): void {
  closeHandlers.add(close);
  ensureSubscribed();
}

/**
 * Register background/foreground callbacks. Used by the JS event-loop stall
 * watchdog (`observability/loop-stall-watchdog.ts`) to pause on `background` and
 * resume on `active`, so the frozen-then-resumed gap of a backgrounded app is
 * never misread as a multi-second JS-thread stall.
 */
export function registerForForegroundState(handler: ForegroundStateHandler): () => void {
  foregroundStateHandlers.add(handler);
  ensureSubscribed();
  return () => {
    foregroundStateHandlers.delete(handler);
  };
}
