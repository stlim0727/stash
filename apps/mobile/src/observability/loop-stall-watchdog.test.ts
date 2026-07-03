import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  armLoopStallWatchdog,
  DEFAULT_LOOP_STALL_INTERVAL_MS,
  DEFAULT_LOOP_STALL_THRESHOLD_MS,
} from './loop-stall-watchdog.ts';

/**
 * A manual clock: a virtual `now`, plus a single outstanding scheduled tick we
 * fire on demand. `set(ms)` moves virtual time so the next `fire()` observes a
 * chosen overshoot (that overshoot is what the watchdog reads as a stall).
 */
function makeClock() {
  let currentMs = 0;
  let pending: (() => void) | null = null;
  return {
    now: () => currentMs,
    schedule(callback: () => void, _ms: number) {
      pending = callback;
      return 'handle';
    },
    cancel(handle: unknown) {
      assert.equal(handle, 'handle');
      pending = null;
    },
    /** Move virtual time to an absolute ms. */
    set(ms: number) {
      currentMs = ms;
    },
    /** Fire the outstanding tick, if any. */
    fire() {
      pending?.();
    },
    get pending() {
      return pending;
    },
  };
}

const TUNABLES = {
  intervalMs: 1_000,
  thresholdMs: 3_000,
  cooldownMs: 5_000,
  backgroundSuspicionMs: 100_000,
};

test('a healthy loop (ticks arrive on time) never reports', () => {
  const clock = makeClock();
  const reports: string[] = [];
  armLoopStallWatchdog({
    ...TUNABLES,
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    report: (m) => reports.push(m),
  });

  // Fire several ticks each exactly one interval apart → zero overshoot.
  for (let t = 1_000; t <= 5_000; t += 1_000) {
    clock.set(t);
    clock.fire();
  }
  assert.equal(reports.length, 0);
});

test('one stall reports exactly once, with the measured ms and coarse detail', () => {
  const clock = makeClock();
  const reports: string[] = [];
  armLoopStallWatchdog({
    ...TUNABLES,
    describe: () => 'syncing=false queue=0',
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    report: (m) => reports.push(m),
  });

  clock.set(5_000); // tick due at 1000 arrives at 5000 → 4000ms overshoot
  clock.fire();

  assert.equal(reports.length, 1);
  assert.match(reports[0]!, /stalled ~4000ms/);
  assert.match(reports[0]!, /reporting only/);
  assert.match(reports[0]!, /syncing=false queue=0/);
  assert.match(reports[0]!, /cannot be captured/);
});

test('a second stall within the cooldown is suppressed; one after it reports again', () => {
  const clock = makeClock();
  const reports: string[] = [];
  armLoopStallWatchdog({
    ...TUNABLES,
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    report: (m) => reports.push(m),
  });

  clock.set(5_000); // stall #1 (delta 4000) → report
  clock.fire();
  assert.equal(reports.length, 1);

  clock.set(9_001); // rescheduled to 6000; delta 3001 but only 4001ms since report
  clock.fire();
  assert.equal(reports.length, 1, 'within cooldown → suppressed');

  clock.set(14_001); // rescheduled to 10001; delta 4000 and 9001ms since report
  clock.fire();
  assert.equal(reports.length, 2, 'past cooldown → reports again');
});

test('an implausibly late tick is treated as OS suspension, not a stall', () => {
  const clock = makeClock();
  const reports: string[] = [];
  const suspensions: string[] = [];
  armLoopStallWatchdog({
    ...TUNABLES,
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    report: (m) => reports.push(m),
    reportSuspension: (m) => suspensions.push(m),
  });

  clock.set(200_000); // way past backgroundSuspicionMs (100000)
  clock.fire();

  assert.equal(reports.length, 0);
  assert.equal(suspensions.length, 1);
  assert.match(suspensions[0]!, /OS suspension/);
});

test('pause cancels the pending tick and resume rebaselines so the gap is not a stall', () => {
  const clock = makeClock();
  const reports: string[] = [];
  const watchdog = armLoopStallWatchdog({
    ...TUNABLES,
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    report: (m) => reports.push(m),
  });

  watchdog.pause();
  assert.equal(clock.pending, null, 'pause cancels the outstanding tick');

  clock.set(500_000); // a long time asleep
  watchdog.resume();
  clock.set(501_000); // next tick one interval after resume → zero overshoot
  clock.fire();

  assert.equal(reports.length, 0, 'the paused gap must not be reported as a stall');
});

test('disarm stops future ticks and is a safe idempotent no-op', () => {
  const clock = makeClock();
  const reports: string[] = [];
  const watchdog = armLoopStallWatchdog({
    ...TUNABLES,
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    report: (m) => reports.push(m),
  });

  clock.fire(); // first tick reschedules
  watchdog.disarm();
  assert.equal(clock.pending, null);

  clock.set(500_000);
  clock.fire(); // a stray already-queued tick after disarm stays silent
  watchdog.disarm(); // double-disarm must not throw
  assert.equal(reports.length, 0);
});

test('omits the detail suffix when no describe() is provided', () => {
  const clock = makeClock();
  const reports: string[] = [];
  armLoopStallWatchdog({
    ...TUNABLES,
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    report: (m) => reports.push(m),
  });

  clock.set(5_000);
  clock.fire();
  assert.equal(reports.length, 1);
  // With describe() the message reads "...frozen (detail); ..."; without one the
  // parenthetical is gone and "frozen" runs straight into the semicolon.
  assert.match(reports[0]!, /frozen; /);
  assert.doesNotMatch(reports[0]!, /frozen \(/);
});

test('exposes generous, deliberately-chosen defaults', () => {
  assert.equal(DEFAULT_LOOP_STALL_INTERVAL_MS, 1_000);
  assert.equal(DEFAULT_LOOP_STALL_THRESHOLD_MS, 3_000);
});
