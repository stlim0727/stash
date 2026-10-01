import assert from 'node:assert/strict';
import test from 'node:test';
import { changedSyncFields, mergeSyncChanges, parseSyncChanges } from './sync-changes.ts';
import type { Bookmark } from './types';

const at = '2026-10-01T10:00:00Z';
test('field evidence includes explicit clears but excludes local-only and bookkeeping fields', () => {
  const before = { title: 'Old', collection_id: 'folder', site_name: 'Same', title_is_derived: true } as Bookmark;
  assert.deepEqual(changedSyncFields(before, {
    title: null, collection_id: null, site_name: 'Same', title_is_derived: false,
    sync_status: 'pending', updated_at: at, ever_synced: true,
  }), ['collection_id', 'title']);
});

test('coalescing retains both user and metadata causes and unions repeated metadata subtypes', () => {
  const user = [{ source: 'user_edit' as const, fields: ['title'], at }];
  const first = mergeSyncChanges(user, { source: 'metadata_fetch', fields: ['preview_image_url'], at });
  const next = mergeSyncChanges(first, { source: 'metadata_fetch', fields: ['favicon_url', 'preview_image_url'], at: '2026-10-01T10:01:00Z' });
  assert.deepEqual(next.map((change) => [change.source, change.fields]), [
    ['user_edit', ['title']], ['metadata_fetch', ['favicon_url', 'preview_image_url']],
  ]);
  assert.equal(next[1]?.at, '2026-10-01T10:01:00Z');
  assert.deepEqual(user, [{ source: 'user_edit', fields: ['title'], at }]);
});

test('legacy and corrupt records remain unknown rather than fabricated folder changes', () => {
  assert.equal(parseSyncChanges(null), undefined);
  assert.equal(parseSyncChanges('{invalid'), undefined);
  assert.equal(parseSyncChanges(JSON.stringify([{ source: 'made_up', fields: [], at }])), undefined);
  assert.deepEqual(parseSyncChanges(JSON.stringify([{ source: 'user_edit', fields: ['collection_id'], at }])),
    [{ source: 'user_edit', fields: ['collection_id'], at }]);
});
