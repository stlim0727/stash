import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";

import type { Bookmark } from "@/domain/types";

jest.mock("@/storage/repository", () =>
  require("./helpers/fake-repository").createFakeRepositoryModule(),
);

const mockRealSession = {
  access_token: "real-token",
  refresh_token: "real-refresh",
  token_type: "bearer",
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: "real-user", is_anonymous: false, email: "user@example.com" },
};
const mockOtherRealSession = {
  ...mockRealSession,
  access_token: "other-token",
  user: {
    id: "other-real-user",
    is_anonymous: false,
    email: "other@example.com",
  },
};

jest.mock("@/supabase/auth-provider", () => {
  let state = {
    status: "authenticated" as string,
    session: mockRealSession as unknown,
    userId: "real-user" as string | null,
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

jest.mock("@/api/bookmarks", () => {
  let remoteRows: Array<{ id: string; url: string | null }> = [];
  let remoteCollections: Array<{
    id: string;
    user_id: string;
    name: string;
    description: null;
    created_at: string;
    updated_at: string;
  }> = [];
  const listBookmarksUpdatedSince = jest.fn(async () => []);
  const listBookmarkIds = jest.fn(async () => remoteRows.map((r) => r.id));
  const empty = async () => [];
  const resetLibraryMock = jest.fn(async () => ({
    bookmarks: remoteRows.length,
  }));
  const createCollectionMock = jest.fn(async (name: string) => {
    const now = new Date().toISOString();
    const collection = {
      id: `collection-${remoteCollections.length + 1}`,
      user_id: "real-user",
      name,
      description: null,
      created_at: now,
      updated_at: now,
    };
    remoteCollections.push(collection);
    return collection;
  });
  const updateBookmarkMock = jest.fn(
    async (id: string, payload: Record<string, unknown>) => ({
      id,
      ...payload,
      updated_at: new Date().toISOString(),
    }),
  );
  const addTagsMock = jest.fn(async ({ tags }: { tags: string[] }) =>
    tags.map((name, index) => ({
      id: `tag-${index + 1}`,
      user_id: "real-user",
      name,
      slug: name.toLowerCase(),
      source: "user" as const,
      created_at: new Date().toISOString(),
    })),
  );

  const createBookmarkMock = jest.fn(
    async (payload: { url?: string | null; id?: string }) => {
      if (mockCreateNetworkErrorOnce) {
        mockCreateNetworkErrorOnce = false;
        throw new Error("Network error during create");
      }
      const url = payload.url ?? null;
      if (url && mockServerDuplicateUrlMap[url]) {
        return {
          bookmark_id: mockServerDuplicateUrlMap[url],
          status: "duplicate" as const,
          metadata_status: "complete" as const,
        };
      }
      const newId =
        payload.id ||
        "server-gen-id-" + Math.random().toString(36).substring(2, 9);
      remoteRows.push({ id: newId, url });
      return {
        bookmark_id: newId,
        status: "created" as const,
        metadata_status: "complete" as const,
      };
    },
  );

  const createBookmarksMock = jest.fn(
    async (payloads: Array<{ url?: string | null; id?: string }>) => {
      if (mockCreateNetworkErrorOnce) {
        mockCreateNetworkErrorOnce = false;
        throw new Error("Network error during bulk create");
      }
      return payloads.map((payload) => {
        const url = payload.url ?? null;
        if (url && mockServerDuplicateUrlMap[url]) {
          return {
            bookmark_id: mockServerDuplicateUrlMap[url],
            status: "duplicate" as const,
            metadata_status: "complete" as const,
          };
        }
        const newId =
          payload.id ||
          "server-gen-id-" + Math.random().toString(36).substring(2, 9);
        remoteRows.push({ id: newId, url });
        return {
          bookmark_id: newId,
          status: "created" as const,
          metadata_status: "complete" as const,
        };
      });
    },
  );

  return {
    __setRemoteRows: (rows: Array<{ id: string; url: string | null }>) => {
      remoteRows = [...rows];
      remoteCollections = [];
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
    __createCollectionMock: createCollectionMock,
    __updateBookmarkMock: updateBookmarkMock,
    __addTagsMock: addTagsMock,
    createBookmarkApi: () => ({
      listBookmarksUpdatedSince,
      listBookmarkIds,
      listEnrichmentsUpdatedSince: empty,
      listTags: empty,
      listBookmarkTags: empty,
      listCollections: async () => [...remoteCollections],
      createBookmark: createBookmarkMock,
      createBookmarks: createBookmarksMock,
      updateBookmark: updateBookmarkMock,
      addTags: addTagsMock,
      removeTags: jest.fn(async () => undefined),
      createCollection: createCollectionMock,
      resetLibrary: resetLibraryMock,
    }),
  };
});

jest.mock("@/domain/enrichment", () => ({
  enrichBookmark: async () => ({ patch: {}, metadata_status: "complete" }),
}));

import { BookmarksProvider, useBookmarks } from "@/store/bookmarks";
import { type FakeRepositoryModule } from "./helpers/fake-repository";

const fakeRepo = jest.requireMock(
  "@/storage/repository",
) as FakeRepositoryModule;
const apiMock = jest.requireMock("@/api/bookmarks") as {
  __setRemoteRows: (rows: Array<{ id: string; url: string | null }>) => void;
  __setDuplicateMap: (map: Record<string, string>) => void;
  __setNetworkErrorOnce: (val: boolean) => void;
  __createBookmarkMock: jest.Mock;
  __createBookmarksMock: jest.Mock;
  __resetLibraryMock: jest.Mock;
  __createCollectionMock: jest.Mock;
  __updateBookmarkMock: jest.Mock;
  __addTagsMock: jest.Mock;
};
const authMock = jest.requireMock("@/supabase/auth-provider") as {
  __setAuth: (next: Record<string, unknown>) => void;
};

function wrapper({ children }: { children: ReactNode }) {
  return <BookmarksProvider>{children}</BookmarksProvider>;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
  apiMock.__createCollectionMock.mockClear();
  apiMock.__updateBookmarkMock.mockClear();
  apiMock.__addTagsMock.mockClear();
  authMock.__setAuth({
    status: "authenticated",
    session: mockRealSession,
    userId: "real-user",
  });
});

describe("Mass Import, Sync & Reset lifecycle", () => {
  test("mass imports 50 items, dedupes intra-batch, and flushes to local queue without blocking UI", async () => {
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

  test("restores an imported collection through the durable post-create outbox", async () => {
    const { result } = await renderReadyStore();

    await act(async () => {
      result.current.importBookmarks([
        {
          source: "stash-backup",
          url: "https://example.com/organized",
          title: "Organized",
          notes: null,
          tags: [],
          collection: "Projects",
        },
      ]);
    });

    await waitFor(
      () => expect(apiMock.__createCollectionMock).toHaveBeenCalledWith("Projects"),
      { timeout: 5_000 },
    );
    const collectionId = apiMock.__createCollectionMock.mock.results[0]?.value
      ? (await apiMock.__createCollectionMock.mock.results[0].value).id
      : null;
    expect(collectionId).toBe("collection-1");
    await waitFor(() =>
      expect(apiMock.__updateBookmarkMock).toHaveBeenCalledWith(
        expect.any(String),
        { collection_id: "collection-1" },
      ),
    );
    await waitFor(() =>
      expect(result.current.inbox[0]?.collection_id).toBe("collection-1"),
    );
    expect(fakeRepo.__meta("pending_import_collections")).toBe("[]");
  });

  test("keeps a failed collection intent and retries it on manual sync", async () => {
    apiMock.__createCollectionMock.mockRejectedValueOnce(
      new Error("temporary collection failure"),
    );
    const { result } = await renderReadyStore();

    await act(async () => {
      result.current.importBookmarks([
        {
          source: "netscape-html",
          url: "https://example.com/retry-folder",
          title: "Retry folder",
          notes: null,
          tags: [],
          collection: "Retry Projects",
        },
      ]);
    });

    await waitFor(() => {
      const pending = JSON.parse(
        fakeRepo.__meta("pending_import_collections") ?? "[]",
      );
      expect(pending[0]).toEqual(
        expect.objectContaining({
          collection_name: "Retry Projects",
          status: "failed",
          last_error: "temporary collection failure",
        }),
      );
    });

    await act(async () => {
      await result.current.syncNow();
    });

    await waitFor(() =>
      expect(fakeRepo.__meta("pending_import_collections")).toBe("[]"),
    );
    expect(apiMock.__createCollectionMock).toHaveBeenCalledTimes(2);
  });

  test("a manual collection move supersedes a failed imported collection intent", async () => {
    apiMock.__createCollectionMock.mockRejectedValueOnce(
      new Error("temporary collection failure"),
    );
    const { result } = await renderReadyStore();

    await act(async () => {
      result.current.importBookmarks([
        {
          source: "netscape-html",
          url: "https://example.com/manual-folder-wins",
          title: "Manual folder wins",
          notes: null,
          tags: [],
          collection: "Imported folder",
        },
      ]);
    });
    await waitFor(() => {
      const pending = JSON.parse(
        fakeRepo.__meta("pending_import_collections") ?? "[]",
      );
      expect(pending[0]?.status).toBe("failed");
    });

    const bookmarkId = result.current.inbox[0]!.id;
    await act(async () => {
      result.current.assignCollection(bookmarkId, "manual-collection");
      await result.current.syncNow();
    });

    await waitFor(() =>
      expect(fakeRepo.__meta("pending_import_collections")).toBe("[]"),
    );
    expect(apiMock.__createCollectionMock).toHaveBeenCalledTimes(1);
    expect(apiMock.__updateBookmarkMock).not.toHaveBeenCalledWith(
      bookmarkId,
      { collection_id: "collection-1" },
    );
  });

  test("re-drives imported tags after their bookmark create finishes", async () => {
    const { result } = await renderReadyStore();

    await act(async () => {
      result.current.importBookmarks([
        {
          source: "pocket-csv",
          url: "https://example.com/imported-tag-redrive",
          title: "Imported tag redrive",
          notes: null,
          tags: ["Reading"],
          collection: null,
        },
      ]);
    });

    await waitFor(
      () =>
        expect(apiMock.__addTagsMock).toHaveBeenCalledWith(
          expect.objectContaining({ tags: ["Reading"] }),
        ),
      { timeout: 5_000 },
    );
    await waitFor(() =>
      expect(fakeRepo.__meta("pending_tag_ops")).toBe("[]"),
    );
  });

  test("reconciles an account switch before uploading an in-flight import", async () => {
    const { result, rerender } = await renderReadyStore();
    await act(async () => {
      result.current.setSyncPaused(true);
      result.current.importBookmarks([
        {
          source: "stash-backup",
          url: "https://example.com/account-switch-import",
          title: "Account switch import",
          notes: null,
          tags: [],
          collection: "Carried import folder",
        },
      ]);
    });
    await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(1));

    authMock.__setAuth({
      status: "authenticated",
      session: mockOtherRealSession,
      userId: "other-real-user",
    });
    await act(async () => {
      rerender(undefined);
    });
    await act(async () => {
      result.current.setSyncPaused(false);
    });

    await waitFor(
      () => expect(apiMock.__createBookmarkMock).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );
    await waitFor(() =>
      expect(result.current.inbox[0]?.collection_id).toBe("collection-1"),
    );
    await waitFor(() => expect(result.current.queue).toHaveLength(0));
    await waitFor(() => expect(result.current.isSyncing).toBe(false));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    await waitFor(() => expect(result.current.isSyncing).toBe(false));
    expect(result.current.inbox).toHaveLength(1);
    expect(fakeRepo.__meta("pending_import_collections")).toBe("[]");
  });

  test("syncs bulk import and adopts server duplicate IDs (STASH-3Q) without duplicating local rows", async () => {
    const EXISTING_SERVER_ID = "00000000-0000-4000-8000-0000000000ef";
    const DUP_URL = "https://example.com/already-on-server";

    // The existing bookmark lives on the server under EXISTING_SERVER_ID
    apiMock.__setDuplicateMap({ [DUP_URL]: EXISTING_SERVER_ID });
    apiMock.__setRemoteRows([{ id: EXISTING_SERVER_ID, url: DUP_URL }]);

    const { result } = await renderReadyStore();

    const importItems = [
      {
        url: DUP_URL,
        title: "Duplicate Item",
        notes: null,
        tags: [],
        collection: "Existing duplicate folder",
      },
      {
        url: "https://example.com/fresh-item-1",
        title: "Fresh 1",
        notes: null,
        tags: [],
        collection: null,
      },
      {
        url: "https://example.com/fresh-item-2",
        title: "Fresh 2",
        notes: null,
        tags: [],
        collection: null,
      },
    ];

    await act(async () => {
      result.current.importBookmarks(importItems);
    });

    // Wait for the auto-triggered background sync to settle
    await waitFor(() => expect(result.current.isSyncing).toBe(false), {
      timeout: 5000,
    });
    await waitFor(() => expect(result.current.queue).toHaveLength(0), {
      timeout: 5000,
    });

    // The duplicate item must adopt EXISTING_SERVER_ID locally
    const dupBookmark = result.current.inbox.find((b) => b.url === DUP_URL);
    expect(dupBookmark).toBeDefined();
    expect(dupBookmark?.id).toBe(EXISTING_SERVER_ID);
    expect(dupBookmark?.sync_status).toBe("synced");
    await waitFor(
      () =>
        expect(apiMock.__updateBookmarkMock).toHaveBeenCalledWith(
          EXISTING_SERVER_ID,
          { collection_id: "collection-1" },
        ),
      { timeout: 5_000 },
    );

    // Ensure library total count is exactly 3 (no duplication of duplicate item)
    expect(result.current.inbox).toHaveLength(3);
    expect(fakeRepo.__bookmarks()).toHaveLength(3);
  });

  test("tracks inbox counter stability and pending queue counter reduction during chunked bulk sync", async () => {
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
    await waitFor(() => expect(result.current.isSyncing).toBe(false), {
      timeout: 5000,
    });
    await waitFor(() => expect(result.current.queue).toHaveLength(0), {
      timeout: 5000,
    });

    // Inbox counter stays exactly 60 (no fluctuations or duplicates)
    expect(result.current.inbox).toHaveLength(60);
    expect(result.current.inbox.every((b) => b.sync_status === "synced")).toBe(
      true,
    );
  });

  test("reproduces STASH-3Y / STASH-41 counter bouncing: background metadata resolution during bulk create sync does NOT enqueue update operations", async () => {
    const { result } = await renderReadyStore();

    await act(async () => {
      result.current.setSyncPaused(true);
    });

    await act(async () => {
      result.current.importBookmarks([
        {
          url: "https://example.com/meta-1",
          title: "Meta 1",
          notes: null,
          tags: [],
          collection: null,
        },
        {
          url: "https://example.com/meta-2",
          title: "Meta 2",
          notes: null,
          tags: [],
          collection: null,
        },
      ]);
    });

    // Simulate background metadata resolution (site_name, metadata_status: 'complete')
    const item1 = result.current.inbox.find(
      (b) => b.url === "https://example.com/meta-1",
    )!;
    await fakeRepo.repository.updateBookmark({
      ...item1,
      site_name: "Example Site",
      metadata_status: "complete",
    });

    // Resume sync
    await act(async () => {
      result.current.setSyncPaused(false);
    });

    await waitFor(() => expect(result.current.isSyncing).toBe(false), {
      timeout: 5000,
    });

    // Queue must settle cleanly to 0 (metadata resolution must not bounce queue entries or enqueue updates)
    expect(result.current.queue).toHaveLength(0);
  });

  test("resetLibrary refuses while local import flush is active", async () => {
    const { result } = await renderReadyStore();
    const originalInsertImportBatch = fakeRepo.repository.insertImportBatch;
    const flushStarted = deferred();
    const releaseFlush = deferred();

    fakeRepo.repository.insertImportBatch = jest.fn(
      async (bookmarks, entries) => {
        flushStarted.resolve();
        await releaseFlush.promise;
        await originalInsertImportBatch?.(bookmarks, entries);
      },
    );

    try {
      await act(async () => {
        result.current.importBookmarks([
          {
            url: "https://example.com/reset-busy-local-1",
            title: "R1",
            notes: null,
            tags: [],
            collection: null,
          },
          {
            url: "https://example.com/reset-busy-local-2",
            title: "R2",
            notes: null,
            tags: [],
            collection: null,
          },
        ]);
      });

      await flushStarted.promise;

      let resetOutcome!: Awaited<
        ReturnType<typeof result.current.resetLibrary>
      >;
      await act(async () => {
        resetOutcome = await result.current.resetLibrary();
      });

      expect(resetOutcome).toEqual({ ok: false, reason: "busy" });
      expect(apiMock.__resetLibraryMock).not.toHaveBeenCalled();
    } finally {
      releaseFlush.resolve();
      fakeRepo.repository.insertImportBatch = originalInsertImportBatch;
    }

    await waitFor(() => expect(result.current.isSyncing).toBe(false), {
      timeout: 5000,
    });
    await waitFor(() => expect(result.current.queue).toHaveLength(0), {
      timeout: 5000,
    });
  });

  test("resetLibrary refuses while sync upload is active, and cleanly clears state when idle", async () => {
    const { result } = await renderReadyStore();

    await act(async () => {
      result.current.setSyncPaused(true);
    });

    await act(async () => {
      result.current.importBookmarks([
        {
          url: "https://example.com/reset-busy-sync-1",
          title: "R1",
          notes: null,
          tags: [],
          collection: null,
        },
        {
          url: "https://example.com/reset-busy-sync-2",
          title: "R2",
          notes: null,
          tags: [],
          collection: null,
        },
      ]);
    });

    await waitFor(() => expect(result.current.queue).toHaveLength(2), {
      timeout: 5000,
    });

    const originalCreateBookmarks =
      apiMock.__createBookmarksMock.getMockImplementation();
    const uploadStarted = deferred();
    const releaseUpload = deferred();
    apiMock.__createBookmarksMock.mockImplementationOnce(async (payloads) => {
      uploadStarted.resolve();
      await releaseUpload.promise;
      if (originalCreateBookmarks) {
        return originalCreateBookmarks(payloads);
      }
      return [];
    });

    try {
      await act(async () => {
        result.current.setSyncPaused(false);
      });

      await uploadStarted.promise;

      let busyOutcome!: Awaited<ReturnType<typeof result.current.resetLibrary>>;
      await act(async () => {
        busyOutcome = await result.current.resetLibrary();
      });

      expect(busyOutcome).toEqual({ ok: false, reason: "busy" });
      expect(apiMock.__resetLibraryMock).not.toHaveBeenCalled();
    } finally {
      releaseUpload.resolve();
    }

    await waitFor(() => expect(result.current.isSyncing).toBe(false), {
      timeout: 5000,
    });
    await waitFor(() => expect(result.current.queue).toHaveLength(0), {
      timeout: 5000,
    });

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

  test("a save landing inside the debounce window joins the same batch (fresh queue, not the armed-at snapshot)", async () => {
    // PR #635 review: the auto-sync trigger waits METADATA_SYNC_DEBOUNCE_MS
    // before running a pass so a burst of captures uploads together. The
    // timer must invoke the CURRENT syncNow, not the one captured when it was
    // armed — the whole point of the window is that more work arrives during
    // it, and each arrival recreates syncNow around the new queue. A captured
    // closure would upload only the first save (a single non-bulk create),
    // leaving the second for a later pass, which is exactly the per-item sync
    // churn the debounce was added to stop.
    const { result } = await renderReadyStore();

    await act(async () => {
      result.current.addBookmark({ url: "https://example.com/batched-1" });
    });
    // Well inside the 250ms window, so this must join the first one's batch.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      result.current.addBookmark({ url: "https://example.com/batched-2" });
    });

    await waitFor(() => expect(result.current.queue).toHaveLength(0), {
      timeout: 5000,
    });

    expect(apiMock.__createBookmarksMock).toHaveBeenCalledTimes(1);
    const batch = apiMock.__createBookmarksMock.mock.calls[0]?.[0] as Array<{
      url: string;
    }>;
    expect(batch.map((payload) => payload.url).sort()).toEqual([
      "https://example.com/batched-1",
      "https://example.com/batched-2",
    ]);
    // The single-row endpoint is the tell-tale of a one-item stale batch.
    expect(apiMock.__createBookmarkMock).not.toHaveBeenCalled();
  });

  test("recovers from transient network error mid-bulk sync without losing pending queue items", async () => {
    const { result } = await renderReadyStore();

    // Set 1 transient network failure for the upcoming sync
    apiMock.__setNetworkErrorOnce(true);

    await act(async () => {
      result.current.importBookmarks([
        {
          url: "https://example.com/err-1",
          title: "E1",
          notes: null,
          tags: [],
          collection: null,
        },
        {
          url: "https://example.com/err-2",
          title: "E2",
          notes: null,
          tags: [],
          collection: null,
        },
      ]);
    });

    // Wait for the initial failing pass to settle completely
    await waitFor(() => expect(result.current.isSyncing).toBe(false), {
      timeout: 5000,
    });

    // Since metadata is already resolved at the time of the first sync run,
    // the network failure leaves the items failed. Trigger syncNow manually
    // to drive the retry pass (simulating a reconnect or manual Sync now nudge).
    await act(async () => {
      await result.current.syncNow();
    });

    await waitFor(() => expect(result.current.queue).toHaveLength(0), {
      timeout: 5000,
    });

    // Both bookmarks recovered and synced successfully
    expect(result.current.inbox).toHaveLength(2);
    expect(result.current.inbox.every((b) => b.sync_status === "synced")).toBe(
      true,
    );
  });
});
