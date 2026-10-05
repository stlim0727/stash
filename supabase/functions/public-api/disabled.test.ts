import assert from 'node:assert/strict';
import { test } from 'node:test';

test('default-disabled public API rejects historical/self-created keys before DB I/O', async () => {
  let handler: (req: Request) => Promise<Response>;
  let calls = 0;
  Object.assign(globalThis, { Deno: {
    env: { get: () => undefined },
    serve: (registered: typeof handler) => { handler = registered; },
  } });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls++; throw new Error('No network permitted'); };
  try {
    await import('./index.ts');
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      const res = await handler!(new Request('https://example.test/public-api/bookmarks', {
        method, headers: { Authorization: 'Bearer stash_self_created_key' },
      }));
      assert.equal(res.status, 403);
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
