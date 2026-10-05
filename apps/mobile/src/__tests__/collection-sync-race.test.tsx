import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import type { Bookmark } from '@/domain/types';
import { makeStoredBookmark, type FakeRepositoryModule } from './helpers/fake-repository';

jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);
jest.mock('@/supabase/auth-provider', () => {
  const session = {
    access_token: 'token', refresh_token: 'refresh', token_type: 'bearer',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: 'real-user', is_anonymous: false },
  };
  const state = {
    status: 'authenticated', session, userId: 'real-user', message: null,
    ensureAnonymousSession: async () => session,
  };
  return { useSupabaseAuth: () => state };
});
jest.mock('@/api/bookmarks', () => {
  let remote: Bookmark[] = [];
  const empty = async () => [];
  return {
    __setRemote: (rows: Bookmark[]) => { remote = rows; },
    __getRemote: () => remote,
    createBookmarkApi: () => ({
      listBookmarksUpdatedSince: async () => remote,
      listBookmarkIds: async () => remote.map((row) => row.id),
      listEnrichmentsUpdatedSince: empty, listTags: empty,
      listBookmarkTags: empty, listCollections: empty,
      updateBookmark: async (id: string, patch: Partial<Bookmark>) => {
        remote = remote.map((row) => row.id === id ? { ...row, ...patch } : row);
      },
    }),
  };
});
jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: async () => ({ patch: {}, metadata_status: 'complete' }),
}));

import { BookmarksProvider, useBookmarks } from '@/store/bookmarks';
const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;
const apiMock = jest.requireMock('@/api/bookmarks') as { __setRemote: (rows: Bookmark[]) => void; __getRemote: () => Bookmark[] };
const ids = ['7e64cf1e-0000-4000-8000-000000000001', '7e64cf1e-0000-4000-8000-000000000002'];
function wrapper({ children }: { children: ReactNode }) {
  return <BookmarksProvider>{children}</BookmarksProvider>;
}

beforeEach(() => {
  const rows = ids.map((id) => makeStoredBookmark({
    id, user_id: 'real-user', collection_id: null, updated_at: '2026-09-29T00:00:00.000Z',
  }));
  fakeRepo.__reset(rows);
  apiMock.__setRemote(rows);
});
afterEach(() => jest.restoreAllMocks());

for (const phase of ['local reload', 'pull write', 'pull deletion', 'pull commit'] as const) {
  test(`STASH-7A: a batch collection move survives an in-flight ${phase}`, async () => {
    const { result } = await renderHook(() => useBookmarks(), { wrapper });
    await waitFor(() => expect(result.current.lastPulledAt).not.toBeNull());
    await waitFor(() => expect(result.current.isSyncing).toBe(false));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reached = false;
    if (phase === 'local reload') {
      const original = fakeRepo.repository.listBookmarks;
      jest.spyOn(fakeRepo.repository, 'listBookmarks').mockImplementationOnce(async () => {
        const stale = await original();
        reached = true;
        await gate;
        return stale;
      });
    } else {
      apiMock.__setRemote(fakeRepo.__bookmarks().map((row) => ({
        ...row, updated_at: '2026-09-30T00:00:00.000Z',
      })));
      if (phase === 'pull deletion') {
        apiMock.__setRemote(apiMock.__getRemote().filter((row) => row.id !== ids[0]));
        const original = fakeRepo.repository.deleteBookmark;
        jest.spyOn(fakeRepo.repository, 'deleteBookmark').mockImplementationOnce(async (id) => {
          reached = true;
          await gate;
          await original(id);
        });
      } else if (phase === 'pull write') {
        const original = fakeRepo.repository.insertBookmark;
        jest.spyOn(fakeRepo.repository, 'insertBookmark').mockImplementationOnce(async (row) => {
          reached = true;
          await gate;
          await original(row);
        });
      } else {
        const original = fakeRepo.repository.replaceTagData;
        jest.spyOn(fakeRepo.repository, 'replaceTagData').mockImplementationOnce(async (data) => {
          reached = true;
          await gate;
          await original(data);
        });
      }
    }
    let sync!: Promise<boolean>;
    await act(async () => { sync = result.current.syncNow(); });
    await waitFor(() => expect(reached).toBe(true));
    await act(async () => {
      // Hold the next pass so another upload/pull cannot conceal a rollback.
      result.current.setSyncPaused(true);
      for (const id of ids) result.current.assignCollection(id, 'folder-new');
    });
    expect(result.current.inbox.map((row) => row.collection_id)).toEqual(['folder-new', 'folder-new']);
    await act(async () => { release(); await sync; });
    expect(result.current.inbox.map((row) => row.collection_id)).toEqual(['folder-new', 'folder-new']);
    expect(result.current.queue.map((entry) => entry.local_id).sort()).toEqual([...ids].sort());
    expect(fakeRepo.__bookmarks().map((row) => row.collection_id)).toEqual(['folder-new', 'folder-new']);
    expect(fakeRepo.__queue().map((entry) => entry.local_id).sort()).toEqual([...ids].sort());
    if (phase !== 'pull deletion') {
      await act(async () => { result.current.setSyncPaused(false); });
      await waitFor(() => expect(result.current.queue).toHaveLength(0));
      expect(apiMock.__getRemote().map((row) => row.collection_id)).toEqual(['folder-new', 'folder-new']);
      expect(result.current.inbox.map((row) => row.collection_id)).toEqual(['folder-new', 'folder-new']);
    }
  });
}
