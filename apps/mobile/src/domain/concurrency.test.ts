import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createConcurrencyLimiter } from './concurrency.ts';

/** A task that resolves only when the test releases it, tracking in-flight count. */
function makeControlledTasks(counts: { active: number; max: number }) {
  const releases: (() => void)[] = [];
  const make = () => () => {
    counts.active += 1;
    counts.max = Math.max(counts.max, counts.active);
    return new Promise<void>((resolve) => {
      releases.push(() => {
        counts.active -= 1;
        resolve();
      });
    });
  };
  return { make, releases };
}

test('never runs more than `limit` tasks at once across a large burst', async () => {
  const run = createConcurrencyLimiter(3);
  const counts = { active: 0, max: 0 };
  const { make, releases } = makeControlledTasks(counts);

  // The STASH-3B shape: a 50-task burst submitted synchronously in one loop.
  const settled = Promise.all(Array.from({ length: 50 }, () => run(make())));
  await Promise.resolve();
  assert.equal(counts.max, 3);

  // Drain one at a time; the in-flight count must never exceed the limit.
  while (releases.length > 0) {
    releases.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(counts.active <= 3, `active ${counts.active} exceeded limit`);
  }
  await settled;
  assert.equal(counts.max, 3);
  assert.equal(counts.active, 0);
});

test('queued tasks start in submission order (FIFO)', async () => {
  const run = createConcurrencyLimiter(1);
  const started: number[] = [];
  const done = Promise.all(
    [0, 1, 2, 3].map((i) =>
      run(async () => {
        started.push(i);
      }),
    ),
  );
  await done;
  assert.deepEqual(started, [0, 1, 2, 3]);
});

test('a rejected task frees its slot and propagates to its caller only', async () => {
  const run = createConcurrencyLimiter(1);
  const failing = run(async () => {
    throw new Error('boom');
  });
  const after = run(async () => 'ran');

  await assert.rejects(failing, /boom/);
  // The queue is not stalled by the rejection — the next task still runs.
  assert.equal(await after, 'ran');
});

test('resolves with each task result and accepts new tasks after draining', async () => {
  const run = createConcurrencyLimiter(2);
  const first = await Promise.all([run(async () => 1), run(async () => 2), run(async () => 3)]);
  assert.deepEqual(first, [1, 2, 3]);
  assert.equal(await run(async () => 'again'), 'again');
});

test('a slot freed mid-burst is handed to the queued waiter, not double-filled', async () => {
  // Regression shape for the release/acquire race: with limit 2 and a waiter
  // queued, finishing one task while a NEW task is submitted in the same tick
  // must not let both start (that would make 3 in flight).
  const run = createConcurrencyLimiter(2);
  const counts = { active: 0, max: 0 };
  const { make, releases } = makeControlledTasks(counts);

  const a = run(make());
  const b = run(make());
  const waiter = run(make());
  releases.shift()!(); // finish `a`, freeing a slot with `waiter` queued
  const late = run(make()); // new submission racing the hand-off
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(counts.max <= 2, `active peaked at ${counts.max}`);

  while (releases.length > 0) {
    releases.shift()!();
    await Promise.resolve();
    await Promise.resolve();
  }
  await Promise.all([a, b, waiter, late]);
  assert.equal(counts.max, 2);
});
