import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  clearLogEntries,
  formatLogEntries,
  getLogEntries,
  installConsoleCapture,
  recordLog,
  stringifyArg,
} from './log-buffer.ts';

afterEach(clearLogEntries);

test('records entries and formats them as lines', () => {
  clearLogEntries();
  recordLog('warn', 'first');
  recordLog('error', 'second');

  const entries = getLogEntries();
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.level, 'warn');
  assert.equal(entries[1]!.message, 'second');
  assert.match(formatLogEntries(), /\[warn\] first/);
  assert.match(formatLogEntries(), /\[error\] second/);
});

test('caps the buffer so it cannot grow without bound', () => {
  clearLogEntries();
  for (let i = 0; i < 350; i += 1) {
    recordLog('log', `line ${i}`);
  }
  const entries = getLogEntries();
  assert.equal(entries.length, 300);
  // Oldest were dropped; the newest survives.
  assert.equal(entries[entries.length - 1]!.message, 'line 349');
});

test('stringifyArg handles strings, errors and objects', () => {
  assert.equal(stringifyArg('hello'), 'hello');
  assert.match(stringifyArg(new Error('boom')), /^Error: boom/);
  assert.equal(stringifyArg({ a: 1 }), '{"a":1}');
});

test('installConsoleCapture records calls and preserves original output', () => {
  clearLogEntries();
  const seen: string[] = [];
  const fake = {
    log: (...a: unknown[]) => seen.push(`log:${a.join(' ')}`),
    info: () => {},
    warn: (...a: unknown[]) => seen.push(`warn:${a.join(' ')}`),
    error: () => {},
  } as unknown as Record<string, (...args: unknown[]) => void>;

  installConsoleCapture(fake);
  fake.warn('disk', 'failed');

  // Original still ran...
  assert.deepEqual(seen, ['warn:disk failed']);
  // ...and it was captured.
  assert.match(formatLogEntries(), /\[warn\] disk failed/);
});
