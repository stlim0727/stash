import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BookmarkApi, type RemoteBookmark } from './bookmarks.ts';
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
