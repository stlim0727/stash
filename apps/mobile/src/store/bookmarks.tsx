import { createContext, useCallback, useContext, useMemo, useState } from 'react';
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
import type { AIEnrichment, Bookmark, Collection, Tag } from '@/domain/types';

export type AddBookmarkResult =
  | { status: 'created' | 'duplicate'; bookmark: Bookmark }
  | { status: 'invalid'; error: string };

interface BookmarksContextValue {
  /** Active (non-archived) bookmarks, newest first. */
  inbox: Bookmark[];
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

export function BookmarksProvider({ children }: { children: ReactNode }) {
  // In-memory until Milestone 4 introduces the durable local store.
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(mockBookmarks);

  const getBookmark = useCallback(
    (id: string) => bookmarks.find((bookmark) => bookmark.id === id),
    [bookmarks],
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

      // Idempotent saves: reuse the existing bookmark for the same URL.
      const existing = bookmarks.find((bookmark) => bookmark.url_hash === normalized);
      if (existing) {
        const now = new Date().toISOString();
        setBookmarks((current) =>
          current.map((bookmark) =>
            bookmark.id === existing.id ? { ...bookmark, last_saved_at: now } : bookmark,
          ),
        );
        return { status: 'duplicate', bookmark: existing };
      }

      const now = new Date().toISOString();
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

      setBookmarks((current) => [bookmark, ...current]);
      return { status: 'created', bookmark };
    },
    [bookmarks],
  );

  const value = useMemo<BookmarksContextValue>(
    () => ({
      inbox: bookmarks
        .filter((bookmark) => !bookmark.is_archived)
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
      getBookmark,
      getTagsForBookmark,
      getCollection,
      getEnrichment,
      addBookmark,
    }),
    [bookmarks, getBookmark, getTagsForBookmark, getCollection, getEnrichment, addBookmark],
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
