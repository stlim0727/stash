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
  // Fake for the batch-attach RPC (issue #713): resolves/creates each tag and
  // the (at most one) collection per bookmark against the same `remoteCollections`
  // store `__createCollectionMock` used to use, so collection ids keep the
  // "collection-1", "collection-2", ... numbering the other assertions below
  // rely on. Always reports the collection as attached — the real RPC's
  // `collection_id is null` guard is a server-side detail; the client-side
  // "did a manual move win the race" guarantee is enforced by the store's own
  // intentIsCurrent/collection_id-null checks before it applies the result,
  // which is what these tests actually verify.
  const bulkAttachMock = jest.fn(
    async (
      items: Array<{
        bookmark_id: string;
        tags: Array<{ name: string; source: string }>;
        collection_name: string | null;
      }>,
    ) =>
      items.map((item) => {
        const tags = item.tags.map((tag) => ({
          id: `tag-${tag.name.toLowerCase()}`,
          user_id: "real-user",
          name: tag.name,
          slug: tag.name.trim().toLowerCase().replace(/\s+/g, "-"),
          source: tag.source,
          created_at: new Date().toISOString(),
        }));

        let collection = null as null | (typeof remoteCollections)[number];
        let collectionAttached = false;
        let bookmarkUpdatedAt: string | null = null;
        if (item.collection_name) {
          const key = item.collection_name.trim().toLowerCase();
          collection =
            remoteCollections.find(
              (candidate) => candidate.name.trim().toLowerCase() === key,
            ) ?? null;
          if (!collection) {
            const now = new Date().toISOString();
            collection = {
              id: `collection-${remoteCollections.length + 1}`,
              user_id: "real-user",
              name: item.collection_name,
              description: null,
              created_at: now,
              updated_at: now,
            };
            remoteCollections.push(collection);
          }
          collectionAttached = true;
          bookmarkUpdatedAt = new Date().toISOString();
        }

        return {
          bookmark_id: item.bookmark_id,
          tags,
          collection,
          collection_attached: collectionAttached,
          bookmark_updated_at: bookmarkUpdatedAt,
        };
      }),
  );
  // Fake for the bulk enrichment-restore endpoint (issue #719): mirrors the
  // real bulkRestoreAIEnrichment's "one row per input, in the same order"
  // shape. Tests below import a single bookmark at a time, so each chunk is
  // an array of length 1 — the assertions wrap their expected input in `[...]`.
  const bulkRestoreAIEnrichmentMock = jest.fn(
    async (
      inputs: Array<{ bookmark_id: string; [key: string]: unknown }>,
    ) =>
      inputs.map((input) => ({
        id: `enrichment-${input.bookmark_id}`,
        bookmark_id: input.bookmark_id,
        user_id: "real-user",
        summary: (input.summary as string | null) ?? null,
        topics: (input.topics as string[]) ?? [],
        suggested_tags: (input.suggested_tags as unknown[]) ?? [],
        suggested_collection_id: null,
        suggested_collection_name: null,
        model: (input.model as string | null) ?? null,
        status: input.status,
        confidence: (input.confidence as number | null) ?? null,
        degraded: false,
        degraded_reason: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
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
    __bulkAttachMock: bulkAttachMock,
    __bulkRestoreAIEnrichmentMock: bulkRestoreAIEnrichmentMock,
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
      bulkAttachTagsAndCollections: bulkAttachMock,
      resetLibrary: resetLibraryMock,
      bulkRestoreAIEnrichment: bulkRestoreAIEnrichmentMock,
    }),
  };
});

jest.mock("@/domain/enrichment", () => ({
  enrichBookmark: jest.fn(async () => ({
    patch: {},
    metadata_status: "complete" as const,
  })),
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
  __bulkAttachMock: jest.Mock;
  __bulkRestoreAIEnrichmentMock: jest.Mock;
};
const authMock = jest.requireMock("@/supabase/auth-provider") as {
  __setAuth: (next: Record<string, unknown>) => void;
};
const enrichmentMock = jest.requireMock("@/domain/enrichment") as {
  enrichBookmark: jest.Mock;
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
  apiMock.__bulkAttachMock.mockClear();
  apiMock.__bulkRestoreAIEnrichmentMock.mockClear();
  enrichmentMock.enrichBookmark.mockClear();
  authMock.__setAuth({
    status: "authenticated",
    session: mockRealSession,
    userId: "real-user",
  });
});

describe("Mass Import, Sync & Reset lifecycle", () => {
  test("pausing during enrichment restore stops before the next chunk (STASH-5C)", async () => {
    const { result } = await renderReadyStore();
    const firstChunkStarted = deferred();
    const releaseFirstChunk = deferred();
    const originalBulkRestore =
      apiMock.__bulkRestoreAIEnrichmentMock.getMockImplementation()!;
    apiMock.__bulkRestoreAIEnrichmentMock.mockImplementationOnce(
      async (items: unknown[]) => {
        firstChunkStarted.resolve();
        await releaseFirstChunk.promise;
        return originalBulkRestore(items);
      },
    );

    await act(async () => {
      result.current.setSyncPaused(true);
      result.current.importBookmarks(
        Array.from({ length: 51 }, (_, i) => ({
          source: "stash-backup" as const,
          url: `https://example.com/pause-enrichment-${i}`,
          title: `Pause enrichment ${i}`,
          notes: null,
          tags: [],
          collection: null,
          enrichment: {
            summary: `Summary ${i}`,
            topics: [],
            suggested_tags: [],
            status: "complete" as const,
            model: null,
            confidence: null,
          },
        })),
      );
    });
    await waitFor(() => expect(result.current.queue).toHaveLength(51));

    await act(async () => {
      result.current.setSyncPaused(false);
    });
    await firstChunkStarted.promise;
    await act(async () => {
      result.current.setSyncPaused(true);
    });
    expect(result.current.syncPaused).toBe(true);
    await act(async () => {
      releaseFirstChunk.resolve();
    });

    await waitFor(() => expect(result.current.isSyncing).toBe(false), {
      timeout: 10_000,
    });
    expect(apiMock.__bulkRestoreAIEnrichmentMock).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(fakeRepo.__meta("pending_enrichment_restore") ?? "[]"),
    ).toHaveLength(1);
  });

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
      () =>
        expect(apiMock.__bulkAttachMock).toHaveBeenCalledWith([
          expect.objectContaining({ collection_name: "Projects" }),
        ]),
      { timeout: 5_000 },
    );
    await waitFor(() =>
      expect(result.current.inbox[0]?.collection_id).toBe("collection-1"),
    );
    expect(fakeRepo.__meta("pending_import_collections")).toBe("[]");
  });

  test("restores a Stash JSON backup's AI enrichment through the durable post-create outbox (#671)", async () => {
    const { result } = await renderReadyStore();

    await act(async () => {
      result.current.importBookmarks([
        {
          source: "stash-backup",
          url: "https://example.com/enriched",
          title: "Enriched",
          notes: null,
          tags: [],
          collection: null,
          enrichment: {
            summary: "A concise summary.",
            topics: ["reading"],
            suggested_tags: [{ name: "tech", confidence: 0.9 }],
            status: "complete",
            model: "gpt-5",
            confidence: 0.87,
          },
        },
      ]);
    });

    await waitFor(
      () =>
        expect(apiMock.__bulkRestoreAIEnrichmentMock).toHaveBeenCalledWith([
          expect.objectContaining({
            bookmark_id: expect.any(String),
            summary: "A concise summary.",
            status: "complete",
            model: "gpt-5",
          }),
        ]),
      { timeout: 5_000 },
    );
    const bookmarkId = result.current.inbox[0]?.id;
    await waitFor(() =>
      expect(result.current.getEnrichment(bookmarkId!)?.summary).toBe(
        "A concise summary.",
      ),
    );
    expect(fakeRepo.__meta("pending_enrichment_restore")).toBe("[]");
  });

  test("keeps a failed enrichment restore intent and retries it on manual sync (#671)", async () => {
    apiMock.__bulkRestoreAIEnrichmentMock.mockRejectedValueOnce(
      new Error("temporary enrichment restore failure"),
    );
    const { result } = await renderReadyStore();

    await act(async () => {
      result.current.importBookmarks([
        {
          source: "stash-backup",
          url: "https://example.com/retry-enrichment",
          title: "Retry enrichment",
          notes: null,
          tags: [],
          collection: null,
          enrichment: {
            summary: "retry me",
            topics: [],
            suggested_tags: [],
            status: "complete",
            model: null,
            confidence: null,
          },
        },
      ]);
    });

    await waitFor(
      () => {
        const pending = JSON.parse(
          fakeRepo.__meta("pending_enrichment_restore") ?? "[]",
        );
        expect(pending[0]).toEqual(
          expect.objectContaining({
            status: "failed",
            last_error: "temporary enrichment restore failure",
          }),
        );
      },
      { timeout: 5_000 },
    );

    await act(async () => {
      await result.current.syncNow();
    });

    await waitFor(() =>
      expect(fakeRepo.__meta("pending_enrichment_restore")).toBe("[]"),
    );
    expect(apiMock.__bulkRestoreAIEnrichmentMock).toHaveBeenCalledTimes(2);
  });

  test("does not double-upload during an in-flight enrichment restore sync run (#671)", async () => {
    const gate = deferred<{ id: string }>();
    apiMock.__bulkRestoreAIEnrichmentMock.mockImplementationOnce(
      async (inputs: any[]) => {
        await gate.promise;
        return inputs.map((input) => ({
          id: "enrichment-id",
          bookmark_id: input.bookmark_id,
          user_id: "real-user",
          summary: input.summary,
          topics: [],
          suggested_tags: [],
          status: "complete",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }));
      },
    );

    const { result } = await renderReadyStore();

    await act(async () => {
      result.current.importBookmarks([
        {
          source: "stash-backup",
          url: "https://example.com/double-upload-enrichment",
          title: "Double upload",
          notes: null,
          tags: [],
          collection: null,
          enrichment: {
            summary: "concurrent test",
            topics: [],
            suggested_tags: [],
            status: "complete",
            model: null,
            confidence: null,
          },
        },
      ]);
    });

    // Wait until the first sync attempts to upload the enrichment and is held open by our gate
    await waitFor(() =>
      expect(apiMock.__bulkRestoreAIEnrichmentMock).toHaveBeenCalledTimes(1),
    );

    // Fire a second syncNow while the first one is pending
    await act(async () => {
      await result.current.syncNow();
    });

    // Release the gate
    gate.resolve({ id: "enrichment-id" });

    // Ensure it was called exactly once in total (no double-upload happened) and queue is cleared
    await waitFor(() =>
      expect(fakeRepo.__meta("pending_enrichment_restore")).toBe("[]"),
    );
    expect(apiMock.__bulkRestoreAIEnrichmentMock).toHaveBeenCalledTimes(1);
  });

  test("a Stash JSON backup restore with a metadata snapshot skips the client metadata fetch and marks enrichment_policy skip (#671)", async () => {
    const { result } = await renderReadyStore();

    await act(async () => {
      result.current.importBookmarks([
        {
          source: "stash-backup",
          url: "https://example.com/restored-metadata",
          title: "Restored",
          notes: null,
          tags: [],
          collection: null,
          metadata: {
            description: "A fetched description.",
            preview_image_url: "https://example.com/preview.png",
            favicon_url: "https://example.com/favicon.ico",
            site_name: "Example",
            canonical_url: "https://example.com/restored-metadata/",
            content_type: "article",
          },
        },
      ]);
    });

    // Restored losslessly, not re-fetched: enrichBookmark's pending-only guard
    // means it must never even be invoked for a bookmark whose metadata_status
    // is already settled by the restore.
    expect(result.current.inbox[0]).toMatchObject({
      metadata_status: "complete",
      description: "A fetched description.",
      preview_image_url: "https://example.com/preview.png",
      favicon_url: "https://example.com/favicon.ico",
      site_name: "Example",
    });
    expect(enrichmentMock.enrichBookmark).not.toHaveBeenCalled();

    // A lone import goes through the single-bookmark create path, not the
    // bulk one (see the "syncs bulk import..." test below for that path).
    await waitFor(() =>
      expect(apiMock.__createBookmarkMock).toHaveBeenCalledTimes(1),
    );
    const uploaded = apiMock.__createBookmarkMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(uploaded).toMatchObject({
      enrichment_policy: "skip",
      metadata_status: "complete",
      description: "A fetched description.",
      site_name: "Example",
      favicon_url: "https://example.com/favicon.ico",
      preview_image_url: "https://example.com/preview.png",
    });
  });

  test("a Stash JSON backup restore with no metadata snapshot still skips the fetch (marks metadata_status skipped, not pending) (#671)", async () => {
    const { result } = await renderReadyStore();

    await act(async () => {
      result.current.importBookmarks([
        {
          source: "stash-backup",
          url: "https://example.com/no-metadata",
          title: "No metadata in backup",
          notes: null,
          tags: [],
          collection: null,
        },
      ]);
    });

    expect(result.current.inbox[0]?.metadata_status).toBe("skipped");
    expect(enrichmentMock.enrichBookmark).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(apiMock.__createBookmarkMock).toHaveBeenCalledTimes(1),
    );
    const uploaded = apiMock.__createBookmarkMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(uploaded).toMatchObject({
      enrichment_policy: "skip",
      metadata_status: "skipped",
    });
  });

  test("an external HTML/CSV import still fetches metadata but marks enrichment_policy skip (#671)", async () => {
    const { result } = await renderReadyStore();

    await act(async () => {
      result.current.importBookmarks([
        {
          source: "netscape-html",
          url: "https://example.com/external-import",
          title: "External",
          notes: null,
          tags: [],
          collection: null,
        },
      ]);
    });

    // Unchanged behavior: external imports still get the client metadata
    // fetch (unlike a stash-backup restore above) — only automatic AI is
    // suppressed, per the #671 policy table.
    await waitFor(() =>
      expect(enrichmentMock.enrichBookmark).toHaveBeenCalled(),
    );

    await waitFor(() =>
      expect(apiMock.__createBookmarkMock).toHaveBeenCalledTimes(1),
    );
    const uploaded = apiMock.__createBookmarkMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(uploaded).toMatchObject({ enrichment_policy: "skip" });
  });

  test("keeps a failed collection intent and retries it on manual sync", async () => {
    apiMock.__bulkAttachMock.mockRejectedValueOnce(
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
    expect(apiMock.__bulkAttachMock).toHaveBeenCalledTimes(2);
    expect(result.current.inbox[0]?.collection_id).toBe("collection-1");
  });

  test("a manual collection move supersedes a failed imported collection intent", async () => {
    apiMock.__bulkAttachMock.mockRejectedValueOnce(
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
    // The intent was dropped by the manual move before the retry pass, so the
    // failed first attempt is the ONLY bulk-attach call — no retry ever fires.
    expect(apiMock.__bulkAttachMock).toHaveBeenCalledTimes(1);
    expect(result.current.inbox[0]?.collection_id).toBe("manual-collection");
  });

  test("a manual move during collection lookup wins over the in-flight import intent", async () => {
    const bulkAttachGate = deferred<
      Array<{
        bookmark_id: string;
        tags: unknown[];
        collection: {
          id: string;
          user_id: string;
          name: string;
          description: null;
          created_at: string;
          updated_at: string;
        };
        collection_attached: boolean;
        bookmark_updated_at: string;
      }>
    >();
    apiMock.__bulkAttachMock.mockImplementationOnce(
      async () => bulkAttachGate.promise,
    );
    const { result } = await renderReadyStore();

    await act(async () => {
      result.current.importBookmarks([
        {
          source: "netscape-html",
          url: "https://example.com/in-flight-folder",
          title: "In-flight folder",
          notes: null,
          tags: [],
          collection: "Imported folder",
        },
      ]);
    });
    await waitFor(() =>
      expect(apiMock.__bulkAttachMock).toHaveBeenCalledWith([
        expect.objectContaining({ collection_name: "Imported folder" }),
      ]),
    );
    const bookmarkId = result.current.inbox[0]!.id;
    await act(async () => {
      result.current.assignCollection(bookmarkId, "manual-collection");
      // The batch RPC resolves AFTER the manual move already landed locally
      // (and dropped the pending import intent) — the store's
      // intentIsCurrent + collection_id-null re-check must refuse to apply
      // this stale result on top of the manual assignment.
      bulkAttachGate.resolve([
        {
          bookmark_id: bookmarkId,
          tags: [],
          collection: {
            id: "in-flight-imported-collection",
            user_id: "real-user",
            name: "Imported folder",
            description: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          collection_attached: true,
          bookmark_updated_at: new Date().toISOString(),
        },
      ]);
    });

    await waitFor(() => expect(result.current.isSyncing).toBe(false));
    expect(result.current.inbox[0]?.collection_id).toBe("manual-collection");
  });

  test("does not reuse a same-named collection owned by the previous account", async () => {
    const now = new Date().toISOString();
    fakeRepo.__reset([], {
      tags: [],
      bookmarkTags: [],
      collections: [
        {
          id: "foreign-collection",
          user_id: "departed-user",
          name: "Projects",
          description: null,
          created_at: now,
          updated_at: now,
        },
      ],
    });
    const { result } = await renderReadyStore();

    await act(async () => {
      result.current.importBookmarks([
        {
          source: "stash-backup",
          url: "https://example.com/owned-folder-only",
          title: "Owned folder only",
          notes: null,
          tags: [],
          collection: "Projects",
        },
      ]);
    });

    await waitFor(() =>
      expect(apiMock.__bulkAttachMock).toHaveBeenCalledWith([
        expect.objectContaining({ collection_name: "Projects" }),
      ]),
    );
    // The RPC resolves collections scoped to the caller's own uid server-side,
    // so a same-named collection owned by a different account can never match
    // — the local cache seeded with "foreign-collection" above is never
    // consulted for this resolution anymore.
    await waitFor(() =>
      expect(result.current.inbox[0]?.collection_id).not.toBe(
        "foreign-collection",
      ),
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
        expect(apiMock.__bulkAttachMock).toHaveBeenCalledWith([
          expect.objectContaining({
            tags: [expect.objectContaining({ name: "Reading" })],
          }),
        ]),
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

  test("rekeys pending enrichment restores on anonymous to authenticated account transition (carry-over) (#671)", async () => {
    authMock.__setAuth({
      status: "authenticated",
      session: {
        access_token: "anon-token",
        refresh_token: "anon-refresh",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        token_type: "bearer",
        user: { id: "anon-user", is_anonymous: true },
      },
      userId: "anon-user",
    });

    apiMock.__bulkRestoreAIEnrichmentMock.mockRejectedValueOnce(
      new Error("temporary enrichment restore failure"),
    );

    const { result, rerender } = await renderReadyStore();

    await act(async () => {
      result.current.importBookmarks([
        {
          source: "stash-backup",
          url: "https://example.com/carryover-enrichment",
          title: "Carry over enrichment",
          notes: null,
          tags: [],
          collection: null,
          enrichment: {
            summary: "carryover summary",
            topics: [],
            suggested_tags: [],
            status: "complete",
            model: null,
            confidence: null,
          },
        },
      ]);
    });

    await waitFor(() => expect(result.current.queue).toHaveLength(0));
    await waitFor(() => {
      const pending = JSON.parse(
        fakeRepo.__meta("pending_enrichment_restore") ?? "[]",
      );
      expect(pending).toHaveLength(1);
      expect(pending[0].status).toBe("failed");
    });

    const oldId = result.current.inbox[0]?.id;
    expect(oldId).toBeDefined();

    authMock.__setAuth({
      status: "authenticated",
      session: mockRealSession,
      userId: "real-user",
    });

    await act(async () => {
      rerender(undefined);
    });

    const newId = result.current.inbox[0]?.id;
    expect(newId).toBeDefined();
    expect(newId).not.toBe(oldId);

    const pending = JSON.parse(
      fakeRepo.__meta("pending_enrichment_restore") ?? "[]",
    );
    expect(pending).toHaveLength(1);
    expect(pending[0].bookmark_id).toBe(newId);

    apiMock.__bulkRestoreAIEnrichmentMock.mockResolvedValueOnce([
      { id: "enrichment-id", bookmark_id: newId },
    ]);
    await act(async () => {
      await result.current.syncNow();
    });

    await waitFor(() =>
      expect(fakeRepo.__meta("pending_enrichment_restore")).toBe("[]"),
    );
    expect(apiMock.__bulkRestoreAIEnrichmentMock).toHaveBeenCalledWith([
      expect.objectContaining({
        bookmark_id: newId,
        summary: "carryover summary",
      }),
    ]);
  });

  test("drops pending enrichment restores on real-to-real account switch (#671)", async () => {
    const { result, rerender } = await renderReadyStore();

    await act(async () => {
      result.current.importBookmarks([
        {
          source: "stash-backup",
          url: "https://example.com/switch-drop-enrichment",
          title: "Switch drop",
          notes: null,
          tags: [],
          collection: null,
          enrichment: {
            summary: "drop me",
            topics: [],
            suggested_tags: [],
            status: "complete",
            model: null,
            confidence: null,
          },
        },
      ]);
    });

    apiMock.__bulkRestoreAIEnrichmentMock.mockRejectedValueOnce(new Error("fail"));

    await waitFor(() => expect(result.current.queue).toHaveLength(0));
    await waitFor(() => {
      const pending = JSON.parse(
        fakeRepo.__meta("pending_enrichment_restore") ?? "[]",
      );
      expect(pending).toHaveLength(1);
    });

    authMock.__setAuth({
      status: "authenticated",
      session: mockOtherRealSession,
      userId: "other-real-user",
    });

    await act(async () => {
      rerender(undefined);
    });

    await waitFor(() => expect(result.current.inbox).toHaveLength(0));
    await waitFor(() =>
      expect(fakeRepo.__meta("pending_enrichment_restore")).toBe("[]"),
    );
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
        expect(apiMock.__bulkAttachMock).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({
              bookmark_id: EXISTING_SERVER_ID,
              collection_name: "Existing duplicate folder",
            }),
          ]),
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

  test("pausing during imported folder attachment stops before the next chunk (STASH-5C)", async () => {
    const { result } = await renderReadyStore();
    const firstChunkStarted = deferred();
    const releaseFirstChunk = deferred();
    const originalBulkAttach =
      apiMock.__bulkAttachMock.getMockImplementation()!;
    apiMock.__bulkAttachMock.mockImplementationOnce(async (items: unknown[]) => {
      firstChunkStarted.resolve();
      await releaseFirstChunk.promise;
      return originalBulkAttach(items);
    });

    await act(async () => {
      result.current.setSyncPaused(true);
      result.current.importBookmarks(
        Array.from({ length: 51 }, (_, i) => ({
          source: "stash-backup" as const,
          url: `https://example.com/pause-folder-${i}`,
          title: `Pause folder ${i}`,
          notes: null,
          tags: [],
          collection: `Folder ${i}`,
        })),
      );
    });
    await waitFor(() => expect(result.current.queue).toHaveLength(51));

    await act(async () => {
      result.current.setSyncPaused(false);
    });
    await firstChunkStarted.promise;
    await act(async () => {
      result.current.setSyncPaused(true);
    });
    expect(result.current.syncPaused).toBe(true);
    await act(async () => {
      releaseFirstChunk.resolve();
    });

    await waitFor(() => expect(result.current.isSyncing).toBe(false), {
      timeout: 10_000,
    });
    expect(apiMock.__bulkAttachMock).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(fakeRepo.__meta("pending_import_collections") ?? "[]"),
    ).toHaveLength(1);
  });

  test("pausing during imported tag attachment stops before the next chunk (STASH-5C)", async () => {
    const { result } = await renderReadyStore();
    const firstChunkStarted = deferred();
    const releaseFirstChunk = deferred();
    const originalBulkAttach =
      apiMock.__bulkAttachMock.getMockImplementation()!;
    apiMock.__bulkAttachMock.mockImplementationOnce(async (items: unknown[]) => {
      firstChunkStarted.resolve();
      await releaseFirstChunk.promise;
      return originalBulkAttach(items);
    });

    await act(async () => {
      result.current.setSyncPaused(true);
      result.current.importBookmarks(
        Array.from({ length: 51 }, (_, i) => ({
          source: "stash-backup" as const,
          url: `https://example.com/pause-tag-${i}`,
          title: `Pause tag ${i}`,
          notes: null,
          tags: [`Tag ${i}`],
          collection: null,
        })),
      );
    });
    await waitFor(() => expect(result.current.queue).toHaveLength(51));

    await act(async () => {
      result.current.setSyncPaused(false);
    });
    await firstChunkStarted.promise;
    await act(async () => {
      result.current.setSyncPaused(true);
    });
    expect(result.current.syncPaused).toBe(true);
    await act(async () => {
      releaseFirstChunk.resolve();
    });

    await waitFor(() => expect(result.current.isSyncing).toBe(false), {
      timeout: 10_000,
    });
    expect(apiMock.__bulkAttachMock).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(fakeRepo.__meta("pending_tag_ops") ?? "[]"),
    ).toHaveLength(1);
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
    // (force: true, matching Settings' "Sync now" tap) to drive the retry
    // pass (simulating a reconnect or manual Sync now nudge) without waiting
    // out the failed entries' retry backoff (see isSyncable's ignoreBackoff).
    await act(async () => {
      await result.current.syncNow({ force: true });
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
