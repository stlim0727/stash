import assert from 'node:assert/strict';
import { test } from 'node:test';

import { filterBookmarks, type SearchResolvers } from './search.ts';
import type { Bookmark } from './types.ts';

function makeBookmark(overrides: Partial<Bookmark> = {}): Bookmark {
  const now = '2026-06-12T00:00:00.000Z';
  return {
    id: 'b1',
    user_id: 'u1',
    url: 'https://example.com/a',
    canonical_url: null,
    url_hash: 'https://example.com/a',
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

const corpus = [
  makeBookmark({ id: 'b1', title: 'Local-first software', notes: 'sync design' }),
  makeBookmark({ id: 'b2', title: 'Raindrop review', description: 'bookmark manager' }),
  makeBookmark({ id: 'b3', url: 'https://docs.expo.dev/router/' }),
];

test('empty query returns everything', () => {
  assert.equal(filterBookmarks(corpus, '').length, 3);
  assert.equal(filterBookmarks(corpus, '   ').length, 3);
});

test('matches are case-insensitive across title, description, notes, and URL', () => {
  assert.deepEqual(
    filterBookmarks(corpus, 'LOCAL-FIRST').map((b) => b.id),
    ['b1'],
  );
  assert.deepEqual(
    filterBookmarks(corpus, 'manager').map((b) => b.id),
    ['b2'],
  );
  assert.deepEqual(
    filterBookmarks(corpus, 'expo.dev').map((b) => b.id),
    ['b3'],
  );
});

test('multiple terms AND together across fields', () => {
  assert.deepEqual(
    filterBookmarks(corpus, 'local sync').map((b) => b.id),
    ['b1'],
  );
  assert.equal(filterBookmarks(corpus, 'local manager').length, 0);
});

test('matches by site_name', () => {
  const items = [
    makeBookmark({ id: 's1', site_name: 'YouTube' }),
    makeBookmark({ id: 's2', site_name: 'GitHub' }),
  ];
  assert.deepEqual(
    filterBookmarks(items, 'youtube').map((b) => b.id),
    ['s1'],
  );
});

test('matches by tag name via resolver', () => {
  const items = [
    makeBookmark({ id: 't1' }),
    makeBookmark({ id: 't2' }),
  ];
  const tagsById: Record<string, string[]> = { t1: ['React Native', 'mobile'], t2: ['backend'] };
  const resolvers: SearchResolvers = {
    tagNames: (b) => tagsById[b.id] ?? [],
  };
  assert.deepEqual(
    filterBookmarks(items, 'mobile', resolvers).map((b) => b.id),
    ['t1'],
  );
});

test('matches by collection name via resolver', () => {
  const items = [
    makeBookmark({ id: 'c1', collection_id: 'col-reading' }),
    makeBookmark({ id: 'c2', collection_id: 'col-work' }),
  ];
  const names: Record<string, string> = { 'col-reading': 'Reading List', 'col-work': 'Work' };
  const resolvers: SearchResolvers = {
    collectionName: (b) => (b.collection_id ? names[b.collection_id] : null),
  };
  assert.deepEqual(
    filterBookmarks(items, 'reading', resolvers).map((b) => b.id),
    ['c1'],
  );
});

test('normalization tolerates punctuation/spacing/case (대충 입력해도 매칭)', () => {
  const items = [makeBookmark({ id: 'n1', collection_id: 'col' })];
  const resolvers: SearchResolvers = {
    collectionName: () => 'Watch-Later',
  };
  // "watch later" (spaced) matches "Watch-Later" (hyphenated).
  assert.deepEqual(
    filterBookmarks(items, 'watch later', resolvers).map((b) => b.id),
    ['n1'],
  );
  // And the punctuation-free / cased form matches too.
  assert.deepEqual(
    filterBookmarks(items, 'WATCHLATER', resolvers).map((b) => b.id),
    ['n1'],
  );
});

test('matches Korean tags and titles, incl. partial substrings', () => {
  const items = [
    makeBookmark({ id: 'k1', title: '회사일 정리' }),
    makeBookmark({ id: 'k2', title: '개인 메모' }),
  ];
  const tagsById: Record<string, string[]> = { k1: ['리액트', '업무'], k2: ['일상'] };
  const resolvers: SearchResolvers = { tagNames: (b) => tagsById[b.id] ?? [] };

  // Exact Korean tag.
  assert.deepEqual(
    filterBookmarks(items, '리액트', resolvers).map((b) => b.id),
    ['k1'],
  );
  // Partial Korean substring against title "회사일".
  assert.deepEqual(
    filterBookmarks(items, '회사', resolvers).map((b) => b.id),
    ['k1'],
  );
});

test('NFKC folds full-width CJK-adjacent text (ＹｏｕＴｕｂｅ -> youtube)', () => {
  const items = [makeBookmark({ id: 'f1', site_name: 'ＹｏｕＴｕｂｅ' })];
  assert.deepEqual(
    filterBookmarks(items, 'youtube').map((b) => b.id),
    ['f1'],
  );
});

test('empty/whitespace-only tag names from a resolver are ignored safely', () => {
  const items = [makeBookmark({ id: 'e1', title: 'hello' })];
  const resolvers: SearchResolvers = { tagNames: () => ['  ', ''] };
  // Those blank tags must not become an empty-string match-everything haystack
  // entry, and must not crash.
  assert.equal(filterBookmarks(items, 'nope', resolvers).length, 0);
  assert.deepEqual(
    filterBookmarks(items, 'hello', resolvers).map((b) => b.id),
    ['e1'],
  );
});

test('a collectionName resolver returning null is handled', () => {
  const items = [makeBookmark({ id: 'cn1', title: 'doc' })];
  const resolvers: SearchResolvers = { collectionName: () => null };
  assert.equal(filterBookmarks(items, 'missing', resolvers).length, 0);
  assert.deepEqual(
    filterBookmarks(items, 'doc', resolvers).map((b) => b.id),
    ['cn1'],
  );
});

test('non-empty query without resolvers still searches the row fields', () => {
  // Regression: calling without the optional resolvers must behave like before.
  assert.equal(filterBookmarks(corpus, 'foo').length, 0);
  assert.deepEqual(
    filterBookmarks(corpus, 'raindrop').map((b) => b.id),
    ['b2'],
  );
});

test('single-token no-space query matches a spaced LABEL value (bidirectional)', () => {
  const items = [makeBookmark({ id: 'w1', collection_id: 'col' })];
  const resolvers: SearchResolvers = { collectionName: () => 'Watch Later' };
  // Reverse direction: no-space query against a spaced collection NAME (label).
  assert.deepEqual(
    filterBookmarks(items, 'watchlater', resolvers).map((b) => b.id),
    ['w1'],
  );
  // Forward (spaced query) still holds.
  assert.deepEqual(
    filterBookmarks(items, 'watch later', resolvers).map((b) => b.id),
    ['w1'],
  );
});

test('collapse fallback applies to label fields (title/site_name)', () => {
  // title is a label -> collapse fallback applies.
  const titled = [makeBookmark({ id: 'lt', title: 'Watch Later' })];
  assert.deepEqual(
    filterBookmarks(titled, 'watchlater').map((b) => b.id),
    ['lt'],
  );
  // site_name is a label -> collapse fallback applies.
  const sited = [makeBookmark({ id: 'ls', site_name: 'You Tube' })];
  assert.deepEqual(
    filterBookmarks(sited, 'youtube').map((b) => b.id),
    ['ls'],
  );
});

test('single-token collapse does NOT fire on prose (notes/description)', () => {
  // PROSE cross-word guard, restored per product decision: a no-space single
  // token must not fuse adjacent words in a memo body.
  const noted = [makeBookmark({ id: 'p1', notes: 'sync design' })];
  assert.equal(filterBookmarks(noted, 'syncdesign').length, 0);

  const described = [makeBookmark({ id: 'p2', description: 'local manager' })];
  assert.equal(filterBookmarks(described, 'localmanager').length, 0);
});

test('multi-term query does not create cross-word false positives', () => {
  // "local" lives in b1, "manager" in b2; the AND of two SEPARATE terms must not
  // match either. The single-token collapse fallback only fires for one-term
  // queries, so this multi-token cross-word guard is preserved.
  assert.equal(filterBookmarks(corpus, 'local manager').length, 0);
});

test('symbol-bearing query "C++" matches a C++ bookmark and stays selective', () => {
  // Regression for the P2 search bug: normalization collapses "C++" -> "c", and
  // every collapsed ".com" URL contains a "c", so the symbol query used to return
  // the entire inbox. It must now match ONLY items literally about C++.
  const items = [
    makeBookmark({ id: 'cpp', title: 'Learn C++ templates', url: 'https://cppref.com/x' }),
    makeBookmark({ id: 'u1', title: 'Cooking blog', url: 'https://recipes.com/a' }),
    makeBookmark({ id: 'u2', title: 'Climbing news', url: 'https://news.com/b' }),
    makeBookmark({ id: 'u3', title: 'Docs', url: 'https://docs.com/c' }),
  ];
  assert.deepEqual(
    filterBookmarks(items, 'C++').map((b) => b.id),
    ['cpp'],
  );
  // Lowercase form behaves identically.
  assert.deepEqual(
    filterBookmarks(items, 'c++').map((b) => b.id),
    ['cpp'],
  );
});

test('symbol queries match symbol tags and do not collide across symbols', () => {
  const items = [
    makeBookmark({ id: 'cpp' }),
    makeBookmark({ id: 'csharp' }),
  ];
  const tagsById: Record<string, string[]> = { cpp: ['C++'], csharp: ['C#'] };
  const resolvers: SearchResolvers = { tagNames: (b) => tagsById[b.id] ?? [] };

  // Tag "C++" is found by "C++"...
  assert.deepEqual(
    filterBookmarks(items, 'C++', resolvers).map((b) => b.id),
    ['cpp'],
  );
  // ...and "C#" by "C#" — the two symbol forms do not match each other.
  assert.deepEqual(
    filterBookmarks(items, 'C#', resolvers).map((b) => b.id),
    ['csharp'],
  );
});

test('".NET" is selective and does not match plain ".com" URLs', () => {
  const items = [
    makeBookmark({ id: 'net', title: 'ASP.NET guide', url: 'https://learn.com/x' }),
    makeBookmark({ id: 'other', title: 'Networking 101', url: 'https://example.com/y' }),
  ];
  assert.deepEqual(
    filterBookmarks(items, '.NET').map((b) => b.id),
    ['net'],
  );
});
