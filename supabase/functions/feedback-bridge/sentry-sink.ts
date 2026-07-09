// Sentry adapter for the ReportSink seam.
//
// It turns a redacted FeedbackReport into a Sentry event and posts it to the
// project's envelope endpoint, derived from the DSN. The HTTP transport is
// injectable so unit tests assert the exact payload built from a report without
// ever touching Sentry's network — the same dependency-injection discipline the
// `ai-enrich` DummyProvider uses to stay CI-friendly.
//
// Dependency-free and runtime-agnostic: parses the DSN by hand and uses the
// envelope HTTP API directly rather than the Sentry SDK, so it runs unchanged
// under both Node (tests) and Deno (the edge function).

import type { DeliveryResult, FeedbackReport, ReportSink } from './sink.ts';

/** Minimal HTTP transport. The default uses `fetch`; tests inject a fake that
 *  records the request and returns a canned result. */
export type SentryTransport = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string | Uint8Array },
) => Promise<{ ok: boolean; status: number }>;

const defaultTransport: SentryTransport = async (url, init) => {
  const res = await fetch(url, init);
  return { ok: res.ok, status: res.status };
};

export interface SentryDsn {
  /** e.g. https://o123.ingest.sentry.io/api/456/envelope/ */
  envelopeUrl: string;
  publicKey: string;
  projectId: string;
}

/** Parse a Sentry DSN of the form `https://<key>@<host>/<path?>/<projectId>`. */
export function parseDsn(dsn: string): SentryDsn {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new Error('Invalid SENTRY_DSN: not a URL');
  }
  const publicKey = url.username;
  const segments = url.pathname.split('/').filter(Boolean);
  const projectId = segments.pop() ?? '';
  if (!publicKey || !projectId) {
    throw new Error('Invalid SENTRY_DSN: missing public key or project id');
  }
  // Preserve any path prefix (self-hosted Sentry can live under a sub-path).
  const prefix = segments.length ? `/${segments.join('/')}` : '';
  const envelopeUrl = `${url.protocol}//${url.host}${prefix}/api/${projectId}/envelope/`;
  return { envelopeUrl, publicKey, projectId };
}

export interface SentrySinkOptions {
  transport?: SentryTransport;
  /** Overridable for deterministic tests. */
  newEventId?: () => string;
  now?: () => Date;
  /** Identifies this client to Sentry; stored on the event. */
  release?: string | null;
}

function randomEventId(): string {
  // Sentry event ids are 32 lowercase hex chars, no dashes.
  return crypto.randomUUID().replace(/-/g, '');
}

// Bugs are errors; ideas and everything else are informational. Keeps the
// Sentry issue stream triageable by severity.
function levelFor(category: string): 'error' | 'info' {
  return category === 'bug' ? 'error' : 'info';
}

function screenshotTags(context: Record<string, unknown>): Record<string, string> {
  const screenshot = context.screenshot;
  if (!screenshot || typeof screenshot !== 'object') {
    return { screenshot: 'absent' };
  }
  const record = screenshot as Record<string, unknown>;
  const tags: Record<string, string> = { screenshot: 'present' };
  if (typeof record.surface === 'string' && record.surface.length > 0) {
    tags.screenshot_surface = record.surface.slice(0, 64);
  }
  return tags;
}

interface ScreenshotAttachment {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
}

function extractScreenshot(context: Record<string, unknown>): ScreenshotAttachment | null {
  const screenshot = context.screenshot;
  if (!screenshot || typeof screenshot !== 'object') {
    return null;
  }
  const record = screenshot as Record<string, unknown>;
  const dataUrl = typeof record.dataUrl === 'string' ? record.dataUrl : '';
  const mimeType = typeof record.mimeType === 'string' ? record.mimeType : 'image/jpeg';
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    return null;
  }
  let binary: string;
  try {
    binary = atob(match[2] ?? '');
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return {
    bytes,
    contentType: match[1] || mimeType,
    filename: 'feedback-screen.jpg',
  };
}

function contextWithoutScreenshotData(
  context: Record<string, unknown>,
): Record<string, unknown> {
  const screenshot = context.screenshot;
  if (!screenshot || typeof screenshot !== 'object') {
    return context;
  }
  const { dataUrl: _dataUrl, ...metadata } = screenshot as Record<string, unknown>;
  return {
    ...context,
    screenshot: {
      ...metadata,
      dataUrl: '[redacted screenshot data]',
    },
  };
}

function concatBytes(parts: Array<string | Uint8Array>): Uint8Array {
  const encoder = new TextEncoder();
  const encoded = parts.map((part) => (typeof part === 'string' ? encoder.encode(part) : part));
  const length = encoded.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of encoded) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export class SentrySink implements ReportSink {
  readonly name = 'sentry';
  private readonly dsn: SentryDsn;
  private readonly rawDsn: string;
  private readonly transport: SentryTransport;
  private readonly newEventId: () => string;
  private readonly now: () => Date;
  private readonly release: string | null;

  constructor(dsn: string, options: SentrySinkOptions = {}) {
    this.rawDsn = dsn;
    this.dsn = parseDsn(dsn);
    this.transport = options.transport ?? defaultTransport;
    this.newEventId = options.newEventId ?? randomEventId;
    this.now = options.now ?? (() => new Date());
    this.release = options.release ?? null;
  }

  /** Build the Sentry event JSON for a report. Exposed for tests/inspection. */
  buildEvent(report: FeedbackReport): Record<string, unknown> {
    const eventId = this.newEventId();
    const tags: Record<string, string> = {
      source: 'in-app-feedback',
      category: report.category,
      ...screenshotTags(report.context),
    };
    if (report.platform) {
      tags.platform_os = report.platform;
    }
    if (report.app_version) {
      tags.app_version = report.app_version;
    }
    return {
      event_id: eventId,
      timestamp: report.created_at,
      platform: 'other',
      level: levelFor(report.category),
      logger: 'feedback-bridge',
      // The reporter's own words — this is the feedback itself.
      message: { formatted: `[${report.category}] ${report.message}` },
      release: this.release ?? report.app_version ?? undefined,
      user: report.user_id ? { id: report.user_id } : undefined,
      tags,
      // Context is already redacted client-side; forward it verbatim under a
      // single namespaced key so it is searchable but clearly attributed.
      extra: {
        report_id: report.id,
        diagnostics: contextWithoutScreenshotData(report.context),
      },
    };
  }

  private buildEnvelope(
    event: Record<string, unknown>,
    attachment: ScreenshotAttachment | null,
  ): string | Uint8Array {
    const header = JSON.stringify({
      event_id: event.event_id,
      sent_at: this.now().toISOString(),
      dsn: this.rawDsn,
    });
    const itemHeader = JSON.stringify({ type: 'event' });
    const item = JSON.stringify(event);
    const eventEnvelope = `${header}\n${itemHeader}\n${item}\n`;
    if (!attachment) {
      return eventEnvelope;
    }
    const attachmentHeader = JSON.stringify({
      type: 'attachment',
      filename: attachment.filename,
      content_type: attachment.contentType,
      length: attachment.bytes.length,
    });
    return concatBytes([eventEnvelope, `${attachmentHeader}\n`, attachment.bytes, '\n']);
  }

  async deliver(report: FeedbackReport): Promise<DeliveryResult> {
    const event = this.buildEvent(report);
    const body = this.buildEnvelope(event, extractScreenshot(report.context));
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-sentry-envelope',
      'X-Sentry-Auth': [
        'Sentry sentry_version=7',
        'sentry_client=stash-feedback-bridge/1.0',
        `sentry_key=${this.dsn.publicKey}`,
      ].join(', '),
    };

    try {
      const res = await this.transport(this.dsn.envelopeUrl, {
        method: 'POST',
        headers,
        body,
      });
      if (!res.ok) {
        return {
          delivered: false,
          reason: `Sentry responded with status ${res.status}`,
        };
      }
      return { delivered: true, reference: String(event.event_id) };
    } catch (error) {
      return {
        delivered: false,
        reason: error instanceof Error ? error.message : 'Sentry request failed',
      };
    }
  }
}
