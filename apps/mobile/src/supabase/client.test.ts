import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { errorMessageFrom, StashSupabaseClient, SupabaseRequestError } from './client.ts';

test('errorMessageFrom prefers GoTrue/PostgREST human-readable keys', () => {
  assert.equal(errorMessageFrom({ msg: 'bad login' }, 400), 'bad login');
  assert.equal(errorMessageFrom({ message: 'permission denied' }, 403), 'permission denied');
  assert.equal(
    errorMessageFrom({ error: 'invalid_grant', error_description: 'token expired' }, 401),
    'token expired',
  );
});

test('errorMessageFrom surfaces an edge function { error } body (was opaque before)', () => {
  // ai-enrich / feedback-bridge return { error: '…' }. Previously this fell
  // through to the HTTP fallback and the real reason was lost.
  assert.equal(errorMessageFrom({ error: 'Failed to save enrichment' }, 400), 'Failed to save enrichment');
  assert.equal(errorMessageFrom({ error: 'bookmark_id is required' }, 400), 'bookmark_id is required');
});

test('errorMessageFrom falls back to a plain-text body, then the HTTP status', () => {
  assert.equal(errorMessageFrom('gateway timeout', 504), 'gateway timeout');
  assert.equal(errorMessageFrom(null, 400), 'Supabase request failed with HTTP 400');
  assert.equal(errorMessageFrom({}, 500), 'Supabase request failed with HTTP 500');
  // Non-string keys are ignored, not coerced.
  assert.equal(errorMessageFrom({ error: 42 }, 400), 'Supabase request failed with HTTP 400');
});

test('signOut clears the local session even when the revoke request hangs (STASH-G)', async () => {
  // A wedged network (a hang, not an error) must not strand sign-out: the
  // local clear has to run regardless, or the logout button appears frozen
  // ("logout does not respond"). Without the timeout race, awaiting the
  // never-resolving fetch below would hang this test forever.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch;
  mock.timers.enable({ apis: ['setTimeout'] });

  try {
    const client = new StashSupabaseClient({
      url: 'https://proj.supabase.co',
      anonKey: 'anon-key',
    });
    const pending = client.signOut('access-token');
    // Fire the revoke timeout so the race settles on it instead of the fetch.
    mock.timers.tick(5000);
    await pending;
  } finally {
    mock.timers.reset();
    globalThis.fetch = originalFetch;
  }
});

test('updateUserMetadata issues PUT /auth/v1/user with { data } (GoTrue rejects PATCH)', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: 'user-1' }), { status: 200 });
  }) as typeof fetch;

  try {
    const client = new StashSupabaseClient({
      url: 'https://proj.supabase.co',
      anonKey: 'anon-key',
    });
    await client.updateUserMetadata('access-token', { app_version: '1.0.0-rc15' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://proj.supabase.co/auth/v1/user');
  // The regression this guards: must be PUT, not PATCH — GoTrue does not route
  // PATCH /user, so a PATCH silently fails and no app_version is ever written.
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(
    (calls[0].init.headers as Record<string, string>).Authorization,
    'Bearer access-token',
  );
  assert.deepEqual(JSON.parse(calls[0].init.body as string), {
    data: { app_version: '1.0.0-rc15' },
  });
});

test('request() carries the response body\'s reason onto SupabaseRequestError', async () => {
  // ai-enrich's 429 body is { error, reason, retry_after } — callers need
  // `reason` ('daily_limit' vs 'hourly_limit') to tell a quota-exhausted
  // rejection apart from any other rate limit.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ error: 'rate_limited', reason: 'daily_limit', retry_after: 3600 }),
      { status: 429 },
    )) as typeof fetch;

  try {
    const client = new StashSupabaseClient({
      url: 'https://proj.supabase.co',
      anonKey: 'anon-key',
    });
    await assert.rejects(
      client.request('/functions/v1/ai-enrich', { method: 'POST' }),
      (error: unknown) => {
        assert.ok(error instanceof SupabaseRequestError);
        assert.equal(error.status, 429);
        assert.equal(error.reason, 'daily_limit');
        assert.equal(error.retryAfterSeconds, 3600);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('requestCount() issues a HEAD request with Prefer: count=exact and reads the total off Content-Range', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    // PostgREST answers a HEAD request with an empty body and the exact total
    // in Content-Range — the response never carries the rows themselves.
    return new Response(null, {
      status: 200,
      headers: { 'content-range': '*/1101' },
    });
  }) as typeof fetch;

  try {
    const client = new StashSupabaseClient({
      url: 'https://proj.supabase.co',
      anonKey: 'anon-key',
    });
    const count = await client.requestCount('/rest/v1/pending_ai_enrichment?select=id', {
      accessToken: 'access-token',
    });
    assert.equal(count, 1101);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://proj.supabase.co/rest/v1/pending_ai_enrichment?select=id');
  assert.equal(calls[0].init.method, 'HEAD');
  assert.equal((calls[0].init.headers as Record<string, string>).Prefer, 'count=exact');
  assert.equal(
    (calls[0].init.headers as Record<string, string>).Authorization,
    'Bearer access-token',
  );
});

test('requestCount() throws a SupabaseRequestError when Content-Range is missing or unparseable', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;

  try {
    const client = new StashSupabaseClient({
      url: 'https://proj.supabase.co',
      anonKey: 'anon-key',
    });
    await assert.rejects(
      client.requestCount('/rest/v1/pending_ai_enrichment?select=id'),
      (error: unknown) => {
        assert.ok(error instanceof SupabaseRequestError);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('requestCount() surfaces a non-2xx response the same way request() does', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: 'permission denied' }), { status: 403 })) as typeof fetch;

  try {
    const client = new StashSupabaseClient({
      url: 'https://proj.supabase.co',
      anonKey: 'anon-key',
    });
    await assert.rejects(
      client.requestCount('/rest/v1/pending_ai_enrichment?select=id'),
      (error: unknown) => {
        assert.ok(error instanceof SupabaseRequestError);
        assert.equal((error as SupabaseRequestError).status, 403);
        assert.equal((error as SupabaseRequestError).message, 'permission denied');
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('request() leaves reason undefined when the response body has none', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: 'bookmark_id is required' }), { status: 400 })) as typeof fetch;

  try {
    const client = new StashSupabaseClient({
      url: 'https://proj.supabase.co',
      anonKey: 'anon-key',
    });
    await assert.rejects(client.request('/functions/v1/ai-enrich', { method: 'POST' }), (error: unknown) => {
      assert.ok(error instanceof SupabaseRequestError);
      assert.equal(error.reason, undefined);
      assert.equal(error.retryAfterSeconds, undefined);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('storageUploadTarget computes the object/public URLs and auth headers without making a network call', () => {
  const client = new StashSupabaseClient({
    url: 'https://proj.supabase.co',
    anonKey: 'anon-key',
  });

  const target = client.storageUploadTarget('bookmark-images', 'user-1/bookmark-1', {
    accessToken: 'access-token',
    contentType: 'image/jpeg',
  });

  assert.equal(target.uploadUrl, 'https://proj.supabase.co/storage/v1/object/bookmark-images/user-1/bookmark-1');
  assert.equal(
    target.publicUrl,
    'https://proj.supabase.co/storage/v1/object/public/bookmark-images/user-1/bookmark-1',
  );
  assert.equal(target.headers.apikey, 'anon-key');
  assert.equal(target.headers.Authorization, 'Bearer access-token');
  assert.equal(target.headers['Content-Type'], 'image/jpeg');
  assert.equal(target.headers['x-upsert'], 'true');
});

test('storageUploadTarget percent-encodes path segments (defends the URL structure, not just RLS)', () => {
  const client = new StashSupabaseClient({
    url: 'https://proj.supabase.co',
    anonKey: 'anon-key',
  });

  const target = client.storageUploadTarget('bookmark-images', 'user 1/bookmark#1', {
    accessToken: 'access-token',
    contentType: 'image/png',
  });

  assert.equal(
    target.uploadUrl,
    'https://proj.supabase.co/storage/v1/object/bookmark-images/user%201/bookmark%231',
  );
});
