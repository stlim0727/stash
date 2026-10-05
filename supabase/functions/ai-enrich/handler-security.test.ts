import assert from 'node:assert/strict';
import { test } from 'node:test';

const bookmarkId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000000002';
const row = { id: bookmarkId, user_id: userId, title: 'Test', content_type: 'url', url: 'https://example.test' };

test('synchronous, trigger and worker paths never call Gemini without explicit user/global approval', async () => {
  let handler: (req: Request) => Promise<Response>;
  const env: Record<string, string> = { SUPABASE_URL: 'https://project.test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service', GEMINI_API_KEY: 'test-key', AI_ENRICH_TRIGGER_SECRET: 'secret' };
  Object.assign(globalThis, { Deno: { env: { get: (key: string) => env[key] }, serve: (registered: typeof handler) => { handler = registered; } } });
  let userVerdict: unknown = { allowed: true };
  let globalVerdict: unknown = { allowed: true };
  let failure: 'user' | 'user-http' | 'global' | null = null;
  let providerCalls = 0;
  const settled: Array<Record<string, unknown>> = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (path.includes('generativelanguage.googleapis.com')) { providerCalls++; throw new Error('No provider call permitted'); }
    if (path.includes('request_ai_enrichment_slot')) {
      if (failure === 'user-http') return new Response('', { status: 500 });
      if (failure === 'user') throw new Error('Limiter unavailable');
      return Response.json(userVerdict);
    }
    if (path.includes('reserve_ai_enrichment_budget')) {
      if (failure === 'global') return new Response('', { status: 500 });
      return Response.json(globalVerdict);
    }
    if (path.includes('claim_pending_ai_enrichment_batch')) return Response.json([{ id: 'queue-1', bookmark_id: bookmarkId, user_id: userId, attempts: 0, locale: 'en' }]);
    if (path.includes('/pending_ai_enrichment') && init?.method === 'PATCH') settled.push(JSON.parse(String(init.body)));
    if (path.includes('/bookmarks?')) return Response.json([row]);
    return Response.json([]);
  };
  try {
    await import('./index.ts');
    for (const caller of ['user', 'server', 'worker']) {
      for (const scenario of ['user-null', 'user-missing', 'user-string', 'user-failure', 'user-http', 'global-null', 'global-denied', 'global-failure']) {
        userVerdict = { allowed: true }; globalVerdict = { allowed: true }; failure = null;
        if (scenario === 'user-null') userVerdict = null;
        if (scenario === 'user-missing') userVerdict = {};
        if (scenario === 'user-string') userVerdict = { allowed: 'true' };
        if (scenario === 'user-failure') failure = 'user';
        if (scenario === 'user-http') failure = 'user-http';
        if (scenario === 'global-null') globalVerdict = null;
        if (scenario === 'global-denied') globalVerdict = { allowed: false, reason: 'global_budget_limit' };
        if (scenario === 'global-failure') failure = 'global';
        const res = await handler!(new Request('https://project.test/ai-enrich', {
          method: 'POST', headers: caller === 'user' ? { Authorization: 'Bearer registered-user' } : { 'x-ai-enrich-secret': 'secret' },
          body: JSON.stringify(caller === 'worker' ? { batch_worker: true } : { bookmark_id: bookmarkId, locale: 'en' }),
        }));
        assert.equal(providerCalls, 0, `${caller}: ${scenario}`);
        assert.ok(caller === 'worker' ? res.status === 200 : [429, 503].includes(res.status), `${caller}: ${scenario}: ${res.status}`);
        if (caller === 'worker') assert.deepEqual(await res.json(), { processed: 0, deferred: 1 });
      }
    }
    assert.ok(settled.length > 0);
    assert.ok(settled.every((entry) => entry.status === 'pending' && entry.attempts === 0));
    userVerdict = { allowed: true }; globalVerdict = { allowed: true }; failure = null;
    await handler!(new Request('https://project.test/ai-enrich', {
      method: 'POST', headers: { Authorization: 'Bearer registered-user' },
      body: JSON.stringify({ bookmark_id: bookmarkId, locale: 'en' }),
    }));
    assert.equal(providerCalls, 1, 'explicit user and global permission reaches the provider');
  } finally {
    globalThis.fetch = previousFetch;
  }
});
