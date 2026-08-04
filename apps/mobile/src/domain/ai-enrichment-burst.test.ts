import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AI_ENRICHMENT_BURST_TOAST_MIN,
  EMPTY_AI_ENRICHMENT_BURST_QUEUE,
  clearBurstCompletion,
  dequeueAiEnrichmentDispatch,
  dropAiEnrichmentDispatchIds,
  enqueueAiEnrichmentDispatch,
  isBurstComplete,
  recordAiEnrichmentDispatchSettled,
} from './ai-enrichment-burst.ts';

test('enqueue adds ids in order and is idempotent', () => {
  let queue = enqueueAiEnrichmentDispatch(EMPTY_AI_ENRICHMENT_BURST_QUEUE, 'a');
  queue = enqueueAiEnrichmentDispatch(queue, 'b');
  assert.deepEqual(queue.pending, ['a', 'b']);

  const before = queue;
  queue = enqueueAiEnrichmentDispatch(queue, 'a'); // already queued
  assert.equal(queue, before); // same reference — no-op
  assert.deepEqual(queue.pending, ['a', 'b']);
});

test('dequeue pops oldest first and reports null on an empty queue', () => {
  let queue = enqueueAiEnrichmentDispatch(EMPTY_AI_ENRICHMENT_BURST_QUEUE, 'a');
  queue = enqueueAiEnrichmentDispatch(queue, 'b');

  const first = dequeueAiEnrichmentDispatch(queue);
  assert.equal(first.id, 'a');
  assert.deepEqual(first.queue.pending, ['b']);

  const second = dequeueAiEnrichmentDispatch(first.queue);
  assert.equal(second.id, 'b');
  assert.deepEqual(second.queue.pending, []);

  const third = dequeueAiEnrichmentDispatch(second.queue);
  assert.equal(third.id, null);
  assert.equal(third.queue, second.queue); // same reference on empty
});

test('a burst is not "complete" until the queue drains AND something settled', () => {
  let queue = enqueueAiEnrichmentDispatch(EMPTY_AI_ENRICHMENT_BURST_QUEUE, 'a');
  assert.equal(isBurstComplete(queue), false); // still pending

  const { queue: drained } = dequeueAiEnrichmentDispatch(queue);
  assert.equal(isBurstComplete(drained), false); // drained but nothing settled yet

  const settled = recordAiEnrichmentDispatchSettled(drained);
  assert.equal(isBurstComplete(settled), true);
});

test('a fresh arrival mid-drain keeps the burst incomplete until it drains too', () => {
  // Simulates: id 'a' dequeued and dispatched, then a fresh capture enqueues
  // 'b' before 'a' settles.
  let queue = enqueueAiEnrichmentDispatch(EMPTY_AI_ENRICHMENT_BURST_QUEUE, 'a');
  const dequeueA = dequeueAiEnrichmentDispatch(queue);
  queue = enqueueAiEnrichmentDispatch(dequeueA.queue, 'b');
  queue = recordAiEnrichmentDispatchSettled(queue); // 'a' settles
  assert.equal(isBurstComplete(queue), false); // 'b' still pending

  const dequeueB = dequeueAiEnrichmentDispatch(queue);
  queue = recordAiEnrichmentDispatchSettled(dequeueB.queue);
  assert.equal(isBurstComplete(queue), true);
  assert.equal(queue.completedInBurst, 2);
});

test('clearBurstCompletion resets the counter and is a no-op at zero', () => {
  let queue = enqueueAiEnrichmentDispatch(EMPTY_AI_ENRICHMENT_BURST_QUEUE, 'a');
  queue = dequeueAiEnrichmentDispatch(queue).queue;
  queue = recordAiEnrichmentDispatchSettled(queue);
  assert.equal(queue.completedInBurst, 1);

  queue = clearBurstCompletion(queue);
  assert.equal(queue.completedInBurst, 0);

  const before = queue;
  queue = clearBurstCompletion(queue);
  assert.equal(queue, before); // same reference — nothing to clear
});

test('AI_ENRICHMENT_BURST_TOAST_MIN gates single, routine completions out of the toast', () => {
  // A lone bookmark settling is not a "burst" worth announcing.
  assert.ok(AI_ENRICHMENT_BURST_TOAST_MIN >= 2);
});

test('dropAiEnrichmentDispatchIds removes a stale id left behind by an account switch (STASH-4Y)', () => {
  // Reproduces: account A stages a bookmark for staggered auto-dispatch, then
  // the user switches to account B before the drain loop pops it. Without the
  // drop, A's bookmark id keeps counting toward B's pipeline total.
  let queue = enqueueAiEnrichmentDispatch(EMPTY_AI_ENRICHMENT_BURST_QUEUE, 'a-bookmark');
  queue = enqueueAiEnrichmentDispatch(queue, 'a-other-bookmark');
  queue = enqueueAiEnrichmentDispatch(queue, 'b-bookmark'); // already B's, e.g. rehomed

  queue = dropAiEnrichmentDispatchIds(queue, ['a-bookmark', 'a-other-bookmark']);
  assert.deepEqual(queue.pending, ['b-bookmark']);
});

test('dropAiEnrichmentDispatchIds zeroes completedInBurst so account A\'s settled count cannot surface in account B\'s toast', () => {
  // Reproduces: account A enqueues 3 items, 2 settle (completedInBurst = 2,
  // still below AI_ENRICHMENT_BURST_TOAST_MIN's threshold — no toast yet),
  // then the user switches to account B before the 3rd drains. Without
  // zeroing, B enqueueing and settling just 1 of its own bookmarks would push
  // completedInBurst to 3 and fire a completion toast under B that's really
  // reporting A's dispatches.
  let queue = enqueueAiEnrichmentDispatch(EMPTY_AI_ENRICHMENT_BURST_QUEUE, 'a-1');
  queue = enqueueAiEnrichmentDispatch(queue, 'a-2');
  queue = enqueueAiEnrichmentDispatch(queue, 'a-3');
  queue = dequeueAiEnrichmentDispatch(queue).queue; // 'a-1' dispatched
  queue = recordAiEnrichmentDispatchSettled(queue);
  queue = dequeueAiEnrichmentDispatch(queue).queue; // 'a-2' dispatched
  queue = recordAiEnrichmentDispatchSettled(queue);
  assert.equal(queue.completedInBurst, 2);
  assert.deepEqual(queue.pending, ['a-3']);

  queue = dropAiEnrichmentDispatchIds(queue, ['a-3']); // account switch drops what's left of A
  assert.equal(queue.completedInBurst, 0);
  assert.deepEqual(queue.pending, []);

  queue = enqueueAiEnrichmentDispatch(queue, 'b-1');
  queue = dequeueAiEnrichmentDispatch(queue).queue;
  queue = recordAiEnrichmentDispatchSettled(queue);
  assert.equal(queue.completedInBurst, 1); // not 3 — A's settled count didn't carry over
  assert.equal(isBurstComplete(queue), true); // drained, but below the toast minimum
});

test('dropAiEnrichmentDispatchIds is a no-op (same reference) when nothing pending matches', () => {
  let queue = enqueueAiEnrichmentDispatch(EMPTY_AI_ENRICHMENT_BURST_QUEUE, 'b-bookmark');
  const before = queue;

  queue = dropAiEnrichmentDispatchIds(queue, ['a-bookmark']);
  assert.equal(queue, before);

  queue = dropAiEnrichmentDispatchIds(queue, []);
  assert.equal(queue, before);

  queue = dropAiEnrichmentDispatchIds(EMPTY_AI_ENRICHMENT_BURST_QUEUE, ['a-bookmark']);
  assert.equal(queue, EMPTY_AI_ENRICHMENT_BURST_QUEUE);
});
