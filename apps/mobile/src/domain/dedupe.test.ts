import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planBookmarkDeduplication, type DedupeRow } from './dedupe.ts';

function row(overrides: Partial<DedupeRow> & Pick<DedupeRow, 'id'>): DedupeRow {
  return {
    user_id: 'user-1',
    url: 'https://example.com/a',
    url_hash: 'https://example.com/a',
    is_archived: false,
    created_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

test('collapses active rows that canonicalize to the same URL, keeping the earliest', () => {
  const plan = planBookmarkDeduplication([
    row({ id: 'b', created_at: '2026-06-02T00:00:00.000Z', url: 'https://example.com/a?utm_source=x' }),
    row({ id: 'a', created_at: '2026-06-01T00:00:00.000Z', url: 'https://example.com/a' }),
    row({ id: 'c', created_at: '2026-06-03T00:00:00.000Z', url: 'https://example.com/a#section' }),
  ]);

  assert.equal(plan.groups.length, 1);
  const group = plan.groups[0];
  assert.equal(group.keeperId, 'a');
  assert.deepEqual(group.duplicateIds, ['b', 'c']);
  assert.equal(group.canonical, 'https://example.com/a');
});

test('leaves a single row alone but still rewrites a stale url_hash', () => {
  const plan = planBookmarkDeduplication([
    row({ id: 'a', url: 'https://example.com/a?utm_source=x', url_hash: 'https://example.com/a?utm_source=x' }),
  ]);

  assert.equal(plan.groups.length, 0);
  assert.deepEqual(plan.hashRewrites, [{ id: 'a', url_hash: 'https://example.com/a' }]);
});

test('does not rewrite a hash that already matches the canonical URL', () => {
  const plan = planBookmarkDeduplication([row({ id: 'a' })]);
  assert.equal(plan.groups.length, 0);
  assert.equal(plan.hashRewrites.length, 0);
});

test('only the surviving keeper is listed for a hash rewrite, not the deleted dups', () => {
  const plan = planBookmarkDeduplication([
    row({ id: 'a', created_at: '2026-06-01T00:00:00.000Z', url: 'https://example.com/a?utm_source=x', url_hash: 'wrong' }),
    row({ id: 'b', created_at: '2026-06-02T00:00:00.000Z', url: 'https://example.com/a', url_hash: 'wrong' }),
  ]);

  assert.deepEqual(plan.groups[0].duplicateIds, ['b']);
  // Only the keeper (a) gets a rewrite; b is being deleted.
  assert.deepEqual(plan.hashRewrites, [{ id: 'a', url_hash: 'https://example.com/a' }]);
});

test('scopes grouping per user and ignores archived twins', () => {
  const plan = planBookmarkDeduplication([
    row({ id: 'u1-a', user_id: 'user-1' }),
    row({ id: 'u2-a', user_id: 'user-2' }),
    row({ id: 'u1-archived', user_id: 'user-1', is_archived: true }),
  ]);

  // Different users don't merge, and the archived row is left out of grouping.
  assert.equal(plan.groups.length, 0);
});

test('ignores rows without a URL', () => {
  const plan = planBookmarkDeduplication([
    row({ id: 'a', url: null, url_hash: null }),
    row({ id: 'b', url: null, url_hash: null }),
  ]);
  assert.equal(plan.groups.length, 0);
  assert.equal(plan.hashRewrites.length, 0);
});
