import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import type { Bookmark, LocalPendingBookmark } from '@/domain/types';

jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);

const anonSession = {
  access_token: 'anon-token',
  refresh_token: 'anon-refresh',
  token_type: 'bearer',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'anon-user', is_anonymous: true },
};

jest.mock('@/supabase/auth-provider', () => {
  const session = {
    access_token: 'anon-token',
    refresh_token: 'anon-refresh',
    token_type: 'bearer',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: 'anon-user', is_anonymous: true },
  };
  const state = {
    status: 'anonymous' as string,
    session: session as unknown,
    userId: 'anon-user' as string | null,
    message: null,
    ensureAnonymousSession: async () => session,
  };
  return {
    useSupabaseAuth: () => state,
    SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
  };
});

// The pull returns the remote twin so the pull half of syncNow is consistent and
// idempotent — the duplicate is created by the leftover reconcile, not the pull.
jest.mock('@/api/bookmarks', () => {
  let remote: Bookmark[] = [];
  const empty = async () => [];
  return {
    __setRemote: (rows: Bookmark[]) => {
      remote = rows;
    },
    createBookmarkApi: () => ({
      listBookmarksUpdatedSince: async () => [...remote],
      listBookmarkIds: async () => remote.map((row) => row.id),
      listEnrichmentsUpdatedSince: empty,
      listTags: empty,
      listBookmarkTags: empty,
      listCollections: empty,
    }),
  };
});

jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: async () => ({ patch: {}, metadata_status: 'complete' }),
}));

import { BookmarksProvider, useBookmarks } from '@/store/bookmarks';
import { makeStoredBookmark, type FakeRepositoryModule } from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;
const apiMock = jest.requireMock('@/api/bookmarks') as {
  __setRemote: (rows: Bookmark[]) => void;
};

const REMOTE_ID = '1a2b3c4d-0000-4000-8000-00000000abcd';
const LOCAL_ID = 'local-carbonara';

function wrapper({ children }: { children: ReactNode }) {
  return <BookmarksProvider>{children}</BookmarksProvider>;
}

test('a synced create-leftover does not duplicate a bookmark whose remote twin was already pulled', async () => {
  // Reconstructs the reported state: a create uploaded (the queue entry is marked
  // 'synced' with the new remote id) but the app was killed before the local->remote
  // id swap, AND the remote twin has since been pulled down under its UUID. So both
  // a stranded local-* row and its UUID twin sit in storage with a synced leftover
  // queue entry still pointing local_id -> remote_id.
  const localTwin = makeStoredBookmark({
    id: LOCAL_ID,
    url: 'https://youtube.com/shorts/carbonara',
    url_hash: 'https://youtube.com/shorts/carbonara',
    title: 'carbonara',
    sync_status: 'pending',
  });
  const remoteTwin = makeStoredBookmark({
    id: REMOTE_ID,
    url: 'https://youtube.com/shorts/carbonara',
    url_hash: 'https://youtube.com/shorts/carbonara',
    title: 'carbonara',
    sync_status: 'synced',
  });
  fakeRepo.__reset([localTwin, remoteTwin]);
  apiMock.__setRemote([remoteTwin]);

  const leftover: LocalPendingBookmark = {
    local_id: LOCAL_ID,
    remote_id: REMOTE_ID,
    operation: 'create',
    payload: { url: 'https://youtube.com/shorts/carbonara' },
    sync_status: 'synced',
    retry_count: 0,
    last_error: null,
    created_at: '2026-06-12T00:00:00.000Z',
    updated_at: '2026-06-12T00:00:00.000Z',
  };
  await fakeRepo.repository.enqueue(leftover);

  const { result } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));

  // Drive a sync: its first step reconciles the synced leftover (local-* -> UUID).
  await act(async () => {
    await result.current.syncNow();
  });

  // Exactly one carbonara row, under the remote id — not two entries sharing it.
  await waitFor(() =>
    expect(result.current.inbox.filter((b) => b.url === 'https://youtube.com/shorts/carbonara')),
  );
  const carbonara = result.current.inbox.filter(
    (b) => b.url === 'https://youtube.com/shorts/carbonara',
  );
  expect(carbonara).toHaveLength(1);
  expect(carbonara[0].id).toBe(REMOTE_ID);
  // The stranded local-* row is gone from the visible library.
  expect(result.current.inbox.some((b) => b.id === LOCAL_ID)).toBe(false);

  // ...and durably: the replaceBookmark swap must collapse the destination twin
  // too, so a reload (listBookmarks) can't resurface the duplicate. Guards the
  // web/localStorage path, whose replaceBookmark renamed previousId but left a
  // pre-existing destination-id row behind.
  const stored = fakeRepo
    .__bookmarks()
    .filter((b) => b.url === 'https://youtube.com/shorts/carbonara');
  expect(stored).toHaveLength(1);
  expect(stored[0].id).toBe(REMOTE_ID);
});

test('multiple synced leftovers are reconciled sequentially, not as a concurrent burst (Sentry STASH-3N)', async () => {
  // Same class of bug as the startup orphan re-enqueue: firing one
  // repository call per leftover without awaiting the previous one stacks
  // concurrent native SQLite calls on the single serialized connection under
  // a large backlog ("sqlite tail wait" depth climbing into the tens).
  const pairs = [1, 2, 3].map((n) => {
    const localId = `local-leftover-${n}`;
    const remoteId = `1a2b3c4d-0000-4000-8000-00000000ab0${n}`;
    const url = `https://example.com/leftover-${n}`;
    return {
      localId,
      remoteId,
      local: makeStoredBookmark({ id: localId, url, url_hash: url, sync_status: 'pending' }),
      remote: makeStoredBookmark({ id: remoteId, url, url_hash: url, sync_status: 'synced' }),
    };
  });
  fakeRepo.__reset(pairs.flatMap((p) => [p.local, p.remote]));
  apiMock.__setRemote(pairs.map((p) => p.remote));
  for (const p of pairs) {
    await fakeRepo.repository.enqueue({
      local_id: p.localId,
      remote_id: p.remoteId,
      operation: 'create',
      payload: { url: p.local.url ?? undefined },
      sync_status: 'synced',
      retry_count: 0,
      last_error: null,
      created_at: '2026-06-12T00:00:00.000Z',
      updated_at: '2026-06-12T00:00:00.000Z',
    });
  }

  const track = (fn: (...args: never[]) => Promise<unknown>) => {
    let concurrent = 0;
    let max = 0;
    const wrapped = async (...args: never[]) => {
      concurrent += 1;
      max = Math.max(max, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrent -= 1;
      return fn(...args);
    };
    return { wrapped, getMax: () => max };
  };
  const replaceTrack = track(fakeRepo.repository.replaceBookmark.bind(fakeRepo.repository));
  const removeTrack = track(fakeRepo.repository.removeQueueEntry.bind(fakeRepo.repository));
  fakeRepo.repository.replaceBookmark = replaceTrack.wrapped as typeof fakeRepo.repository.replaceBookmark;
  fakeRepo.repository.removeQueueEntry = removeTrack.wrapped as typeof fakeRepo.repository.removeQueueEntry;

  const { result } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));

  await act(async () => {
    await result.current.syncNow();
  });

  await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(0));
  expect(replaceTrack.getMax()).toBe(1);
  expect(removeTrack.getMax()).toBe(1);
});
