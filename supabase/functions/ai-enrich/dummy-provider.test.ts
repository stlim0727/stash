import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DummyProvider } from './dummy-provider.ts';
import type { EnrichmentInput } from './provider.ts';

const provider = new DummyProvider();

function input(overrides: Partial<EnrichmentInput> = {}): EnrichmentInput {
  return {
    url: null,
    title: null,
    description: null,
    notes: null,
    site_name: null,
    content_type: 'url',
    ...overrides,
  };
}

const EMPTY = {
  summary: null,
  topics: [],
  suggested_tags: [],
  suggested_collection: null,
  confidence: null,
};

test('is tagged with the dummy-v0 model id (the fallback the client keys off)', () => {
  assert.equal(provider.model, 'dummy-v0');
});

test('suggests nothing — no tags, no collection, no summary — for any URL', async () => {
  // Even a URL the old heuristics would have matched (github → "programming")
  // now yields nothing: broad keyword categories were noise, not suggestions.
  const out = await provider.enrich(input({ url: 'https://github.com/facebook/react', title: 'React' }));
  assert.deepEqual(out, EMPTY);
});

test('suggests nothing for an unmatched URL', async () => {
  const out = await provider.enrich(input({ url: 'https://kittens.example/page' }));
  assert.deepEqual(out, EMPTY);
});

test('suggests nothing for a text-only share', async () => {
  const out = await provider.enrich(input({ url: null, notes: 'just a thought' }));
  assert.deepEqual(out, EMPTY);
});

test('ignores locale — there is nothing to localize', async () => {
  const out = await provider.enrich(
    input({ url: 'https://github.com/facebook/react', title: 'React', locale: 'ko' }),
  );
  assert.deepEqual(out, EMPTY);
});

test('is deterministic — same (empty) output regardless of input', async () => {
  const a = await provider.enrich(input({ url: 'https://figma.com/file/x', notes: 'design system' }));
  const b = await provider.enrich(input({ url: 'https://youtube.com/watch?v=abc' }));
  assert.deepEqual(a, EMPTY);
  assert.deepEqual(b, EMPTY);
});
