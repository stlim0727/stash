import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SentrySink, parseDsn } from './sentry-sink.ts';
import type { SentryTransport } from './sentry-sink.ts';
import { parseWebhookReport } from './sink.ts';
import type { FeedbackReport } from './sink.ts';

const DSN = 'https://abc123@o42.ingest.sentry.io/9876';

function report(overrides: Partial<FeedbackReport> = {}): FeedbackReport {
  return {
    id: 'report-1',
    user_id: 'user-1',
    category: 'bug',
    message: 'Sync spinner never stops',
    context: { route: '/inbox', queueDepth: 3, lastError: 'timeout' },
    app_version: '1.4.0',
    platform: 'ios',
    created_at: '2026-06-14T10:00:00.000Z',
    ...overrides,
  };
}

/** Records the single request a sink makes and returns a canned result. */
function fakeTransport(result = { ok: true, status: 200 }) {
  const calls: Array<{
    url: string;
    headers: Record<string, string>;
    body: string | Uint8Array;
  }> = [];
  const transport: SentryTransport = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return result;
  };
  return { transport, calls };
}

function makeSink(transport: SentryTransport) {
  return new SentrySink(DSN, {
    transport,
    newEventId: () => 'deadbeefdeadbeefdeadbeefdeadbeef',
    now: () => new Date('2026-06-14T10:00:01.000Z'),
  });
}

function bodyText(body: string | Uint8Array): string {
  return typeof body === 'string' ? body : new TextDecoder().decode(body);
}

test('parseDsn derives the envelope URL, key, and project id', () => {
  const parsed = parseDsn(DSN);
  assert.equal(parsed.publicKey, 'abc123');
  assert.equal(parsed.projectId, '9876');
  assert.equal(parsed.envelopeUrl, 'https://o42.ingest.sentry.io/api/9876/envelope/');
});

test('parseDsn rejects a malformed DSN', () => {
  assert.throws(() => parseDsn('not-a-dsn'));
  assert.throws(() => parseDsn('https://o42.ingest.sentry.io/9876')); // no key
});

test('buildEvent maps a report to a Sentry event with tags and redacted extra', () => {
  const event = makeSink(fakeTransport().transport).buildEvent(report());
  assert.equal(event.level, 'error'); // bug → error
  assert.equal((event.message as { formatted: string }).formatted, '[bug] Sync spinner never stops');
  assert.deepEqual(event.user, { id: 'user-1' });
  const tags = event.tags as Record<string, string>;
  assert.equal(tags.source, 'in-app-feedback');
  assert.equal(tags.category, 'bug');
  assert.equal(tags.screenshot, 'absent');
  assert.equal(tags.platform_os, 'ios');
  assert.equal(tags.app_version, '1.4.0');
  const extra = event.extra as { report_id: string; diagnostics: Record<string, unknown> };
  assert.equal(extra.report_id, 'report-1');
  assert.deepEqual(extra.diagnostics, { route: '/inbox', queueDepth: 3, lastError: 'timeout' });
});

test('ideas are informational, not errors', () => {
  const event = makeSink(fakeTransport().transport).buildEvent(report({ category: 'idea' }));
  assert.equal(event.level, 'info');
});

test('deliver posts a Sentry envelope and reports the event id (no real network)', async () => {
  const { transport, calls } = fakeTransport();
  const result = await makeSink(transport).deliver(report());

  assert.deepEqual(result, {
    delivered: true,
    reference: 'deadbeefdeadbeefdeadbeefdeadbeef',
  });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.url, 'https://o42.ingest.sentry.io/api/9876/envelope/');
  assert.match(call.headers['X-Sentry-Auth'], /sentry_key=abc123/);
  assert.equal(call.headers['Content-Type'], 'application/x-sentry-envelope');

  // Envelope = 3 newline-delimited JSON lines: header, item header, event.
  const lines = bodyText(call.body).trim().split('\n');
  assert.equal(lines.length, 3);
  const header = JSON.parse(lines[0]);
  assert.equal(header.event_id, 'deadbeefdeadbeefdeadbeefdeadbeef');
  assert.equal(header.sent_at, '2026-06-14T10:00:01.000Z');
  assert.equal(JSON.parse(lines[1]).type, 'event');
  assert.equal(JSON.parse(lines[2]).logger, 'feedback-bridge');
});

test('deliver surfaces a non-2xx Sentry response as not delivered', async () => {
  const { transport } = fakeTransport({ ok: false, status: 429 });
  const result = await makeSink(transport).deliver(report());
  assert.equal(result.delivered, false);
  assert.match(result.reason ?? '', /429/);
});

test('deliver catches transport errors and reports them', async () => {
  const transport: SentryTransport = async () => {
    throw new Error('network down');
  };
  const result = await makeSink(transport).deliver(report());
  assert.equal(result.delivered, false);
  assert.match(result.reason ?? '', /network down/);
});

test('parseWebhookReport reads the record from a Supabase webhook payload', () => {
  const parsed = parseWebhookReport({
    type: 'INSERT',
    table: 'feedback_reports',
    record: {
      id: 'r9',
      user_id: 'u9',
      category: 'idea',
      message: 'Dark mode please',
      context: { route: '/settings' },
      app_version: '1.4.0',
      platform: 'android',
      created_at: '2026-06-14T09:00:00.000Z',
    },
  });
  assert.equal(parsed.id, 'r9');
  assert.equal(parsed.category, 'idea');
  assert.equal(parsed.message, 'Dark mode please');
  assert.deepEqual(parsed.context, { route: '/settings' });
});

test('screenshot data is sent as an attachment and stripped from diagnostics extra', async () => {
  const { transport, calls } = fakeTransport();
  const result = await makeSink(transport).deliver(
    report({
      context: {
        route: '/settings',
        screenshot: {
          dataUrl: `data:image/jpeg;base64,${btoa('jpeg-bytes')}`,
          mimeType: 'image/jpeg',
          capturedAt: '2026-06-14T09:59:00.000Z',
          platform: 'web',
          surface: 'settings',
        },
      },
    }),
  );

  assert.equal(result.delivered, true);
  const body = bodyText(calls[0]!.body);
  const lines = body.trim().split('\n');
  assert.equal(lines.length, 5);
  const event = JSON.parse(lines[2]);
  assert.equal(
    event.extra.diagnostics.screenshot.dataUrl,
    '[redacted screenshot data]',
  );
  assert.equal(event.tags.screenshot, 'present');
  assert.equal(event.tags.screenshot_surface, 'settings');
  const attachmentHeader = JSON.parse(lines[3]);
  assert.equal(attachmentHeader.type, 'attachment');
  assert.equal(attachmentHeader.filename, 'feedback-screen.jpg');
  assert.equal(attachmentHeader.content_type, 'image/jpeg');
  assert.equal(lines[4], 'jpeg-bytes');
});

test('malformed screenshot base64 is ignored instead of failing delivery', async () => {
  const { transport, calls } = fakeTransport();
  const result = await makeSink(transport).deliver(
    report({
      context: {
        route: '/settings',
        screenshot: {
          dataUrl: 'data:image/jpeg;base64,%%%not-base64%%%',
          mimeType: 'image/jpeg',
          capturedAt: '2026-06-14T09:59:00.000Z',
          platform: 'web',
          surface: 'settings',
        },
      },
    }),
  );

  assert.equal(result.delivered, true);
  const lines = bodyText(calls[0]!.body).trim().split('\n');
  assert.equal(lines.length, 3);
  const event = JSON.parse(lines[2]);
  assert.equal(
    event.extra.diagnostics.screenshot.dataUrl,
    '[redacted screenshot data]',
  );
});

test('parseWebhookReport rejects payloads missing required fields', () => {
  assert.throws(() => parseWebhookReport({}));
  assert.throws(() => parseWebhookReport({ record: { id: 'x' } })); // no message
  assert.throws(() => parseWebhookReport(null));
});

test('parseWebhookReport defaults a missing/odd context to an empty object', () => {
  const parsed = parseWebhookReport({
    record: { id: 'r', user_id: 'u', message: 'hi' },
  });
  assert.deepEqual(parsed.context, {});
  assert.equal(parsed.category, 'other');
  assert.equal(parsed.app_version, null);
});
