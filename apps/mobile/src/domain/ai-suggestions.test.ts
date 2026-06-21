import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addReviewedNames,
  parseReviewedMap,
  pendingSuggestions,
  reviewedNamesFor,
  SUGGESTION_MIN_CONFIDENCE,
} from './ai-suggestions.ts';
import type { AIEnrichment, SuggestedTag } from './types.ts';

function makeEnrichment(suggested_tags: SuggestedTag[]): AIEnrichment {
  const now = '2026-06-12T00:00:00.000Z';
  return {
    id: 'enrichment-test',
    bookmark_id: 'bookmark-test',
    user_id: 'user-test',
    summary: null,
    topics: [],
    suggested_tags,
    suggested_collection_id: null,
    suggested_collection_name: null,
    model: 'dummy-v0',
    status: 'complete',
    confidence: null,
    degraded: false,
    degraded_reason: null,
    created_at: now,
    updated_at: now,
  };
}

test('the threshold is documented at 0.6', () => {
  assert.equal(SUGGESTION_MIN_CONFIDENCE, 0.6);
});

test('keeps only suggestions at or above the confidence threshold', () => {
  const enrichment = makeEnrichment([
    { name: 'design', confidence: 0.9 },
    { name: 'video', confidence: 0.6 },
    { name: 'noise', confidence: 0.59 },
    { name: 'low', confidence: 0.2 },
  ]);

  const result = pendingSuggestions(enrichment, new Set());

  assert.deepEqual(
    result.map((s) => s.name),
    ['design', 'video'],
  );
});

test('drops suggestions whose name is already applied, case-insensitively', () => {
  const enrichment = makeEnrichment([
    { name: 'Design', confidence: 0.9 },
    { name: 'video', confidence: 0.8 },
  ]);

  const result = pendingSuggestions(enrichment, new Set(['design']));

  assert.deepEqual(
    result.map((s) => s.name),
    ['video'],
  );
});

test('combines the threshold and applied-name filters', () => {
  const enrichment = makeEnrichment([
    { name: 'design', confidence: 0.9 }, // applied -> dropped
    { name: 'video', confidence: 0.5 }, // below threshold -> dropped
    { name: 'react', confidence: 0.7 }, // kept
  ]);

  const result = pendingSuggestions(enrichment, new Set(['design']));

  assert.deepEqual(
    result.map((s) => s.name),
    ['react'],
  );
});

test('returns an empty list for missing or empty enrichment', () => {
  assert.deepEqual(pendingSuggestions(undefined, new Set()), []);
  assert.deepEqual(pendingSuggestions(null, new Set()), []);
  assert.deepEqual(pendingSuggestions(makeEnrichment([]), new Set()), []);
});

test('drops suggestions the user already reviewed, case-insensitively', () => {
  const enrichment = makeEnrichment([
    { name: 'Design', confidence: 0.9 },
    { name: 'video', confidence: 0.8 },
  ]);

  // Reviewed but NOT currently applied — the key case: accepting then removing a
  // tag must not resurface it as pending (the badge stays gone).
  const result = pendingSuggestions(enrichment, new Set(), new Set(['design']));

  assert.deepEqual(
    result.map((s) => s.name),
    ['video'],
  );
});

test('parseReviewedMap tolerates missing and malformed values', () => {
  assert.deepEqual(parseReviewedMap(null), {});
  assert.deepEqual(parseReviewedMap('not json'), {});
  assert.deepEqual(parseReviewedMap('[]'), {});
  assert.deepEqual(parseReviewedMap('123'), {});
  assert.deepEqual(parseReviewedMap('{"b1":["x",1,"y"]}'), { b1: ['x', 'y'] });
});

test('reviewedNamesFor returns a lowercased set for a bookmark', () => {
  const map = { b1: ['Design', 'VIDEO'], b2: ['react'] };
  assert.deepEqual(reviewedNamesFor(map, 'b1'), new Set(['design', 'video']));
  assert.deepEqual(reviewedNamesFor(map, 'missing'), new Set());
});

test('addReviewedNames merges, lowercases and dedupes', () => {
  const next = addReviewedNames({ b1: ['design'] }, 'b1', ['Video', ' design ', '']);
  assert.deepEqual(next, { b1: ['design', 'video'] });
});

test('addReviewedNames returns the same reference when nothing is new', () => {
  const map = { b1: ['design'] };
  // Already present (case-insensitively) and blank entries add nothing.
  assert.equal(addReviewedNames(map, 'b1', ['DESIGN', '  ']), map);
});

test('addReviewedNames creates an entry for a new bookmark', () => {
  assert.deepEqual(addReviewedNames({}, 'b2', ['React']), { b2: ['react'] });
});
