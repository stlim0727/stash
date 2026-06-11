import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
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
import type { AIEnrichment, Bookmark, Collection, LocalPendingBookmark, Tag } from '@/domain/types';
import { repository } from '@/storage/repository';

export type AddBookmarkResult =
  | { status: 'created' | 'duplicate'; bookmark: Bookmark }
  | { status: 'invalid'; error: string };

interface BookmarksContextValue {
  /** True until the durable store has been read on startup. */
  isLoading: boolean;
  /** Active (non-archived) bookmarks, newest first. */
  inbox: Bookmark[];
  /** Offline sync queue, oldest first — exposed for inspection until sync exists. */
  queue: LocalPendingBookmark[];
  getBookmark: (id: string) => Bookmark | undefined;
  getTagsForBookmark: (id: string) => Tag[];
  getCollection: (id: string | null) => Collection | undefined;
  getEnrichment: (bookmarkId: string) => AIEnrichment | undefined;
  /** Local-first creation: the bookmark is visible immediately with pending states. */
  addBookmark: (input: { url: string; notes?: string }) => AddBookmarkResult;
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
  const [bookmarks, setBookmarks] = useState<Bookmark[] | null>(null);
  const [queue, setQueue] = useState<LocalPendingBookmark[]>([]);

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

      return { status: 'created', bookmark };
    },
    [loadedBookmarks],
  );

  const value = useMemo<BookmarksContextValue>(
    () => ({
      isLoading: bookmarks === null,
      inbox: loadedBookmarks
        .filter((bookmark) => !bookmark.is_archived)
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
      queue,
      getBookmark,
      getTagsForBookmark,
      getCollection,
      getEnrichment,
      addBookmark,
    }),
    [
      bookmarks,
      loadedBookmarks,
      queue,
      getBookmark,
      getTagsForBookmark,
      getCollection,
      getEnrichment,
      addBookmark,
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
