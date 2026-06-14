import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pendingSuggestions, SUGGESTION_MIN_CONFIDENCE } from './ai-suggestions.ts';
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
    model: 'dummy-v0',
    status: 'complete',
    confidence: null,
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
