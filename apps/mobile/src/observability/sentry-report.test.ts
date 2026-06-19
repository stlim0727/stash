import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildConsoleErrorReport, scrubText } from './sentry-report.ts';

test('scrubText redacts URLs and emails (privacy: never send content)', () => {
  assert.equal(scrubText('failed to fetch https://example.com/secret?x=1'), 'failed to fetch [url]');
  assert.equal(scrubText('mail user@example.com now'), 'mail [email] now');
  assert.equal(scrubText('no sensitive data here'), 'no sensitive data here');
});

test('buildConsoleErrorReport returns null for nothing meaningful', () => {
  assert.equal(buildConsoleErrorReport([]), null);
  assert.equal(buildConsoleErrorReport(['   ']), null);
});

test('buildConsoleErrorReport keeps the Error name/stack and scrubs both', () => {
  const err = new Error('boom while loading https://example.com/page');
  err.name = 'StorageError';
  const report = buildConsoleErrorReport(['save failed', err]);

  assert.ok(report);
  assert.equal(report.hadError, true);
  assert.equal(report.name, 'StorageError');
  // Message is built from all args and scrubbed.
  assert.match(report.message, /save failed/);
  assert.match(report.message, /StorageError: boom while loading \[url\]/);
  assert.doesNotMatch(report.message, /example\.com/);
  // Stack is carried over for grouping, also scrubbed.
  assert.ok(report.stack);
  assert.doesNotMatch(report.stack ?? '', /example\.com/);
});

test('buildConsoleErrorReport handles plain string logs (no Error object)', () => {
  const report = buildConsoleErrorReport(['something went wrong']);
  assert.ok(report);
  assert.equal(report.hadError, false);
  assert.equal(report.name, 'ConsoleError');
  assert.equal(report.message, 'something went wrong');
  assert.equal(report.stack, undefined);
});
