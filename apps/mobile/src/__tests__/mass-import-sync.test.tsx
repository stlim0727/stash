import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import type { Bookmark } from '@/domain/types';

jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);

const mockRealSession = {
  access_token: 'real-token',
  refresh_token: 'real-refresh',
  token_type: 'bearer',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'real-user', is_anonymous: false, email: 'user@example.com' },
};

jest.mock('@/supabase/auth-provider', () => {
  let state = {
    status: 'authenticated' as string,
    session: mockRealSession as unknown,
    userId: 'real-user' as string | null,
    message: null as string | null,
    ensureAnonymousSession: async () => state.session,
  };
  return {
    __setAuth: (next: Partial<typeof state>) => {
      state = { ...state, ...next };
    },
    useSupabaseAuth: () => state,
    SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
  };
});

let mockServerDuplicateUrlMap: Record<string, string> = {};
let mockCreateNetworkErrorOnce = false;

jest.mock('@/api/bookmarks', () => {
  let remoteRows: Array<{ id: string; url: string | null }> = [];
  const listBookmarksUpdatedSince = jest.fn(async () => []);
  const listBookmarkIds = jest.fn(async () => remoteRows.map((r) => r.id));
  const empty = async () => [];
  const resetLibraryMock = jest.fn(async () => ({ bookmarks: remoteRows.length }));

  const createBookmarkMock = jest.fn(async (payload: { url?: string | null; id?: string }) => {
    if (mockCreateNetworkErrorOnce) {
      mockCreateNetworkErrorOnce = false;
      throw new Error('Network error during create');
    }
    const url = payload.url ?? null;
    if (url && mockServerDuplicateUrlMap[url]) {
      return {
        bookmark_id: mockServerDuplicateUrlMap[url],
        status: 'duplicate' as const,
        metadata_status: 'complete' as const,
      };
    }
    const newId = payload.id || 'server-gen-id-' + Math.random().toString(36).substring(2, 9);
    remoteRows.push({ id: newId, url });
    return {
      bookmark_id: newId,
      status: 'created' as const,
      metadata_status: 'complete' as const,
    };
  });

  const createBookmarksMock = jest.fn(async (payloads: Array<{ url?: string | null; id?: string }>) => {
    if (mockCreateNetworkErrorOnce) {
      mockCreateNetworkErrorOnce = false;
      throw new Error('Network error during bulk create');
    }
    return payloads.map((payload) => {
      const url = payload.url ?? null;
      if (url && mockServerDuplicateUrlMap[url]) {
        return {
          bookmark_id: mockServerDuplicateUrlMap[url],
          status: 'duplicate' as const,
          metadata_status: 'complete' as const,
        };
      }
      const newId = payload.id || 'server-gen-id-' + Math.random().toString(36).substring(2, 9);
      remoteRows.push({ id: newId, url });
      return {
        bookmark_id: newId,
        status: 'created' as const,
        metadata_status: 'complete' as const,
      };
    });
  });

  return {
    __setRemoteRows: (rows: Array<{ id: string; url: string | null }>) => {
      remoteRows = [...rows];
    },
    __setDuplicateMap: (map: Record<string, string>) => {
      mockServerDuplicateUrlMap = map;
    },
    __setNetworkErrorOnce: (val: boolean) => {
      mockCreateNetworkErrorOnce = val;
    },
    __createBookmarkMock: createBookmarkMock,
    __createBookmarksMock: createBookmarksMock,
    __resetLibraryMock: resetLibraryMock,
    createBookmarkApi: () => ({
      listBookmarksUpdatedSince,
      listBookmarkIds,
      listEnrichmentsUpdatedSince: empty,
      listTags: empty,
      listBookmarkTags: empty,
      listCollections: empty,
      createBookmark: createBookmarkMock,
      createBookmarks: createBookmarksMock,
      updateBookmark: async (_id: string, payload: unknown) => payload as Bookmark,
      resetLibrary: resetLibraryMock,
    }),
  };
});

jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: async () => ({ patch: {}, metadata_status: 'complete' }),
}));

import { BookmarksProvider, useBookmarks } from '@/store/bookmarks';
import { type FakeRepositoryModule } from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;
const apiMock = jest.requireMock('@/api/bookmarks') as {
  __setRemoteRows: (rows: Array<{ id: string; url: string | null }>) => void;
  __setDuplicateMap: (map: Record<string, string>) => void;
  __setNetworkErrorOnce: (val: boolean) => void;
  __createBookmarkMock: jest.Mock;
  __createBookmarksMock: jest.Mock;
  __resetLibraryMock: jest.Mock;
};
const authMock = jest.requireMock('@/supabase/auth-provider') as {
  __setAuth: (next: Record<string, unknown>) => void;
};

function wrapper({ children }: { children: ReactNode }) {
  return <BookmarksProvider>{children}</BookmarksProvider>;
}

async function renderReadyStore() {
  const utils = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(utils.result.current.isLoading).toBe(false));
  await waitFor(() => expect(utils.result.current.isSyncing).toBe(false));
  return utils;
}

beforeEach(() => {
  fakeRepo.__reset([]);
  apiMock.__setRemoteRows([]);
  apiMock.__setDuplicateMap({});
  apiMock.__setNetworkErrorOnce(false);
  apiMock.__createBookmarkMock.mockClear();
  apiMock.__createBookmarksMock.mockClear();
  apiMock.__resetLibraryMock.mockClear();
  authMock.__setAuth({ status: 'authenticated', session: mockRealSession, userId: 'real-user' });
});

describe('Mass Import, Sync & Reset lifecycle', () => {
  test('mass imports 50 items, dedupes intra-batch, and flushes to local queue without blocking UI', async () => {
    const { result } = await renderReadyStore();

    const importItems = Array.from({ length: 50 }, (_, i) => ({
      url: `https://example.com/item-${i % 40}`, // 40 unique URLs, 10 duplicate URLs intra-batch
      title: `Item ${i}`,
      notes: null,
      tags: [],
      collection: null,
    }));

    let summary!: ReturnType<typeof result.current.importBookmarks>;
    await act(async () => {
      summary = result.current.importBookmarks(importItems);
    });

    expect(summary.imported).toBe(40);
    expect(summary.duplicates).toBe(10);
    expect(summary.skipped).toBe(0);

    // Verify local inbox contains 40 items immediately
    expect(result.current.inbox).toHaveLength(40);
    expect(fakeRepo.__bookmarks()).toHaveLength(40);
  });

  test('syncs bulk import and adopts server duplicate IDs (STASH-3Q) without duplicating local rows', async () => {
    const EXISTING_SERVER_ID = '00000000-0000-4000-8000-0000000000ef';
    const DUP_URL = 'https://example.com/already-on-server';

    // The existing bookmark lives on the server under EXISTING_SERVER_ID
    apiMock.__setDuplicateMap({ [DUP_URL]: EXISTING_SERVER_ID });
    apiMock.__setRemoteRows([{ id: EXISTING_SERVER_ID, url: DUP_URL }]);

    const { result } = await renderReadyStore();

    const importItems = [
      { url: DUP_URL, title: 'Duplicate Item', notes: null, tags: [], collection: null },
      { url: 'https://example.com/fresh-item-1', title: 'Fresh 1', notes: null, tags: [], collection: null },
      { url: 'https://example.com/fresh-item-2', title: 'Fresh 2', notes: null, tags: [], collection: null },
    ];

    await act(async () => {
      result.current.importBookmarks(importItems);
    });

    // Wait for the auto-triggered background sync to settle
    await waitFor(() => expect(result.current.isSyncing).toBe(false), { timeout: 5000 });
    await waitFor(() => expect(result.current.queue).toHaveLength(0), { timeout: 5000 });

    // The duplicate item must adopt EXISTING_SERVER_ID locally
    const dupBookmark = result.current.inbox.find((b) => b.url === DUP_URL);
    expect(dupBookmark).toBeDefined();
    expect(dupBookmark?.id).toBe(EXISTING_SERVER_ID);
    expect(dupBookmark?.sync_status).toBe('synced');

    // Ensure library total count is exactly 3 (no duplication of duplicate item)
    expect(result.current.inbox).toHaveLength(3);
    expect(fakeRepo.__bookmarks()).toHaveLength(3);
  });

  test('tracks inbox counter stability and pending queue counter reduction during chunked bulk sync', async () => {
    const { result } = await renderReadyStore();

    // Pause sync so we can verify exact counter counts before and during upload
    await act(async () => {
      result.current.setSyncPaused(true);
    });

    // Import 60 unique items
    const importItems = Array.from({ length: 60 }, (_, i) => ({
      url: `https://example.com/counter-item-${i}`,
      title: `Counter Item ${i}`,
      notes: null,
      tags: [],
      collection: null,
    }));

    await act(async () => {
      result.current.importBookmarks(importItems);
    });

    // Inbox counter jumps immediately to +60
    expect(result.current.inbox).toHaveLength(60);
    // Queue (pending counter) is 60
    expect(result.current.queue).toHaveLength(60);

    // Unpause sync to trigger upload
    await act(async () => {
      result.current.setSyncPaused(false);
    });

    // Wait for sync to settle completely
    await waitFor(() => expect(result.current.isSyncing).toBe(false), { timeout: 5000 });
    await waitFor(() => expect(result.current.queue).toHaveLength(0), { timeout: 5000 });

    // Inbox counter stays exactly 60 (no fluctuations or duplicates)
    expect(result.current.inbox).toHaveLength(60);
    expect(result.current.inbox.every((b) => b.sync_status === 'synced')).toBe(true);
  });

  test('reproduces STASH-3Y / STASH-41 counter bouncing: background metadata resolution during bulk create sync does NOT enqueue update operations', async () => {
    const { result } = await renderReadyStore();

    await act(async () => {
      result.current.setSyncPaused(true);
    });

    await act(async () => {
      result.current.importBookmarks([
        { url: 'https://example.com/meta-1', title: 'Meta 1', notes: null, tags: [], collection: null },
        { url: 'https://example.com/meta-2', title: 'Meta 2', notes: null, tags: [], collection: null },
      ]);
    });

    // Simulate background metadata resolution (site_name, metadata_status: 'complete')
    const item1 = result.current.inbox.find((b) => b.url === 'https://example.com/meta-1')!;
    await fakeRepo.repository.updateBookmark({
      ...item1,
      site_name: 'Example Site',
      metadata_status: 'complete',
    });

    // Resume sync
    await act(async () => {
      result.current.setSyncPaused(false);
    });

    await waitFor(() => expect(result.current.isSyncing).toBe(false), { timeout: 5000 });

    // Queue must settle cleanly to 0 (metadata resolution must not bounce queue entries or enqueue updates)
    expect(result.current.queue).toHaveLength(0);
  });

  test('resetLibrary refuses during active local import or sync, and cleanly clears state when idle', async () => {
    const { result } = await renderReadyStore();

    // Import items
    await act(async () => {
      result.current.importBookmarks([
        { url: 'https://example.com/reset-test-1', title: 'R1', notes: null, tags: [], collection: null },
        { url: 'https://example.com/reset-test-2', title: 'R2', notes: null, tags: [], collection: null },
      ]);
    });

    // Wait for sync to settle
    await waitFor(() => expect(result.current.isSyncing).toBe(false), { timeout: 5000 });

    // Call resetLibrary when idle
    let resetOutcome!: Awaited<ReturnType<typeof result.current.resetLibrary>>;
    await act(async () => {
      resetOutcome = await result.current.resetLibrary();
    });

    expect(resetOutcome).toEqual({ ok: true });
    expect(result.current.inbox).toHaveLength(0);
    expect(fakeRepo.__bookmarks()).toHaveLength(0);
    expect(fakeRepo.__queue()).toHaveLength(0);
    expect(apiMock.__resetLibraryMock).toHaveBeenCalledTimes(1);
  });

  test('recovers from transient network error mid-bulk sync without losing pending queue items', async () => {
    const { result } = await renderReadyStore();

    // Set 1 transient network failure for the upcoming sync
    apiMock.__setNetworkErrorOnce(true);

    await act(async () => {
      result.current.importBookmarks([
        { url: 'https://example.com/err-1', title: 'E1', notes: null, tags: [], collection: null },
        { url: 'https://example.com/err-2', title: 'E2', notes: null, tags: [], collection: null },
      ]);
    });

    // Wait for both the initial failing pass and auto-retry pass to settle completely
    await waitFor(() => expect(result.current.isSyncing).toBe(false), { timeout: 5000 });
    await waitFor(() => expect(result.current.queue).toHaveLength(0), { timeout: 5000 });

    // Both bookmarks recovered and synced successfully
    expect(result.current.inbox).toHaveLength(2);
    expect(result.current.inbox.every((b) => b.sync_status === 'synced')).toBe(true);
  });
});
