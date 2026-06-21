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

test('suggests programming tag and Development collection for a GitHub repo', async () => {
  const out = await provider.enrich(
    input({ url: 'https://github.com/facebook/react', title: 'React' }),
  );
  const names = out.suggested_tags.map((tag) => tag.name);
  assert.ok(names.includes('programming'));
  assert.equal(out.suggested_collection, 'Development');
  assert.ok(out.topics.includes('programming'));
});

test('every suggested tag carries a 0..1 confidence', async () => {
  const out = await provider.enrich(input({ url: 'https://www.youtube.com/watch?v=abc' }));
  assert.ok(out.suggested_tags.length > 0);
  for (const tag of out.suggested_tags) {
    assert.ok(tag.confidence > 0 && tag.confidence <= 0.9, `confidence ${tag.confidence}`);
  }
  assert.ok(out.suggested_tags.some((tag) => tag.name === 'video'));
});

test('is deterministic — same input yields identical output', async () => {
  const args = input({ url: 'https://figma.com/file/x', notes: 'design system' });
  const a = await provider.enrich(args);
  const b = await provider.enrich(args);
  assert.deepEqual(a, b);
});

test('caps suggestions at five tags', async () => {
  const out = await provider.enrich(
    input({
      url: 'https://github.com/x',
      title: 'react typescript design figma video youtube blog arxiv docs amazon reddit',
    }),
  );
  assert.ok(out.suggested_tags.length <= 5);
});

test('suggests no tag (and null confidence) when nothing matches, rather than host noise', async () => {
  const out = await provider.enrich(input({ url: 'https://kittens.example/page' }));
  assert.deepEqual(out.suggested_tags, []);
  assert.equal(out.suggested_collection, null);
  assert.equal(out.confidence, null);
  // The summary still grounds the bookmark even with no tags to suggest.
  assert.match(out.summary ?? '', /dummy-v0/);
});

test('produces a summary for a URL and none for a text-only share', async () => {
  const withUrl = await provider.enrich(input({ url: 'https://example.com', title: 'Hi' }));
  assert.match(withUrl.summary ?? '', /dummy-v0/);

  const textOnly = await provider.enrich(input({ url: null, notes: 'just a thought' }));
  assert.equal(textOnly.summary, null);
});

test('localizes heuristic tags and topics for a Korean locale', async () => {
  const out = await provider.enrich(
    input({ url: 'https://github.com/facebook/react', title: 'React', locale: 'ko' }),
  );
  const names = out.suggested_tags.map((tag) => tag.name);
  assert.ok(names.includes('프로그래밍'), `expected Korean tag, got: ${names.join(', ')}`);
  assert.ok(!names.includes('programming'), 'English tag should not leak through');
  assert.ok(out.topics.includes('프로그래밍'), `topics not localized: ${out.topics.join(', ')}`);
});

test('keeps English heuristic tags when locale is English or absent', async () => {
  const out = await provider.enrich(input({ url: 'https://github.com/facebook/react', locale: 'en' }));
  assert.ok(out.suggested_tags.map((tag) => tag.name).includes('programming'));
});
