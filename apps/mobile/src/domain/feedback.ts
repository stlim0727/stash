/**
 * Pure, platform-free helpers for the in-app feedback / issue system.
 *
 * This module is intentionally dependency-free so it can be unit tested with the
 * Node test runner and reused from any caller (API, screens). It encodes two
 * product rules:
 *
 *  1. Capture with attachments — testers can attach their own screenshots and
 *     short videos; attachment storage paths are namespaced per user/report.
 *  2. Visibility split — a report row carries both tester-facing fields and
 *     internal/developer fields. `summarizeReportForTester` is the single place
 *     that decides what a reporter is allowed to see: it deliberately omits
 *     `external_ref` (the link to the internal GitHub issue) and any other field
 *     not meant for testers, so internal discussion can never leak through the
 *     read path.
 */

import type { DiagnosticsContext } from '@/domain/diagnostics';

export type FeedbackCategory = 'bug' | 'idea' | 'other';

/**
 * Lifecycle of a report. `open` is the only status a tester can create; every
 * later transition is made by a developer (or an agent) on the internal side.
 */
export type FeedbackStatus = 'open' | 'triaged' | 'in_progress' | 'resolved' | 'closed';

export const FEEDBACK_STATUSES: readonly FeedbackStatus[] = [
  'open',
  'triaged',
  'in_progress',
  'resolved',
  'closed',
] as const;

const STATUS_LABELS: Record<FeedbackStatus, string> = {
  open: 'Open',
  triaged: 'Triaged',
  in_progress: 'In progress',
  resolved: 'Resolved',
  closed: 'Closed',
};

/** Human-readable label for a status, tolerant of unknown values from the API. */
export function feedbackStatusLabel(status: string | null | undefined): string {
  if (status && status in STATUS_LABELS) {
    return STATUS_LABELS[status as FeedbackStatus];
  }
  return 'Open';
}

/** Normalize an arbitrary string into a known status, defaulting to `open`. */
export function normalizeFeedbackStatus(value: string | null | undefined): FeedbackStatus {
  return value && (FEEDBACK_STATUSES as readonly string[]).includes(value)
    ? (value as FeedbackStatus)
    : 'open';
}

/** A status the tester should consider "done" — drives the in-app highlight. */
export function isClosedStatus(status: string | null | undefined): boolean {
  const normalized = normalizeFeedbackStatus(status);
  return normalized === 'resolved' || normalized === 'closed';
}

/**
 * A raw `feedback_reports` row as returned by Supabase REST. Internal-only data
 * (the GitHub issue link) lives in a separate `feedback_report_internal` table
 * that reporters cannot read, so it never appears here. The diagnostics
 * `context` is still projected away before reaching a tester — see
 * `summarizeReportForTester`.
 */
export interface FeedbackReportRow {
  id: string;
  user_id: string;
  category: string;
  message: string;
  context?: DiagnosticsContext | Record<string, unknown> | null;
  attachments?: unknown;
  status?: string | null;
  developer_reply?: string | null;
  resolution?: string | null;
  app_version?: string | null;
  platform?: string | null;
  created_at: string;
  updated_at?: string | null;
}

/**
 * The tester-facing projection of a report. This is the ONLY shape that should
 * be rendered to a reporter. It intentionally excludes the diagnostics
 * `context` (operational internals), surfacing only what a tester needs to
 * follow their report: the words they wrote, how many files they attached, the
 * current status, and any developer reply / resolution.
 */
export interface TesterReport {
  id: string;
  category: FeedbackCategory;
  message: string;
  status: FeedbackStatus;
  statusLabel: string;
  /** A developer's reply meant for the reporter (null until one is published). */
  developerReply: string | null;
  /** The closing summary shown when the report is resolved/closed. */
  resolution: string | null;
  attachmentCount: number;
  createdAt: string;
  updatedAt: string | null;
}

function normalizeCategory(value: string | null | undefined): FeedbackCategory {
  return value === 'idea' || value === 'other' ? value : 'bug';
}

function attachmentCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function nullableText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Project a raw report row into the tester-safe view. Internal fields are
 * dropped here by construction, so callers cannot accidentally render them.
 */
export function summarizeReportForTester(row: FeedbackReportRow): TesterReport {
  const status = normalizeFeedbackStatus(row.status);
  return {
    id: row.id,
    category: normalizeCategory(row.category),
    message: row.message,
    status,
    statusLabel: feedbackStatusLabel(status),
    developerReply: nullableText(row.developer_reply),
    resolution: nullableText(row.resolution),
    attachmentCount: attachmentCount(row.attachments),
    createdAt: row.created_at,
    updatedAt: nullableText(row.updated_at),
  };
}

const SAFE_SEGMENT = /[^a-zA-Z0-9._-]+/g;

/** Make a single path segment safe for object storage (no slashes/spaces). */
export function sanitizeFilename(name: string, fallback = 'attachment'): string {
  const base = (name.split('/').pop() ?? name).trim();
  const cleaned = base.replace(SAFE_SEGMENT, '_').replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 100) : fallback;
}

/**
 * Build the storage object path for a report attachment. Paths are namespaced
 * by user id first so a single Storage RLS policy (`owner = first path segment`)
 * keeps every tester's uploads private to them.
 *
 *   <userId>/<reportId>/<index>-<filename>
 */
export function attachmentObjectPath(params: {
  userId: string;
  reportId: string;
  index: number;
  filename: string;
}): string {
  const file = sanitizeFilename(params.filename);
  return `${params.userId}/${params.reportId}/${params.index}-${file}`;
}
