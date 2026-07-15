import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import type { Bookmark, MetadataStatus } from '@/domain/types';

const mockEnrichBookmark = jest.fn<
  Promise<{ patch: Partial<Bookmark>; metadata_status: MetadataStatus }>,
  [Bookmark, unknown?]
>(async () => ({ patch: {}, metadata_status: 'complete' }));
const SYNCED_ID = '7e64cf1e-0000-4000-8000-000000000001';

jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);
jest.mock('@/supabase/auth-provider', () => ({
  useSupabaseAuth: () => ({
    status: 'not_configured',
    session: null,
    userId: null,
    message: 'not configured',
    ensureAnonymousSession: async () => null,
  }),
  SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: (bookmark: Bookmark, fetcher?: unknown) => mockEnrichBookmark(bookmark, fetcher),
}));

import { BookmarksProvider, useBookmarks } from '@/store/bookmarks';
import { makeStoredBookmark, type FakeRepositoryModule } from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

function wrapper({ children }: { children: ReactNode }) {
  return <BookmarksProvider>{children}</BookmarksProvider>;
}

async function renderStore() {
  const utils = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(utils.result.current.isLoading).toBe(false));
  return utils;
}

beforeEach(() => {
  fakeRepo.__reset();
  mockEnrichBookmark.mockReset();
  mockEnrichBookmark.mockResolvedValue({ patch: {}, metadata_status: 'complete' });
});

test('addBookmark shows the bookmark immediately and queues a create', async () => {
  const { result } = await renderStore();

  let outcome = '';
  await act(async () => {
    outcome = result.current.addBookmark({ url: 'example.com/article' }).status;
  });

  expect(outcome).toBe('created');
  await waitFor(() => expect(result.current.inbox).toHaveLength(1));
  expect(result.current.inbox[0]?.url).toBe('https://example.com/article');
  expect(result.current.inbox[0]?.sync_status).toBe('pending');
  await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(1));
  expect(fakeRepo.__queue()[0]?.operation).toBe('create');
});

test('markBookmarkAccessed sets last_accessed_at and persists it durably', async () => {
  fakeRepo.__reset([makeStoredBookmark({ id: 'bm-access', last_accessed_at: null })]);
  const { result } = await renderStore();
  await waitFor(() => expect(result.current.inbox).toHaveLength(1));

  await act(async () => {
    result.current.markBookmarkAccessed('bm-access');
  });

  // Reflected in memory…
  expect(result.current.inbox[0]?.last_accessed_at).toEqual(expect.any(String));
  // …and written through to durable storage (not just the in-memory state),
  // so the "Recently opened" order survives a reload.
  const persisted = (await fakeRepo.repository.listBookmarks()).find((b) => b.id === 'bm-access');
  expect(persisted?.last_accessed_at).toEqual(expect.any(String));

  // It must not enqueue a sync mutation — last_accessed_at is local-only.
  expect(fakeRepo.__queue()).toHaveLength(0);
});

test('saving the same URL twice reuses the existing bookmark', async () => {
  const { result } = await renderStore();

  await act(async () => {
    result.current.addBookmark({ url: 'example.com/a' });
  });
  await waitFor(() => expect(result.current.inbox).toHaveLength(1));

  let status = '';
  await act(async () => {
    status = result.current.addBookmark({ url: 'https://example.com/a' }).status;
  });

  expect(status).toBe('duplicate');
  expect(result.current.inbox).toHaveLength(1);
});

test('re-sharing a YouTube URL dedupes against a stored row with a stale si hash', async () => {
  // Simulates a local row saved by an older build, before `si` was stripped:
  // its persisted url_hash still carries the old share token and hasn't been
  // rewritten by pull sync yet. A fresh re-share (different si) must still
  // dedupe against it instead of creating a duplicate.
  fakeRepo.__reset([
    makeStoredBookmark({
      url: 'https://youtube.com/shorts/gkx8ZfytWeE?si=OLDtoken',
      url_hash: 'https://youtube.com/shorts/gkx8ZfytWeE?si=OLDtoken',
    }),
  ]);
  const { result } = await renderStore();
  await waitFor(() => expect(result.current.inbox).toHaveLength(1));

  let status = '';
  await act(async () => {
    status = result.current.addBookmark({
      url: 'https://youtube.com/shorts/gkx8ZfytWeE?si=NEWtoken',
    }).status;
  });

  expect(status).toBe('duplicate');
  expect(result.current.inbox).toHaveLength(1);
});

test('invalid input is rejected with a message and saves nothing', async () => {
  const { result } = await renderStore();

  let outcome: ReturnType<typeof result.current.addBookmark> | null = null;
  await act(async () => {
    outcome = result.current.addBookmark({ url: 'not a url' });
  });

  expect(outcome).toMatchObject({ status: 'invalid' });
  expect(result.current.inbox).toHaveLength(0);
});

test('a URL too long to save is rejected up front instead of queuing a create that can never succeed', async () => {
  // Sentry STASH-2J: an Oracle email-verification link's huge embedded token
  // blew Postgres's index row-size limit on every retry, forever. Reject
  // before it ever reaches the queue.
  const { result } = await renderStore();
  const huge = `https://login.oracle.com/verify?token=${'x'.repeat(2800)}`;

  let outcome: ReturnType<typeof result.current.addBookmark> | null = null;
  await act(async () => {
    outcome = result.current.addBookmark({ url: huge });
  });

  expect(outcome).toMatchObject({ status: 'invalid', reason: 'too_long' });
  expect(result.current.inbox).toHaveLength(0);
  expect(result.current.queue).toHaveLength(0);
});

test('syncNow drains an already-stuck too-long-URL entry from the queue instead of leaving it permanently "waiting" (Sentry STASH-2J)', async () => {
  // Reproduces an entry queued on a pre-fix build: last_error already carries
  // the exact Postgres message from its last failed attempt. isSyncable
  // excludes it from retries, but leaving the row in the queue would make
  // every "waiting to sync" count (e.g. Settings) treat it as pending forever
  // (caught in PR review) — syncNow must actually remove the row.
  await fakeRepo.repository.enqueue({
    local_id: 'local-stuck',
    remote_id: null,
    operation: 'create',
    payload: { url: 'https://login.oracle.com/verify?token=x' },
    sync_status: 'failed',
    retry_count: 3,
    last_error:
      'index row size 2888 exceeds btree version 4 maximum 2704 for index "bookmarks_user_url_hash_active_idx"',
    created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:00:00.000Z',
  });

  const { result } = await renderStore();
  expect(result.current.queue).toHaveLength(1);

  await act(async () => {
    await result.current.syncNow();
  });

  expect(result.current.queue).toHaveLength(0);
  expect(fakeRepo.__queue()).toHaveLength(0);
});

test('trashing moves a bookmark from inbox to trash and back', async () => {
  const { result } = await renderStore();
  await act(async () => {
    result.current.addBookmark({ url: 'example.com/b' });
  });
  await waitFor(() => expect(result.current.inbox).toHaveLength(1));
  const id = result.current.inbox[0]!.id;

  await act(async () => {
    result.current.trashBookmark(id);
  });
  expect(result.current.inbox).toHaveLength(0);
  expect(result.current.trash).toHaveLength(1);

  await act(async () => {
    result.current.restoreBookmark(id);
  });
  expect(result.current.inbox).toHaveLength(1);
  expect(result.current.trash).toHaveLength(0);
});

test('re-adding a trashed URL creates a fresh active bookmark instead of folding into the trashed row', async () => {
  // A trashed row must not count as "already in stash": local dedupe only
  // matches active rows, so re-saving revives the URL as a new inbox item
  // rather than silently bumping the hidden trashed one.
  const { result } = await renderStore();
  await act(async () => {
    result.current.addBookmark({ url: 'example.com/revive' });
  });
  await waitFor(() => expect(result.current.inbox).toHaveLength(1));
  const id = result.current.inbox[0]!.id;

  await act(async () => {
    result.current.trashBookmark(id);
  });
  expect(result.current.inbox).toHaveLength(0);
  expect(result.current.trash).toHaveLength(1);

  let status = '';
  await act(async () => {
    status = result.current.addBookmark({ url: 'https://example.com/revive' }).status;
  });

  expect(status).toBe('created');
  expect(result.current.inbox).toHaveLength(1);
  expect(result.current.trash).toHaveLength(1);
});

test('deleting a local bookmark also clears its queued upload', async () => {
  const { result } = await renderStore();
  await act(async () => {
    result.current.addBookmark({ url: 'example.com/c' });
  });
  await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(1));
  const id = result.current.inbox[0]!.id;

  await act(async () => {
    result.current.deleteBookmark(id);
  });

  expect(result.current.inbox).toHaveLength(0);
  await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(0));
});

test('updateBookmarkFields edits the title and clears it back to null', async () => {
  const { result } = await renderStore();
  await act(async () => {
    result.current.addBookmark({ url: 'example.com/d', title: 'Original' });
  });
  await waitFor(() => expect(result.current.inbox).toHaveLength(1));
  const id = result.current.inbox[0]!.id;

  await act(async () => {
    result.current.updateBookmarkFields(id, { title: 'Renamed', notes: 'a note' });
  });
  expect(result.current.inbox[0]).toMatchObject({ title: 'Renamed', notes: 'a note' });

  await act(async () => {
    result.current.updateBookmarkFields(id, { title: '' });
  });
  expect(result.current.inbox[0]?.title).toBeNull();
});

test('editing title/notes marks a complete enrichment stale (locally + persisted)', async () => {
  const {
    makeStoredBookmark,
    makeEnrichment,
  } = require('./helpers/fake-repository');
  const SYNCED_ID = '7e64cf1e-0000-4000-8000-000000000001';
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID, title: 'Original title' })],
    undefined,
    [makeEnrichment({ bookmark_id: SYNCED_ID, status: 'complete' })],
  );

  const { result } = await renderStore();
  expect(result.current.getEnrichment(SYNCED_ID)?.status).toBe('complete');

  await act(async () => {
    result.current.updateBookmarkFields(SYNCED_ID, { title: 'A new title' });
  });

  expect(result.current.getEnrichment(SYNCED_ID)?.status).toBe('stale');
  await waitFor(() =>
    expect(fakeRepo.repository.listEnrichments()).resolves.toEqual([
      expect.objectContaining({ bookmark_id: SYNCED_ID, status: 'stale' }),
    ]),
  );
});

test('refreshBookmarkPreview replaces generated preview metadata and queues sync', async () => {
  const id = SYNCED_ID;
  fakeRepo.__reset([
    makeStoredBookmark({
      id,
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'YouTube video',
      title_is_derived: true,
      site_name: 'youtu.be',
      favicon_url: 'https://youtu.be/favicon.ico',
      preview_image_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    }),
  ]);
  mockEnrichBookmark.mockResolvedValueOnce({
    patch: {
      title: 'Rick Astley - Never Gonna Give You Up',
      title_is_derived: false,
      site_name: 'YouTube',
      favicon_url: 'https://www.youtube.com/favicon.ico',
      preview_image_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/sddefault.jpg',
    },
    metadata_status: 'complete',
  });
  const { result } = await renderStore();

  await act(async () => {
    await result.current.refreshBookmarkPreview(id);
  });

  await waitFor(() =>
    expect(result.current.getBookmark(id)).toMatchObject({
      title: 'Rick Astley - Never Gonna Give You Up',
      title_is_derived: false,
      site_name: 'YouTube',
      favicon_url: 'https://www.youtube.com/favicon.ico',
      preview_image_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/sddefault.jpg',
      sync_status: 'pending',
    }),
  );
  expect(mockEnrichBookmark).toHaveBeenCalledWith(
    expect.objectContaining({
      id,
      title: null,
      site_name: null,
      favicon_url: null,
      preview_image_url: null,
    }),
    undefined,
  );
  await waitFor(() => expect(fakeRepo.__queue()).toEqual([expect.objectContaining({ local_id: id, operation: 'update' })]));
});

test('refreshBookmarkPreview keeps a user-authored title while refreshing generated fields', async () => {
  const id = SYNCED_ID;
  fakeRepo.__reset([
    makeStoredBookmark({
      id,
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'My title',
      title_is_derived: false,
      preview_image_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    }),
  ]);
  mockEnrichBookmark.mockResolvedValueOnce({
    patch: {
      title: 'Fetched title should not win',
      title_is_derived: false,
      site_name: 'YouTube',
      preview_image_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/sddefault.jpg',
    },
    metadata_status: 'complete',
  });
  const { result } = await renderStore();

  await act(async () => {
    await result.current.refreshBookmarkPreview(id);
  });

  await waitFor(() =>
    expect(result.current.getBookmark(id)).toMatchObject({
      title: 'My title',
      title_is_derived: false,
      site_name: 'YouTube',
      preview_image_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/sddefault.jpg',
    }),
  );
});

test('a no-op edit (no real text change) does not mark the enrichment stale', async () => {
  const {
    makeStoredBookmark,
    makeEnrichment,
  } = require('./helpers/fake-repository');
  const SYNCED_ID = '7e64cf1e-0000-4000-8000-000000000001';
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID, title: 'Unchanged' })],
    undefined,
    [makeEnrichment({ bookmark_id: SYNCED_ID, status: 'complete' })],
  );

  const { result } = await renderStore();

  await act(async () => {
    result.current.updateBookmarkFields(SYNCED_ID, { title: 'Unchanged' });
  });

  expect(result.current.getEnrichment(SYNCED_ID)?.status).toBe('complete');
});

test('bookmarks stored from a previous session load on startup', async () => {
  const { makeStoredBookmark } = require('./helpers/fake-repository');
  fakeRepo.__reset([makeStoredBookmark({ title: 'From last session' })]);

  const { result } = await renderStore();

  expect(result.current.inbox).toHaveLength(1);
  expect(result.current.inbox[0]?.title).toBe('From last session');
});

test('a stranded pending bookmark with no queue entry is re-enqueued on startup', async () => {
  const { makeStoredBookmark } = require('./helpers/fake-repository');
  // A non-synced local-ID row whose create entry never persisted: without a
  // queue entry it would show "sync pending" forever.
  fakeRepo.__reset([
    makeStoredBookmark({ id: 'local-stranded', sync_status: 'pending', title: 'Stuck' }),
  ]);
  expect(fakeRepo.__queue()).toHaveLength(0);

  const { result } = await renderStore();

  expect(result.current.inbox).toHaveLength(1);
  await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(1));
  expect(fakeRepo.__queue()[0]).toMatchObject({
    local_id: 'local-stranded',
    operation: 'create',
  });
});

test('a synced bookmark loaded on startup is not re-enqueued', async () => {
  const { makeStoredBookmark } = require('./helpers/fake-repository');
  fakeRepo.__reset([makeStoredBookmark({ sync_status: 'synced' })]);

  await renderStore();

  expect(fakeRepo.__queue()).toHaveLength(0);
});

test('enriching a synced bookmark queues an update so metadata reaches the cloud', async () => {
  const { makeStoredBookmark } = require('./helpers/fake-repository');
  // A cloud-synced bookmark whose metadata has not been enriched yet.
  fakeRepo.__reset([makeStoredBookmark({ metadata_status: 'pending' })]);

  await renderStore();

  // The startup enrichment pass completes it and queues a metadata update.
  await waitFor(() => {
    const entry = fakeRepo.__queue().find((q) => q.operation === 'update');
    expect(entry).toBeTruthy();
  });
});
