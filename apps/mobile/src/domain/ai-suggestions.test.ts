import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addDismissedFolderToken,
  addReviewedNames,
  dismissedFolderTokensFor,
  parseDismissedFolderMap,
  parseReviewedMap,
  pendingSuggestedFolder,
  pendingSuggestions,
  resolveSuggestedFolder,
  reviewedNamesFor,
  suggestedFolderToken,
  suggestedFolderTokens,
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

function makeFolderEnrichment(overrides: Partial<AIEnrichment>): AIEnrichment {
  return { ...makeEnrichment([]), ...overrides };
}

const COLLECTIONS = [
  { id: 'col-recipes', name: 'Recipes' },
  { id: 'col-watch', name: 'Watch Later' },
];

test('resolveSuggestedFolder files into the collection resolved by id', () => {
  const enrichment = makeFolderEnrichment({ suggested_collection_id: 'col-recipes' });
  assert.deepEqual(resolveSuggestedFolder(enrichment, COLLECTIONS, null), {
    kind: 'existing',
    id: 'col-recipes',
    name: 'Recipes',
  });
});

test('resolveSuggestedFolder re-matches a name tolerantly when no id resolved', () => {
  // The edge function left the id null, but the user has a matching folder
  // (different spacing/case) — file into it rather than offering to create.
  const enrichment = makeFolderEnrichment({ suggested_collection_name: 'watch-later' });
  assert.deepEqual(resolveSuggestedFolder(enrichment, COLLECTIONS, null), {
    kind: 'existing',
    id: 'col-watch',
    name: 'Watch Later',
  });
});

test('resolveSuggestedFolder offers to create when nothing matches', () => {
  const enrichment = makeFolderEnrichment({ suggested_collection_name: 'Travel' });
  assert.deepEqual(resolveSuggestedFolder(enrichment, COLLECTIONS, null), {
    kind: 'create',
    name: 'Travel',
  });
});

test('resolveSuggestedFolder returns null when already in the suggested folder', () => {
  const enrichment = makeFolderEnrichment({ suggested_collection_id: 'col-recipes' });
  assert.equal(resolveSuggestedFolder(enrichment, COLLECTIONS, 'col-recipes'), null);
});

test('resolveSuggestedFolder returns null with no hint or no enrichment', () => {
  assert.equal(resolveSuggestedFolder(null, COLLECTIONS, null), null);
  assert.equal(resolveSuggestedFolder(makeFolderEnrichment({}), COLLECTIONS, null), null);
});

test('suggestedFolderToken keys "file into" by id and "create" by tolerant name', () => {
  assert.equal(suggestedFolderToken({ kind: 'existing', id: 'col-recipes', name: 'Recipes' }), 'id:col-recipes');
  // The create token folds case/spacing/punctuation, so "Watch Later" and
  // "watch-later" map to the same dismissal — re-proposing it stays hidden.
  assert.equal(suggestedFolderToken({ kind: 'create', name: 'Watch Later' }), 'name:watchlater');
  assert.equal(suggestedFolderToken({ kind: 'create', name: 'watch-later' }), 'name:watchlater');
});

test('addDismissedFolderToken merges per bookmark and is idempotent by reference', () => {
  const empty: ReturnType<typeof parseDismissedFolderMap> = {};
  const once = addDismissedFolderToken(empty, 'b1', 'id:col-recipes');
  assert.deepEqual([...dismissedFolderTokensFor(once, 'b1')], ['id:col-recipes']);
  // Re-dismissing the same token returns the SAME reference (no re-persist).
  assert.equal(addDismissedFolderToken(once, 'b1', 'id:col-recipes'), once);
  // A different token for the same bookmark accumulates.
  const twice = addDismissedFolderToken(once, 'b1', 'name:travel');
  assert.deepEqual([...dismissedFolderTokensFor(twice, 'b1')], ['id:col-recipes', 'name:travel']);
  // Other bookmarks are untouched.
  assert.deepEqual([...dismissedFolderTokensFor(twice, 'b2')], []);
});

test('parseDismissedFolderMap tolerates malformed JSON', () => {
  assert.deepEqual(parseDismissedFolderMap(null), {});
  assert.deepEqual(parseDismissedFolderMap('not json'), {});
  assert.deepEqual(parseDismissedFolderMap('{"b1":["id:col-x"]}'), { b1: ['id:col-x'] });
});

test('suggestedFolderTokens lists the resolved-form token plus the proposed-name key', () => {
  // A file-into suggestion: both the id token and the AI's name key identify it.
  assert.deepEqual(
    suggestedFolderTokens({ kind: 'existing', id: 'col-recipes', name: 'Recipes' }, 'Recipes'),
    ['id:col-recipes', 'name:recipes'],
  );
  // A create suggestion: the resolved token already IS the name key — deduped.
  assert.deepEqual(suggestedFolderTokens({ kind: 'create', name: 'Travel' }, 'Travel'), [
    'name:travel',
  ]);
  // No resolved folder but a proposed name (e.g. computing tokens to dismiss a
  // create chip) still yields the name key.
  assert.deepEqual(suggestedFolderTokens(null, 'Travel'), ['name:travel']);
  // Nothing to key on.
  assert.deepEqual(suggestedFolderTokens(null, null), []);
});

test('pendingSuggestedFolder returns the folder when nothing is dismissed', () => {
  const enrichment = makeFolderEnrichment({ suggested_collection_id: 'col-recipes' });
  assert.deepEqual(pendingSuggestedFolder(enrichment, COLLECTIONS, null, new Set()), {
    kind: 'existing',
    id: 'col-recipes',
    name: 'Recipes',
  });
});

test('pendingSuggestedFolder suppresses a folder dismissed by its id token', () => {
  const enrichment = makeFolderEnrichment({ suggested_collection_id: 'col-recipes' });
  assert.equal(
    pendingSuggestedFolder(enrichment, COLLECTIONS, null, new Set(['id:col-recipes'])),
    null,
  );
});

test('pendingSuggestedFolder suppresses a name-matched folder dismissed earlier as "create"', () => {
  // Dismissed when it was a "create Recipes" chip (name token); a matching folder
  // now exists so it resolves to "file into" — the name-keyed dismissal still wins.
  const enrichment = makeFolderEnrichment({ suggested_collection_name: 'recipes' });
  assert.equal(
    pendingSuggestedFolder(enrichment, COLLECTIONS, null, new Set(['name:recipes'])),
    null,
  );
});

test('pendingSuggestedFolder ignores an unrelated dismissal', () => {
  const enrichment = makeFolderEnrichment({ suggested_collection_id: 'col-recipes' });
  assert.deepEqual(pendingSuggestedFolder(enrichment, COLLECTIONS, null, new Set(['name:travel'])), {
    kind: 'existing',
    id: 'col-recipes',
    name: 'Recipes',
  });
});
