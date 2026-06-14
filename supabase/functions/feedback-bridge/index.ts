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
import { parseWebhookReport } from './sink.ts';

const SENTRY_DSN = Deno.env.get('SENTRY_DSN') ?? '';
const APP_RELEASE = Deno.env.get('FEEDBACK_RELEASE') ?? null;
// Shared secret a Supabase webhook can send as a header so only the database
// can drive this function. Optional: if unset, the check is skipped.
const WEBHOOK_SECRET = Deno.env.get('FEEDBACK_BRIDGE_SECRET') ?? '';

// ── The swappable seam ──────────────────────────────────────────────────────
// Choose the sink at boot. Without a DSN the function is a no-op so local and
// preview environments don't fail closed.
const sink: ReportSink | null = SENTRY_DSN
  ? new SentrySink(SENTRY_DSN, { release: APP_RELEASE })
  : null;
// ────────────────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Constant-time-ish comparison so the secret check doesn't leak length/contents
// via timing. Both strings are short shared secrets.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  if (WEBHOOK_SECRET) {
    const provided = req.headers.get('x-feedback-bridge-secret') ?? '';
    if (!safeEqual(provided, WEBHOOK_SECRET)) {
      return json({ error: 'Unauthorized' }, 401);
    }
  }

  let report;
  try {
    report = parseWebhookReport(await req.json());
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : 'Invalid payload' },
      400,
    );
  }

  if (!sink) {
    // No destination configured — acknowledge so the webhook doesn't retry.
    return json({ skipped: true, reason: 'No report sink configured' }, 200);
  }

  const result = await sink.deliver(report);
  if (!result.delivered) {
    // 502: the report is safely persisted in `feedback_reports`; only the
    // forward failed, so a webhook retry is harmless.
    return json({ sink: sink.name, ...result }, 502);
  }
  return json({ sink: sink.name, ...result }, 200);
});
