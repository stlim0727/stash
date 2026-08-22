import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BookmarkApi, type RemoteBookmark } from './bookmarks.ts';
import { SupabaseRequestError } from '@/supabase/client';
import type { SupabaseAuthSession } from '@/supabase/types';

const SESSION: SupabaseAuthSession = {
  access_token: 'token',
  refresh_token: 'refresh',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: 9999999999,
  user: {
    id: 'user-1',
    aud: 'authenticated',
    role: 'authenticated',
    email: null,
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-06-12T00:00:00.000Z',
    is_anonymous: true,
  },
};

function remoteBookmark(overrides: Partial<RemoteBookmark>): RemoteBookmark {
  const now = '2026-06-12T00:00:00.000Z';
  return {
    id: '00000000-0000-4000-8000-000000000001',
    user_id: 'user-1',
    url: 'https://example.com/a',
    canonical_url: null,
    url_hash: 'https://example.com/a',
    title: null,
    description: null,
    notes: null,
    source_app: null,
    content_type: 'url',
    preview_image_url: null,
    favicon_url: null,
    site_name: null,
    collection_id: null,
    is_archived: false,
    deleted_at: null,
    created_at: now,
    updated_at: now,
    last_saved_at: now,
    metadata_status: 'pending',
    ...overrides,
  } as RemoteBookmark;
}

test('paginated pull lists stop before requesting another page', async () => {
  let requestCount = 0;
  let pageCheckCount = 0;
  const stopped = new Error('paused before next page');
  const client = {
    request: async (path: string) => {
      requestCount += 1;
      const url = new URL(path, 'https://example.test');
      const pageSize = Number(url.searchParams.get('limit'));
      return Array.from({ length: pageSize }, (_, index) => ({
        id: `bookmark-${index}`,
      }));
    },
  };
  const api = new BookmarkApi(SESSION, client as never);

  await assert.rejects(
    api.listBookmarkIds(() => {
      pageCheckCount += 1;
      if (pageCheckCount > 1) {
        throw stopped;
      }
    }),
    stopped,
  );

  assert.equal(requestCount, 1);
  assert.equal(pageCheckCount, 2);
});

test('createBookmarks bulk-inserts only new rows and returns outputs in input order', async () => {
  const calls: Array<{ path: string; options: Record<string, unknown> }> = [];
  const existing = remoteBookmark({
    id: '00000000-0000-4000-8000-000000000011',
    url: 'https://example.com/existing',
    url_hash: 'https://example.com/existing',
    client_id: '11111111-1111-4111-8111-111111111111',
    metadata_status: 'complete',
  });
  const created = remoteBookmark({
    id: '00000000-0000-4000-8000-000000000022',
    url: 'https://example.com/new',
    url_hash: 'https://example.com/new',
    client_id: '22222222-2222-4222-8222-222222222222',
  });
  const client = {
    request: async (path: string, options: Record<string, unknown> = {}) => {
      calls.push({ path, options });
      if (path.startsWith('/rest/v1/bookmarks?select=*&user_id=eq.user-1&url_hash=')) {
        return [existing];
      }
      if (path.startsWith('/rest/v1/bookmarks?select=*&user_id=eq.user-1&client_id=')) {
        return [existing];
      }
      if (path.startsWith('/rest/v1/bookmarks?id=in.')) {
        return null;
      }
      if (path === '/rest/v1/bookmarks') {
        assert.equal(options.method, 'POST');
        assert.equal((options.headers as Record<string, string>).Prefer, 'return=representation');
        assert.deepEqual(
          (options.body as Array<Record<string, unknown>>).map((row) => ({
            url: row.url,
            url_hash: row.url_hash,
            client_id: row.client_id,
            title: row.title,
          })),
          [
            {
              url: 'https://example.com/new',
              url_hash: 'https://example.com/new',
              client_id: '22222222-2222-4222-8222-222222222222',
              title: 'New',
            },
          ],
        );
        return [created];
      }
      throw new Error(`unexpected request ${path}`);
    },
  };

  const api = new BookmarkApi(SESSION, client as never);
  const outputs = await api.createBookmarks([
    {
      url: 'https://example.com/existing',
      client_id: '11111111-1111-4111-8111-111111111111',
    },
    {
      url: 'https://example.com/new',
      title: 'New',
      client_id: '22222222-2222-4222-8222-222222222222',
    },
  ]);

  assert.deepEqual(
    outputs.map((output) => ({
      id: output.bookmark_id,
      status: output.status,
      metadata_status: output.metadata_status,
    })),
    [
      {
        id: '00000000-0000-4000-8000-000000000011',
        status: 'duplicate',
        metadata_status: 'complete',
      },
      {
        id: '00000000-0000-4000-8000-000000000022',
        status: 'created',
        metadata_status: 'pending',
      },
    ],
  );
  assert.equal(calls.some((call) => call.path.startsWith('/rest/v1/bookmarks?id=in.')), true);
});

test('createBookmarks pushes a refreshed memo body for an idempotent duplicate retry, not just last_saved_at', async () => {
  const existing = remoteBookmark({
    id: '00000000-0000-4000-8000-000000000011',
    url: null,
    content_type: 'text',
    description: 'original body',
    client_id: 'cid-memo',
  });
  const patches: Array<{ path: string; body: Record<string, unknown> }> = [];
  const client = {
    request: async (path: string, options: Record<string, unknown> = {}) => {
      if (path.startsWith('/rest/v1/bookmarks?select=*&user_id=eq.user-1&client_id=in.')) {
        // The first attempt already landed; only its response was lost, so
        // this retry finds it via client_id.
        return [existing];
      }
      if (options.method === 'PATCH') {
        patches.push({ path, body: options.body as Record<string, unknown> });
        return [{ ...existing, ...(options.body as Record<string, unknown>) }];
      }
      throw new Error(`unexpected request ${path}`);
    },
  };
  const api = new BookmarkApi(SESSION, client as never);

  const outputs = await api.createBookmarks([
    {
      // The memo was edited locally between the original (lost-response)
      // create and this retry.
      shared_text: 'edited body',
      client_id: 'cid-memo',
    },
  ]);

  assert.equal(outputs[0]?.status, 'duplicate');
  const descriptionPatch = patches.find((patch) => patch.path.includes('id=eq.'));
  assert.equal(descriptionPatch?.body.description, 'edited body');
});

test('createBookmarks does not patch description for a urlHash duplicate from a different device', async () => {
  const existing = remoteBookmark({
    id: '00000000-0000-4000-8000-000000000011',
    url: 'https://example.com/a',
    url_hash: 'https://example.com/a',
    description: 'fetched by the other device',
    client_id: 'cid-other-device',
  });
  const patches: Array<{ path: string; body: Record<string, unknown> }> = [];
  const client = {
    request: async (path: string, options: Record<string, unknown> = {}) => {
      if (path.startsWith('/rest/v1/bookmarks?select=*&user_id=eq.user-1&url_hash=')) {
        return [existing];
      }
      if (path.startsWith('/rest/v1/bookmarks?select=*&user_id=eq.user-1&client_id=')) {
        return [];
      }
      if (options.method === 'PATCH') {
        patches.push({ path, body: options.body as Record<string, unknown> });
        return null;
      }
      throw new Error(`unexpected request ${path}`);
    },
  };
  const api = new BookmarkApi(SESSION, client as never);

  const outputs = await api.createBookmarks([
    {
      url: 'https://example.com/a',
      description: 'a stale local guess',
      client_id: 'cid-this-device',
    },
  ]);

  assert.equal(outputs[0]?.status, 'duplicate');
  assert.equal(patches.length, 1);
  assert.equal('description' in (patches[0]?.body ?? {}), false);
});

test('createBookmarks dedupes same-url inputs before the bulk POST', async () => {
  const created = remoteBookmark({
    id: '00000000-0000-4000-8000-000000000033',
    url: 'https://example.com/same',
    url_hash: 'https://example.com/same',
    client_id: '33333333-3333-4333-8333-333333333333',
  });
  let postCount = 0;
  const client = {
    request: async (path: string, options: Record<string, unknown> = {}) => {
      if (path.startsWith('/rest/v1/bookmarks?select=*&user_id=eq.user-1&url_hash=')) {
        return [];
      }
      if (path.startsWith('/rest/v1/bookmarks?select=*&user_id=eq.user-1&client_id=')) {
        return [];
      }
      if (path === '/rest/v1/bookmarks') {
        postCount += 1;
        assert.deepEqual(
          (options.body as Array<Record<string, unknown>>).map((row) => ({
            url: row.url,
            url_hash: row.url_hash,
            client_id: row.client_id,
          })),
          [
            {
              url: 'https://example.com/same',
              url_hash: 'https://example.com/same',
              client_id: '33333333-3333-4333-8333-333333333333',
            },
          ],
        );
        return [created];
      }
      throw new Error(`unexpected request ${path}`);
    },
  };

  const api = new BookmarkApi(SESSION, client as never);
  const outputs = await api.createBookmarks([
    {
      url: 'https://example.com/same',
      client_id: '33333333-3333-4333-8333-333333333333',
    },
    {
      url: 'https://example.com/same',
      client_id: '44444444-4444-4444-8444-444444444444',
    },
  ]);

  assert.equal(postCount, 1);
  assert.deepEqual(
    outputs.map((output) => ({ id: output.bookmark_id, status: output.status })),
    [
      { id: '00000000-0000-4000-8000-000000000033', status: 'created' },
      { id: '00000000-0000-4000-8000-000000000033', status: 'duplicate' },
    ],
  );
});

test('createBookmark accepts an image-only payload once its binary is already uploaded', async () => {
  const calls: Array<{ path: string; options: Record<string, unknown> }> = [];
  const client = {
    request: async (path: string, options: Record<string, unknown> = {}) => {
      calls.push({ path, options });
      if (path.startsWith('/rest/v1/bookmarks?select=*&user_id=eq.user-1&client_id=')) {
        return [];
      }
      if (path === '/rest/v1/bookmarks') {
        assert.equal(options.method, 'POST');
        const body = options.body as Record<string, unknown>;
        assert.equal(body.url, null);
        assert.equal(body.content_type, 'image');
        assert.equal(body.preview_image_url, 'https://proj.supabase.co/storage/v1/object/public/bookmark-images/user-1/b1');
        return [
          remoteBookmark({
            id: 'b1',
            url: null,
            content_type: 'image',
            preview_image_url: 'https://proj.supabase.co/storage/v1/object/public/bookmark-images/user-1/b1',
          }),
        ];
      }
      throw new Error(`unexpected request ${path}`);
    },
  };
  const api = new BookmarkApi(SESSION, client as never);

  const result = await api.createBookmark({
    id: 'b1',
    content_type: 'image',
    preview_image_url: 'https://proj.supabase.co/storage/v1/object/public/bookmark-images/user-1/b1',
    client_id: 'cid-img',
  });

  assert.equal(result.status, 'created');
  assert.equal(result.bookmark_id, 'b1');
});

test('createBookmark preserves leading/trailing whitespace in a Markdown memo body', async () => {
  const client = {
    request: async (path: string, options: Record<string, unknown> = {}) => {
      if (path.startsWith('/rest/v1/bookmarks?select=*&user_id=eq.user-1&client_id=')) {
        return [];
      }
      if (path === '/rest/v1/bookmarks') {
        assert.equal(options.method, 'POST');
        const body = options.body as Record<string, unknown>;
        assert.equal(body.description, '    indented code block\n');
        return [
          remoteBookmark({
            id: 'b1',
            url: null,
            content_type: 'text',
            description: '    indented code block\n',
          }),
        ];
      }
      throw new Error(`unexpected request ${path}`);
    },
  };
  const api = new BookmarkApi(SESSION, client as never);

  await api.createBookmark({
    id: 'b1',
    shared_text: '    indented code block\n',
    client_id: 'cid-memo',
  });
});

test('createBookmark pushes a refreshed memo body when a retry finds its own earlier create (idempotent duplicate)', async () => {
  const patches: Array<Record<string, unknown>> = [];
  const client = {
    request: async (path: string, options: Record<string, unknown> = {}) => {
      if (path.startsWith('/rest/v1/bookmarks?select=*&user_id=eq.user-1&client_id=')) {
        // The first attempt already landed server-side; only its response
        // was lost, so this retry finds it via the same client_id.
        return [
          remoteBookmark({
            id: 'b1',
            url: null,
            content_type: 'text',
            description: 'original body',
            client_id: 'cid-memo',
          }),
        ];
      }
      if (path === '/rest/v1/bookmarks?id=eq.b1&user_id=eq.user-1') {
        assert.equal(options.method, 'PATCH');
        const body = options.body as Record<string, unknown>;
        patches.push(body);
        return [remoteBookmark({ id: 'b1', url: null, content_type: 'text', description: body.description as string })];
      }
      throw new Error(`unexpected request ${path}`);
    },
  };
  const api = new BookmarkApi(SESSION, client as never);

  const result = await api.createBookmark({
    id: 'b1',
    // The memo was edited locally between the original (lost-response)
    // create and this retry — createUploadPayload refreshes shared_text
    // from the latest bookmark before every upload attempt.
    shared_text: 'edited body',
    client_id: 'cid-memo',
  });

  assert.equal(result.status, 'duplicate');
  assert.equal(patches[0]?.description, 'edited body');
});

test('createBookmark does not patch description for a urlHash duplicate from a different device (not this create attempt retried)', async () => {
  const patches: Array<Record<string, unknown>> = [];
  const client = {
    request: async (path: string, options: Record<string, unknown> = {}) => {
      if (path.startsWith('/rest/v1/bookmarks?select=*&user_id=eq.user-1&url_hash=')) {
        // Another device already saved this URL since the last pull — a
        // genuine different save, not a retry of THIS create attempt.
        return [
          remoteBookmark({
            id: 'b1',
            url: 'https://example.com/a',
            url_hash: 'https://example.com/a',
            description: 'fetched by the other device',
            client_id: 'cid-other-device',
          }),
        ];
      }
      if (path === '/rest/v1/bookmarks?id=eq.b1&user_id=eq.user-1') {
        assert.equal(options.method, 'PATCH');
        const body = options.body as Record<string, unknown>;
        patches.push(body);
        return [remoteBookmark({ id: 'b1', url: 'https://example.com/a' })];
      }
      throw new Error(`unexpected request ${path}`);
    },
  };
  const api = new BookmarkApi(SESSION, client as never);

  const result = await api.createBookmark({
    id: 'b1',
    url: 'https://example.com/a',
    description: 'a stale local guess',
    client_id: 'cid-this-device',
  });

  assert.equal(result.status, 'duplicate');
  assert.equal('description' in (patches[0] ?? {}), false);
  assert.equal(patches[0]?.last_saved_at !== undefined, true);
});

test('createBookmark pushes a refreshed memo body when a 409 conflict reveals its own earlier create (race with the pre-insert lookup)', async () => {
  const patches: Array<Record<string, unknown>> = [];
  let clientIdLookupCount = 0;
  const client = {
    request: async (path: string, options: Record<string, unknown> = {}) => {
      if (path.startsWith('/rest/v1/bookmarks?select=*&user_id=eq.user-1&client_id=')) {
        clientIdLookupCount += 1;
        if (clientIdLookupCount === 1) {
          // The pre-insert lookup runs before the original attempt's insert
          // has landed — finds nothing.
          return [];
        }
        // By the time the POST below fails with 409, the original attempt
        // has landed — this second lookup (the 409 recovery path) finds it.
        return [
          remoteBookmark({
            id: 'b1',
            url: null,
            content_type: 'text',
            description: 'original body',
            client_id: 'cid-memo',
          }),
        ];
      }
      if (path === '/rest/v1/bookmarks' && options.method === 'POST') {
        throw new SupabaseRequestError('conflict', 409);
      }
      if (path === '/rest/v1/bookmarks?id=eq.b1&user_id=eq.user-1') {
        assert.equal(options.method, 'PATCH');
        const body = options.body as Record<string, unknown>;
        patches.push(body);
        return [remoteBookmark({ id: 'b1', url: null, content_type: 'text', description: body.description as string })];
      }
      throw new Error(`unexpected request ${path}`);
    },
  };
  const api = new BookmarkApi(SESSION, client as never);

  const result = await api.createBookmark({
    id: 'b1',
    shared_text: 'edited body',
    client_id: 'cid-memo',
  });

  assert.equal(result.status, 'duplicate');
  assert.equal(patches[0]?.description, 'edited body');
});

test('createBookmark rejects an image payload with no uploaded preview_image_url (STASH-65 invariant: never create before the binary lands)', async () => {
  const client = {
    request: async () => {
      throw new Error('must never reach the network without an uploaded image');
    },
  };
  const api = new BookmarkApi(SESSION, client as never);

  await assert.rejects(
    api.createBookmark({ id: 'b1', content_type: 'image' }),
    /requires either url, shared_text, or an uploaded image/,
  );
});

test('createBookmark rejects a payload with neither url, shared_text, nor an image', async () => {
  const client = {
    request: async () => {
      throw new Error('must never reach the network with an empty payload');
    },
  };
  const api = new BookmarkApi(SESSION, client as never);

  await assert.rejects(
    api.createBookmark({ id: 'b1', title: 'Untitled' }),
    /requires either url, shared_text, or an uploaded image/,
  );
});

test("imageUploadTarget scopes the object path to this session's own user id", () => {
  const client = {
    request: async () => {
      throw new Error('imageUploadTarget must not make a network call');
    },
    storageUploadTarget: (
      bucket: string,
      path: string,
      options: { accessToken: string; contentType: string },
    ) => ({
      uploadUrl: `https://proj.supabase.co/storage/v1/object/${bucket}/${path}`,
      publicUrl: `https://proj.supabase.co/storage/v1/object/public/${bucket}/${path}`,
      headers: {
        apikey: 'anon-key',
        Authorization: `Bearer ${options.accessToken}`,
        'Content-Type': options.contentType,
        'x-upsert': 'true',
      },
    }),
  };
  const api = new BookmarkApi(SESSION, client as never);

  const target = api.imageUploadTarget('b1', 'image/jpeg');

  assert.equal(target.uploadUrl, 'https://proj.supabase.co/storage/v1/object/bookmark-images/user-1/b1');
  assert.equal(
    target.publicUrl,
    'https://proj.supabase.co/storage/v1/object/public/bookmark-images/user-1/b1',
  );
  assert.equal(target.headers.Authorization, 'Bearer token');
});

test("deleteImages scopes each object path to this session's own user id", async () => {
  let removed: { bucket: string; paths: string[]; accessToken: string } | undefined;
  const client = {
    request: async () => {
      throw new Error('deleteImages must go through removeStorageObjects, not a raw request');
    },
    removeStorageObjects: async (bucket: string, paths: string[], accessToken: string) => {
      removed = { bucket, paths, accessToken };
    },
  };
  const api = new BookmarkApi(SESSION, client as never);

  await api.deleteImages(['b1', 'b2']);

  assert.equal(removed?.bucket, 'bookmark-images');
  assert.deepEqual(removed?.paths, ['user-1/b1', 'user-1/b2']);
  assert.equal(removed?.accessToken, 'token');
});

test('enqueuePendingEnrichment targets bookmark_id for conflict resolution and requests a minimal response (STASH-4K)', async () => {
  // STASH-4K, verified live against production:
  //  - `on_conflict=bookmark_id` is required for `resolution=ignore-duplicates`
  //    to target the table's unique `bookmark_id` constraint. Without it,
  //    PostgREST's conflict target defaults to the primary key (`id`, always
  //    a fresh random UUID), so a genuine repeat enqueue raised a raw 23505
  //    duplicate-key error instead of silently no-op'ing as designed.
  //  - `return=minimal` avoids PostgREST's default RETURNING representation,
  //    which this call never reads.
  //  - The actual RLS fix is a DB-side SELECT policy (see
  //    20260731150000_pending_ai_enrichment_select_policy.sql) — Postgres's
  //    ON CONFLICT clause needs SELECT privilege to check for a conflicting
  //    row even under DO NOTHING, which nothing here can substitute for.
  let seenPath: string | undefined;
  let seenHeaders: Record<string, string> | undefined;
  const client = {
    request: async (path: string, options: Record<string, unknown> = {}) => {
      seenPath = path;
      seenHeaders = options.headers as Record<string, string>;
      return null;
    },
  };

  const api = new BookmarkApi(SESSION, client as never);
  await api.enqueuePendingEnrichment('00000000-0000-4000-8000-000000000099', 'ko');

  assert.equal(seenPath, '/rest/v1/pending_ai_enrichment?on_conflict=bookmark_id');
  assert.equal(seenHeaders?.Prefer, 'resolution=ignore-duplicates, return=minimal');
});

test('restoreAIEnrichment creates a row and targets bookmark_id for conflict resolution (#671)', async () => {
  let seenPath: string | undefined;
  let seenHeaders: Record<string, string> | undefined;
  let seenBody: Record<string, unknown> | undefined;
  const client = {
    request: async (path: string, options: Record<string, unknown> = {}) => {
      seenPath = path;
      seenHeaders = options.headers as Record<string, string>;
      seenBody = options.body as Record<string, unknown>;
      return [
        {
          id: '00000000-0000-4000-8000-000000000055',
          bookmark_id: '00000000-0000-4000-8000-000000000001',
          user_id: 'user-1',
          summary: 'restored summary',
          topics: ['a'],
          suggested_tags: [],
          suggested_collection_id: null,
          suggested_collection_name: null,
          model: 'gpt-5',
          status: 'complete',
          confidence: 0.5,
          degraded: false,
          degraded_reason: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ];
    },
  };

  const api = new BookmarkApi(SESSION, client as never);
  const result = await api.restoreAIEnrichment({
    bookmark_id: '00000000-0000-4000-8000-000000000001',
    summary: 'restored summary',
    topics: ['a'],
    status: 'complete',
    model: 'gpt-5',
    confidence: 0.5,
  });

  assert.equal(seenPath, '/rest/v1/ai_enrichments?on_conflict=bookmark_id');
  assert.equal(seenHeaders?.Prefer, 'resolution=ignore-duplicates, return=representation');
  assert.equal(seenBody?.bookmark_id, '00000000-0000-4000-8000-000000000001');
  assert.equal(result?.summary, 'restored summary');
});

test('fetchAiQueueSnapshot returns bookmark-addressable active and failed server work', async () => {
  const seenPaths: string[] = [];
  const client = {
    request: async (path: string) => {
      seenPaths.push(path);
      return [
        {
          bookmark_id: '00000000-0000-4000-8000-000000000001',
          status: 'processing',
          attempts: 2,
          created_at: '2026-08-05T00:00:00.000Z',
          updated_at: '2026-08-05T00:01:00.000Z',
        },
      ];
    },
  };

  const api = new BookmarkApi(SESSION, client as never);
  const rows = await api.fetchAiQueueSnapshot();

  assert.equal(rows.length, 1);
  const params = new URLSearchParams(seenPaths[0].split('?')[1]);
  assert.equal(params.get('select'), 'bookmark_id,status,attempts,created_at,updated_at');
  assert.equal(params.get('status'), 'in.(pending,processing,failed)');
  assert.equal(params.get('order'), 'created_at.asc,bookmark_id.asc');
});

test('restoreAIEnrichment returns null (not an error) when the bookmark already has an enrichment', async () => {
  // PostgREST returns an empty array for an ignored ON CONFLICT row when
  // return=representation is set — this must read as "already had one, skip",
  // not as a failure that would mark the durable outbox entry failed forever.
  const client = {
    request: async () => [],
  };

  const api = new BookmarkApi(SESSION, client as never);
  const result = await api.restoreAIEnrichment({
    bookmark_id: '00000000-0000-4000-8000-000000000001',
    status: 'complete',
  });

  assert.equal(result, null);
});
