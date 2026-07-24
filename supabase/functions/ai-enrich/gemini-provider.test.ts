import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GeminiContentError, GeminiProvider, type FetchLike } from './gemini-provider.ts';
import type { EnrichmentInput } from './provider.ts';

function input(overrides: Partial<EnrichmentInput> = {}): EnrichmentInput {
  return {
    url: 'https://github.com/facebook/react',
    title: 'React',
    description: null,
    notes: null,
    site_name: 'GitHub',
    content_type: 'url',
    ...overrides,
  };
}

/** A fetch stub that returns one Gemini generateContent response and records
 *  the request it was called with. */
function stubFetch(
  modelJson: unknown,
  opts: { ok?: boolean; status?: number; usageMetadata?: unknown } = {},
) {
  const calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }> = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, init });
    const body =
      opts.ok === false
        ? 'rate limit exceeded'
        : JSON.stringify({
            candidates: [{ content: { parts: [{ text: JSON.stringify(modelJson) }] } }],
            ...(opts.usageMetadata ? { usageMetadata: opts.usageMetadata } : {}),
          });
    return Promise.resolve({
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      text: () => Promise.resolve(body),
    });
  };
  return { fetchImpl, calls };
}

test('parses a well-formed model response into an EnrichmentOutput', async () => {
  const { fetchImpl } = stubFetch({
    summary: 'The React source repository on GitHub.',
    topics: ['react', 'javascript'],
    suggested_tags: [
      { name: 'programming', confidence: 0.9 },
      { name: 'react', confidence: 0.8 },
    ],
    suggested_collection: 'Development',
    confidence: 0.85,
  });
  const provider = new GeminiProvider({ apiKey: 'k', fetchImpl });

  const out = await provider.enrich(input());
  assert.equal(out.summary, 'The React source repository on GitHub.');
  assert.deepEqual(out.topics, ['react', 'javascript']);
  assert.equal(out.suggested_collection, 'Development');
  assert.equal(out.confidence, 0.85);
  assert.equal(out.suggested_tags.length, 2);
});

test('clamps out-of-range confidences and caps tags at five', async () => {
  const { fetchImpl } = stubFetch({
    summary: '',
    topics: [],
    suggested_tags: [
      { name: 'a', confidence: 1.7 },
      { name: 'b', confidence: -0.5 },
      { name: 'c', confidence: 0.5 },
      { name: 'd', confidence: 0.5 },
      { name: 'e', confidence: 0.5 },
      { name: 'f', confidence: 0.5 },
    ],
    suggested_collection: null,
    confidence: 9,
  });
  const provider = new GeminiProvider({ apiKey: 'k', fetchImpl });

  const out = await provider.enrich(input());
  assert.equal(out.suggested_tags.length, 5);
  assert.equal(out.suggested_tags[0].confidence, 1);
  assert.equal(out.suggested_tags[1].confidence, 0);
  assert.equal(out.confidence, 1);
  // Empty summary string becomes null.
  assert.equal(out.summary, null);
});

test('sends the api key header and existing collection names in the prompt', async () => {
  const { fetchImpl, calls } = stubFetch({
    summary: null,
    topics: [],
    suggested_tags: [],
    suggested_collection: null,
    confidence: null,
  });
  const provider = new GeminiProvider({ apiKey: 'secret-key', model: 'gemini-2.5-flash', fetchImpl });

  await provider.enrich(input({ collections: ['Development', 'Reading'] }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.headers?.['x-goog-api-key'], 'secret-key');
  assert.match(calls[0].url, /models\/gemini-2\.5-flash:generateContent$/);
  assert.match(calls[0].init?.body ?? '', /Development, Reading/);
});

test('includes the user\'s existing tags and asks the model to reuse them', async () => {
  const { fetchImpl, calls } = stubFetch({
    summary: null,
    topics: [],
    suggested_tags: [],
    suggested_collection: null,
    confidence: null,
  });
  const provider = new GeminiProvider({ apiKey: 'k', fetchImpl });

  await provider.enrich(input({ existing_tags: ['swimming', 'korean food', 'recipe'] }));
  const body = calls[0].init?.body ?? '';
  // The vocabulary rides in the prompt, most-used first (as passed)…
  assert.match(body, /Existing tags \(reuse when one fits\): swimming, korean food, recipe/);
  // …and the system instruction tells the model to reuse rather than duplicate.
  assert.match(body, /reuse its exact name verbatim/);
});

test('tells the model to derive tags from non-title metadata too', async () => {
  const { fetchImpl, calls } = stubFetch({
    summary: null,
    topics: [],
    suggested_tags: [],
    suggested_collection: null,
    confidence: null,
  });
  const provider = new GeminiProvider({ apiKey: 'k', fetchImpl });

  await provider.enrich(
    input({
      url: 'https://example.com/research/vector-database-guide',
      title: 'Example',
      description: 'A practical guide to vector databases and semantic search.',
      notes: 'Compare indexing strategies for search infrastructure.',
      site_name: 'Example Docs',
    }),
  );
  const body = calls[0].init?.body ?? '';

  assert.match(body, /Description: A practical guide to vector databases/);
  assert.match(body, /User notes: Compare indexing strategies/);
  assert.match(body, /Tagging guidance: derive tags from the combined metadata above, not just the title/);
  assert.match(body, /description, user notes, site name, content type, and meaningful URL path terms are as important as the title/);
});

test('tells the model not to reuse generic media buckets as real suggestions', async () => {
  const { fetchImpl, calls } = stubFetch({
    summary: null,
    topics: [],
    suggested_tags: [],
    suggested_collection: null,
    confidence: null,
  });
  const provider = new GeminiProvider({ apiKey: 'k', fetchImpl });

  await provider.enrich(input({ collections: ['Watch later'], existing_tags: ['비디오'] }));
  const body = calls[0].init?.body ?? '';

  assert.match(body, /Do not suggest labels that only describe the storage action or media format/);
  assert.match(body, /watch later/);
  assert.match(body, /비디오/);
});

test('drops generic media tags and collections from model output', async () => {
  const { fetchImpl } = stubFetch({
    summary: 'A video about prompt engineering workflows.',
    topics: ['video', 'prompt engineering'],
    suggested_tags: [
      { name: '비디오', confidence: 0.91 },
      { name: 'prompt engineering', confidence: 0.82 },
      { name: 'WatchLater', confidence: 0.77 },
      { name: '나중에보기', confidence: 0.76 },
      { name: 'Watch List', confidence: 0.75 },
      { name: 'Watch: Later', confidence: 0.74 },
      { name: 'Watch + Later', confidence: 0.73 },
      { name: '\u{1F4FA} Watch Later', confidence: 0.72 },
    ],
    suggested_collection: 'Watch + Later',
    confidence: null,
  });
  const provider = new GeminiProvider({ apiKey: 'k', fetchImpl });

  const out = await provider.enrich(
    input({
      url: 'https://www.youtube.com/watch?v=abc',
      title: 'Prompt engineering patterns',
      content_type: 'video',
      collections: ['Watch later'],
      existing_tags: ['비디오'],
    }),
  );

  assert.deepEqual(out.suggested_tags, [{ name: 'prompt engineering', confidence: 0.82 }]);
  assert.equal(out.suggested_collection, null);
  assert.equal(out.confidence, 0.82);
});

test('tells the model not to just restate the title as the summary', async () => {
  const { fetchImpl, calls } = stubFetch({
    summary: null,
    topics: [],
    suggested_tags: [],
    suggested_collection: null,
    confidence: null,
  });
  const provider = new GeminiProvider({ apiKey: 'k', fetchImpl });

  await provider.enrich(input());
  const body = calls[0].init?.body ?? '';
  assert.match(body, /Never just restate, rephrase, or translate the title/);
  assert.match(body, /Null if the metadata gives nothing beyond what the title already says/);
});

test('omits the existing-tags line when the user has no tags yet', async () => {
  const { fetchImpl, calls } = stubFetch({
    summary: null,
    topics: [],
    suggested_tags: [],
    suggested_collection: null,
    confidence: null,
  });
  const provider = new GeminiProvider({ apiKey: 'k', fetchImpl });

  await provider.enrich(input());
  assert.doesNotMatch(calls[0].init?.body ?? '', /Existing tags/);
});

test('asks the model to answer in the user locale when one is given', async () => {
  const { fetchImpl, calls } = stubFetch({
    summary: null,
    topics: [],
    suggested_tags: [],
    suggested_collection: null,
    confidence: null,
  });
  const provider = new GeminiProvider({ apiKey: 'k', fetchImpl });

  await provider.enrich(input({ locale: 'ko-KR' }));
  // The free-text fields are requested in Korean; the collection name is not
  // (it must match an existing name verbatim).
  assert.match(calls[0].init?.body ?? '', /summary, suggested_tags, and topics in Korean/);
  // …and the directive is also in the system instruction, authoritatively, so
  // short keyword tags don't come back in the source content's language.
  assert.match(calls[0].init?.body ?? '', /regardless of the language of the bookmark/);
});

test('defaults to English when the locale is missing or unknown', async () => {
  const { fetchImpl, calls } = stubFetch({
    summary: null,
    topics: [],
    suggested_tags: [],
    suggested_collection: null,
    confidence: null,
  });
  const provider = new GeminiProvider({ apiKey: 'k', fetchImpl });

  await provider.enrich(input({ locale: 'fr' }));
  assert.match(calls[0].init?.body ?? '', /summary, suggested_tags, and topics in English/);
});

test('aborts and throws when the endpoint hangs past the timeout', async () => {
  // A fetch that never resolves on its own, but rejects when the signal aborts.
  const fetchImpl: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      );
    });
  const provider = new GeminiProvider({ apiKey: 'k', timeoutMs: 10, fetchImpl });
  await assert.rejects(() => provider.enrich(input()), /timed out after 10ms/);
});

test('throws on a non-ok response so the caller can fall back', async () => {
  const { fetchImpl } = stubFetch(null, { ok: false, status: 429 });
  const provider = new GeminiProvider({ apiKey: 'k', fetchImpl });
  await assert.rejects(() => provider.enrich(input()), /429/);
});

test('reports the real token usage from the response', async () => {
  const { fetchImpl } = stubFetch(
    {
      summary: null,
      topics: [],
      suggested_tags: [],
      suggested_collection: null,
      confidence: null,
    },
    { usageMetadata: { promptTokenCount: 712, candidatesTokenCount: 238, totalTokenCount: 950 } },
  );
  const provider = new GeminiProvider({ apiKey: 'k', fetchImpl });

  const out = await provider.enrich(input());
  assert.deepEqual(out.usage, { prompt_tokens: 712, output_tokens: 238, total_tokens: 950 });
});

test('folds thinking tokens into output_tokens', async () => {
  const { fetchImpl } = stubFetch(
    {
      summary: null,
      topics: [],
      suggested_tags: [],
      suggested_collection: null,
      confidence: null,
    },
    {
      usageMetadata: {
        promptTokenCount: 700,
        candidatesTokenCount: 100,
        thoughtsTokenCount: 400,
        totalTokenCount: 1200,
      },
    },
  );
  const provider = new GeminiProvider({ apiKey: 'k', fetchImpl });

  const out = await provider.enrich(input());
  assert.deepEqual(out.usage, { prompt_tokens: 700, output_tokens: 500, total_tokens: 1200 });
});

test('preserves usage in a GeminiContentError when a 200 response has no usable candidate', async () => {
  const fetchImpl: FetchLike = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            candidates: [],
            usageMetadata: { promptTokenCount: 650, candidatesTokenCount: 0, totalTokenCount: 650 },
          }),
        ),
    });
  const provider = new GeminiProvider({ apiKey: 'k', fetchImpl });

  await assert.rejects(
    () => provider.enrich(input()),
    (err: unknown) => {
      assert.ok(err instanceof GeminiContentError);
      assert.deepEqual(err.usage, { prompt_tokens: 650, output_tokens: 0, total_tokens: 650 });
      return true;
    },
  );
});

test('reports null usage when the response has no usageMetadata', async () => {
  const { fetchImpl } = stubFetch({
    summary: null,
    topics: [],
    suggested_tags: [],
    suggested_collection: null,
    confidence: null,
  });
  const provider = new GeminiProvider({ apiKey: 'k', fetchImpl });

  const out = await provider.enrich(input());
  assert.equal(out.usage, null);
});

test('reports its model id with a gemini prefix', () => {
  const provider = new GeminiProvider({ apiKey: 'k', model: 'gemini-2.5-flash', fetchImpl: stubFetch(null).fetchImpl });
  assert.equal(provider.model, 'gemini:gemini-2.5-flash');
});

test('requires an api key', () => {
  assert.throws(() => new GeminiProvider({ apiKey: '', fetchImpl: stubFetch(null).fetchImpl }));
});

// ── Batch worker path (STASH #578 Phase 2) ──────────────────────────────────

test('enrichBatch sends one call embedding all items and maps results back in order', async () => {
  const { fetchImpl, calls } = stubFetch([
    {
      summary: 'First item summary.',
      topics: ['a'],
      suggested_tags: [{ name: 'alpha', confidence: 0.9 }],
      suggested_collection: null,
      confidence: 0.9,
    },
    {
      summary: 'Second item summary.',
      topics: ['b'],
      suggested_tags: [{ name: 'beta', confidence: 0.8 }],
      suggested_collection: 'Cooking',
      confidence: 0.8,
    },
  ]);
  const provider = new GeminiProvider({ apiKey: 'k', fetchImpl });

  const { outputs, usage } = await provider.enrichBatch([
    input({ title: 'First' }),
    input({ title: 'Second' }),
  ]);

  assert.equal(calls.length, 1);
  assert.equal(outputs.length, 2);
  assert.equal(outputs[0].summary, 'First item summary.');
  assert.equal(outputs[1].summary, 'Second item summary.');
  assert.equal(outputs[1].suggested_collection, 'Cooking');
  assert.equal(usage, null);
  const body = calls[0].init?.body ?? '';
  assert.match(body, /Item 1:/);
  assert.match(body, /Item 2:/);
  assert.match(body, /First/);
  assert.match(body, /Second/);
  assert.match(body, /JSON array of exactly 2 objects/);
});

test('enrichBatch lets each item request its own language independently', async () => {
  const { fetchImpl, calls } = stubFetch([
    { summary: null, topics: [], suggested_tags: [], suggested_collection: null, confidence: null },
    { summary: null, topics: [], suggested_tags: [], suggested_collection: null, confidence: null },
  ]);
  const provider = new GeminiProvider({ apiKey: 'k', fetchImpl });

  await provider.enrichBatch([input({ locale: 'ko' }), input({ locale: 'en' })]);
  const body = calls[0].init?.body ?? '';
  assert.match(body, /Item 1:[\s\S]*Write this item's summary, suggested_tags, and topics in Korean/);
  assert.match(body, /Item 2:[\s\S]*Write this item's summary, suggested_tags, and topics in English/);
});

test('enrichBatch returns an empty result without calling Gemini for zero inputs', async () => {
  const { fetchImpl, calls } = stubFetch([]);
  const provider = new GeminiProvider({ apiKey: 'k', fetchImpl });

  const { outputs, usage } = await provider.enrichBatch([]);
  assert.deepEqual(outputs, []);
  assert.equal(usage, null);
  assert.equal(calls.length, 0);
});

test('enrichBatch throws when the model returns the wrong array length', async () => {
  const { fetchImpl } = stubFetch([
    { summary: null, topics: [], suggested_tags: [], suggested_collection: null, confidence: null },
  ]);
  const provider = new GeminiProvider({ apiKey: 'k', fetchImpl });

  await assert.rejects(
    () => provider.enrichBatch([input(), input()]),
    (err: unknown) => {
      assert.ok(err instanceof GeminiContentError);
      assert.match(err.message, /expected an array of 2, got an array of 1/);
      return true;
    },
  );
});

test('enrichBatch throws when the model returns a non-array', async () => {
  const { fetchImpl } = stubFetch({ not: 'an array' });
  const provider = new GeminiProvider({ apiKey: 'k', fetchImpl });

  await assert.rejects(
    () => provider.enrichBatch([input()]),
    (err: unknown) => {
      assert.ok(err instanceof GeminiContentError);
      assert.match(err.message, /expected an array of 1, got object/);
      return true;
    },
  );
});

test('enrichBatch reports the real usage for the whole call, not per item', async () => {
  const { fetchImpl } = stubFetch(
    [
      { summary: null, topics: [], suggested_tags: [], suggested_collection: null, confidence: null },
      { summary: null, topics: [], suggested_tags: [], suggested_collection: null, confidence: null },
    ],
    { usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 300, totalTokenCount: 1200 } },
  );
  const provider = new GeminiProvider({ apiKey: 'k', fetchImpl });

  const { usage } = await provider.enrichBatch([input(), input()]);
  assert.deepEqual(usage, { prompt_tokens: 900, output_tokens: 300, total_tokens: 1200 });
});

test('enrichBatch aborts and throws when the endpoint hangs past the timeout', async () => {
  const fetchImpl: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      );
    });
  const provider = new GeminiProvider({ apiKey: 'k', timeoutMs: 10, fetchImpl });
  await assert.rejects(() => provider.enrichBatch([input()]), /Gemini batch request timed out after 10ms/);
});

test('enrichBatch throws on a non-ok response', async () => {
  const { fetchImpl } = stubFetch(null, { ok: false, status: 429 });
  const provider = new GeminiProvider({ apiKey: 'k', fetchImpl });
  await assert.rejects(() => provider.enrichBatch([input()]), /Gemini batch request failed \(429\)/);
});
