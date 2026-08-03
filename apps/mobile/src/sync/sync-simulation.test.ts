import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DeterministicSimulation,
  runSeededEvents,
  seededEventOrder,
  type SimulationEvent,
} from '@/__tests__/helpers/deterministic-simulation';

interface SyncRunnerState {
  activeRuns: number;
  maxActiveRuns: number;
  pending: boolean;
  completedRuns: number;
}

test('simulation: repeated sync triggers coalesce without concurrent execution', async () => {
  const state: SyncRunnerState = {
    activeRuns: 0,
    maxActiveRuns: 0,
    pending: false,
    completedRuns: 0,
  };
  const simulation = new DeterministicSimulation(
    () => state,
    ({ state: current }) => {
      assert.ok(current.activeRuns <= 1, 'more than one sync run became active');
      assert.ok(current.completedRuns <= 2, 'coalesced triggers started too many runs');
    },
  );

  const triggerSync = async () => {
    if (state.activeRuns > 0) {
      state.pending = true;
      return;
    }

    state.activeRuns += 1;
    state.maxActiveRuns = Math.max(state.maxActiveRuns, state.activeRuns);
    do {
      state.pending = false;
      if (state.completedRuns === 0) {
        await simulation.waitAt('first-sync-upload');
      }
      state.completedRuns += 1;
    } while (state.pending);
    state.activeRuns -= 1;
  };

  simulation.spawn('initial-sync', triggerSync);
  await simulation.waitUntilReached('first-sync-upload');
  await simulation.step('realtime-nudge', triggerSync);
  await simulation.step('queue-change-nudge', triggerSync);
  await simulation.step('login-nudge', triggerSync);
  simulation.release('first-sync-upload');
  await simulation.join('initial-sync');
  await simulation.finish();

  assert.equal(state.maxActiveRuns, 1);
  assert.equal(state.completedRuns, 2);
  assert.equal(state.pending, false);
  assert.deepEqual(
    simulation.trace.filter((entry) => entry.startsWith('barrier:')),
    [
      'barrier:first-sync-upload:reached',
      'barrier:first-sync-upload:released',
      'barrier:first-sync-upload:passed',
    ],
  );
});

interface RestoreState {
  localBookmark: boolean;
  uploadIntent: boolean;
  remoteBookmark: boolean;
  enrichmentUploaded: boolean;
  processGeneration: number;
}

test('simulation: a process restart re-drives durable restore work', async () => {
  const durable: RestoreState = {
    localBookmark: false,
    uploadIntent: false,
    remoteBookmark: false,
    enrichmentUploaded: false,
    processGeneration: 1,
  };
  let processAlive = true;
  const simulation = new DeterministicSimulation(
    () => durable,
    ({ state }) => {
      assert.ok(!state.enrichmentUploaded || state.remoteBookmark);
      assert.ok(!state.remoteBookmark || state.localBookmark);
    },
  );

  await simulation.step('persist-local-bookmark', () => {
    durable.localBookmark = true;
  });
  await simulation.step('persist-upload-intent', () => {
    durable.uploadIntent = true;
  });

  simulation.spawn('first-upload', async () => {
    await simulation.waitAt('remote-create');
    if (!processAlive) {
      return;
    }
    durable.remoteBookmark = true;
    durable.uploadIntent = false;
  });
  await simulation.waitUntilReached('remote-create');
  await simulation.step('process-death', () => {
    processAlive = false;
  });
  simulation.release('remote-create');
  await simulation.join('first-upload');

  assert.equal(durable.remoteBookmark, false);
  assert.equal(durable.uploadIntent, true);

  await simulation.step('process-restart', () => {
    processAlive = true;
    durable.processGeneration += 1;
  });
  await simulation.step('retry-bookmark-upload', () => {
    durable.remoteBookmark = true;
    durable.uploadIntent = false;
  });
  await simulation.step('upload-enrichment-snapshot', () => {
    durable.enrichmentUploaded = true;
  });
  await simulation.finish();

  assert.deepEqual(durable, {
    localBookmark: true,
    uploadIntent: false,
    remoteBookmark: true,
    enrichmentUploaded: true,
    processGeneration: 2,
  });
});

test('simulation: seeded event ordering is reproducible', async () => {
  const labels: string[] = [];
  const events: SimulationEvent<{ labels: string[] }>[] = ['metadata', 'upload', 'pull', 'realtime'].map(
    (label) => ({
      label,
      run: () => {
        labels.push(label);
      },
    }),
  );

  const firstOrder = seededEventOrder(events, 671).map((event) => event.label);
  const secondOrder = seededEventOrder(events, 671).map((event) => event.label);
  assert.deepEqual(firstOrder, secondOrder);

  const simulation = new DeterministicSimulation(() => ({ labels: [...labels] }), undefined, 671);
  await runSeededEvents(simulation, events);
  assert.deepEqual(labels, firstOrder);
});

test('simulation: invariant failures include seed, trace, and state', async () => {
  const state = { queueEntries: 1, remoteRows: 0 };
  const simulation = new DeterministicSimulation(
    () => state,
    ({ state: current }) => {
      assert.ok(current.queueEntries > 0 || current.remoteRows > 0, 'durable create was orphaned');
    },
    673,
  );

  await assert.rejects(
    () =>
      simulation.step('drop-upload-intent', () => {
        state.queueEntries = 0;
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /durable create was orphaned/);
      assert.match(error.message, /seed: 673/);
      assert.match(error.message, /step:drop-upload-intent:complete/);
      assert.match(error.message, /"queueEntries": 0/);
      return true;
    },
  );
});

test('simulation: finish drains tasks spawned by running tasks', async () => {
  const state = { childCompleted: false };
  const simulation = new DeterministicSimulation(() => state);

  simulation.spawn('parent', () => {
    simulation.spawn('child', async () => {
      await simulation.waitAt('child-work');
      state.childCompleted = true;
    });
  });

  let didFinish = false;
  const finishing = simulation.finish().then(() => {
    didFinish = true;
  });
  await simulation.waitUntilReached('child-work');
  assert.equal(didFinish, false);
  simulation.release('child-work');
  await finishing;

  assert.equal(state.childCompleted, true);
  assert.equal(simulation.checkpoints.at(-1)?.label, 'finish');
});

test('simulation: barrier waits surface a producer task failure', async () => {
  const simulation = new DeterministicSimulation(() => ({ ready: false }), undefined, 675);
  simulation.spawn('producer', () => {
    throw new Error('dependency failed before barrier');
  });

  await assert.rejects(
    () => simulation.waitUntilReached('never-reached'),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /dependency failed before barrier/);
      assert.match(error.message, /task:producer:failed/);
      assert.match(error.message, /seed: 675/);
      return true;
    },
  );
});

test('simulation: every rejection value fails a joined task', async () => {
  const simulation = new DeterministicSimulation(() => ({ pending: true }));
  simulation.spawn('null-rejection', () => Promise.reject(null));

  await assert.rejects(() => simulation.finish(), /null/);
});

test('simulation: reaching a barrier checks transient state invariants', async () => {
  const state = { activeRuns: 0 };
  const simulation = new DeterministicSimulation(
    () => state,
    ({ state: current }) => {
      assert.ok(current.activeRuns <= 1, 'concurrent sync runs observed at barrier');
    },
  );

  simulation.spawn('sync', async () => {
    state.activeRuns = 2;
    await simulation.waitAt('upload');
    state.activeRuns = 1;
  });

  await assert.rejects(
    () => simulation.waitUntilReached('upload'),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /concurrent sync runs observed at barrier/);
      assert.match(error.message, /checkpoint: barrier:upload/);
      assert.match(error.message, /"activeRuns": 2/);
      return true;
    },
  );
});

test('simulation: an unreleased barrier fails with bounded diagnostics', async () => {
  const simulation = new DeterministicSimulation(
    () => ({ waiting: true }),
    undefined,
    675,
    20,
  );
  simulation.spawn('stuck-upload', () => simulation.waitAt('upload-response'));
  await simulation.waitUntilReached('upload-response');

  await assert.rejects(
    () => simulation.finish(),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /simulation barrier was not released within 20ms/);
      assert.match(error.message, /upload-response/);
      assert.match(error.message, /seed: 675/);
      assert.match(error.message, /barrier:upload-response:reached/);
      return true;
    },
  );
});

test('simulation: unclonable state preserves the original invariant failure', async () => {
  const state = { count: 1, callback: () => undefined };
  const simulation = new DeterministicSimulation(
    () => state,
    ({ state: current }) => {
      assert.equal(current.count, 0, 'count should never exceed zero');
    },
  );

  await assert.rejects(
    () => simulation.step('inspect-unclonable-state', () => undefined),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /count should never exceed zero/);
      assert.match(error.message, /"count": 1/);
      assert.match(error.message, /\[Function callback\]/);
      return true;
    },
  );
});

test('simulation: finish surfaces a later task failure before an earlier task timeout', async () => {
  const simulation = new DeterministicSimulation(
    () => ({ phase: 'running' }),
    undefined,
    675,
    200,
  );
  simulation.spawn('first-stuck', () => simulation.waitAt('first-barrier'));
  await simulation.waitUntilReached('first-barrier');
  simulation.spawn('second-fails', () => {
    throw new Error('later task failed');
  });

  await assert.rejects(
    () => simulation.finish(),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /later task failed/);
      assert.match(error.message, /task:second-fails:failed/);
      assert.doesNotMatch(error.message, /did not settle within/);
      return true;
    },
  );
  simulation.release('first-barrier');
});

test('simulation: spawned task failures retain their failure-time checkpoint', async () => {
  const state = { revision: 1 };
  const simulation = new DeterministicSimulation(() => state);
  simulation.spawn('fails-now', () => {
    throw new Error('failed at revision one');
  });
  await assert.rejects(() => simulation.waitUntilReached('unused'), /failed at revision one/);

  await simulation.step('later-mutation', () => {
    state.revision = 2;
  });

  await assert.rejects(
    () => simulation.join('fails-now'),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /"revision": 1/);
      assert.doesNotMatch(error.message, /step:later-mutation/);
      return true;
    },
  );
});

test('simulation: asynchronous invariants fail explicitly', async () => {
  const simulation = new DeterministicSimulation(
    () => ({ valid: false }),
    async () => {
      throw new Error('async assertion rejection');
    },
    675,
  );

  await assert.rejects(
    () => simulation.step('async-invariant', () => undefined),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /simulation invariants must be synchronous/);
      assert.match(error.message, /step:async-invariant:complete/);
      assert.match(error.message, /"valid": false/);
      return true;
    },
  );
});
