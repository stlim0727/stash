/**
 * A tiny in-memory ring buffer of recent log lines, plus an optional console
 * patch that feeds every `console.*` call into it. This is what lets the
 * "Report a problem" screen attach real internal logs (e.g. the exact SQLite
 * open error behind the "Couldn't open local storage" banner) instead of only
 * coarse, redacted diagnostics.
 *
 * Dependency-free on purpose so it loads under the Node test runner and can be
 * called from anywhere (store, repository, sync) without import cycles.
 */

export type LogLevel = 'log' | 'info' | 'warn' | 'error';

export interface LogEntry {
  /** ISO timestamp. */
  t: string;
  level: LogLevel;
  message: string;
}

const MAX_ENTRIES = 300;
const entries: LogEntry[] = [];

/** Notified for every recorded log entry, with the *raw* arguments when
 *  available (so a subscriber can recover the original Error object and its
 *  stack). Defined ahead of `recordLog` so it can notify on every entry. */
export type ConsoleListener = (level: LogLevel, args: unknown[]) => void;

const listeners = new Set<ConsoleListener>();

/**
 * Subscribe to log entries as they are recorded — from the patched console
 * *and* from direct `recordLog` calls (e.g. the native SQLite-open failure).
 * Used to forward errors to crash monitoring without coupling this
 * dependency-free module to the Sentry SDK. Returns an unsubscribe function.
 */
export function onConsoleEntry(listener: ConsoleListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyListeners(level: LogLevel, args: unknown[]): void {
  for (const listener of listeners) {
    try {
      listener(level, args);
    } catch {
      // A misbehaving listener must never break logging.
    }
  }
}

/**
 * Append one entry, trimming the oldest once the cap is exceeded, then notify
 * listeners. `args` carries the original console arguments when present (so the
 * Sentry bridge keeps the real Error/stack); direct callers pass only a string,
 * for which the message itself is forwarded.
 */
export function recordLog(level: LogLevel, message: string, args?: unknown[]): void {
  entries.push({ t: new Date().toISOString(), level, message });
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
  notifyListeners(level, args ?? [message]);
}

/** A copy of the captured entries, oldest first. */
export function getLogEntries(): LogEntry[] {
  return entries.slice();
}

export function clearLogEntries(): void {
  entries.length = 0;
}

/** Render entries as plain text lines for sharing/preview. */
export function formatLogEntries(list: LogEntry[] = entries): string {
  return list.map((e) => `${e.t} [${e.level}] ${e.message}`).join('\n');
}

/** Best-effort, readable stringification of a single console argument. */
export function stringifyArg(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    const head = `${value.name}: ${value.message}`;
    const stack = value.stack ? value.stack.split('\n').slice(1, 3).join(' | ').trim() : '';
    return stack ? `${head} (${stack})` : head;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

type ConsoleLike = Record<string, (...args: unknown[]) => void>;

let installed = false;

/**
 * Patch `console.{log,info,warn,error}` so each call is also recorded. The
 * original behavior is preserved. Idempotent — safe to call once at startup.
 */
export function installConsoleCapture(target: ConsoleLike = console as unknown as ConsoleLike): void {
  if (installed) {
    return;
  }
  installed = true;

  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = typeof target[level] === 'function' ? target[level].bind(target) : undefined;
    target[level] = (...args: unknown[]) => {
      try {
        // Pass the raw args so listeners keep the original Error/stack.
        recordLog(level, args.map(stringifyArg).join(' '), args);
      } catch {
        // Never let logging capture break the app.
      }
      original?.(...args);
    };
  }
}
