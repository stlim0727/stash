import assert from 'node:assert/strict';
import { test } from 'node:test';

import { legacyFallbackTitle, planTitleBackfill } from './title-backfill.ts';
import type { Bookmark } from './types.ts';

function makeBookmark(overrides: Partial<Bookmark> = {}): Bookmark {
  const now = '2026-07-06T00:00:00.000Z';
  return {
    id: 'bookmark-test',
    user_id: 'user-test',
    url: 'https://youtu.be/MEvcN4Nwa1g',
    canonical_url: null,
    url_hash: 'https://youtu.be/MEvcN4Nwa1g',
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
    metadata_status: 'complete',
    sync_status: 'synced',
    ...overrides,
  } as Bookmark;
}

test('legacyFallbackTitle reproduces the pre-upgrade host/slug fallback', () => {
  assert.equal(legacyFallbackTitle('https://youtu.be/MEvcN4Nwa1g'), 'youtu.be');
  assert.equal(
    legacyFallbackTitle('https://www.threads.com/@ephemeris.ai/post/Dabls52E90n'),
    'Dabls52E90n',
  );
});

test('backfill relabels a YouTube host title with a thumbnail, locally only', () => {
  // Exactly the "youtu.be" case: transient failure baked in the host as a title.
  // A purely local relabel to a clean label + derived thumbnail (no re-fetch, so
  // no sync upload race), recorded as a generated title.
  const plan = planTitleBackfill(makeBookmark({ title: 'youtu.be' }));
  assert.deepEqual(plan, {
    title: 'YouTube video',
    preview_image_url: 'https://i.ytimg.com/vi/MEvcN4Nwa1g/hqdefault.jpg',
    title_is_derived: true,
  });
});

test('backfill relabels a Threads id title with the author label', () => {
  const plan = planTitleBackfill(
    makeBookmark({
      url: 'https://www.threads.com/@ephemeris.ai/post/Dabls52E90n',
      title: 'Dabls52E90n',
    }),
  );
  assert.equal(plan?.title, 'Threads post by @ephemeris.ai');
  assert.equal(plan?.preview_image_url, null);
  assert.equal(plan?.title_is_derived, true);
});

test('backfill trusts recorded provenance over the string match', () => {
  // A title recorded as NOT derived (a real fetched title or user rename) is
  // never touched, even if it happens to equal the historical fallback string.
  assert.equal(
    planTitleBackfill(makeBookmark({ title: 'youtu.be', title_is_derived: false })),
    null,
  );
});

test('backfill never touches a user-renamed title', () => {
  // The stored title differs from the historical machine fallback → the user
  // typed it. Capture is sacred: leave it alone.
  assert.equal(planTitleBackfill(makeBookmark({ title: 'Freestyle drills' })), null);
});

test('backfill leaves a real fetched title alone', () => {
  const plan = planTitleBackfill(
    makeBookmark({
      url: 'https://docs.expo.dev/router/introduction/',
      title: 'Introduction to Expo Router',
    }),
  );
  assert.equal(plan, null);
});

test('backfill is a no-op when the fallback would not improve', () => {
  // A generic word-slug whose legacy fallback already reads fine — nothing to
  // gain, so no churn (and no needless sync mutation).
  const plan = planTitleBackfill(
    makeBookmark({
      url: 'https://www.inkandswitch.com/local-first/',
      title: 'Local First',
    }),
  );
  assert.equal(plan, null);
});

test('backfill skips text-only and untitled bookmarks', () => {
  assert.equal(planTitleBackfill(makeBookmark({ url: null, title: 'note' })), null);
  assert.equal(planTitleBackfill(makeBookmark({ title: null })), null);
});

test('backfill leaves an in-flight (pending) row alone', () => {
  // A fresh add/import mid-enrichment: its title happens to equal the old
  // fallback, but clearing it would race the in-flight fetch and strand it
  // title-less. Only settled rows are repaired.
  assert.equal(
    planTitleBackfill(makeBookmark({ title: 'youtu.be', metadata_status: 'pending' })),
    null,
  );
});
