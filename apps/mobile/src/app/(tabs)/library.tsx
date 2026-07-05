import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { ActivityIndicator, Animated, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  collectionFingerprints,
  relativeTime,
  type RelativeUnit,
} from '@/domain/collection-fingerprint';
import { nextFacetNonce } from '@/domain/facet-nonce';
import { useT } from '@/i18n';
import type { MessageKey } from '@/i18n/messages';
import type { TFunction } from '@/i18n/translate';
import { useBookmarks } from '@/store/bookmarks';
import { usePalette } from '@/theme';
import { TabHeaderActions } from '@/ui/TabHeaderActions';

import { TAB_BAR_HEIGHT, useTabChrome } from './_layout';

// Cap + center the content column on wide (desktop-web) viewports; a no-op on
// phones, matching the Inbox's CONTENT_MAX_WIDTH treatment.
const CONTENT_MAX_WIDTH = 720;

// Animated list so its scroll feeds the shared tab-shell signal (bar + FAB
// hide). The cast preserves FlatList's item typing (Animated.FlatList erases it).
const AnimatedFlatList = Animated.FlatList as unknown as typeof FlatList;

// Each relative-time bucket's translated "… ago" phrase.
const RELATIVE_KEY: Record<RelativeUnit, MessageKey> = {
  now: 'relative.now',
  minutes: 'relative.minutes',
  hours: 'relative.hours',
  days: 'relative.days',
  weeks: 'relative.weeks',
  months: 'relative.months',
  years: 'relative.years',
};

type LibraryRow =
  | { kind: 'all'; count: number }
  | {
      kind: 'collection';
      id: string;
      name: string;
      count: number;
      lastAddedAt: string | null;
      topSite: string | null;
    };

// The content-fingerprint subtitle for a collection row, from REAL data only:
// how many items, when one was last added, and (when a real pattern) the site
// most of them share. No inferred content-type — only what we actually store.
function collectionSubtitle(row: Extract<LibraryRow, { kind: 'collection' }>, t: TFunction): string {
  const parts = [t('library.itemCount', { count: row.count })];
  if (row.lastAddedAt) {
    const rel = relativeTime(row.lastAddedAt, Date.now());
    parts.push(t('library.lastAdded', { time: t(RELATIVE_KEY[rel.unit], { count: rel.value }) }));
  }
  if (row.topSite) {
    parts.push(row.topSite);
  }
  return parts.join(' · ');
}

/**
 * Library — the "everything you've kept" browse home. Unlike the Inbox (the
 * un-triaged queue that can empty), this never empties once anything is saved.
 * v1 browses by collection: an "All items" row plus one row per collection that
 * holds active bookmarks, each carrying a content-fingerprint subtitle. Tapping
 * a row hands the Inbox tab that scope (via its collection facet) so the actual
 * items render with the Inbox's existing cards — no card rendering is
 * duplicated here.
 */
export default function LibraryScreen() {
  const palette = usePalette();
  const t = useT();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  // `inbox` is the store's active set (non-trashed, non-archived) — the same
  // bookmarks the Inbox lists. "All items" counts them; the fingerprints group
  // them by collection.
  const { inbox, collections, isLoading } = useBookmarks();

  // Feed this tab's scroll into the shared tab-shell signal so the bottom bar
  // slides away as you browse down and returns on scroll-up. Reset it to 0 on
  // focus so the bar starts shown (the signal is shared across tabs).
  const { scrollY } = useTabChrome();
  useFocusEffect(
    useCallback(() => {
      scrollY.setValue(0);
    }, [scrollY]),
  );

  const fingerprints = useMemo(() => collectionFingerprints(inbox), [inbox]);

  const rows = useMemo<LibraryRow[]>(() => {
    const collectionRows = collections
      .map((collection): Extract<LibraryRow, { kind: 'collection' }> | null => {
        const fingerprint = fingerprints.get(collection.id);
        const name = collection.name?.trim();
        // Only collections that hold active bookmarks appear — same rule as the
        // Inbox browse shelf, so every row leads somewhere and carries a real
        // last-added time. Blank-named collections are dropped like the Inbox does.
        if (!fingerprint || !name) {
          return null;
        }
        return {
          kind: 'collection',
          id: collection.id,
          name,
          count: fingerprint.count,
          lastAddedAt: fingerprint.lastAddedAt,
          topSite: fingerprint.topSite,
        };
      })
      .filter((row): row is Extract<LibraryRow, { kind: 'collection' }> => row !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
    return [{ kind: 'all', count: inbox.length }, ...collectionRows];
  }, [collections, fingerprints, inbox.length]);

  // Switch to the Inbox tab showing everything.
  const openAll = useCallback(() => {
    router.navigate('/');
  }, [router]);

  // Header search icon: hand the Inbox its own search open (v1 reuses the
  // Inbox's inline search rather than a Library-local surface). A fresh nonce
  // makes the Inbox re-open search even on a repeat tap.
  const openSearch = useCallback(() => {
    router.navigate({ pathname: '/', params: { focusSearch: '1', t: nextFacetNonce() } });
  }, [router]);

  // Switch to the Inbox tab scoped to a collection. A fresh nonce makes the
  // Inbox re-apply the facet even if the same collection is tapped twice (its
  // (facet + nonce) consumer dedupe, see `(tabs)/index.tsx`).
  const openCollection = useCallback(
    (id: string) => {
      router.navigate({ pathname: '/', params: { collection: id, t: nextFacetNonce() } });
    },
    [router],
  );

  const renderRow = useCallback(
    ({ item }: { item: LibraryRow }) => {
      if (item.kind === 'all') {
        return (
          <Pressable
            testID="library-row-all"
            accessibilityRole="button"
            accessibilityLabel={t('library.openAllA11y')}
            onPress={openAll}
            style={({ pressed }) => [
              styles.row,
              { backgroundColor: palette.surfaceElevated, borderColor: palette.border },
              pressed ? styles.rowPressed : null,
            ]}
          >
            <View style={[styles.rowIcon, { backgroundColor: palette.mutedSurface }]}>
              <Ionicons name="albums-outline" size={20} color={palette.accent} />
            </View>
            <View style={styles.rowMain}>
              <Text style={[styles.rowTitle, { color: palette.text }]} numberOfLines={1}>
                {t('library.allItems')}
              </Text>
              <Text style={[styles.rowSubtitle, { color: palette.textSecondary }]} numberOfLines={1}>
                {t('library.itemCount', { count: item.count })}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={palette.textSecondary} />
          </Pressable>
        );
      }
      return (
        <Pressable
          testID={`library-row-${item.id}`}
          accessibilityRole="button"
          accessibilityLabel={t('library.openCollectionA11y', { name: item.name })}
          onPress={() => openCollection(item.id)}
          style={({ pressed }) => [
            styles.row,
            { backgroundColor: palette.surfaceElevated, borderColor: palette.border },
            pressed ? styles.rowPressed : null,
          ]}
        >
          <View style={[styles.rowIcon, { backgroundColor: palette.mutedSurface }]}>
            <Ionicons name="folder-outline" size={20} color={palette.accent} />
          </View>
          <View style={styles.rowMain}>
            <Text style={[styles.rowTitle, { color: palette.text }]} numberOfLines={1}>
              {item.name}
            </Text>
            <Text style={[styles.rowSubtitle, { color: palette.textSecondary }]} numberOfLines={1}>
              {collectionSubtitle(item, t)}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={palette.textSecondary} />
        </Pressable>
      );
    },
    [t, palette, openAll, openCollection],
  );

  const header = (
    <View style={[styles.header, { paddingTop: insets.top + 20 }]}>
      <View style={styles.headerText}>
        <Text style={[styles.title, { color: palette.text }]}>{t('nav.library')}</Text>
        {inbox.length > 0 ? (
          <Text style={[styles.headerCount, { color: palette.textSecondary }]}>
            {t('library.itemCount', { count: inbox.length })}
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
  } else if (inbox.length === 0) {
    // First run: a calm home, never an anxious "debt" empty state. Nothing to
    // triage — just an invitation to save the first link.
    body = (
      <View testID="library-empty" style={styles.centered}>
        <Ionicons name="library-outline" size={44} color={palette.textSecondary} />
        <Text style={[styles.emptyTitle, { color: palette.text }]}>{t('library.empty')}</Text>
        <Text style={[styles.emptyHint, { color: palette.textSecondary }]}>
          {t('library.emptyHint')}
        </Text>
      </View>
    );
  } else {
    body = (
      <AnimatedFlatList
        data={rows}
        keyExtractor={(item) => (item.kind === 'all' ? 'all' : item.id)}
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
    paddingVertical: 12,
    paddingHorizontal: 12,
    marginBottom: 10,
    gap: 12,
  },
  rowPressed: {
    opacity: 0.7,
  },
  rowIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowMain: {
    flex: 1,
  },
  rowTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  rowSubtitle: {
    marginTop: 2,
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
