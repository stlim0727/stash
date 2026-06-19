/**
 * Thin React Native shell over the Sentry SDK — the one place that touches
 * `@sentry/react-native`. All decision logic lives in the pure, unit-tested
 * `sentry-config.ts`; this module just calls `Sentry.init` with what that
 * produces and exposes `wrapWithSentry` for the root component.
 *
 * When no DSN is configured, `initSentry` is a no-op and `wrapWithSentry` is the
 * identity wrapper, so the app runs unchanged in local/preview environments.
 */

import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';
import type { ComponentType } from 'react';

import { onConsoleEntry } from './log-buffer';
import { buildSentryInitOptions, getSentryConfigState } from './sentry-config';
import { buildConsoleErrorReport } from './sentry-report';

let started = false;
let consoleReportingInstalled = false;
// Re-entrancy guard: capturing an exception can itself log via console.error
// (e.g. from inside the SDK), which would otherwise re-enter this forwarder.
let reporting = false;

/**
 * Forward handled error-level logs to Sentry as exceptions. Unhandled crashes
 * are already captured by `Sentry.wrap` + native crash handling; this closes the
 * gap for the many errors this app deliberately swallows and logs (enrichment/
 * sync failures, the storage banner) so they never reach monitoring. Fires for
 * both `console.error(...)` and direct `recordLog('error', …)` calls, since the
 * log buffer notifies listeners on every recorded entry.
 *
 * Messages and stacks are scrubbed of URLs/emails first (see sentry-report).
 */
function installConsoleErrorReporting(): void {
  if (consoleReportingInstalled) {
    return;
  }
  consoleReportingInstalled = true;
  onConsoleEntry((level, args) => {
    if (level !== 'error' || reporting) {
      return;
    }
    reporting = true;
    try {
      const report = buildConsoleErrorReport(args);
      if (!report) {
        return;
      }
      const error = new Error(report.message);
      error.name = report.name;
      if (report.stack) {
        error.stack = report.stack;
      }
      Sentry.captureException(error);
    } catch {
      // Never let error reporting break the app.
    } finally {
      reporting = false;
    }
  });
}

/** Initialize crash & error monitoring. Safe to call more than once; only the
 *  first call with a configured DSN takes effect. Returns whether monitoring
 *  is active. */
export function initSentry(): boolean {
  if (started) {
    return true;
  }
  const options = buildSentryInitOptions(getSentryConfigState(), {
    release: Constants.expoConfig?.version ?? null,
  });
  if (!options) {
    return false;
  }
  Sentry.init(options);
  started = true;
  installConsoleErrorReporting();
  return true;
}

/** Wrap the root component so unhandled render/runtime errors are captured.
 *  Harmless when monitoring is disabled. */
export function wrapWithSentry<P extends Record<string, unknown>>(
  component: ComponentType<P>,
): ComponentType<P> {
  return Sentry.wrap(component);
}

/** Associate the current (anonymous) Supabase user id with future events.
 *  Only the opaque id is sent — never email or content. Pass null to clear. */
export function setSentryUser(userId: string | null): void {
  Sentry.setUser(userId ? { id: userId } : null);
}
