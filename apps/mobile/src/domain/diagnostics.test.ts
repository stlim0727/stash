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
    'recentSlowSegments',
    'storage',
    'shareAttempt',
    'pullHistory',
    'aiQuota',
    'capturedAt',
  ];
  for (const key of Object.keys(context)) {
    assert.ok(allowedKeys.includes(key), `unexpected key in context: ${key}`);
  }
});

test('buildDiagnosticsContext includes structured storage diagnostics when provided', () => {
  const context = buildDiagnosticsContext({
    storage: {
      sqlitePreflight: {
        directoryApi: 'function',
        fileApi: 'function',
        documentRoot: 'string',
        lastStep: 'fallback',
        lastError: 'TypeError: undefined is not a function',
        updatedAt: '2026-07-13T02:30:56.063Z',
      },
      sqliteOpen: {
        phase: 'preflight',
        error: 'TypeError: undefined is not a function',
        updatedAt: '2026-07-13T02:30:56.064Z',
      },
    },
  });

  assert.equal(context.storage?.sqlitePreflight?.lastStep, 'fallback');
  assert.equal(context.storage?.sqliteOpen?.phase, 'preflight');

  const report = formatDiagnosticsReport(context);
  assert.match(report, /"storage"/);
  assert.match(report, /"sqliteOpen"/);
});

test('buildDiagnosticsContext includes the durable last share-attempt record when provided', () => {
  const context = buildDiagnosticsContext({
    shareAttempt: {
      hasUrl: false,
      hasText: false,
      hasImage: false,
      fileCount: 0,
      fileMimeTypes: [],
      result: 'invalid',
      updatedAt: '2026-07-13T11:30:00.000Z',
    },
  });

  assert.equal(context.shareAttempt?.result, 'invalid');
  assert.equal(context.shareAttempt?.hasUrl, false);

  const report = formatDiagnosticsReport(context);
  assert.match(report, /"shareAttempt"/);
});

test('buildDiagnosticsContext includes the durable recent-pulls history when provided', () => {
  const context = buildDiagnosticsContext({
    pullHistory: [
      {
        since: null,
        fullRefreshReason: null,
        remoteRowCount: 0,
        outcome: 'failure',
        errorMessage: 'Pull stopped because sync was paused.',
        durationMs: 42,
        timestamp: '2026-07-13T11:30:00.000Z',
      },
    ],
  });

  assert.equal(context.pullHistory?.length, 1);
  assert.equal(context.pullHistory?.[0]?.outcome, 'failure');

  const report = formatDiagnosticsReport(context);
  assert.match(report, /"pullHistory"/);
});

test('buildDiagnosticsContext omits an empty/absent pullHistory', () => {
  assert.equal(buildDiagnosticsContext({ pullHistory: [] }).pullHistory, undefined);
  assert.equal(buildDiagnosticsContext({}).pullHistory, undefined);
});

test('buildDiagnosticsContext includes the active AI-quota cooldown when provided', () => {
  const context = buildDiagnosticsContext({
    aiQuota: { reason: 'daily_limit', resetAt: '2026-08-02T05:41:00.000Z' },
  });

  assert.deepEqual(context.aiQuota, {
    reason: 'daily_limit',
    resetAt: '2026-08-02T05:41:00.000Z',
  });

  const report = formatDiagnosticsReport(context);
  assert.match(report, /"aiQuota"/);
  assert.match(report, /daily_limit/);
});

test('buildDiagnosticsContext omits aiQuota when no cooldown is active', () => {
  const noInput = buildDiagnosticsContext({});
  assert.equal(noInput.aiQuota, undefined);

  const explicitNull = buildDiagnosticsContext({ aiQuota: null });
  assert.equal(explicitNull.aiQuota, undefined);
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
  assert.match(report, /Keepory diagnostics — main @ d0ae427/);
  assert.match(report, /Recent logs \(2\):/);
  assert.match(report, /sqlite open failed: boom/);
  // The logs array is rendered as a trailing block, not inside the JSON summary.
  assert.ok(!report.includes('"logs"'));
});

test('recentSlowSegments is included when provided and omitted when blank', () => {
  const withSegments = buildDiagnosticsContext({
    recentSlowSegments: 'graph-layout 820ms 300ms ago',
  });
  assert.equal(withSegments.recentSlowSegments, 'graph-layout 820ms 300ms ago');

  const report = formatDiagnosticsReport(withSegments);
  assert.match(report, /"recentSlowSegments"/);
  assert.match(report, /graph-layout 820ms/);

  const blank = buildDiagnosticsContext({ recentSlowSegments: '' });
  assert.equal(blank.recentSlowSegments, undefined);

  const missing = buildDiagnosticsContext({});
  assert.equal(missing.recentSlowSegments, undefined);
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
