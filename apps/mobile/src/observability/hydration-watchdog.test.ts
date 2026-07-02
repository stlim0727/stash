import assert from 'node:assert/strict';
import { test } from 'node:test';

import { armHydrationWatchdog, DEFAULT_HYDRATION_TIMEOUT_MS } from './hydration-watchdog.ts';

/** A manual clock: capture the scheduled callback and fire it on demand. */
function makeClock() {
  let pending: (() => void) | null = null;
  let scheduledMs: number | null = null;
  let cancelled = false;
  return {
    schedule(callback: () => void, ms: number) {
      pending = callback;
      scheduledMs = ms;
      return 'handle';
    },
    cancel(handle: unknown) {
      assert.equal(handle, 'handle');
      cancelled = true;
      pending = null;
    },
    fire() {
      pending?.();
    },
    get scheduledMs() {
      return scheduledMs;
    },
    get cancelled() {
      return cancelled;
    },
  };
}

test('reports once at the timeout, including the coarse phase detail', () => {
  const clock = makeClock();
  const reports: string[] = [];
  armHydrationWatchdog({
    timeoutMs: 500,
    describe: () => 'attempt 2: reading',
    schedule: clock.schedule,
    cancel: clock.cancel,
    report: (message) => reports.push(message),
  });

  assert.equal(clock.scheduledMs, 500);
  clock.fire();

  assert.equal(reports.length, 1);
  assert.match(reports[0]!, /still incomplete after 500ms/);
  assert.match(reports[0]!, /attempt 2: reading/);
  assert.match(reports[0]!, /reporting only/);
});

test('disarm before the timeout cancels the timer and never reports', () => {
  const clock = makeClock();
  const reports: string[] = [];
  const disarm = armHydrationWatchdog({
    timeoutMs: 500,
    schedule: clock.schedule,
    cancel: clock.cancel,
    report: (message) => reports.push(message),
  });

  disarm();
  assert.equal(clock.cancelled, true);

  clock.fire(); // a stray fire after disarm must stay silent
  assert.equal(reports.length, 0);
});

test('fires at most once and disarm after firing is a safe no-op', () => {
  const clock = makeClock();
  const reports: string[] = [];
  const disarm = armHydrationWatchdog({
    timeoutMs: 500,
    schedule: clock.schedule,
    cancel: clock.cancel,
    report: (message) => reports.push(message),
  });

  clock.fire();
  clock.fire(); // second fire is guarded
  assert.equal(reports.length, 1);

  disarm(); // disarm after the report already fired must not cancel/throw
  assert.equal(clock.cancelled, false);
});

test('omits the detail suffix when no describe() is provided', () => {
  const clock = makeClock();
  const reports: string[] = [];
  armHydrationWatchdog({
    timeoutMs: 500,
    schedule: clock.schedule,
    cancel: clock.cancel,
    report: (message) => reports.push(message),
  });

  clock.fire();
  assert.equal(reports.length, 1);
  // With a describe() the message reads "...not settled (phase); ..."; without
  // one the phase parenthetical is gone and "not settled" runs straight into
  // the semicolon.
  assert.match(reports[0]!, /not settled;/);
  assert.doesNotMatch(reports[0]!, /attempt/);
});

test('defaults to a generous 10s bound so a slow-but-fine start never trips', () => {
  const clock = makeClock();
  armHydrationWatchdog({ schedule: clock.schedule, cancel: clock.cancel, report: () => {} });
  assert.equal(clock.scheduledMs, DEFAULT_HYDRATION_TIMEOUT_MS);
  assert.equal(DEFAULT_HYDRATION_TIMEOUT_MS, 10_000);
});
