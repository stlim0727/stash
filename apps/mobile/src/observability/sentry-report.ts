/**
 * Pure helpers for turning a captured `console.error(...)` call into a
 * Sentry-ready report. Dependency-free (no Sentry / RN imports) so it runs
 * under the Node test runner, exactly like `sentry-config.ts`.
 *
 * Privacy first: the app logs user content (notably bookmark URLs) on handled
 * errors, and the project rule is to never send content to Sentry. So every
 * string we forward — message *and* stack — is scrubbed of URLs and emails
 * before it leaves the device.
 */

import { stringifyArg } from './log-buffer.ts';

const URL_RE = /\bhttps?:\/\/\S+/gi;
const EMAIL_RE = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/gi;

/** Redact URLs and email addresses from a log/stack string. */
export function scrubText(input: string): string {
  return input.replace(URL_RE, '[url]').replace(EMAIL_RE, '[email]');
}

export interface ConsoleErrorReport {
  /** Error name for Sentry grouping (the original Error's name when present). */
  name: string;
  /** Scrubbed, human-readable message built from all console arguments. */
  message: string;
  /** Scrubbed stack from the original Error, if one was logged. */
  stack?: string;
  /** Whether a real Error object was among the arguments. */
  hadError: boolean;
}

function argToMessage(arg: unknown): string {
  if (arg instanceof Error) {
    return `${arg.name}: ${arg.message}`;
  }
  return stringifyArg(arg);
}

/**
 * Build a scrubbed report from the arguments of a `console.error(...)` call, or
 * `null` when there is nothing meaningful to report (no args / blank message).
 */
export function buildConsoleErrorReport(
  args: unknown[],
  scrub: (input: string) => string = scrubText,
): ConsoleErrorReport | null {
  if (args.length === 0) {
    return null;
  }
  const message = scrub(args.map(argToMessage).join(' ')).trim();
  if (!message) {
    return null;
  }
  const firstError = args.find((a): a is Error => a instanceof Error) ?? null;
  return {
    name: firstError?.name ?? 'ConsoleError',
    message,
    stack: firstError?.stack ? scrub(firstError.stack) : undefined,
    hadError: firstError !== null,
  };
}
