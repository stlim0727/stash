import { Link, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { usePalette } from '@/theme';
import { pendingSuggestions } from '@/domain/ai-suggestions';
import { filterBookmarks } from '@/domain/search';
import { MONOGRAM_COLORS, itemIcon } from '@/domain/item-icon';
import { ALL_FILTER, filterByFacet, sameFilter, type InboxFilter } from '@/domain/filter';
import {
  DEFAULT_SORT,
  INBOX_SORT_PREF_KEY,
  parseSort,
  serializeSort,
  sortBookmarks,
  type SortOption,
} from '@/domain/sort';
import { getPreference, setPreference } from '@/storage/preferences';
import { useBookmarks } from '@/store/bookmarks';
import type { Bookmark } from '@/domain/types';

function statusLabel(bookmark: Bookmark): string | null {
  const parts: string[] = [];
  if (bookmark.sync_status !== 'synced') {
    parts.push(`sync ${bookmark.sync_status}`);
  }
  if (bookmark.metadata_status === 'pending') {
    parts.push('metadata pending');
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

interface FacetChip {
  key: string;
  label: string;
  filter: InboxFilter;
}

export default function InboxScreen() {
  const palette = usePalette();
  const router = useRouter();
  const { inbox, isLoading, loadError, getTagsForBookmark, getCollection, getEnrichment } =
    useBookmarks();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<InboxFilter>(ALL_FILTER);
  const [sort, setSort] = useState<SortOption>(DEFAULT_SORT);

  // Load the saved sort once, then persist any change. The guard stops the
  // initial default from clobbering the stored value before it has loaded.
  const sortLoaded = useRef(false);
  useEffect(() => {
    let active = true;
    getPreference(INBOX_SORT_PREF_KEY)
      .then((raw) => {
        if (active) {
          setSort(parseSort(raw));
        }
      })
      .catch(() => {})
      .finally(() => {
        sortLoaded.current = true;
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!sortLoaded.current) {
      return;
    }
    void setPreference(INBOX_SORT_PREF_KEY, serializeSort(sort)).catch(() => {});
  }, [sort]);

  // Browse facet handed in by another screen (e.g. tapping a tag in Bookmark
  // Detail). Applying it on param change lets in-app links jump to a view.
  const params = useLocalSearchParams<{ tag?: string | string[]; collection?: string | string[] }>();
  const paramTag = Array.isArray(params.tag) ? params.tag[0] : params.tag;
  const paramCollection = Array.isArray(params.collection)
    ? params.collection[0]
    : params.collection;
  useEffect(() => {
    if (paramTag) {
      setFilter({ kind: 'tag', id: paramTag });
    } else if (paramCollection) {
      setFilter({ kind: 'collection', id: paramCollection });
    }
  }, [paramTag, paramCollection]);

  const tagIdsFor = useCallback(
    (id: string) => getTagsForBookmark(id).map((tag) => tag.id),
    [getTagsForBookmark],
  );

  // Browse facets derived from what is actually in the Inbox, so every chip
  // leads to at least one bookmark and the bar stays empty for fresh installs.
  const { chips, hasUncollected } = useMemo(() => {
    const collectionIds = new Set<string>();
    const tagsById = new Map<string, string>();
    let uncollected = false;
    for (const bookmark of inbox) {
      if (bookmark.collection_id === null) {
        uncollected = true;
      } else {
        collectionIds.add(bookmark.collection_id);
      }
      for (const tag of getTagsForBookmark(bookmark.id)) {
        tagsById.set(tag.id, tag.name);
      }
    }
    const collectionChips: FacetChip[] = [...collectionIds]
      .map((id) => ({ id, name: getCollection(id)?.name }))
      .filter((entry): entry is { id: string; name: string } => Boolean(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ id, name }) => ({ key: `c:${id}`, label: name, filter: { kind: 'collection', id } }));
    const tagChips: FacetChip[] = [...tagsById.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([id, name]) => ({ key: `t:${id}`, label: `#${name}`, filter: { kind: 'tag', id } }));
    return { chips: [...collectionChips, ...tagChips], hasUncollected: uncollected };
  }, [inbox, getTagsForBookmark, getCollection]);

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
      }
      return;
    }
    if (!chips.some((chip) => sameFilter(chip.filter, filter))) {
      setFilter(ALL_FILTER);
    }
  }, [filter, chips, hasUncollected, isLoading]);

  const facetFiltered = useMemo(
    () => filterByFacet(inbox, filter, tagIdsFor),
    [inbox, filter, tagIdsFor],
  );
  const filtered = useMemo(() => filterBookmarks(facetFiltered, query), [facetFiltered, query]);
  const visible = useMemo(() => sortBookmarks(filtered, sort), [filtered, sort]);
  const searching = query.trim().length > 0;
  const showShelf = chips.length > 0;

  const activeChip = chips.find((chip) => sameFilter(chip.filter, filter));
  const sectionLabel = searching
    ? `Matches (${visible.length})`
    : filter.kind === 'uncollected'
      ? `No collection · ${visible.length}`
      : activeChip
        ? `${activeChip.label} · ${visible.length}`
        : 'Recently saved';

  const renderChip = (key: string, label: string, target: InboxFilter) => {
    const active = sameFilter(target, filter);
    return (
      <Pressable
        key={key}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        onPress={() => setFilter(target)}
        style={[
          styles.chip,
          { backgroundColor: active ? palette.accent : palette.card, borderColor: palette.border },
        ]}
      >
        <Text style={[styles.chipLabel, { color: active ? '#ffffff' : palette.text }]}>
          {label}
        </Text>
      </Pressable>
    );
  };

  return (
    <View style={styles.container}>
      {loadError ? (
        <Text style={[styles.errorBanner, { color: '#d93636', backgroundColor: palette.card }]}>
          Couldn’t open local storage — showing sample data. Your saves this session may not persist.
        </Text>
      ) : null}
      <View style={styles.searchWrap}>
        <TextInput
          style={[styles.searchInput, { backgroundColor: palette.card, color: palette.text }]}
          placeholder="Search title, notes, or URL"
          placeholderTextColor={palette.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          value={query}
          onChangeText={setQuery}
          clearButtonMode="while-editing"
        />
      </View>
      <View style={styles.sortRow}>
        <Text style={[styles.sortCaption, { color: palette.textSecondary }]}>Sort</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Sort field: ${sort.field === 'date' ? 'Date' : 'Name'}`}
          onPress={() => setSort((s) => ({ ...s, field: s.field === 'date' ? 'name' : 'date' }))}
          style={[styles.sortPill, { backgroundColor: palette.card, borderColor: palette.border }]}
        >
          <Text style={[styles.sortPillLabel, { color: palette.text }]}>
            {sort.field === 'date' ? 'Date' : 'Name'}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Sort direction: ${sort.dir === 'asc' ? 'ascending' : 'descending'}`}
          onPress={() => setSort((s) => ({ ...s, dir: s.dir === 'asc' ? 'desc' : 'asc' }))}
          style={[styles.sortPill, { backgroundColor: palette.card, borderColor: palette.border }]}
        >
          <Text style={[styles.sortPillLabel, { color: palette.text }]}>
            {sort.dir === 'asc' ? '↑ Asc' : '↓ Desc'}
          </Text>
        </Pressable>
      </View>
      {showShelf ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.shelf}
          contentContainerStyle={styles.shelfContent}
        >
          {renderChip('all', 'All', ALL_FILTER)}
          {hasUncollected ? renderChip('uncollected', 'No collection', { kind: 'uncollected' }) : null}
          {chips.map((chip) => renderChip(chip.key, chip.label, chip.filter))}
        </ScrollView>
      ) : null}
      <FlatList
        data={visible}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <Text style={[styles.sectionLabel, { color: palette.textSecondary }]}>
            {sectionLabel}
          </Text>
        }
        ListEmptyComponent={
          <Text style={[styles.empty, { color: palette.textSecondary }]}>
            {isLoading
              ? 'Loading your bookmarks…'
              : searching
                ? 'No bookmarks match your search.'
                : filter.kind !== 'all'
                  ? 'Nothing in this view yet.'
                  : 'Nothing saved yet. Add your first bookmark below.'}
          </Text>
        }
        renderItem={({ item }) => {
          const status = statusLabel(item);
          const collectionName = getCollection(item.collection_id)?.name ?? null;
          const cardTags = getTagsForBookmark(item.id);
          // Pending AI suggestions = high-confidence suggested tags not yet
          // applied (see @/domain/ai-suggestions), surfaced so they're
          // reviewable from the list rather than buried in Detail.
          const appliedNames = new Set(cardTags.map((tag) => tag.name.toLowerCase()));
          const suggestionCount = pendingSuggestions(
            getEnrichment(item.id),
            appliedNames,
          ).length;
          const metaParts = [
            ...(collectionName ? [`in ${collectionName}`] : []),
            ...cardTags.slice(0, 3).map((tag) => `#${tag.name}`),
          ];
          return (
            <View style={[styles.card, { backgroundColor: palette.card }]}>
              <Pressable
                style={styles.cardBody}
                onPress={() => router.push({ pathname: '/bookmark/[id]', params: { id: item.id } })}
              >
                <View style={styles.cardTitleRow}>
                  {(() => {
                    const icon = itemIcon(item);
                    return icon.kind === 'favicon' ? (
                      <Image source={{ uri: icon.uri }} style={styles.cardIcon} />
                    ) : (
                      <View
                        testID="inbox-card-monogram"
                        style={[
                          styles.cardIcon,
                          styles.cardMonogram,
                          { backgroundColor: MONOGRAM_COLORS[icon.colorIndex] },
                        ]}
                      >
                        <Text style={styles.cardMonogramLetter}>{icon.letter}</Text>
                      </View>
                    );
                  })()}
                  <Text
                    testID="inbox-card-title"
                    style={[styles.cardTitle, { color: palette.text }]}
                    numberOfLines={1}
                  >
                    {item.title ?? item.url ?? 'Untitled'}
                  </Text>
                  {suggestionCount > 0 ? (
                    <View
                      accessibilityLabel={`${suggestionCount} AI suggestion${suggestionCount > 1 ? 's' : ''}`}
                      style={[styles.suggestBadge, { borderColor: palette.accent }]}
                    >
                      <Text style={[styles.suggestBadgeLabel, { color: palette.accent }]}>
                        ✨ {suggestionCount}
                      </Text>
                    </View>
                  ) : null}
                </View>
                {item.url ? (
                  <Text style={[styles.cardUrl, { color: palette.textSecondary }]} numberOfLines={1}>
                    {item.url}
                  </Text>
                ) : null}
                {metaParts.length > 0 ? (
                  <Text style={[styles.cardMeta, { color: palette.textSecondary }]} numberOfLines={1}>
                    {metaParts.join('   ·   ')}
                  </Text>
                ) : null}
                {status ? (
                  <Text style={[styles.cardStatus, { color: palette.accent }]}>{status}</Text>
                ) : null}
              </Pressable>
              {item.url ? (
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel="Open link"
                  hitSlop={8}
                  style={styles.cardOpen}
                  onPress={() => {
                    if (item.url) {
                      void Linking.openURL(item.url).catch(() => {});
                    }
                  }}
                >
                  <Text style={[styles.cardOpenLabel, { color: palette.accent }]}>Open ↗</Text>
                </Pressable>
              ) : null}
            </View>
          );
        }}
      />
      <View style={[styles.footer, { borderTopColor: palette.border }]}>
        <Link href="/add" asChild>
          <Pressable style={[styles.primaryButton, { backgroundColor: palette.accent }]}>
            <Text style={styles.primaryButtonLabel}>Add Bookmark</Text>
          </Pressable>
        </Link>
        <Link href="/settings" asChild>
          <Pressable style={styles.secondaryButton}>
            <Text style={[styles.secondaryButtonLabel, { color: palette.accent }]}>Settings</Text>
          </Pressable>
        </Link>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  list: {
    padding: 16,
    gap: 12,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  empty: {
    fontSize: 15,
    textAlign: 'center',
    paddingVertical: 32,
  },
  errorBanner: {
    fontSize: 13,
    paddingVertical: 10,
    paddingHorizontal: 16,
    textAlign: 'center',
  },
  searchWrap: {
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  searchInput: {
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    fontSize: 15,
  },
  sortRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  sortCaption: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  sortPill: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  sortPillLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
  shelf: {
    flexGrow: 0,
    paddingTop: 10,
  },
  shelfContent: {
    paddingHorizontal: 16,
    gap: 8,
  },
  chip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 14,
  },
  chipLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
  card: {
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
  cardBody: {
    flex: 1,
    padding: 16,
    gap: 4,
  },
  cardOpen: {
    paddingVertical: 16,
    paddingRight: 16,
    paddingLeft: 8,
    alignSelf: 'stretch',
    justifyContent: 'center',
  },
  cardOpenLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
  cardTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  cardIcon: {
    width: 22,
    height: 22,
    borderRadius: 6,
  },
  cardMonogram: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardMonogramLetter: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
  },
  cardTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
  },
  suggestBadge: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingVertical: 2,
    paddingHorizontal: 8,
  },
  suggestBadgeLabel: {
    fontSize: 12,
    fontWeight: '700',
  },
  cardUrl: {
    fontSize: 13,
  },
  cardMeta: {
    fontSize: 12,
  },
  cardStatus: {
    fontSize: 12,
    fontWeight: '600',
  },
  footer: {
    flexDirection: 'row',
    gap: 12,
    padding: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  primaryButton: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryButtonLabel: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  secondaryButtonLabel: {
    fontSize: 16,
    fontWeight: '600',
  },
});
