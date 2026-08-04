import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DeterministicSimulation,
  runSeededEvents,
  seededEventOrder,
  type SimulationEvent,
} from '@/__tests__/helpers/deterministic-simulation';
import { InMemoryBookmarkRepository } from '@/__tests__/helpers/in-memory-bookmark-repository';
import type { BookmarkApi } from '@/api/bookmarks';
import type { Bookmark, LocalPendingBookmark } from '@/domain/types';
import {
  PENDING_IMPORT_COLLECTIONS_KEY,
  parsePendingImportCollections,
} from '@/domain/pending-import-collections';
import {
  PENDING_ENRICHMENT_RESTORE_KEY,
  parsePendingEnrichmentRestores,
  rekeyPendingEnrichmentRestores,
  dropPendingEnrichmentRestores,
  type PendingEnrichmentRestore,
} from '@/domain/pending-enrichment-restore';
import {
  createNeedsReconcileUpdate,
  makeMutationEntry,
  syncQueueEntry,
  type EntrySyncResult,
} from '@/sync/sync-bookmarks';

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

test('simulation: imported bookmark and organization outboxes cross restart together', async () => {
  const now = '2026-08-03T00:00:00.000Z';
  const bookmark: Bookmark = {
    id: '00000000-0000-4000-8000-000000000671',
    user_id: 'user-1',
    url: 'https://example.com/restore',
    canonical_url: null,
    url_hash: 'https://example.com/restore',
    client_id: 'client-671',
    title: 'Restore me',
    description: null,
    notes: null,
    source_app: null,
    content_type: 'url',
    preview_image_url: null,
    favicon_url: null,
    site_name: null,
    collection_id: null,
    is_archived: false,
    deleted_at: null,
    created_at: now,
    updated_at: now,
    last_saved_at: now,
    metadata_status: 'pending',
    sync_status: 'pending',
  };
  const entry: LocalPendingBookmark = {
    local_id: bookmark.id,
    remote_id: null,
    operation: 'create',
    payload: { id: bookmark.id, url: bookmark.url!, client_id: bookmark.client_id! },
    sync_status: 'pending',
    retry_count: 0,
    last_error: null,
    created_at: now,
    updated_at: now,
  };
  const tagOps = [
    {
      id: 'tag-op-1',
      bookmark_id: bookmark.id,
      tag_name: 'research',
      op: 'add',
      source: 'user',
      confidence: null,
      created_at: now,
    },
  ];
  const collectionOps = [
    {
      bookmark_id: bookmark.id,
      collection_name: 'Projects',
      status: 'pending',
      last_error: null,
      created_at: now,
    },
  ];
  const enrichmentOps: PendingEnrichmentRestore[] = [
    {
      bookmark_id: bookmark.id,
      enrichment: {
        summary: 'snapshot summary',
        topics: ['reading'],
        suggested_tags: [{ name: 'tech', confidence: 0.9 }],
        status: 'complete',
        model: 'gpt-5',
        confidence: 0.87,
      },
      status: 'pending',
      last_error: null,
      created_at: now,
    },
  ];
  let repository = new InMemoryBookmarkRepository();
  const simulation = new DeterministicSimulation(
    () => repository.inspect(),
    ({ state }) => {
      const pendingRestores = parsePendingEnrichmentRestores(
        state.meta[PENDING_ENRICHMENT_RESTORE_KEY] ?? null,
      );
      for (const op of pendingRestores) {
        assert.ok(
          state.bookmarks.some((b) => b.id === op.bookmark_id),
          `bookmark ${op.bookmark_id} with queued restore entry must exist in bookmarks`,
        );
      }
      for (const stored of state.bookmarks) {
        assert.ok(state.queue.some((queued) => queued.local_id === stored.id));
        assert.ok(
          JSON.parse(state.meta.pending_tag_ops ?? '[]').some(
            (op: { bookmark_id?: string }) => op.bookmark_id === stored.id,
          ),
        );
        assert.ok(
          parsePendingImportCollections(
            state.meta[PENDING_IMPORT_COLLECTIONS_KEY] ?? null,
          ).some((op) => op.bookmark_id === stored.id),
        );
      }
    },
  );

  await simulation.step('persist-import-batch', () =>
    repository.insertImportBatch([bookmark], [entry], {
      metaUpdates: {
        pending_tag_ops: JSON.stringify(tagOps),
        [PENDING_IMPORT_COLLECTIONS_KEY]: JSON.stringify(collectionOps),
        [PENDING_ENRICHMENT_RESTORE_KEY]: JSON.stringify(enrichmentOps),
      },
    }),
  );
  await simulation.step('process-restart', () => {
    repository = repository.restart();
  });
  await simulation.finish();

  assert.deepEqual(await repository.listBookmarks(), [bookmark]);
  assert.deepEqual(await repository.listQueue(), [entry]);
  assert.equal(
    parsePendingImportCollections(
      await repository.getMeta(PENDING_IMPORT_COLLECTIONS_KEY),
    )[0]?.collection_name,
    'Projects',
  );
  assert.equal(
    parsePendingEnrichmentRestores(
      await repository.getMeta(PENDING_ENRICHMENT_RESTORE_KEY),
    )[0]?.enrichment.summary,
    'snapshot summary',
  );
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

test('simulation: seeded ordering randomizes only dependency-ready events', () => {
  const events: SimulationEvent<never>[] = [
    { label: 'persist-bookmark', run: () => undefined },
    { label: 'persist-upload-intent', after: ['persist-bookmark'], run: () => undefined },
    { label: 'metadata-settles', after: ['persist-bookmark'], run: () => undefined },
    { label: 'upload', after: ['persist-upload-intent'], run: () => undefined },
    { label: 'pull', after: ['upload'], run: () => undefined },
  ];

  const observedOrders = new Set<string>();
  for (const seed of [1, 2, 3, 671, 673]) {
    const labels = seededEventOrder(events, seed).map((event) => event.label);
    observedOrders.add(labels.join(','));
    const indexOf = (label: string) => labels.indexOf(label);
    assert.ok(indexOf('persist-bookmark') < indexOf('persist-upload-intent'));
    assert.ok(indexOf('persist-bookmark') < indexOf('metadata-settles'));
    assert.ok(indexOf('persist-upload-intent') < indexOf('upload'));
    assert.ok(indexOf('upload') < indexOf('pull'));
  }
  assert.ok(observedOrders.size > 1, 'different seeds did not explore different valid orders');
});

test('simulation: seeded ordering rejects missing and cyclic dependencies', () => {
  assert.throws(
    () =>
      seededEventOrder(
        [{ label: 'upload', after: ['persist'], run: () => undefined }],
        673,
      ),
    /dependency does not exist: persist/,
  );
  assert.throws(
    () =>
      seededEventOrder(
        [
          { label: 'upload', after: ['pull'], run: () => undefined },
          { label: 'pull', after: ['upload'], run: () => undefined },
        ],
        673,
      ),
    /dependencies contain a cycle: upload, pull/,
  );
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

test('simulation: a real failure survives a snapshot callback that also throws', async () => {
  const simulation = new DeterministicSimulation<{ count: number }>(() => {
    throw new Error('fake state is temporarily unreadable');
  });

  await assert.rejects(
    () =>
      simulation.step('trigger', () => {
        throw new Error('the real failure');
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /the real failure/);
      assert.match(error.message, /"snapshotUnavailable": true/);
      return true;
    },
  );
});

test('simulation: a snapshot callback failure cannot become a successful checkpoint', async () => {
  const simulation = new DeterministicSimulation<never>(() => {
    throw new Error('snapshot read failed');
  });

  await assert.rejects(
    () => simulation.step('capture-broken-snapshot', () => undefined),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /snapshot read failed/);
      assert.match(error.message, /"snapshotUnavailable": true/);
      assert.equal(simulation.checkpoints.length, 0);
      return true;
    },
  );
});

test('simulation: step() itself is bounded by the simulation timeout', async () => {
  const simulation = new DeterministicSimulation(() => ({}), undefined, null, 20);

  const start = Date.now();
  await assert.rejects(
    () => simulation.step('stuck-step', () => new Promise(() => {})),
    /simulation step did not settle within 20ms: stuck-step/,
  );
  assert.ok(Date.now() - start < 1000, 'step() waited far longer than its own timeout');
});

test('simulation: a timeout message reflects barrier state as of the timeout, not as of the call', async () => {
  const simulation = new DeterministicSimulation(() => ({}), undefined, null, 30);

  simulation.spawn('worker', async () => {
    // Not reached yet when join() is called below -- the message must still
    // name it once it *is* reached during the wait.
    await simulation.waitAt('reached-during-wait');
  });

  await assert.rejects(
    () => simulation.join('worker'),
    /unreleased barriers: reached-during-wait/,
  );
});

const LOCAL_ID = '11111111-1111-4111-8111-111111111111';
const EXISTING_REMOTE_ID = '22222222-2222-4222-8222-222222222222';

function makeDurableBookmark(overrides: Partial<Bookmark> = {}): Bookmark {
  const now = '2026-08-03T00:00:00.000Z';
  return {
    id: LOCAL_ID,
    user_id: 'user-test',
    url: 'https://example.com/article',
    canonical_url: 'https://example.com/article',
    url_hash: 'example-hash',
    title: 'Original title',
    description: null,
    notes: null,
    source_app: null,
    content_type: 'url',
    preview_image_url: null,
    favicon_url: null,
    site_name: null,
    collection_id: null,
    is_archived: false,
    deleted_at: null,
    created_at: now,
    updated_at: now,
    last_saved_at: now,
    metadata_status: 'complete',
    sync_status: 'pending',
    ...overrides,
  } as Bookmark;
}

function makeDurableCreateEntry(): LocalPendingBookmark {
  const now = '2026-08-03T00:00:00.000Z';
  return {
    local_id: LOCAL_ID,
    remote_id: null,
    operation: 'create',
    payload: {
      id: LOCAL_ID,
      url: 'https://example.com/article',
      title: 'Original title',
      client_id: LOCAL_ID,
    },
    sync_status: 'pending',
    retry_count: 0,
    last_error: null,
    created_at: now,
    updated_at: now,
  };
}

test('simulation: real syncQueueEntry reconciles duplicate adoption and an in-flight edit after restart', async () => {
  let currentBookmark = makeDurableBookmark();
  const entry = makeDurableCreateEntry();
  const enrichmentRestore: PendingEnrichmentRestore = {
    bookmark_id: LOCAL_ID,
    enrichment: {
      summary: 'original summary',
      topics: ['a'],
      suggested_tags: [],
      status: 'complete',
      model: 'gpt-5',
      confidence: 0.9,
    },
    status: 'pending',
    last_error: null,
    created_at: '2026-08-03T00:00:00.000Z',
  };

  let repository = new InMemoryBookmarkRepository({
    bookmarks: [currentBookmark],
    queue: [entry],
    meta: {
      [PENDING_ENRICHMENT_RESTORE_KEY]: JSON.stringify([enrichmentRestore]),
    },
  });
  const sentTitles: Array<string | undefined> = [];
  const updatedTitles: Array<string | null> = [];
  let result: EntrySyncResult | undefined;
  const simulation = new DeterministicSimulation(
    () => repository.inspect(),
    ({ state }) => {
      assert.equal(new Set(state.bookmarks.map((bookmark) => bookmark.id)).size, state.bookmarks.length);
      assert.equal(new Set(state.queue.map((queued) => queued.local_id)).size, state.queue.length);
      for (const bookmark of state.bookmarks.filter(
        (candidate) => candidate.sync_status === 'pending',
      )) {
        assert.equal(
          state.queue.filter((queued) => queued.local_id === bookmark.id).length,
          1,
          `pending bookmark ${bookmark.id} must have one durable upload intent`,
        );
      }
    },
    673,
  );
  const api = {
    createBookmark: async (input) => {
      sentTitles.push(input.title);
      await simulation.waitAt('create-response');
      return {
        bookmark_id: EXISTING_REMOTE_ID,
        status: 'duplicate' as const,
        metadata_status: 'complete' as const,
      };
    },
    updateBookmark: async (_id, input) => {
      updatedTitles.push(input.title ?? null);
      return currentBookmark;
    },
  } as BookmarkApi;

  simulation.spawn('real-create-sync', async () => {
    result = await syncQueueEntry(api, repository, entry, (id) =>
      id === currentBookmark.id || id === LOCAL_ID ? currentBookmark : undefined,
    );
  });
  await simulation.waitUntilReached('create-response');
  await simulation.step('edit-title-while-upload-is-in-flight', async () => {
    currentBookmark = {
      ...currentBookmark,
      title: 'Edited while uploading',
      updated_at: '2026-08-03T00:01:00.000Z',
    };
    await repository.updateBookmark(currentBookmark);
  });
  simulation.release('create-response');
  await simulation.join('real-create-sync');

  await simulation.step('apply-create-result-and-persist-reconcile-intent', async () => {
    assert.ok(result?.bookmarkUpdate);
    currentBookmark = result.bookmarkUpdate;
    assert.equal(
      createNeedsReconcileUpdate(currentBookmark, result.uploadedPayload, {
        titleChangedByUser: true,
      }),
      true,
    );
    await repository.enqueue(makeMutationEntry(currentBookmark.id, 'update'));

    // Rekey the enrichment restore outbox exactly as rekeyBookmarkIdentity does
    const restoredMeta = await repository.getMeta(PENDING_ENRICHMENT_RESTORE_KEY);
    const restoredRestores = parsePendingEnrichmentRestores(restoredMeta);
    const idMap = new Map([[LOCAL_ID, EXISTING_REMOTE_ID]]);
    const rekeyed = rekeyPendingEnrichmentRestores(restoredRestores, idMap);

    await repository.setMeta(
      PENDING_ENRICHMENT_RESTORE_KEY,
      JSON.stringify(rekeyed),
    );
  });
  await simulation.step('cold-restart-from-durable-state', async () => {
    repository = repository.restart();
    const [restored] = await repository.listBookmarks();
    assert.ok(restored);
    currentBookmark = restored;
  });

  // Verify that enrichment restore rekeyed state survived the restart
  const postRestartMeta = await repository.getMeta(PENDING_ENRICHMENT_RESTORE_KEY);
  const postRestartRestores = parsePendingEnrichmentRestores(postRestartMeta);
  assert.equal(postRestartRestores.length, 1);
  assert.equal(postRestartRestores[0]?.bookmark_id, EXISTING_REMOTE_ID);

  await simulation.step('resume-durable-reconcile-update', async () => {
    const [reconcileEntry] = await repository.listQueue();
    assert.ok(reconcileEntry);
    await syncQueueEntry(api, repository, reconcileEntry, (id) =>
      id === currentBookmark.id ? currentBookmark : undefined,
    );
  });
  await simulation.finish();

  const durable = repository.inspect();
  assert.deepEqual(sentTitles, ['Original title']);
  assert.deepEqual(updatedTitles, ['Edited while uploading']);
  assert.equal(result?.originalLocalId, LOCAL_ID);
  assert.equal(result?.bookmarkUpdate?.id, EXISTING_REMOTE_ID);
  assert.deepEqual(durable.queue, []);
  assert.equal(durable.bookmarks.length, 1);
  assert.equal(durable.bookmarks[0]?.id, EXISTING_REMOTE_ID);
  assert.equal(durable.bookmarks[0]?.title, 'Edited while uploading');
  assert.equal(durable.bookmarks[0]?.sync_status, 'synced');
  assert.equal(durable.bookmarks[0]?.ever_synced, true);
});

test('simulation: repository restart preserves reset without re-seeding', async () => {
  let repository = new InMemoryBookmarkRepository();
  await repository.init([makeDurableBookmark()]);
  await repository.clearAllData();

  repository = repository.restart();
  await repository.init([makeDurableBookmark({ title: 'Must not return' })]);

  assert.deepEqual(await repository.listBookmarks(), []);
  assert.equal(repository.inspect().initialized, true);
});

test('simulation: batch completion preserves a superseding queue mutation', async () => {
  const createEntry = makeDurableCreateEntry();
  const supersedingUpdate = {
    ...makeMutationEntry(LOCAL_ID, 'update'),
    updated_at: '2026-08-03T00:02:00.000Z',
  };
  const original = makeDurableBookmark();
  const repository = new InMemoryBookmarkRepository({
    bookmarks: [original],
    queue: [supersedingUpdate],
  });

  await repository.completeCreateSyncBatch?.([
    {
      bookmark: makeDurableBookmark({ id: EXISTING_REMOTE_ID, sync_status: 'synced' }),
      entry: createEntry,
      originalLocalId: LOCAL_ID,
    },
  ]);

  assert.deepEqual(await repository.listQueue(), [supersedingUpdate]);
  assert.deepEqual(await repository.listBookmarks(), [original]);
});

test('simulation: import batch cannot repopulate queue work after a concurrent reset', async () => {
  const secondId = '33333333-3333-4333-8333-333333333333';
  const first = makeDurableBookmark();
  const second = makeDurableBookmark({ id: secondId, url: 'https://example.com/second' });
  const firstEntry = makeDurableCreateEntry();
  const secondEntry = {
    ...makeDurableCreateEntry(),
    local_id: secondId,
    payload: { id: secondId, url: 'https://example.com/second', client_id: secondId },
  };
  const repository = new InMemoryBookmarkRepository({ initialized: true });

  const insertion = repository.insertImportBatch?.(
    [first, second],
    [firstEntry, secondEntry],
  );
  await repository.clearAllData();
  await insertion;

  assert.deepEqual(await repository.listBookmarks(), []);
  assert.deepEqual(await repository.listQueue(), []);
});

test('simulation: enrichment restore outbox drives real syncQueueEntry duplicate resolution, restarts, and uploads successfully', async () => {
  const now = '2026-08-04T00:00:00.000Z';
  let currentBookmark = makeDurableBookmark();
  const entry = makeDurableCreateEntry();
  const enrichmentRestore: PendingEnrichmentRestore = {
    bookmark_id: currentBookmark.id,
    enrichment: {
      summary: 'snapshot summary',
      topics: ['a'],
      suggested_tags: [],
      status: 'complete',
      model: 'gpt-5',
      confidence: 0.9,
    },
    status: 'pending',
    last_error: null,
    created_at: now,
  };

  let repository = new InMemoryBookmarkRepository();
  const restoredEnrichments: any[] = [];
  let result: EntrySyncResult | undefined;

  const simulation = new DeterministicSimulation(
    () => repository.inspect(),
    ({ state }) => {
      const raw = state.meta[PENDING_ENRICHMENT_RESTORE_KEY];
      if (raw) {
        const parsed = parsePendingEnrichmentRestores(raw);
        assert.ok(Array.isArray(parsed));
      }
    },
    673,
  );

  const api = {
    createBookmark: async () => {
      await simulation.waitAt('create-response');
      return {
        bookmark_id: EXISTING_REMOTE_ID,
        status: 'duplicate' as const,
        metadata_status: 'complete' as const,
      };
    },
    restoreAIEnrichment: async (input) => {
      restoredEnrichments.push(input);
      return {
        id: 'enrichment-id',
        user_id: 'real-user',
        bookmark_id: input.bookmark_id,
        summary: input.summary ?? null,
        topics: input.topics ?? [],
        suggested_tags: input.suggested_tags ?? [],
        suggested_collection_id: null,
        suggested_collection_name: null,
        status: input.status,
        model: input.model ?? null,
        confidence: input.confidence ?? null,
        degraded: false,
        degraded_reason: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    },
  } as Partial<BookmarkApi> as BookmarkApi;

  // Step 1: Persist import batch with metadata updates (enrichment restore enqueued)
  await simulation.step('persist-import-batch-with-enrichment', () =>
    repository.insertImportBatch([currentBookmark], [entry], {
      metaUpdates: {
        [PENDING_ENRICHMENT_RESTORE_KEY]: JSON.stringify([enrichmentRestore]),
      },
    }),
  );

  // Step 2: Spawn create sync and wait for duplicate create response
  simulation.spawn('real-create-sync', async () => {
    result = await syncQueueEntry(api, repository, entry, (id) =>
      id === currentBookmark.id || id === LOCAL_ID ? currentBookmark : undefined,
    );
  });
  await simulation.waitUntilReached('create-response');
  simulation.release('create-response');
  await simulation.join('real-create-sync');

  // Step 3: Apply the create result and re-key the enrichment restore outbox
  await simulation.step('apply-create-result-and-rekey-outbox', async () => {
    assert.ok(result?.bookmarkUpdate);
    currentBookmark = result.bookmarkUpdate;
    assert.equal(result.originalLocalId, LOCAL_ID);
    assert.equal(currentBookmark.id, EXISTING_REMOTE_ID);

    // Re-key the meta outbox exactly as the store's rekeyBookmarkIdentity does
    const restoredMeta = await repository.getMeta(PENDING_ENRICHMENT_RESTORE_KEY);
    const restoredRestores = parsePendingEnrichmentRestores(restoredMeta);
    const idMap = new Map([[LOCAL_ID, EXISTING_REMOTE_ID]]);
    const rekeyed = rekeyPendingEnrichmentRestores(restoredRestores, idMap);

    // Save rekeyed outbox + replace bookmark with its adopted remote ID
    await repository.completeCreateSyncBatch?.([
      {
        bookmark: currentBookmark,
        entry,
        originalLocalId: LOCAL_ID,
      },
    ]);
    await repository.setMeta(
      PENDING_ENRICHMENT_RESTORE_KEY,
      JSON.stringify(rekeyed),
    );
  });

  // Step 4: Process restart (verify durability of the rekeyed state)
  await simulation.step('process-restart', () => {
    repository = repository.restart();
  });

  // Verify rekeyed and durable state after restart
  const postRestartMeta = await repository.getMeta(PENDING_ENRICHMENT_RESTORE_KEY);
  const postRestartRestores = parsePendingEnrichmentRestores(postRestartMeta);
  assert.equal(postRestartRestores.length, 1);
  assert.equal(postRestartRestores[0]?.bookmark_id, EXISTING_REMOTE_ID);

  const bookmarks = await repository.listBookmarks();
  assert.equal(bookmarks.length, 1);
  assert.equal(bookmarks[0]?.id, EXISTING_REMOTE_ID);

  // Step 5: Upload enrichment restore using the API and drop it from the outbox
  await simulation.step('sync-enrichment-restore-and-drop-on-success', async () => {
    const item = postRestartRestores[0]!;
    // Simulate syncPendingEnrichmentRestores' API call & persist updates
    const created = await api.restoreAIEnrichment({
      bookmark_id: item.bookmark_id,
      summary: item.enrichment.summary,
      topics: item.enrichment.topics,
      suggested_tags: item.enrichment.suggested_tags,
      status: item.enrichment.status,
      model: item.enrichment.model,
      confidence: item.enrichment.confidence,
    });

    assert.ok(created);
    const remaining = dropPendingEnrichmentRestores(postRestartRestores, [item.bookmark_id]);
    await repository.setMeta(
      PENDING_ENRICHMENT_RESTORE_KEY,
      JSON.stringify(remaining),
    );
  });

  await simulation.finish();

  const finalMeta = await repository.getMeta(PENDING_ENRICHMENT_RESTORE_KEY);
  const finalRestores = parsePendingEnrichmentRestores(finalMeta);
  assert.equal(finalRestores.length, 0);
  assert.equal(restoredEnrichments.length, 1);
  assert.equal(restoredEnrichments[0]?.bookmark_id, EXISTING_REMOTE_ID);
  assert.equal(restoredEnrichments[0]?.summary, 'snapshot summary');
});
