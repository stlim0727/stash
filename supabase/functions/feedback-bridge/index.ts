// Supabase Edge Function: feedback-bridge
//
// Forwards in-app feedback reports to an external reporting system (Sentry by
// default). It is invoked by a Supabase database webhook on INSERT into
// `feedback_reports`, so the mobile client only ever writes a row — delivery to
// the third party happens server-side, where the DSN/secret and any further
// redaction live off-device.
//
// The destination is a swappable seam: implement ReportSink in a new module and
// change the single `sink` assignment below (Sentry → Linear, Slack, GitHub, …).
// Nothing in the database, the webhook, or the app needs to change.

import { SentrySink } from './sentry-sink.ts';
import type { ReportSink } from './sink.ts';
import { createFeedbackHandler } from './handler.ts';

const SENTRY_DSN = Deno.env.get('SENTRY_DSN') ?? '';
const APP_RELEASE = Deno.env.get('FEEDBACK_RELEASE') ?? null;
// Shared secret a Supabase webhook can send as a header so only the database
// can drive this function. Unset configuration rejects every request.
const WEBHOOK_SECRET = Deno.env.get('FEEDBACK_BRIDGE_SECRET') ?? '';

// ── The swappable seam ──────────────────────────────────────────────────────
// Choose the sink at boot. Without a DSN the function is a no-op so local and
// preview environments don't fail closed.
const sink: ReportSink | null = SENTRY_DSN
  ? new SentrySink(SENTRY_DSN, { release: APP_RELEASE })
  : null;
// ────────────────────────────────────────────────────────────────────────────

Deno.serve(createFeedbackHandler(WEBHOOK_SECRET, sink));
