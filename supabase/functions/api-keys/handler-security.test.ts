import assert from 'node:assert/strict';
import { test } from 'node:test';

test('issuer rejects anonymous accounts and non-UUID revocation IDs before elevated writes', async () => {
  let handler: (req: Request) => Promise<Response>;
  let anonymous = false;
  let databaseCalls = 0;
  const userId = '00000000-0000-4000-8000-000000000001';
  Object.assign(globalThis, { Deno: {
    env: { get: (key: string) => key === 'SUPABASE_URL' ? 'https://project.test' : undefined },
    serve: (registered: typeof handler) => { handler = registered; },
  } });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/auth/v1/user')) return Response.json({ id: userId, is_anonymous: anonymous });
    databaseCalls++;
    return Response.json([]);
  };
  try {
    await import('./index.ts');
    const req = (path: string, method: string) => new Request(`https://project.test/api-keys${path}`, { method, headers: { Authorization: 'Bearer token' } });
    assert.equal((await handler!(req('/x&user_id=neq.other', 'DELETE'))).status, 400);
    assert.equal((await handler!(req('', 'POST'))).status, 403);
    anonymous = true;
    assert.equal((await handler!(req('', 'GET'))).status, 401);
    assert.equal(databaseCalls, 0);
    anonymous = false;
    assert.equal((await handler!(req(`/${userId}`, 'DELETE'))).status, 204);
    assert.equal(databaseCalls, 1);
  } finally { globalThis.fetch = previousFetch; }
});
