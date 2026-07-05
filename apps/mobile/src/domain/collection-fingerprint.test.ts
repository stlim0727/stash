import assert from 'node:assert/strict';
import { test } from 'node:test';

import { collectionFingerprints, relativeTime } from './collection-fingerprint.ts';
import type { Bookmark } from './types.ts';

function make(overrides: Partial<Bookmark> = {}): Bookmark {
  const now = '2026-06-12T00:00:00.000Z';
  return {
    id: 'b1',
    user_id: 'u1',
    url: 'https://example.com',
    canonical_url: null,
    url_hash: 'https://example.com',
    title: 'Example',
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
    sync_status: 'synced',
    ...overrides,
  };
}

test('collectionFingerprints groups by collection with counts and the latest created_at', () => {
  const fps = collectionFingerprints([
    make({ id: 'a', collection_id: 'work', created_at: '2026-06-01T00:00:00.000Z' }),
    make({ id: 'b', collection_id: 'work', created_at: '2026-06-20T00:00:00.000Z' }),
    make({ id: 'c', collection_id: 'reading', created_at: '2026-05-01T00:00:00.000Z' }),
    // Loose (uncollected) items belong to no collection row.
    make({ id: 'd', collection_id: null }),
  ]);

  assert.equal(fps.size, 2);
  assert.equal(fps.get('work')?.count, 2);
  // Last-added is the most recent save in the collection, not the first seen.
  assert.equal(fps.get('work')?.lastAddedAt, '2026-06-20T00:00:00.000Z');
  assert.equal(fps.get('reading')?.count, 1);
  assert.equal(fps.get('reading')?.lastAddedAt, '2026-05-01T00:00:00.000Z');
});

test('topSite surfaces only a repeated site (≥2), never a lone one', () => {
  const fps = collectionFingerprints([
    make({ id: 'a', collection_id: 'news', site_name: 'WIRED' }),
    make({ id: 'b', collection_id: 'news', site_name: 'WIRED' }),
    make({ id: 'c', collection_id: 'news', site_name: 'The Verge' }),
    // A collection whose items each have a distinct site has no dominant pattern.
    make({ id: 'd', collection_id: 'solo', site_name: 'Only Once' }),
  ]);

  assert.equal(fps.get('news')?.topSite, 'WIRED');
  assert.equal(fps.get('solo')?.topSite, null);
});

test('relativeTime buckets the gap into the coarsest sensible unit', () => {
  const now = Date.parse('2026-07-05T12:00:00.000Z');
  const at = (ms: number) => new Date(now - ms).toISOString();

  assert.deepEqual(relativeTime(at(10_000), now), { unit: 'now', value: 0 });
  assert.deepEqual(relativeTime(at(5 * 60_000), now), { unit: 'minutes', value: 5 });
  assert.deepEqual(relativeTime(at(3 * 3_600_000), now), { unit: 'hours', value: 3 });
  assert.deepEqual(relativeTime(at(2 * 86_400_000), now), { unit: 'days', value: 2 });
  assert.deepEqual(relativeTime(at(10 * 86_400_000), now), { unit: 'weeks', value: 1 });
  assert.deepEqual(relativeTime(at(60 * 86_400_000), now), { unit: 'months', value: 2 });
  assert.deepEqual(relativeTime(at(400 * 86_400_000), now), { unit: 'years', value: 1 });
  // A future timestamp never reads as negative time.
  assert.deepEqual(relativeTime(at(-5_000), now), { unit: 'now', value: 0 });
});
