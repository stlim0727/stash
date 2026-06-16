import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TagData } from '@/storage/types';
import { sanitizeTagData } from './tag-data.ts';

function tag(id: string, name: string) {
  return { id, user_id: 'u', name, slug: name, source: 'user' as const, created_at: 'now' };
}
function collection(id: string, name: string) {
  return { id, user_id: 'u', name, description: null, created_at: 'now', updated_at: 'now' };
}
function link(bookmark_id: string, tag_id: string) {
  return { bookmark_id, tag_id, source: 'user' as const, confidence: null, created_at: 'now' };
}

test('drops blank-named tags and their orphaned links', () => {
  const data: TagData = {
    tags: [tag('t1', 'cooking'), tag('t2', ''), tag('t3', '   ')],
    bookmarkTags: [link('b1', 't1'), link('b1', 't2'), link('b1', 't3')],
    collections: [],
  };
  const { tagData, changed } = sanitizeTagData(data);
  assert.equal(changed, true);
  assert.deepEqual(
    tagData.tags.map((t) => t.id),
    ['t1'],
  );
  // Links to the removed blank tags are dropped too; the real one survives.
  assert.deepEqual(
    tagData.bookmarkTags.map((l) => l.tag_id),
    ['t1'],
  );
});

test('drops blank-named collections', () => {
  const data: TagData = {
    tags: [],
    bookmarkTags: [],
    collections: [collection('c1', 'Recipes'), collection('c2', '  ')],
  };
  const { tagData, changed } = sanitizeTagData(data);
  assert.equal(changed, true);
  assert.deepEqual(
    tagData.collections.map((c) => c.id),
    ['c1'],
  );
});

test('returns the same reference when nothing needs cleaning', () => {
  const data: TagData = {
    tags: [tag('t1', 'cooking')],
    bookmarkTags: [link('b1', 't1')],
    collections: [collection('c1', 'Recipes')],
  };
  const { tagData, changed } = sanitizeTagData(data);
  assert.equal(changed, false);
  assert.equal(tagData, data);
});

test('preserves non-Latin (e.g. Korean) names', () => {
  const data: TagData = {
    tags: [tag('t1', '요리'), tag('t2', '베이킹')],
    bookmarkTags: [link('b1', 't1')],
    collections: [collection('c1', '한식')],
  };
  const { tagData, changed } = sanitizeTagData(data);
  assert.equal(changed, false);
  assert.equal(tagData.tags.length, 2);
  assert.equal(tagData.collections.length, 1);
});
