/**
 * Builds the diagnostic context attached to an in-app feedback report.
 *
 * This module is intentionally PURE and dependency-free so it can be unit
 * tested with the Node test runner and reused from any caller. Callers gather
 * the live values (app version, platform, current route, etc.) and pass them in
 * as plain inputs.
 *
 * Redaction by default: the context never includes user-authored content
 * (bookmark URLs, titles, notes, search terms). Only coarse, non-identifying
 * operational signals are recorded so a report stays safe to store and share.
 * Screenshots are the exception: callers must pass one only after explicit
 * user opt-in because it can show the current screen.
 */

import type { ShareAttemptDiagnostics } from './share-diagnostics';

export type DiagnosticsAuthStatus =
  | 'not_configured'
  | 'loading'
  | 'anonymous'
  | 'authenticated'
  | 'signed_out'
  | 'session_expired'
  | 'error';

export interface DiagnosticsInput {
  /** App version string, e.g. from expo-constants (`expoConfig.version`). */
  appVersion?: string | null;
  /** Platform identifier, e.g. React Native `Platform.OS` ('ios' | 'android' | 'web'). */
  platform?: string | null;
  /** Optional OS / SDK version label for extra context. */
  osVersion?: string | null;
  /** The route the user was on when reporting (path only, no query content). */
  route?: string | null;
  /** Coarse screen surface the report was opened from. */
  sourceSurface?: string | null;
  /** Coarse Supabase auth status — never the token or user content. */
  authStatus?: DiagnosticsAuthStatus | null;
  /** Number of items waiting in the offline sync queue. */
  queueDepth?: number | null;
  /** Whether a sync run is currently in flight. */
  isSyncing?: boolean | null;
  /** Last successful pull time (ISO string), if any. */
  lastPulledAt?: string | null;
  /** Last error message surfaced to the user, if any (operational, not content). */
  lastError?: string | null;
  /** Build identity, e.g. `main @ 7b6e2a9` (from build-info). */
  build?: string | null;
  /** Recent technical log lines to aid debugging (already formatted). */
  logs?: string[] | null;
  /** Structured storage diagnostics captured near the failure site. */
  storage?: DiagnosticsStorage | null;
  /** Durable record of the last share-intent attempt, if any (survives restarts). */
  shareAttempt?: ShareAttemptDiagnostics | null;
  /** Optional user-approved screen capture from where feedback was opened. */
  screenshot?: DiagnosticsScreenshot | null;
}

export interface DiagnosticsScreenshot {
  dataUrl: string;
  mimeType: 'image/jpeg';
  capturedAt: string;
  platform: string;
  surface: string;
}

export interface DiagnosticsStorage {
  sqlitePreflight?: {
    directoryApi: string;
    fileApi: string;
    documentRoot: string;
    lastStep: string;
    lastError?: string;
    updatedAt: string;
  };
  sqliteOpen?: {
    phase: string;
    error: string;
    updatedAt: string;
  };
}

export interface DiagnosticsContext {
  appVersion: string;
  platform: string;
  osVersion?: string;
  route: string;
  sourceSurface?: string;
  authStatus: DiagnosticsAuthStatus;
  queueDepth: number;
  isSyncing: boolean;
  lastPulledAt: string | null;
  lastError?: string;
  build?: string;
  /** Recent technical log lines (capped). Present only when captured. */
  logs?: string[];
  /** Structured storage diagnostics. Present only after storage code records it. */
  storage?: DiagnosticsStorage;
  /** Durable record of the last share-intent attempt. Present only after a share runs. */
  shareAttempt?: ShareAttemptDiagnostics;
  /** User-approved screenshot. May contain visible bookmark or account details. */
  screenshot?: DiagnosticsScreenshot;
  capturedAt: string;
}

const MAX_ERROR_LENGTH = 300;

function cleanString(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeAuthStatus(
  value: DiagnosticsAuthStatus | null | undefined,
): DiagnosticsAuthStatus {
  switch (value) {
    case 'not_configured':
    case 'loading':
    case 'anonymous':
    case 'authenticated':
    case 'signed_out':
    case 'session_expired':
    case 'error':
      return value;
    default:
      return 'not_configured';
  }
}

function normalizeQueueDepth(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

/**
 * Produce the redacted diagnostic context object. The result is a plain,
 * JSON-serializable object suitable for storing in `feedback_reports.context`.
 */
export function buildDiagnosticsContext(input: DiagnosticsInput = {}): DiagnosticsContext {
  const context: DiagnosticsContext = {
    appVersion: cleanString(input.appVersion) ?? 'unknown',
    platform: cleanString(input.platform) ?? 'unknown',
    route: cleanString(input.route) ?? 'unknown',
    authStatus: normalizeAuthStatus(input.authStatus),
    queueDepth: normalizeQueueDepth(input.queueDepth),
    isSyncing: input.isSyncing === true,
    lastPulledAt: cleanString(input.lastPulledAt) ?? null,
    capturedAt: new Date().toISOString(),
  };

  const osVersion = cleanString(input.osVersion);
  if (osVersion) {
    context.osVersion = osVersion;
  }

  const lastError = cleanString(input.lastError);
  if (lastError) {
    context.lastError = lastError.slice(0, MAX_ERROR_LENGTH);
  }

  const build = cleanString(input.build);
  if (build) {
    context.build = build;
  }

  const sourceSurface = cleanString(input.sourceSurface);
  if (sourceSurface) {
    context.sourceSurface = sourceSurface;
  }

  if (input.logs && input.logs.length > 0) {
    context.logs = input.logs.filter((line) => typeof line === 'string' && line.length > 0);
  }

  if (input.storage && typeof input.storage === 'object') {
    context.storage = input.storage;
  }

  if (input.shareAttempt && typeof input.shareAttempt === 'object') {
    context.shareAttempt = input.shareAttempt;
  }

  if (
    input.screenshot &&
    typeof input.screenshot.dataUrl === 'string' &&
    input.screenshot.dataUrl.length > 0
  ) {
    context.screenshot = {
      dataUrl: input.screenshot.dataUrl,
      mimeType: input.screenshot.mimeType,
      capturedAt: input.screenshot.capturedAt,
      platform: input.screenshot.platform,
      surface: input.screenshot.surface,
    };
  }

  return context;
}

/**
 * Render a diagnostics context as a shareable, human-readable text block —
 * what the "Share diagnostics" action hands to the OS share sheet so a user can
 * paste it into an issue, email, or chat. Logs are appended verbatim at the end.
 */
export function formatDiagnosticsReport(context: DiagnosticsContext): string {
  const { logs, ...summary } = context;
  const printableSummary = context.screenshot
    ? {
        ...summary,
        screenshot: {
          ...context.screenshot,
          dataUrl: `[redacted ${context.screenshot.mimeType} screenshot]`,
        },
      }
    : summary;
  const lines = [
    `Keepory diagnostics — ${context.build ?? context.appVersion}`,
    '',
    JSON.stringify(printableSummary, null, 2),
  ];
  if (logs && logs.length > 0) {
    lines.push('', `Recent logs (${logs.length}):`, logs.join('\n'));
  }
  return lines.join('\n');
}
