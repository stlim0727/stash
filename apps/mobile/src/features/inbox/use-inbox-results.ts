import { collectionColorKey } from '@/domain/collection-color';
import {
  ALL_FILTER,
  UNCOLLECTED_FILTER,
  filterByFacet,
  sameFilter,
  type InboxFilter,
} from '@/domain/filter';
import {
  sortFolderTiles,
  type FolderSortOption
} from '@/domain/folder-sort';
import { filterBookmarks } from '@/domain/search';
import {
  sortBookmarks,
  type SortOption
} from '@/domain/sort';
import type { Bookmark, Collection, Tag } from '@/domain/types';
import { type FacetChip, type FolderTileItem, type GridPlaceholder } from '@/features/inbox/types';
import type { TFunction } from '@/i18n/translate';
import type { ImperativeRouter } from 'expo-router';
import type { Dispatch, SetStateAction } from 'react';
import {
  useCallback,
  useEffect,
  useMemo
} from 'react';

interface Dependencies {
  getTagsForBookmark: (id: string) => Tag[];
  inbox: Bookmark[];
  getCollection: (id: string | null) => Collection | undefined;
  filter: InboxFilter;
  router: ImperativeRouter;
  isLoading: boolean;
  setFilter: Dispatch<SetStateAction<InboxFilter>>;
  debouncedQuery: string;
  sort: SortOption;
  t: TFunction;
  collections: Collection[];
  folderSort: FolderSortOption;
}

export function useInboxResults({
  getTagsForBookmark,
  inbox,
  getCollection,
  filter,
  router,
  isLoading,
  setFilter,
  debouncedQuery,
  sort,
  t,
  collections,
  folderSort,
}: Dependencies) {

  const tagIdsFor = useCallback(
    (id: string) => getTagsForBookmark(id).map((tag) => tag.id),
    [getTagsForBookmark],
  );

  // Browse facets derived from what is actually in the Inbox, so every chip
  // leads to at least one bookmark and the bar stays empty for fresh installs.
  const { chips, hasUncollected, collectionCounts } = useMemo(() => {
    const collectionCounts = new Map<string, number>();
    const tagsById = new Map<string, string>();
    let uncollected = 0;
    for (const bookmark of inbox) {
      if (bookmark.collection_id === null) {
        uncollected += 1;
      } else {
        collectionCounts.set(
          bookmark.collection_id,
          (collectionCounts.get(bookmark.collection_id) ?? 0) + 1,
        );
      }
      for (const tag of getTagsForBookmark(bookmark.id)) {
        tagsById.set(tag.id, tag.name);
      }
    }
    const collectionChips: FacetChip[] = [...collectionCounts.keys()]
      .map((id) => ({ id, name: getCollection(id)?.name?.trim(), count: collectionCounts.get(id) ?? 0 }))
      .filter((entry): entry is { id: string; name: string; count: number } => Boolean(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ id, name, count }) => ({
        key: `c:${id}`,
        label: name,
        filter: { kind: 'collection', id },
        icon: 'folder-outline' as const,
        count,
      }));
    const tagChips: FacetChip[] = [...tagsById.entries()]
      // Drop tags whose name is empty/whitespace so they don't render as blank
      // pills (AI enrichment or a partial sync can leave a tag with no name).
      .map(([id, name]) => ({ id, name: name?.trim() ?? '' }))
      .filter((entry) => entry.name.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ id, name }) => ({ key: `t:${id}`, label: `#${name}`, filter: { kind: 'tag', id } }));
    return {
      chips: [...collectionChips, ...tagChips],
      hasUncollected: uncollected > 0,
      collectionCounts,
    };
  }, [inbox, getTagsForBookmark, getCollection]);

  const facetFiltered = useMemo(
    () => filterByFacet(inbox, filter, tagIdsFor),
    [inbox, filter, tagIdsFor],
  );

  // Drop the URL-backed facet deep-link params. On web the tag/folder facet
  // arrives as ?tag=…/?collection=… from /browse/tags and is consumed once by
  // the focus effect above; any path that then moves the in-memory filter away
  // from it must also strip the param, or a reload (F5) re-applies the
  // supposedly-cleared facet from the stale query string. No-op on native (no
  // URL to carry them).
  const clearFacetParams = useCallback(() => {
    router.setParams({ tag: undefined, collection: undefined, t: undefined });
  }, [router]);

  // If the active facet disappears (last member removed/unfiled), fall back to
  // All rather than stranding the user on an empty filtered view.
  useEffect(() => {
    // Wait for the durable load: facets are empty mid-load, which would
    // wrongly reset a filter handed in via route param (deep-link to a tag).
    if (isLoading || filter.kind === 'all') {
      return;
    }
    if (filter.kind === 'uncollected') {
      if (!hasUncollected) {
        setFilter(ALL_FILTER);
        clearFacetParams();
      }
      return;
    }
    if (!chips.some((chip) => sameFilter(chip.filter, filter))) {
      setFilter(ALL_FILTER);
      clearFacetParams();
    }
  }, [filter, chips, hasUncollected, isLoading, clearFacetParams]);

  const filtered = useMemo(
    () =>
      filterBookmarks(facetFiltered, debouncedQuery, {
        tagNames: (b) => getTagsForBookmark(b.id).map((tag) => tag.name),
        collectionName: (b) => getCollection(b.collection_id)?.name,
      }),
    [facetFiltered, debouncedQuery, getTagsForBookmark, getCollection],
  );
  const visible = useMemo(() => sortBookmarks(filtered, sort), [filtered, sort]);

  // Folder View counts follow the active facet and search together (STASH-7D).
  // With no narrowing, `filtered` contains the full Inbox library.
  const { folderCollectionCounts, folderUncollectedCount } = useMemo(() => {
    const counts = new Map<string, number>();
    let uncollected = 0;
    for (const bookmark of filtered) {
      if (bookmark.collection_id === null) {
        uncollected += 1;
      } else {
        counts.set(
          bookmark.collection_id,
          (counts.get(bookmark.collection_id) ?? 0) + 1,
        );
      }
    }
    return {
      folderCollectionCounts: counts,
      folderUncollectedCount: uncollected,
    };
  }, [filtered]);

  // Folder View tiles. Deliberately NOT filtered down to `chips`' collection
  // entries — those only include a collection that already holds an Inbox
  // bookmark, so a just-created empty collection (see the "New folder" dialog
  // below) would never appear as a tile. Folder View reads as a directory of
  // every real Collection (à la Drive/Files, empty folders included), so it
  // iterates the full `collections` list instead and looks up each one's count
  // from the per-collection tally (0 if absent). Counts reflect the active
  // filter and search, including zero matches in a populated folder.
  // Order: the uncollected/"받은함" bucket first (tray icon, `mutedSurface`, not
  // hash-colored), then real collections (alpha-sorted), then a trailing
  // "New folder" tile.
  const folderTiles = useMemo<FolderTileItem[]>(() => {
    const tiles: FolderTileItem[] = [];
    if (hasUncollected) {
      tiles.push({
        id: '__folder-uncollected',
        __folderTile: true,
        kind: 'uncollected',
        label: t('inbox.filterNoCollection'),
        count: folderUncollectedCount,
        filter: UNCOLLECTED_FILTER,
      });
    }
    // Mirrors the browse shelf's own guard: a collection with an empty/
    // whitespace name (a partial sync, an edge case elsewhere) must not
    // render as a blank tile. Only this middle, real-collection segment is
    // reordered by `folderSort` — the uncollected tile above stays pinned
    // first and "New folder" below stays pinned last regardless of order.
    const sortableCollections = collections
      .filter((collection) => collection.name?.trim())
      .map((collection) => ({
        id: collection.id,
        name: collection.name,
        count: folderCollectionCounts.get(collection.id) ?? 0,
        collection,
      }));
    const sortedCollections = sortFolderTiles(sortableCollections, folderSort);
    for (const { collection, count } of sortedCollections) {
      tiles.push({
        id: `__folder-c:${collection.id}`,
        collectionId: collection.id,
        __folderTile: true,
        kind: 'collection',
        label: collection.name,
        count,
        filter: { kind: 'collection', id: collection.id },
        colorKey: collectionColorKey(collection.id),
      });
    }
    tiles.push({ id: '__folder-new', __folderTile: true, kind: 'new' });
    return tiles;
  }, [
    collections,
    folderCollectionCounts,
    folderSort,
    hasUncollected,
    folderUncollectedCount,
    t,
  ]);

  // Pad to an even number of tiles so the trailing row keeps its column width
  // (mirrors the placeholder padding the card grid already does below).
  const folderGridData = useMemo<(FolderTileItem | GridPlaceholder)[]>(() => {
    if (folderTiles.length % 2 === 0) {
      return folderTiles;
    }
    return [...folderTiles, { id: '__folder-ph', __placeholder: true }];
  }, [folderTiles]);
  return { tagIdsFor, chips, hasUncollected, collectionCounts, facetFiltered, clearFacetParams, filtered, visible, folderCollectionCounts, folderUncollectedCount, folderTiles, folderGridData };
}
