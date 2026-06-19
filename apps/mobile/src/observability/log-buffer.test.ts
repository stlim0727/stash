import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  clearLogEntries,
  formatLogEntries,
  getLogEntries,
  installConsoleCapture,
  onConsoleEntry,
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

test('recordLog notifies listeners directly (errors that bypass console reach the bridge)', () => {
  clearLogEntries();
  const notified: Array<{ level: string; args: unknown[] }> = [];
  const unsubscribe = onConsoleEntry((level, args) => notified.push({ level, args }));

  // e.g. repository.native.ts logs the SQLite-open failure via recordLog, not console.
  recordLog('error', 'sqlite open failed: boom');

  assert.equal(notified.length, 1);
  assert.equal(notified[0]!.level, 'error');
  // With no raw args, the message itself is forwarded.
  assert.deepEqual(notified[0]!.args, ['sqlite open failed: boom']);

  unsubscribe();
  recordLog('error', 'ignored after unsubscribe');
  assert.equal(notified.length, 1);
});

test('installConsoleCapture records calls, preserves output, and notifies listeners', () => {
  clearLogEntries();
  const seen: string[] = [];
  const fake = {
    log: (...a: unknown[]) => seen.push(`log:${a.join(' ')}`),
    info: () => {},
    warn: (...a: unknown[]) => seen.push(`warn:${a.join(' ')}`),
    error: () => {},
  } as unknown as Record<string, (...args: unknown[]) => void>;

  // installConsoleCapture is idempotent (patches once per process), so the
  // listener assertions live here, alongside the only install call in this file.
  const notified: Array<{ level: string; args: unknown[] }> = [];
  const unsubscribe = onConsoleEntry((level, args) => notified.push({ level, args }));

  installConsoleCapture(fake);
  const err = new Error('boom');
  fake.error('save failed', err);
  fake.warn('disk', 'failed');

  // Original still ran...
  assert.deepEqual(seen, ['warn:disk failed']);
  // ...it was captured into the buffer...
  assert.match(formatLogEntries(), /\[warn\] disk failed/);
  // ...and listeners got the raw args (the Error object survives, for stacks).
  assert.equal(notified.length, 2);
  assert.equal(notified[0]!.level, 'error');
  assert.equal(notified[0]!.args[1], err);

  // Unsubscribe stops further notifications.
  unsubscribe();
  fake.error('after unsubscribe');
  assert.equal(notified.length, 2);
});
