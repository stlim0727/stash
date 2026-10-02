import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBookmarkProcessingSnapshot, type BookmarkProcessingInput } from './bookmark-processing.ts';
import type { AIEnrichment, Bookmark, LocalPendingBookmark } from './types';

const now = Date.parse('2026-10-01T10:00:00Z');
function input(patch: Partial<BookmarkProcessingInput> = {}): BookmarkProcessingInput {
  return {
    bookmark: { id: 'bookmark-id', sync_status: 'synced', metadata_status: 'complete', updated_at: '2026-10-01T09:00:00Z' } as Bookmark,
    localOnly: false, syncedOnce: true, authStatus: 'authenticated', hasSession: true,
    syncPaused: false, isSyncing: false, lastPulledAt: null, retryEligibleAt: null,
    permanentlyUnsyncable: false, refreshing: false, triggerPending: false,
    dispatchPending: false, inFlight: false, aiRetry: null, confirmedServerQueued: false,
    serverQueue: null, serverQueueObserved: false, aiMode: 'confirm', quota: null, now,
    ...patch,
  };
}
function entry(patch: Partial<LocalPendingBookmark> = {}): LocalPendingBookmark {
  return { local_id: 'bookmark-id', remote_id: 'bookmark-id', operation: 'update', payload: {},
    sync_status: 'pending', retry_count: 0, last_error: null,
    created_at: '2026-10-01T09:00:00Z', updated_at: '2026-10-01T09:00:00Z', ...patch };
}

test('the upload queue overrides a synced mirror, without claiming a folder change', () => {
  const s = buildBookmarkProcessingSnapshot(input({ queue: entry({ payload: { title: 'private title' } }) }));
  assert.equal(s.sync.phase, 'queued');
  assert.equal(s.sync.everSynced, true);
  assert.deepEqual(s.sync.queue?.uploadFields, ['title']);
  assert.ok(!JSON.stringify(s).includes('private title'));
  assert.equal(buildBookmarkProcessingSnapshot(input({ queue: entry() })).sync.phase, 'queued');
});

test('missing queue with a pending mirror is inconsistent, never silently complete', () => {
  const i = input(); i.bookmark = { ...i.bookmark, sync_status: 'pending' };
  assert.equal(buildBookmarkProcessingSnapshot(i).sync.phase, 'inconsistent');
  assert.equal(buildBookmarkProcessingSnapshot(input({ queue: entry({ sync_status: 'synced' }) })).sync.phase, 'inconsistent');
});

test('a persisted in-flight entry is interrupted if the sync service is idle', () => {
  const q = entry({ sync_status: 'syncing' });
  assert.equal(buildBookmarkProcessingSnapshot(input({ queue: q })).sync.phase, 'interrupted');
  assert.equal(buildBookmarkProcessingSnapshot(input({ queue: q, isSyncing: true })).sync.phase, 'syncing');
  // Account-wide work does not claim this bookmark is uploading.
  assert.equal(buildBookmarkProcessingSnapshot(input({ queue: entry(), isSyncing: true })).sync.phase, 'queued');
});

test('failure retains its phase and exposes all independent blockers', () => {
  const i = input({ queue: entry({ sync_status: 'failed', retry_count: 6, last_error_kind: 'transient_dns' }),
    syncPaused: true, hasSession: false, retryEligibleAt: now + 15_000 });
  const s = buildBookmarkProcessingSnapshot(i);
  assert.equal(s.sync.phase, 'failed');
  assert.deepEqual(s.sync.blockers, ['paused', 'auth_unavailable', 'retry_backoff']);
  assert.equal(s.sync.queue?.errorKind, 'transient_dns');
  assert.equal(s.sync.queue?.retryEligibleAt, '2026-10-01T10:00:15.000Z');
  assert.deepEqual(buildBookmarkProcessingSnapshot({ ...i, now: now + 15_000 }).sync.blockers, ['paused', 'auth_unavailable']);
});

test('local-only and never-confirmed sample identities do not claim cloud completion', () => {
  assert.equal(buildBookmarkProcessingSnapshot(input({ localOnly: true, hasSession: false })).sync.phase, 'local_only');
  assert.equal(buildBookmarkProcessingSnapshot(input({ syncedOnce: false })).sync.phase, 'not_synced');
  assert.equal(buildBookmarkProcessingSnapshot(input()).sync.phase, 'synced');
});

test('sync deferral is distinct from provider retry, server queue ignorance is explicit', () => {
  const s = buildBookmarkProcessingSnapshot(input({ aiRetry: { attemptCount: 0, lastAttemptAt: '2026-10-01T10:00:00Z', eligibleAt: now } }));
  assert.equal(s.ai.waitingForSync, true);
  assert.equal(s.ai.retry?.attempts, 0);
  assert.equal(s.ai.serverQueueObserved, false);
  assert.equal(s.ai.serverQueue, null);
  assert.equal(buildBookmarkProcessingSnapshot(input({ aiRetry: {
    attemptCount: 1, lastAttemptAt: 'invalid persisted timestamp', eligibleAt: NaN,
  } })).ai.retry?.eligibleAt, null);
  assert.equal(buildBookmarkProcessingSnapshot(input({ aiRetry: { attemptCount: 1, lastAttemptAt: '2026-10-01T10:00:00Z', eligibleAt: now + 120_000 } })).ai.waitingForSync, false);
});

test('empty completed AI results remain distinct from active work and redact content', () => {
  const enrichment = {
    status: 'complete', model: 'real-model', confidence: 0.1, summary: null,
    suggested_tags: [], suggested_collection_id: null, suggested_collection_name: null,
    degraded_reason: null, updated_at: '2026-10-01T09:00:00Z',
  } as unknown as AIEnrichment;
  const i = input({ enrichment, inFlight: true });
  const s = buildBookmarkProcessingSnapshot(i);
  assert.equal(s.ai.result?.status, 'complete');
  assert.equal(s.ai.result?.hasSummary, false);
  assert.equal(s.ai.result?.suggestedTagCount, 0);
  assert.equal(s.ai.result?.confidence, 0.1);
  assert.equal(s.ai.inFlight, true);
  const populated = buildBookmarkProcessingSnapshot({ ...i, enrichment: { ...enrichment,
    summary: 'Private summary', suggested_tags: [{ name: 'Private tag', confidence: 1 }],
    suggested_collection_name: 'Private folder',
  } });
  assert.equal(populated.ai.result?.hasSummary, true);
  assert.equal(populated.ai.result?.suggestedTagCount, 1);
  assert.ok(!JSON.stringify(populated).includes('Private'));
});

test('error evidence retains the failure while redacting request URLs and bearer credentials', () => {
  const s = buildBookmarkProcessingSnapshot(input({ queue: entry({ last_error:
    'Request https://example.com/private?token=secret failed: Bearer private-token',
  }) }));
  assert.equal(s.sync.queue?.lastError, 'Request [URL] failed: Bearer [redacted]');
});
