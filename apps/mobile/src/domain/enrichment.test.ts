import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deriveMetadata, enrichBookmark } from './enrichment.ts';
import type { Bookmark } from './types.ts';

function makeBookmark(overrides: Partial<Bookmark> = {}): Bookmark {
  const now = '2026-06-12T00:00:00.000Z';
  return {
    id: 'bookmark-test',
    user_id: 'user-test',
    url: 'https://docs.expo.dev/router/introduction/',
    canonical_url: null,
    url_hash: 'https://docs.expo.dev/router/introduction/',
    title: null,
    description: null,
    notes: null,
    source_app: null,
    content_type: 'url',
    preview_image_url: null,
    favicon_url: null,
    site_name: null,
    collection_id: null,
    is_archived: false,
    created_at: now,
    updated_at: now,
    last_saved_at: now,
    metadata_status: 'pending',
    sync_status: 'pending',
    ...overrides,
  };
}

test('deriveMetadata builds title and site from the URL', () => {
  const derived = deriveMetadata('https://www.inkandswitch.com/local-first/');
  assert.equal(derived.title, 'Local First');
  assert.equal(derived.site_name, 'inkandswitch.com');
  assert.equal(derived.favicon_url, 'https://www.inkandswitch.com/favicon.ico');
});

test('deriveMetadata falls back to the host for bare domains', () => {
  const derived = deriveMetadata('https://raindrop.io');
  assert.equal(derived.title, 'raindrop.io');
  assert.equal(derived.site_name, 'raindrop.io');
});

test('enrichBookmark fills only empty generated fields', async () => {
  const result = await enrichBookmark(makeBookmark());
  assert.equal(result.metadata_status, 'complete');
  assert.equal(result.patch.title, 'Introduction');
  assert.equal(result.patch.site_name, 'docs.expo.dev');
});

test('enrichBookmark never overwrites a user-provided title', async () => {
  const result = await enrichBookmark(makeBookmark({ title: 'My own title' }));
  assert.equal(result.metadata_status, 'complete');
  assert.equal('title' in result.patch, false);
});

test('enrichBookmark skips text-only bookmarks', async () => {
  const result = await enrichBookmark(makeBookmark({ url: null }));
  assert.equal(result.metadata_status, 'skipped');
  assert.deepEqual(result.patch, {});
});
