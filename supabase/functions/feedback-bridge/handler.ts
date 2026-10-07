import { readJsonObject, RequestBodyError } from '../_shared/http.ts';
import { timingSafeEqual } from '../ai-enrich/request-auth.ts';
import { parseWebhookReport, type ReportSink } from './sink.ts';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export function createFeedbackHandler(secret: string, sink: ReportSink | null) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    // Configuration failure must not disable authentication, even without a sink.
    if (!secret) return json({ error: 'Webhook authentication is not configured' }, 503);
    const provided = req.headers.get('x-feedback-bridge-secret') ?? '';
    if (!provided || !timingSafeEqual(provided, secret)) return json({ error: 'Unauthorized' }, 401);
    let report;
    try {
      // The app's screenshot data URL is bounded at 1.5M characters; retain
      // room for that legitimate attachment plus diagnostics and webhook fields.
      report = parseWebhookReport(await readJsonObject(req, 2 * 1024 * 1024));
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Invalid payload' },
        error instanceof RequestBodyError ? error.status : 400);
    }
    if (!sink) return json({ skipped: true, reason: 'No report sink configured' });
    const result = await sink.deliver(report);
    return json({ sink: sink.name, ...result }, result.delivered ? 200 : 502);
  };
}
