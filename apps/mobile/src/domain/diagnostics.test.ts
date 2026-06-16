import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildDiagnosticsContext, formatDiagnosticsReport } from './diagnostics.ts';

test('buildDiagnosticsContext includes the expected operational fields', () => {
  const context = buildDiagnosticsContext({
    appVersion: '1.2.3',
    platform: 'ios',
    osVersion: 'iOS 18.0',
    route: '/settings',
    authStatus: 'anonymous',
    queueDepth: 3,
    isSyncing: true,
    lastPulledAt: '2026-06-14T00:00:00.000Z',
    lastError: 'Network request failed',
  });

  assert.equal(context.appVersion, '1.2.3');
  assert.equal(context.platform, 'ios');
  assert.equal(context.osVersion, 'iOS 18.0');
  assert.equal(context.route, '/settings');
  assert.equal(context.authStatus, 'anonymous');
  assert.equal(context.queueDepth, 3);
  assert.equal(context.isSyncing, true);
  assert.equal(context.lastPulledAt, '2026-06-14T00:00:00.000Z');
  assert.equal(context.lastError, 'Network request failed');
  assert.equal(typeof context.capturedAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(context.capturedAt)));
});

test('buildDiagnosticsContext applies safe defaults for missing input', () => {
  const context = buildDiagnosticsContext();

  assert.equal(context.appVersion, 'unknown');
  assert.equal(context.platform, 'unknown');
  assert.equal(context.route, 'unknown');
  assert.equal(context.authStatus, 'not_configured');
  assert.equal(context.queueDepth, 0);
  assert.equal(context.isSyncing, false);
  assert.equal(context.lastPulledAt, null);
  assert.equal(context.osVersion, undefined);
  assert.equal(context.lastError, undefined);
});

test('buildDiagnosticsContext excludes user content — it only keeps known keys', () => {
  const context = buildDiagnosticsContext({
    appVersion: '1.0.0',
    platform: 'android',
    route: '/bookmark/123',
    // Anything resembling user content must be ignored: the builder reads only
    // its typed inputs, so injected extra fields never reach the context.
    ...({
      bookmarkUrl: 'https://secret.example.com/private',
      notes: 'my private note',
      title: 'Confidential title',
    } as Record<string, unknown>),
  });

  const serialized = JSON.stringify(context);
  assert.ok(!serialized.includes('secret.example.com'));
  assert.ok(!serialized.includes('private note'));
  assert.ok(!serialized.includes('Confidential title'));

  const allowedKeys = [
    'appVersion',
    'platform',
    'osVersion',
    'route',
    'authStatus',
    'queueDepth',
    'isSyncing',
    'lastPulledAt',
    'lastError',
    'build',
    'logs',
    'capturedAt',
  ];
  for (const key of Object.keys(context)) {
    assert.ok(allowedKeys.includes(key), `unexpected key in context: ${key}`);
  }
});

test('build and logs are included when provided and formatted for sharing', () => {
  const context = buildDiagnosticsContext({
    appVersion: '1.0.0',
    platform: 'android',
    build: 'main @ d0ae427',
    logs: ['2026-06-16T05:00:00Z [error] sqlite open failed: boom', '', 'kept'],
  });

  assert.equal(context.build, 'main @ d0ae427');
  // Empty lines are dropped.
  assert.deepEqual(context.logs, [
    '2026-06-16T05:00:00Z [error] sqlite open failed: boom',
    'kept',
  ]);

  const report = formatDiagnosticsReport(context);
  assert.match(report, /Stash diagnostics — main @ d0ae427/);
  assert.match(report, /Recent logs \(2\):/);
  assert.match(report, /sqlite open failed: boom/);
  // The logs array is rendered as a trailing block, not inside the JSON summary.
  assert.ok(!report.includes('"logs"'));
});

test('buildDiagnosticsContext normalizes invalid queue depth and truncates long errors', () => {
  const negative = buildDiagnosticsContext({ queueDepth: -5 });
  assert.equal(negative.queueDepth, 0);

  const fractional = buildDiagnosticsContext({ queueDepth: 2.9 });
  assert.equal(fractional.queueDepth, 2);

  const longError = 'x'.repeat(1000);
  const truncated = buildDiagnosticsContext({ lastError: longError });
  assert.equal(truncated.lastError?.length, 300);
});
