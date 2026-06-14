// The feedback reporting seam. Every in-app feedback report that lands in the
// `feedback_reports` table is delivered to an external reporting system through
// a ReportSink, so swapping Sentry for Linear, Slack, or GitHub later is a
// one-line change in index.ts — the database, the webhook trigger, and the
// mobile client all stay the same.
//
// This module is intentionally dependency-free and runtime-agnostic (no Deno,
// Node, or React Native imports) so it can be unit-tested under Node and
// imported unchanged by the Deno edge function. It mirrors the EnrichmentProvider
// seam used by the `ai-enrich` function.

/** A single feedback report, shaped exactly like a `feedback_reports` row.
 *  Diagnostic context is already redacted client-side (see the mobile app's
 *  `buildDiagnosticsContext`): it never contains user-authored bookmark
 *  content (URLs, titles, notes). The `message` is the reporter's own words. */
export interface FeedbackReport {
  id: string;
  user_id: string;
  category: string;
  message: string;
  context: Record<string, unknown>;
  app_version: string | null;
  platform: string | null;
  created_at: string;
}

export interface DeliveryResult {
  /** True when the sink accepted the report. */
  delivered: boolean;
  /** Opaque reference from the destination (e.g. a Sentry event id), if any. */
  reference?: string;
  /** Human-readable reason when `delivered` is false. */
  reason?: string;
}

export interface ReportSink {
  /** Identifies the destination, surfaced in responses and logs for tracing. */
  readonly name: string;
  deliver(report: FeedbackReport): Promise<DeliveryResult>;
}

/** Parse the raw insert payload from a Supabase database webhook into a typed
 *  FeedbackReport. Webhooks POST `{ type, table, schema, record, old_record }`;
 *  we read `record`. Throws on a payload that is not an INSERT we can use. */
export function parseWebhookReport(payload: unknown): FeedbackReport {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Expected a JSON webhook payload');
  }
  const record = (payload as { record?: unknown }).record;
  if (!record || typeof record !== 'object') {
    throw new Error('Webhook payload is missing a `record`');
  }
  const row = record as Record<string, unknown>;
  const id = typeof row.id === 'string' ? row.id : '';
  const user_id = typeof row.user_id === 'string' ? row.user_id : '';
  const category = typeof row.category === 'string' ? row.category : 'other';
  const message = typeof row.message === 'string' ? row.message : '';
  if (!id || !message) {
    throw new Error('Report record is missing required fields (id, message)');
  }
  const context =
    row.context && typeof row.context === 'object'
      ? (row.context as Record<string, unknown>)
      : {};
  return {
    id,
    user_id,
    category,
    message,
    context,
    app_version: typeof row.app_version === 'string' ? row.app_version : null,
    platform: typeof row.platform === 'string' ? row.platform : null,
    created_at:
      typeof row.created_at === 'string' ? row.created_at : new Date().toISOString(),
  };
}
