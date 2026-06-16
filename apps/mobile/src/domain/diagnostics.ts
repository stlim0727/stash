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
 */

export type DiagnosticsAuthStatus =
  | 'not_configured'
  | 'loading'
  | 'anonymous'
  | 'authenticated'
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
}

export interface DiagnosticsContext {
  appVersion: string;
  platform: string;
  osVersion?: string;
  route: string;
  authStatus: DiagnosticsAuthStatus;
  queueDepth: number;
  isSyncing: boolean;
  lastPulledAt: string | null;
  lastError?: string;
  build?: string;
  /** Recent technical log lines (capped). Present only when captured. */
  logs?: string[];
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

  if (input.logs && input.logs.length > 0) {
    context.logs = input.logs.filter((line) => typeof line === 'string' && line.length > 0);
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
  const lines = [
    `Stash diagnostics — ${context.build ?? context.appVersion}`,
    '',
    JSON.stringify(summary, null, 2),
  ];
  if (logs && logs.length > 0) {
    lines.push('', `Recent logs (${logs.length}):`, logs.join('\n'));
  }
  return lines.join('\n');
}
