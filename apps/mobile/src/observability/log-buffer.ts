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

/** Append one entry, trimming the oldest once the cap is exceeded. */
export function recordLog(level: LogLevel, message: string): void {
  entries.push({ t: new Date().toISOString(), level, message });
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
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
        recordLog(level, args.map(stringifyArg).join(' '));
      } catch {
        // Never let logging capture break the app.
      }
      original?.(...args);
    };
  }
}
