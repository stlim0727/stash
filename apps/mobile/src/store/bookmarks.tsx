import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';

import {
  mockBookmarkTags,
  mockBookmarks,
  mockCollections,
  mockEnrichments,
  mockTags,
  mockUserId,
} from '@/domain/mock-data';
import { normalizeUrl } from '@/domain/urls';
import { enrichBookmark } from '@/domain/enrichment';
import type { AIEnrichment, Bookmark, Collection, LocalPendingBookmark, Tag } from '@/domain/types';
import { repository } from '@/storage/repository';
import { useSupabaseAuth } from '@/supabase/auth-provider';
import { createSyncApi, isSyncable, syncQueueEntry } from '@/sync/sync-bookmarks';

export type AddBookmarkResult =
  | { status: 'created' | 'duplicate'; bookmark: Bookmark }
  | { status: 'invalid'; error: string };

interface BookmarksContextValue {
  /** True until the durable store has been read on startup. */
  isLoading: boolean;
  /** Set when the durable store failed to load and in-memory fallback is used. */
  loadError: boolean;
  /** Active (non-archived) bookmarks, newest first. */
  inbox: Bookmark[];
  /** Archived bookmarks, most recently archived (updated) first. */
  archived: Bookmark[];
  /** Offline sync queue, oldest first — exposed for inspection until sync exists. */
  queue: LocalPendingBookmark[];
  getBookmark: (id: string) => Bookmark | undefined;
  getTagsForBookmark: (id: string) => Tag[];
  getCollection: (id: string | null) => Collection | undefined;
  getEnrichment: (bookmarkId: string) => AIEnrichment | undefined;
  /** Local-first creation: the bookmark is visible immediately with pending states. */
  addBookmark: (input: { url: string; notes?: string }) => AddBookmarkResult;
  /** Archive or unarchive a bookmark (preferred over permanent deletion). */
  archiveBookmark: (id: string, archived: boolean) => void;
  /** Permanently remove a bookmark and any pending queue entry for it. */
  deleteBookmark: (id: string) => void;
  /** True while the background sync service is uploading queue entries. */
  isSyncing: boolean;
  /** Upload pending/failed queue entries to Supabase. No-op without auth. */
  syncNow: () => Promise<void>;
}

const BookmarksContext = createContext<BookmarksContextValue | null>(null);

function makeLocalId() {
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function logStorageError(operation: string, error: unknown) {
  console.warn(`[stash] failed to persist ${operation}; state remains in memory`, error);
}

// Single shared init so background writes can never race ahead of table
// creation/seeding, even for saves made before the startup load finishes.
let repositoryReady: Promise<void> | null = null;
function ensureRepositoryReady(): Promise<void> {
  if (!repositoryReady) {
    repositoryReady = repository.init(mockBookmarks);
  }
  return repositoryReady;
}

/** Append items from `loaded` that aren't already present (by key). */
function mergeById<T>(current: T[], loaded: T[], key: (item: T) => string): T[] {
  const seen = new Set(current.map(key));
  return [...current, ...loaded.filter((item) => !seen.has(key(item)))];
}

export function BookmarksProvider({ children }: { children: ReactNode }) {
  const auth = useSupabaseAuth();
  const [bookmarks, setBookmarks] = useState<Bookmark[] | null>(null);
  const [queue, setQueue] = useState<LocalPendingBookmark[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const syncInFlight = useRef(false);
  // Bookmark IDs currently being enriched, so concurrent passes (startup +
  // a fresh save) never double-process the same item.
  const enriching = useRef(new Set<string>());
  // Tombstones for deleted local bookmarks. The sync loop iterates over a
  // snapshot, so a delete that lands mid-run must be visible to it — both
  // before uploading an entry and before applying an upload's result.
  const deletedIds = useRef(new Set<string>());

  // Fire-and-forget metadata enrichment. Runs off the save path so capture is
  // never blocked, only fills generated fields, and a failure just records a
  // failed status — it never affects bookmark creation.
  const enrichInBackground = useCallback((bookmark: Bookmark) => {
    if (bookmark.metadata_status !== 'pending' || enriching.current.has(bookmark.id)) {
      return;
    }
    enriching.current.add(bookmark.id);
    (async () => {
      const { patch, metadata_status } = await enrichBookmark(bookmark);
      // Re-read the latest row so we merge onto current state, not the stale
      // snapshot captured when enrichment started.
      let updated: Bookmark | null = null;
      setBookmarks((current) => {
        if (current === null) {
          return current;
        }
        return current.map((item) => {
          if (item.id !== bookmark.id) {
            return item;
          }
          updated = {
            ...item,
            ...patch,
            metadata_status,
            updated_at: new Date().toISOString(),
          };
          return updated;
        });
      });
      if (updated) {
        try {
          await ensureRepositoryReady();
          await repository.updateBookmark(updated);
        } catch (error) {
          logStorageError('metadata enrichment', error);
        }
      }
      enriching.current.delete(bookmark.id);
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await ensureRepositoryReady();
        const [storedBookmarks, storedQueue] = await Promise.all([
          repository.listBookmarks(),
          repository.listQueue(),
        ]);
        if (!cancelled) {
          // Merge instead of replace: saves made while loading must survive.
          setBookmarks((current) =>
            current === null
              ? storedBookmarks
              : mergeById(current, storedBookmarks, (bookmark) => bookmark.id),
          );
          setQueue((current) => mergeById(current, storedQueue, (entry) => entry.local_id));
        }
      } catch (error) {
        logStorageError('startup load', error);
        if (!cancelled) {
          setLoadError(true);
          setBookmarks((current) =>
            current === null
              ? mockBookmarks
              : mergeById(current, mockBookmarks, (bookmark) => bookmark.id),
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadedBookmarks = useMemo(() => bookmarks ?? [], [bookmarks]);

  const getBookmark = useCallback(
    (id: string) => loadedBookmarks.find((bookmark) => bookmark.id === id),
    [loadedBookmarks],
  );

  const getTagsForBookmark = useCallback((id: string) => {
    const tagIds = mockBookmarkTags
      .filter((link) => link.bookmark_id === id)
      .map((link) => link.tag_id);
    return mockTags.filter((tag) => tagIds.includes(tag.id));
  }, []);

  const getCollection = useCallback(
    (id: string | null) => mockCollections.find((collection) => collection.id === id),
    [],
  );

  const getEnrichment = useCallback(
    (bookmarkId: string) =>
      mockEnrichments.find((enrichment) => enrichment.bookmark_id === bookmarkId),
    [],
  );

  const addBookmark = useCallback(
    ({ url, notes }: { url: string; notes?: string }): AddBookmarkResult => {
      const normalized = normalizeUrl(url);
      if (!normalized) {
        return {
          status: 'invalid',
          error: 'Enter a valid web address, like example.com or https://example.com.',
        };
      }

      const now = new Date().toISOString();

      // Idempotent saves: reuse the existing bookmark for the same URL.
      const existing = loadedBookmarks.find((bookmark) => bookmark.url_hash === normalized);
      if (existing) {
        const updated = { ...existing, last_saved_at: now };
        setBookmarks((current) =>
          (current ?? []).map((bookmark) => (bookmark.id === existing.id ? updated : bookmark)),
        );
        ensureRepositoryReady()
          .then(() => repository.updateBookmark(updated))
          .catch((error) => logStorageError('duplicate save', error));
        return { status: 'duplicate', bookmark: existing };
      }

      const bookmark: Bookmark = {
        id: makeLocalId(),
        user_id: mockUserId,
        url: normalized,
        canonical_url: null,
        // Placeholder dedupe key until real canonicalization and hashing exist.
        url_hash: normalized,
        title: null,
        description: null,
        notes: notes?.trim() ? notes.trim() : null,
        source_app: null,
        content_type: 'url',
        preview_image_url: null,
        favicon_url: null,
        site_name: null,
        collection_id: null,
        is_archived: false,
        created_at: now,
        updated_at: now,
        last_saved_at: now,
        metadata_status: 'pending',
        sync_status: 'pending',
      };

      const queueEntry: LocalPendingBookmark = {
        local_id: bookmark.id,
        remote_id: null,
        payload: { url: normalized, notes: bookmark.notes ?? undefined },
        sync_status: 'pending',
        retry_count: 0,
        last_error: null,
        created_at: now,
        updated_at: now,
      };

      // Optimistic update first; persistence happens in the background so
      // capture never waits on storage or (later) the network.
      setBookmarks((current) => [bookmark, ...(current ?? [])]);
      setQueue((current) => [...current, queueEntry]);
      ensureRepositoryReady()
        .then(() =>
          Promise.all([repository.insertBookmark(bookmark), repository.enqueue(queueEntry)]),
        )
        .catch((error) => logStorageError('new bookmark', error));

      // Enrich after the bookmark is already visible and persisted.
      enrichInBackground(bookmark);

      return { status: 'created', bookmark };
    },
    [loadedBookmarks, enrichInBackground],
  );

  const archiveBookmark = useCallback((id: string, archived: boolean) => {
    let updated: Bookmark | null = null;
    setBookmarks((current) => {
      if (current === null) {
        return current;
      }
      return current.map((bookmark) => {
        if (bookmark.id !== id) {
          return bookmark;
        }
        updated = { ...bookmark, is_archived: archived, updated_at: new Date().toISOString() };
        return updated;
      });
    });
    if (updated) {
      ensureRepositoryReady()
        .then(() => repository.updateBookmark(updated as Bookmark))
        .catch((error) => logStorageError('archive bookmark', error));
    }
  }, []);

  const deleteBookmark = useCallback((id: string) => {
    deletedIds.current.add(id);
    setBookmarks((current) => (current === null ? current : current.filter((b) => b.id !== id)));
    // Drop any pending queue entry so a deleted local bookmark is never synced.
    setQueue((current) => current.filter((entry) => entry.local_id !== id));
    ensureRepositoryReady()
      .then(() => Promise.all([repository.deleteBookmark(id), repository.removeQueueEntry(id)]))
      .catch((error) => logStorageError('delete bookmark', error));
  }, []);

  const syncNow = useCallback(async () => {
    if (syncInFlight.current) {
      return;
    }
    if (auth.status !== 'anonymous' || !auth.session) {
      return;
    }
    const syncable = queue.filter(isSyncable);
    if (syncable.length === 0) {
      return;
    }

    syncInFlight.current = true;
    setIsSyncing(true);
    try {
      await ensureRepositoryReady();
      // Re-ensure the session so a token that expired while the app stayed
      // open is refreshed before we sync; otherwise every entry would fail
      // against a stale bearer token until restart.
      const session = (await auth.ensureAnonymousSession()) ?? auth.session;
      const api = createSyncApi(session);
      // Lookup snapshot: replacements only touch the entry being synced, so
      // other entries' local IDs stay valid for the duration of the loop.
      const bookmarksSnapshot = loadedBookmarks;

      for (const entry of syncable) {
        // Deleted while this run was queued up: skip the upload entirely.
        if (deletedIds.current.has(entry.local_id)) {
          continue;
        }

        setQueue((current) =>
          current.map((queued) =>
            queued.local_id === entry.local_id ? { ...queued, sync_status: 'syncing' } : queued,
          ),
        );

        const localBookmark = bookmarksSnapshot.find(
          (bookmark) => bookmark.id === entry.local_id,
        );
        const result = await syncQueueEntry(api, repository, entry, localBookmark);

        // Deleted while the upload was in flight: don't resurrect it. Undo the
        // rows syncQueueEntry just persisted and best-effort delete the remote
        // copy so the user's delete wins end to end.
        if (deletedIds.current.has(entry.local_id)) {
          const replacementId = result.bookmarkReplacement?.bookmark.id;
          ensureRepositoryReady()
            .then(() =>
              Promise.all([
                replacementId ? repository.deleteBookmark(replacementId) : Promise.resolve(),
                repository.removeQueueEntry(entry.local_id),
              ]),
            )
            .catch((error) => logStorageError('post-delete sync cleanup', error));
          if (result.entry.remote_id) {
            api.deleteBookmark(result.entry.remote_id, true).catch(() => {
              // Remote cleanup is best-effort; the row is owner-scoped either way.
            });
          }
          continue;
        }

        setQueue((current) =>
          current.map((queued) => (queued.local_id === entry.local_id ? result.entry : queued)),
        );
        if (result.bookmarkReplacement) {
          const { previousId, bookmark: replacement } = result.bookmarkReplacement;
          setBookmarks((current) =>
            (current ?? []).map((bookmark) =>
              bookmark.id === previousId ? replacement : bookmark,
            ),
          );
        }
      }
    } catch (error) {
      logStorageError('sync run', error);
    } finally {
      syncInFlight.current = false;
      setIsSyncing(false);
    }
  }, [auth, queue, loadedBookmarks]);

  // Background enrichment: once local data is loaded, enrich any bookmark
  // whose metadata is still pending (seeded items, or saves from a previous
  // session that closed before enrichment finished).
  useEffect(() => {
    if (bookmarks === null) {
      return;
    }
    for (const bookmark of bookmarks) {
      if (bookmark.metadata_status === 'pending') {
        enrichInBackground(bookmark);
      }
    }
  }, [bookmarks, enrichInBackground]);

  // Background sync: upload as soon as auth and local data are ready, and
  // whenever a new pending entry appears. Failed entries are retried on the
  // next save or via the manual Sync now action, not in a hot loop.
  useEffect(() => {
    if (
      !isSyncing &&
      bookmarks !== null &&
      auth.status === 'anonymous' &&
      queue.some((entry) => entry.sync_status === 'pending')
    ) {
      void syncNow();
    }
  }, [bookmarks, auth.status, queue, isSyncing, syncNow]);

  const value = useMemo<BookmarksContextValue>(
    () => ({
      isLoading: bookmarks === null,
      loadError,
      inbox: loadedBookmarks
        .filter((bookmark) => !bookmark.is_archived)
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
      archived: loadedBookmarks
        .filter((bookmark) => bookmark.is_archived)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
      queue,
      getBookmark,
      getTagsForBookmark,
      getCollection,
      getEnrichment,
      addBookmark,
      archiveBookmark,
      deleteBookmark,
      isSyncing,
      syncNow,
    }),
    [
      bookmarks,
      loadError,
      loadedBookmarks,
      queue,
      getBookmark,
      getTagsForBookmark,
      getCollection,
      getEnrichment,
      addBookmark,
      archiveBookmark,
      deleteBookmark,
      isSyncing,
      syncNow,
    ],
  );

  return <BookmarksContext.Provider value={value}>{children}</BookmarksContext.Provider>;
}

export function useBookmarks() {
  const context = useContext(BookmarksContext);
  if (!context) {
    throw new Error('useBookmarks must be used within a BookmarksProvider');
  }
  return context;
}
