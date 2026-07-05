import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { ActivityIndicator, Animated, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { nextFacetNonce } from '@/domain/facet-nonce';
import { MONOGRAM_COLORS, monogramColorIndex } from '@/domain/item-icon';
import { buildTagCloud, type TagCloudEntry } from '@/domain/tag-cloud';
import { countTagsForBookmarks } from '@/domain/tag-counts';
import { useT } from '@/i18n';
import { useBookmarks } from '@/store/bookmarks';
import { usePalette } from '@/theme';
import { TabHeaderActions } from '@/ui/TabHeaderActions';

import { TAB_BAR_HEIGHT, useTabChrome } from './_layout';

// Cap + center the content column on wide (desktop-web) viewports; a no-op on
// phones, matching the Inbox/Library CONTENT_MAX_WIDTH treatment.
const CONTENT_MAX_WIDTH = 720;

// Animated list so its scroll feeds the shared tab-shell signal (bar + FAB
// hide). The cast preserves FlatList's item typing (Animated.FlatList erases it).
const AnimatedFlatList = Animated.FlatList as unknown as typeof FlatList;

/**
 * Tags — the cross-cutting topic index over the whole library ("find by topic,
 * across everything"). Unlike the Library tab (browse by collection), this
 * aggregates every tag on every active bookmark into one frequency-ranked list
 * with per-tag counts. Tapping a tag hands the Inbox tab that tag's facet (via
 * a fresh nonce) so the actual items render there with the Inbox's existing
 * cards — no items are rendered inline, and there is no filter-pill row (Tags is
 * its own browse). The transient "browse by tag" drill-in from the Inbox still
 * lives at `browse/tags.tsx`; this tab is a separate, whole-library entry point.
 */
export default function TagsScreen() {
  const palette = usePalette();
  const t = useT();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  // `inbox` is the store's active set (non-trashed, non-archived) — the same
  // bookmarks the Inbox lists and browse/tags.tsx aggregates over.
  const { inbox, getTagsForBookmark, isLoading } = useBookmarks();

  // Feed this tab's scroll into the shared tab-shell signal so the bottom bar
  // slides away as you browse down and returns on scroll-up. Reset it to 0 on
  // focus so the bar starts shown (the signal is shared across tabs).
  const { scrollY } = useTabChrome();
  useFocusEffect(
    useCallback(() => {
      scrollY.setValue(0);
    }, [scrollY]),
  );

  // Frequency-ranked tag index over the whole library. Reuses the same pure
  // helpers browse/tags.tsx uses: count how many bookmarks carry each tag, then
  // rank (desc by count, then name) — `buildTagCloud` also drops blank names.
  const tags = useMemo<TagCloudEntry[]>(() => {
    const counts = countTagsForBookmarks(
      inbox.map((bookmark) => bookmark.id),
      getTagsForBookmark,
    );
    return buildTagCloud(counts);
  }, [inbox, getTagsForBookmark]);

  // Switch to the Inbox tab scoped to a tag. A fresh nonce makes the Inbox
  // re-apply the facet even if the same tag is tapped twice (its (facet + nonce)
  // consumer dedupe, see `(tabs)/index.tsx`).
  const openTag = useCallback(
    (id: string) => {
      router.navigate({ pathname: '/', params: { tag: id, t: nextFacetNonce() } });
    },
    [router],
  );

  // Header search icon: hand the Inbox its own search open (v1 reuses the
  // Inbox's inline search rather than a Tags-local surface). A fresh nonce makes
  // the Inbox re-open search even on a repeat tap.
  const openSearch = useCallback(() => {
    router.navigate({ pathname: '/', params: { focusSearch: '1', t: nextFacetNonce() } });
  }, [router]);

  const renderRow = useCallback(
    ({ item }: { item: TagCloudEntry }) => {
      const color = MONOGRAM_COLORS[monogramColorIndex(item.name)];
      return (
        <Pressable
          testID={`tags-row-${item.id}`}
          accessibilityRole="button"
          accessibilityLabel={t('tags.openTagA11y', { name: item.name })}
          onPress={() => openTag(item.id)}
          style={({ pressed }) => [
            styles.row,
            { backgroundColor: palette.surfaceElevated, borderColor: palette.border },
            pressed ? styles.rowPressed : null,
          ]}
        >
          <View style={[styles.rowDot, { backgroundColor: color }]} />
          <Text style={[styles.rowTitle, { color: palette.text }]} numberOfLines={1}>
            {`#${item.name}`}
          </Text>
          <Text style={[styles.rowCount, { color: palette.textSecondary }]}>
            {t('library.itemCount', { count: item.count })}
          </Text>
          <Ionicons name="chevron-forward" size={18} color={palette.textSecondary} />
        </Pressable>
      );
    },
    [t, palette, openTag],
  );

  const header = (
    <View style={[styles.header, { paddingTop: insets.top + 20 }]}>
      <View style={styles.headerText}>
        <Text style={[styles.title, { color: palette.text }]}>{t('nav.tags')}</Text>
        {tags.length > 0 ? (
          <Text style={[styles.headerCount, { color: palette.textSecondary }]}>
            {t('tags.count', { count: tags.length })}
          </Text>
        ) : null}
      </View>
      <TabHeaderActions onSearch={openSearch} onSettings={() => router.push('/settings')} />
    </View>
  );

  let body;
  if (isLoading) {
    body = (
      <View style={styles.centered}>
        <ActivityIndicator color={palette.accent} />
      </View>
    );
  } else if (tags.length === 0) {
    // Calm home, never a "debt" empty state: no tags yet is just an invitation,
    // matching the Library tab's tone.
    body = (
      <View testID="tags-empty" style={styles.centered}>
        <Ionicons name="pricetags-outline" size={44} color={palette.textSecondary} />
        <Text style={[styles.emptyTitle, { color: palette.text }]}>{t('tags.empty')}</Text>
        <Text style={[styles.emptyHint, { color: palette.textSecondary }]}>
          {t('tags.emptyHint')}
        </Text>
      </View>
    );
  } else {
    body = (
      <AnimatedFlatList
        data={tags}
        keyExtractor={(item) => item.id}
        renderItem={renderRow}
        style={styles.list}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
          useNativeDriver: true,
        })}
        scrollEventThrottle={16}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: insets.bottom + TAB_BAR_HEIGHT + 24 },
        ]}
      />
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: palette.background }]}>
      {header}
      {body}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    width: '100%',
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingBottom: 12,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  headerText: {
    flex: 1,
  },
  title: {
    fontSize: 28,
    fontWeight: '800',
  },
  headerCount: {
    marginTop: 2,
    fontSize: 14,
    fontWeight: '600',
  },
  list: {
    width: '100%',
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: 'center',
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 14,
    marginBottom: 10,
    gap: 12,
  },
  rowPressed: {
    opacity: 0.7,
  },
  rowDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  rowTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: '700',
  },
  rowCount: {
    fontSize: 13,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
  },
  emptyTitle: {
    marginTop: 16,
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  emptyHint: {
    marginTop: 8,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
});
