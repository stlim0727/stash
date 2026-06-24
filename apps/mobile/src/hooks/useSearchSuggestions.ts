import { useMemo } from 'react';

import { useBookmarks } from '@/store/bookmarks';
import { buildTagCloud } from '@/domain/tag-cloud';
import {
  buildSearchSuggestions,
  type SearchSuggestion,
  type SuggestionFolder,
  type SuggestionTagCount,
} from '@/domain/search-suggestions';

/**
 * Projects the user's already-loaded inbox into the suggestion-shelf chip list.
 *
 * This is a PURE PROJECTION of in-memory state (`inbox`, `getTagsForBookmark`,
 * `getCollection`) plus the caller-owned `recents` list — it triggers no fetch,
 * sync, or enrichment, honoring capture-is-sacred. It also draws ONLY from
 * user-authored sources: recent searches the user typed, tags the user applied
 * (the same `buildTagCloud` input the browse shelf trusts), and folders that
 * actually contain inbox bookmarks. It never touches AI-suggested tags, a
 * model's proposed collection name, or any generated field.
 *
 * `recents` is owned by the screen (loaded/persisted there via
 * `pref.search.recents`, ST-3) and passed in, keeping this hook a thin selector.
 * `query` is the Phase-2 seam — accepted and threaded to the builder now (unused
 * in Phase 1) so the live-filter swap doesn't reshape the call site.
 */
export function useSearchSuggestions(recents: string[], query = ''): SearchSuggestion[] {
  const { inbox, getTagsForBookmark, getCollection } = useBookmarks();

  // Tag frequencies and folder bookmark-counts over the (whole) inbox. One pass,
  // mirroring how the browse shelf derives its chips from what's actually saved.
  const { tagCounts, folders } = useMemo(() => {
    const tagAgg = new Map<string, { name: string; count: number }>();
    const folderCounts = new Map<string, number>();
    for (const bookmark of inbox) {
      if (bookmark.collection_id !== null) {
        folderCounts.set(
          bookmark.collection_id,
          (folderCounts.get(bookmark.collection_id) ?? 0) + 1,
        );
      }
      for (const tag of getTagsForBookmark(bookmark.id)) {
        const existing = tagAgg.get(tag.id);
        if (existing) {
          existing.count += 1;
        } else {
          tagAgg.set(tag.id, { name: tag.name, count: 1 });
        }
      }
    }
    // buildTagCloud already drops blank-named tags and sorts by frequency — the
    // exact, trusted ordering the builder then caps.
    const cloud = buildTagCloud(
      [...tagAgg.entries()].map(([id, { name, count }]) => ({ id, name, count })),
    );
    const tagCountList: SuggestionTagCount[] = cloud.map(({ id, name, count }) => ({
      id,
      name,
      count,
    }));
    const folderList: SuggestionFolder[] = [...folderCounts.entries()]
      .map(([id, count]) => ({ id, name: getCollection(id)?.name?.trim() ?? '', count }))
      .filter((folder) => folder.name.length > 0);
    return { tagCounts: tagCountList, folders: folderList };
  }, [inbox, getTagsForBookmark, getCollection]);

  return useMemo(
    () => buildSearchSuggestions({ recents, tagCounts, folders, query }),
    [recents, tagCounts, folders, query],
  );
}
