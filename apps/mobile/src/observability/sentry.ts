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

import { onConsoleEntry, recordLog } from './log-buffer';
import { buildSentryInitOptions, getSentryConfigState } from './sentry-config';
import { buildConsoleErrorReport, scrubText } from './sentry-report';

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
    // Builds that share a version name — every web deploy stamps the bare
    // marketing version (e.g. `1.1.0`) — are otherwise indistinguishable in
    // Sentry, so a fix can't be told apart from the build that had the bug.
    // The commit SHA (already exposed via app.config.js `extra.gitSha`) gives
    // each deploy a distinct release+dist pair.
    dist: (Constants.expoConfig?.extra?.gitSha as string | null | undefined) ?? null,
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

/**
 * Record a low-severity diagnostic breadcrumb for a user interaction we want a
 * trail of when something later goes wrong. It lands in two places: the in-app
 * log buffer (so it ships with a "Report a problem" / "Share diagnostics"
 * submission) and as a Sentry breadcrumb (attached to any event from this
 * session). `info`-level, so it never fires a Sentry exception of its own.
 *
 * Pass only coarse, non-identifying values in `data` — never user content
 * (titles, URLs, notes, search text). Opaque ids (tag/collection UUIDs) are ok.
 */
export function trackBreadcrumb(
  category: string,
  message: string,
  data?: Record<string, string | number | boolean | null>,
): void {
  const suffix = data ? ` ${JSON.stringify(data)}` : '';
  recordLog('info', `[${category}] ${message}${suffix}`);
  try {
    Sentry.addBreadcrumb({ category, message, level: 'info', data });
  } catch {
    // Breadcrumbs are best-effort; never let diagnostics break the UI.
  }
}

/** Associate the current (anonymous) Supabase user id with future events.
 *  Only the opaque id is sent — never email or content. Pass null to clear. */
export function setSentryUser(userId: string | null): void {
  Sentry.setUser(userId ? { id: userId } : null);
}

/**
 * Escalates a sync-queue entry that just crossed the retry-health threshold
 * (see `crossedHealthEscalationThreshold` in sync/sync-bookmarks.ts) so a
 * systemic sync problem surfaces to the team without waiting for an in-app
 * feedback report.
 *
 * The captured message is a fixed, non-identifying string on purpose: Sentry
 * groups events by message by default, so a fixed string lets every
 * occurrence across every device land in ONE recurring issue instead of a
 * new issue per bookmark. The variable, still non-content data (operation,
 * retry count, last error) rides as `extra` instead, since only the message
 * participates in that default grouping.
 */
export function reportSyncQueueHealthEscalation(entry: {
  operation: string;
  retryCount: number;
  lastError: string | null;
}): void {
  try {
    Sentry.captureMessage('Sync queue entry crossed retry-health threshold', {
      level: 'warning',
      extra: {
        operation: entry.operation,
        retry_count: entry.retryCount,
        last_error: entry.lastError ? scrubText(entry.lastError) : entry.lastError,
      },
    });
  } catch {
    // Escalation reporting is best-effort; never let it break sync.
  }
}

/**
 * Reports a bulk-create chunk that finished with completed local ids still
 * sitting in the sync queue (see `findStaleQueueEntries` in
 * sync/sync-bookmarks.ts) — the STASH-3Y "queue count bounces/grows" signature.
 * Only counts, never bookmark ids/content, ride as `extra`. Fixed message so
 * every occurrence groups into one recurring Sentry issue instead of one per
 * chunk.
 */
export function reportQueueReconcileMismatch(entry: {
  staleCount: number;
  chunkCompletedCount: number;
  reenqueuedCount: number;
}): void {
  try {
    Sentry.captureMessage('Bulk create chunk left stale queue entries behind', {
      level: 'warning',
      extra: {
        stale_count: entry.staleCount,
        chunk_completed_count: entry.chunkCompletedCount,
        reenqueued_count: entry.reenqueuedCount,
      },
    });
  } catch {
    // Escalation reporting is best-effort; never let it break sync.
  }
}
