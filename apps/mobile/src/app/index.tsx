import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import {
  Alert,
  Animated,
  FlatList,
  Image,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { usePalette } from '@/theme';
import { Card } from '@/ui/Card';
import { Chip } from '@/ui/Chip';
import { pendingSuggestions } from '@/domain/ai-suggestions';
import { filterBookmarks } from '@/domain/search';
import { MONOGRAM_COLORS, itemIcon, monogramColorIndex, monogramIcon } from '@/domain/item-icon';
import { displayTitle } from '@/domain/item-display';
import { ALL_FILTER, filterByFacet, sameFilter, type InboxFilter } from '@/domain/filter';
import {
  DEFAULT_SORT,
  INBOX_SORT_PREF_KEY,
  parseSort,
  serializeSort,
  sortBookmarks,
  type SortOption,
} from '@/domain/sort';
import {
  DEFAULT_VIEW_MODE,
  INBOX_VIEW_PREF_KEY,
  VIEW_MODES,
  parseViewMode,
  serializeViewMode,
  type ViewMode,
} from '@/domain/view-mode';
import { buildTagCloud, tagCloudFontSize } from '@/domain/tag-cloud';
import { getPreference, setPreference } from '@/storage/preferences';
import { useT } from '@/i18n';
import type { MessageKey } from '@/i18n/messages';
import type { TFunction } from '@/i18n/translate';
import { metadataStatusLabel, syncStatusLabel } from '@/i18n/status';
import { useBookmarks } from '@/store/bookmarks';
import { ActionSheet, type SheetAction } from '@/ui/ActionSheet';
import type { Bookmark } from '@/domain/types';

function statusLabel(bookmark: Bookmark, t: TFunction): string | null {
  const parts: string[] = [];
  if (bookmark.sync_status !== 'synced') {
    parts.push(syncStatusLabel(t, bookmark.sync_status));
  }
  if (bookmark.metadata_status === 'pending') {
    parts.push(metadataStatusLabel(t, 'pending'));
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

interface FacetChip {
  key: string;
  label: string;
  filter: InboxFilter;
  icon?: keyof typeof Ionicons.glyphMap;
}

// Glyph for each layout in the view-mode segmented control.
const VIEW_MODE_ICON: Record<ViewMode, ComponentProps<typeof Ionicons>['name']> = {
  card: 'albums-outline',
  list: 'list-outline',
  cloud: 'pricetags-outline',
};

// Translation key for each layout's human label (segmented-control a11y).
const VIEW_MODE_LABEL_KEY: Record<ViewMode, MessageKey> = {
  card: 'viewMode.card',
  list: 'viewMode.list',
  cloud: 'viewMode.cloud',
};

/**
 * The bookmark's leading glyph — its favicon when known, otherwise a colored
 * domain monogram. Shared by both Inbox layouts; `compact` shrinks it for the
 * dense list rows.
 */
function ItemIcon({
  item,
  compact = false,
  testID,
}: {
  item: Bookmark;
  compact?: boolean;
  testID?: string;
}) {
  const palette = usePalette();
  // A favicon URL can still 404 or be undecodable on-device; when it does, fall
  // back to the monogram instead of leaving a blank white tile.
  const [faviconFailed, setFaviconFailed] = useState(false);
  const base = itemIcon(item);
  const icon = base.kind === 'favicon' && faviconFailed ? monogramIcon(item) : base;
  const sizeStyle = compact ? styles.listIcon : styles.cardIcon;
  if (icon.kind === 'favicon') {
    // Frame the favicon on a clean white rounded tile: many sites only expose a
    // tiny /favicon.ico, and transparent ones would otherwise show the card
    // through their edges (the "irregular boundary"). `contain` keeps odd
    // aspect ratios from stretching.
    return (
      <View style={[sizeStyle, styles.faviconTile, { borderColor: palette.border }]}>
        <Image
          source={{ uri: icon.uri }}
          style={styles.faviconImage}
          resizeMode="contain"
          onError={() => setFaviconFailed(true)}
        />
      </View>
    );
  }
  return (
    <View
      testID={testID}
      style={[sizeStyle, styles.cardMonogram, { backgroundColor: MONOGRAM_COLORS[icon.colorIndex] }]}
    >
      <Text style={styles.cardMonogramLetter}>{icon.letter}</Text>
    </View>
  );
}

// The list that drives the collapsing header. Animated.FlatList lets the
// scroll position feed an Animated.Value over the native driver; the cast keeps
// FlatList's generic item typing (Animated.FlatList erases it to `any`).
const AnimatedFlatList = Animated.FlatList as unknown as typeof FlatList;

// Pre-rendered brand wordmark (in place of bundled display fonts): the Gothic A1
// "Stash" and Gowun Dodum 스태시 baked into PNGs. Two locale forms — plain
// "Stash" vs the bilingual "Stash | 스태시" lockup — each with a light/dark
// variant. `ratio` is the asset's intrinsic width/height so the Image can be
// sized by height alone.
const WORDMARK = {
  en: {
    ratio: 3.118,
    light: require('../../assets/images/wordmark-en-light.png'),
    dark: require('../../assets/images/wordmark-en-dark.png'),
  },
  local: {
    ratio: 6.158,
    light: require('../../assets/images/wordmark-ko-light.png'),
    dark: require('../../assets/images/wordmark-ko-dark.png'),
  },
};

export default function InboxScreen() {
  const palette = usePalette();
  const t = useT();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  // Pick the wordmark: bilingual lockup when the locale has a native form
  // (app.nameLocal differs from app.name), and the variant that matches the
  // active light/dark theme. The a11y label mirrors what sighted users see, so
  // screen readers announce the native wordmark too (e.g. "Stash 스태시").
  const scheme = useColorScheme();
  const hasLocalName = t('app.nameLocal') !== t('app.name');
  const wmSet = hasLocalName ? WORDMARK.local : WORDMARK.en;
  const wordmark = { source: scheme === 'dark' ? wmSet.dark : wmSet.light, ratio: wmSet.ratio };
  const wordmarkLabel = hasLocalName ? `${t('app.name')} ${t('app.nameLocal')}` : t('app.name');
  const {
    inbox,
    isLoading,
    loadError,
    getTagsForBookmark,
    getCollection,
    getEnrichment,
    getReviewedSuggestions,
    unseenSuggestionIds,
    clearUnseenSuggestions,
    collections,
    trashBookmark,
    deleteBookmark,
    assignCollection,
  } = useBookmarks();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<InboxFilter>(ALL_FILTER);
  const [sort, setSort] = useState<SortOption>(DEFAULT_SORT);
  const [viewMode, setViewMode] = useState<ViewMode>(DEFAULT_VIEW_MODE);

  // How many inbox bookmarks have AI suggestions that arrived while the user
  // wasn't looking (auto-enrichment, a server-side trigger, another device) and
  // still carry an unreviewed suggestion. Drives the "new AI suggestions"
  // banner. Intersect the unseen-id set with the *live* pending list so an item
  // whose suggestions were since applied/dismissed stops counting even if its id
  // lingers in the set.
  const newSuggestionsCount = useMemo(() => {
    if (unseenSuggestionIds.size === 0) {
      return 0;
    }
    let count = 0;
    for (const bookmark of inbox) {
      if (!unseenSuggestionIds.has(bookmark.id)) {
        continue;
      }
      const applied = new Set(getTagsForBookmark(bookmark.id).map((tag) => tag.name.toLowerCase()));
      const pending = pendingSuggestions(
        getEnrichment(bookmark.id),
        applied,
        getReviewedSuggestions(bookmark.id),
      );
      if (pending.length > 0) {
        count += 1;
      }
    }
    return count;
  }, [unseenSuggestionIds, inbox, getTagsForBookmark, getEnrichment, getReviewedSuggestions]);

  // Long-press action menu: which bookmark it targets, and whether it's showing
  // the top-level actions or the "move to collection" picker. Null item = closed.
  const [menuItem, setMenuItem] = useState<Bookmark | null>(null);
  const [menuMode, setMenuMode] = useState<'main' | 'move'>('main');

  // Collapsing header: the top cluster (hero + search + controls + browse
  // shelf) slides up out of view as the list scrolls down and slides back on
  // scroll up — à la Instagram/YouTube — reclaiming vertical space for the
  // bookmarks. We measure the cluster's height once it lays out, then drive its
  // translateY from the list's scroll position. diffClamp tracks the *net*
  // scroll movement (clamped to the header's height), so an upward flick reveals
  // the header immediately wherever you are in the list, not only at the top.
  const scrollY = useRef(new Animated.Value(0)).current;
  const [headerHeight, setHeaderHeight] = useState(0);
  const headerTranslate = useMemo(() => {
    if (!headerHeight) {
      return 0;
    }
    return Animated.diffClamp(scrollY, 0, headerHeight).interpolate({
      inputRange: [0, headerHeight],
      outputRange: [0, -headerHeight],
      extrapolate: 'clamp',
    });
  }, [scrollY, headerHeight]);

  // Load the saved sort + view mode once, then persist any change. The guards
  // stop the initial defaults from clobbering the stored values before they
  // have loaded.
  const sortLoaded = useRef(false);
  const viewLoaded = useRef(false);
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
    getPreference(INBOX_VIEW_PREF_KEY)
      .then((raw) => {
        if (!active) {
          return;
        }
        const stored = parseViewMode(raw);
        // Cold-starting via a tag/collection deep link forces a bookmark layout
        // (see the routed-facet effect); don't let a restored Tag-cloud
        // preference land afterwards and hide the linked-to bookmarks.
        if (stored === 'cloud' && (paramTag || paramCollection)) {
          return;
        }
        setViewMode(stored);
      })
      .catch(() => {})
      .finally(() => {
        viewLoaded.current = true;
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
  useEffect(() => {
    if (!viewLoaded.current) {
      return;
    }
    void setPreference(INBOX_VIEW_PREF_KEY, serializeViewMode(viewMode)).catch(() => {});
  }, [viewMode]);

  // Browse facet handed in by another screen (e.g. tapping a tag in Bookmark
  // Detail). Applying it on param change lets in-app links jump to a view.
  const params = useLocalSearchParams<{ tag?: string | string[]; collection?: string | string[] }>();
  const paramTag = Array.isArray(params.tag) ? params.tag[0] : params.tag;
  const paramCollection = Array.isArray(params.collection)
    ? params.collection[0]
    : params.collection;
  useEffect(() => {
    if (!paramTag && !paramCollection) {
      return;
    }
    setFilter(paramTag ? { kind: 'tag', id: paramTag } : { kind: 'collection', id: paramCollection! });
    // A routed facet wants the matching bookmarks in view; the tag cloud is a
    // global overview that ignores the facet, so drop back to a bookmark layout
    // (same drill-in as tapping a tag inside the cloud).
    setViewMode((mode) => (mode === 'cloud' ? 'card' : mode));
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
      .map((id) => ({ id, name: getCollection(id)?.name?.trim() }))
      .filter((entry): entry is { id: string; name: string } => Boolean(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ id, name }) => ({
        key: `c:${id}`,
        label: name,
        filter: { kind: 'collection', id },
        icon: 'folder-outline' as const,
      }));
    const tagChips: FacetChip[] = [...tagsById.entries()]
      // Drop tags whose name is empty/whitespace so they don't render as blank
      // pills (AI enrichment or a partial sync can leave a tag with no name).
      .map(([id, name]) => ({ id, name: name?.trim() ?? '' }))
      .filter((entry) => entry.name.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ id, name }) => ({ key: `t:${id}`, label: `#${name}`, filter: { kind: 'tag', id } }));
    return { chips: [...collectionChips, ...tagChips], hasUncollected: uncollected };
  }, [inbox, getTagsForBookmark, getCollection]);

  const facetFiltered = useMemo(
    () => filterByFacet(inbox, filter, tagIdsFor),
    [inbox, filter, tagIdsFor],
  );

  // Tag cloud derived from the facet-filtered Inbox (so the browse-shelf chips
  // scope it — e.g. picking a folder chip narrows the cloud to that folder's
  // tags): a frequency-ranked overview sized by how many of those bookmarks
  // carry each tag. Search is left out on purpose — the cloud is the navigation
  // surface, not a result of it. Tapping a tag drills in by applying its filter.
  const tagCloud = useMemo(() => {
    const counts = new Map<string, { name: string; count: number }>();
    for (const bookmark of facetFiltered) {
      for (const tag of getTagsForBookmark(bookmark.id)) {
        const existing = counts.get(tag.id);
        if (existing) {
          existing.count += 1;
        } else {
          counts.set(tag.id, { name: tag.name, count: 1 });
        }
      }
    }
    return buildTagCloud(
      [...counts.entries()].map(([id, { name, count }]) => ({ id, name, count })),
    );
  }, [facetFiltered, getTagsForBookmark]);

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

  const filtered = useMemo(() => filterBookmarks(facetFiltered, query), [facetFiltered, query]);
  const visible = useMemo(() => sortBookmarks(filtered, sort), [filtered, sort]);
  const searching = query.trim().length > 0;
  const showShelf = chips.length > 0;

  const activeChip = chips.find((chip) => sameFilter(chip.filter, filter));
  const sectionLabel = searching
    ? t('inbox.sectionMatches', { count: visible.length })
    : filter.kind === 'uncollected'
      ? t('inbox.sectionNoCollection', { count: visible.length })
      : activeChip
        ? t('inbox.sectionFacet', { label: activeChip.label, count: visible.length })
        : t('inbox.sectionRecent');

  const closeMenu = useCallback(() => {
    setMenuItem(null);
    setMenuMode('main');
  }, []);

  // Mirrors the detail screen's delete: a destructive confirm (native Alert, or
  // window.confirm on web where Alert has no buttons) before the row is gone.
  const confirmDelete = useCallback(
    (item: Bookmark) => {
      const remove = () => deleteBookmark(item.id);
      if (Platform.OS === 'web') {
        if (typeof confirm === 'undefined' || confirm(t('detail.deleteConfirmWeb'))) {
          remove();
        }
        return;
      }
      Alert.alert(t('bookmark.deleteTitle'), t('bookmark.deleteMessage'), [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('common.delete'), style: 'destructive', onPress: remove },
      ]);
    },
    [deleteBookmark, t],
  );

  // Actions for the long-press sheet. In 'move' mode it lists the collections so
  // a bookmark can be filed in one tap; otherwise the top-level item actions.
  const menuActions = useMemo<SheetAction[]>(() => {
    const item = menuItem;
    if (!item) {
      return [];
    }
    if (menuMode === 'move') {
      return [
        {
          key: 'none',
          label: t('inbox.inboxNoCollection'),
          icon: 'file-tray-outline',
          selected: item.collection_id === null,
          onPress: () => {
            assignCollection(item.id, null);
            closeMenu();
          },
        },
        ...collections.map(
          (collection): SheetAction => ({
            key: collection.id,
            label: collection.name,
            icon: 'folder-outline',
            selected: item.collection_id === collection.id,
            onPress: () => {
              assignCollection(item.id, collection.id);
              closeMenu();
            },
          }),
        ),
        { key: 'back', label: t('common.back'), onPress: () => setMenuMode('main') },
      ];
    }
    const actions: SheetAction[] = [];
    if (item.url) {
      actions.push({
        key: 'open',
        label: t('common.openLink'),
        icon: 'open-outline',
        onPress: () => {
          closeMenu();
          void Linking.openURL(item.url!).catch(() => {});
        },
      });
      actions.push({
        key: 'share',
        label: t('common.share'),
        icon: 'share-social-outline',
        onPress: () => {
          closeMenu();
          void Share.share({
            message: item.url!,
            url: item.url!,
            title: item.title ?? undefined,
          }).catch(() => {});
        },
      });
    }
    actions.push({
      key: 'move',
      label: t('inbox.moveToCollectionAction'),
      icon: 'folder-outline',
      onPress: () => setMenuMode('move'),
    });
    actions.push({
      key: 'trash',
      label: t('common.trash'),
      icon: 'trash-outline',
      destructive: true,
      onPress: () => {
        closeMenu();
        trashBookmark(item.id);
      },
    });
    return actions;
  }, [menuItem, menuMode, collections, assignCollection, trashBookmark, closeMenu, t]);

  const menuTitle =
    menuMode === 'move'
      ? t('inbox.moveToCollectionTitle')
      : ((menuItem ? displayTitle(menuItem) : null) ?? t('common.untitled'));

  const renderChip = (
    key: string,
    label: string,
    target: InboxFilter,
    icon?: keyof typeof Ionicons.glyphMap,
  ) => {
    const active = sameFilter(target, filter);
    return (
      <Chip
        key={key}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        onPress={() => setFilter(target)}
        variant={active ? 'selected' : 'default'}
        icon={icon}
      >
        {label}
      </Chip>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: palette.background }]}>
      <Animated.View
        // The cluster is absolutely positioned so it floats over the list and
        // can translate out of view. It needs an opaque background so list rows
        // sliding underneath stay hidden while it is partly collapsed.
        onLayout={(event) => setHeaderHeight(event.nativeEvent.layout.height)}
        style={[
          styles.header,
          { backgroundColor: palette.background, transform: [{ translateY: headerTranslate }] },
        ]}
      >
        <View style={[styles.hero, { paddingTop: insets.top + 12 }]}>
          <View style={styles.heroTitleBlock}>
            {/* The brand wordmark is a pre-rendered image (Gothic A1 "Stash" +
                Gowun Dodum 스태시) rather than bundled fonts — a few KB of PNG
                instead of multi-MB font files. Locales with a native wordmark
                (app.nameLocal differs from app.name) use the bilingual lockup;
                others use the plain "Stash". A light/dark variant matches the
                theme. */}
            <Image
              accessibilityRole="header"
              accessibilityLabel={wordmarkLabel}
              source={wordmark.source}
              resizeMode="contain"
              style={[styles.heroWordmark, { aspectRatio: wordmark.ratio }]}
            />
            <Text style={[styles.heroSubtitle, { color: palette.textSecondary }]}>
              {t('app.tagline')}
            </Text>
            <Text style={[styles.heroCountText, { color: palette.textSecondary }]}>
              {t('inbox.savedCount', { count: inbox.length })}
            </Text>
          </View>
          <View style={styles.headerActions}>
            {/* Single settings entry point. Account sign-in/management lives
                inside Settings (the account card), so the hero stays focused on
                bookmarks rather than carrying a second, redundant account button. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('inbox.settingsA11y')}
              hitSlop={8}
              style={styles.accountButton}
              onPress={() => router.push('/settings')}
            >
              <View style={[styles.avatar, { backgroundColor: palette.surface, borderColor: palette.border }]}>
                <Ionicons name="settings-sharp" size={20} color={palette.text} />
              </View>
              <Text style={[styles.accountCaption, { color: palette.textSecondary }]}>{t('nav.settings')}</Text>
            </Pressable>
          </View>
        </View>
        {loadError ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('inbox.reportStorageProblem')}
            onPress={() => router.push('/report')}
            style={({ pressed }) => [styles.errorBanner, { backgroundColor: palette.card, opacity: pressed ? 0.7 : 1 }]}
          >
            <Text style={{ color: '#d93636', fontSize: 13, textAlign: 'center' }}>
              {t('inbox.storageError')}
            </Text>
          </Pressable>
        ) : null}
        {newSuggestionsCount > 0 ? (
          <View
            testID="new-suggestions-banner"
            style={[styles.suggestBanner, { backgroundColor: palette.accentSoft }]}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('inbox.newSuggestionsA11y', { count: newSuggestionsCount })}
              onPress={() => router.push('/review')}
              style={({ pressed }) => [styles.suggestBannerMain, { opacity: pressed ? 0.7 : 1 }]}
            >
              <Text style={[styles.suggestBannerText, { color: palette.accent }]} numberOfLines={1}>
                {t('inbox.newSuggestions', { count: newSuggestionsCount })}
              </Text>
              <Text style={[styles.suggestBannerCta, { color: palette.accent }]}>
                {t('inbox.newSuggestionsReview')}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('inbox.newSuggestionsDismiss')}
              hitSlop={8}
              onPress={() => clearUnseenSuggestions()}
              style={({ pressed }) => [styles.suggestBannerClose, { opacity: pressed ? 0.5 : 1 }]}
            >
              <Ionicons name="close" size={18} color={palette.accent} />
            </Pressable>
          </View>
        ) : null}
        <View style={styles.searchWrap}>
          <TextInput
            style={[styles.searchInput, { backgroundColor: palette.card, color: palette.text }]}
            placeholder={t('inbox.searchPlaceholder')}
            placeholderTextColor={palette.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
            value={query}
            onChangeText={setQuery}
            clearButtonMode="while-editing"
          />
        </View>
        <View style={styles.sortRow}>
          <Text style={[styles.sortCaption, { color: palette.textSecondary }]}>{t('inbox.browse')}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('inbox.sortFieldA11y', {
              field: t(sort.field === 'date' ? 'inbox.sortFieldDate' : 'inbox.sortFieldName'),
            })}
            onPress={() => setSort((s) => ({ ...s, field: s.field === 'date' ? 'name' : 'date' }))}
            style={[styles.sortPill, { backgroundColor: palette.surface, borderColor: palette.border }]}
          >
            <Text style={[styles.sortPillLabel, { color: palette.text }]}>
              {sort.field === 'date' ? t('inbox.sortNewest') : t('inbox.sortName')}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('inbox.sortDirectionA11y', {
              direction: t(
                sort.dir === 'asc'
                  ? 'inbox.sortDirectionAscending'
                  : 'inbox.sortDirectionDescending',
              ),
            })}
            onPress={() => setSort((s) => ({ ...s, dir: s.dir === 'asc' ? 'desc' : 'asc' }))}
            style={[styles.sortPill, { backgroundColor: palette.surface, borderColor: palette.border }]}
          >
            <Text style={[styles.sortPillLabel, { color: palette.text }]}>
              {sort.dir === 'asc' ? t('inbox.sortAsc') : t('inbox.sortDesc')}
            </Text>
          </Pressable>
          <View style={[styles.viewSegment, { backgroundColor: palette.surface, borderColor: palette.border }]}>
            {VIEW_MODES.map((mode) => {
              const active = viewMode === mode;
              return (
                <Pressable
                  key={mode}
                  accessibilityRole="button"
                  accessibilityLabel={t('inbox.viewAsA11y', { mode: t(VIEW_MODE_LABEL_KEY[mode]) })}
                  accessibilityState={{ selected: active }}
                  testID={`inbox-view-${mode}`}
                  onPress={() => setViewMode(mode)}
                  style={[styles.viewSegmentButton, active ? { backgroundColor: palette.accentSoft } : null]}
                >
                  <Ionicons
                    name={VIEW_MODE_ICON[mode]}
                    size={18}
                    color={active ? palette.accent : palette.textSecondary}
                  />
                </Pressable>
              );
            })}
          </View>
        </View>
        {showShelf ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            testID="browse-shelf"
            style={styles.shelf}
            contentContainerStyle={styles.shelfContent}
          >
            {renderChip('all', t('inbox.filterAll'), ALL_FILTER)}
            {hasUncollected
              ? renderChip('uncollected', t('inbox.filterNoCollection'), { kind: 'uncollected' }, 'file-tray-outline')
              : null}
            {chips.map((chip) => renderChip(chip.key, chip.label, chip.filter, chip.icon))}
          </ScrollView>
        ) : null}
      </Animated.View>
      {viewMode === 'cloud' ? (
        <Animated.ScrollView
          testID="inbox-tag-cloud"
          onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
            useNativeDriver: true,
          })}
          scrollEventThrottle={16}
          scrollIndicatorInsets={{ top: headerHeight }}
          contentContainerStyle={[
            styles.list,
            { paddingTop: headerHeight + 8, paddingBottom: insets.bottom + 96 },
          ]}
        >
          <Text style={[styles.sectionLabel, { color: palette.textSecondary }]}>
            {t('inbox.tagCloudHeader', { count: tagCloud.length })}
          </Text>
          {tagCloud.length > 0 ? (
            <View style={styles.cloudWrap}>
              {/* Render alphabetically so big/small words intersperse into a
                  cloud rather than a frequency-sorted descending wedge; size +
                  weight + a stable per-tag color carry the frequency signal. */}
              {[...tagCloud]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((entry) => {
                  const size = tagCloudFontSize(entry.weight);
                  const color = MONOGRAM_COLORS[monogramColorIndex(entry.name)];
                  return (
                    <Pressable
                      key={entry.id}
                      testID="inbox-cloud-tag"
                      accessibilityRole="button"
                      accessibilityLabel={t('inbox.tagCloudTagA11y', { name: entry.name, count: entry.count })}
                      hitSlop={6}
                      // Drill into the tag: apply its filter, then drop back to
                      // cards so the matching bookmarks are immediately visible.
                      onPress={() => {
                        setFilter({ kind: 'tag', id: entry.id });
                        setViewMode('card');
                      }}
                    >
                      <Text
                        style={{
                          color,
                          fontSize: size,
                          lineHeight: Math.round(size * 1.12),
                          letterSpacing: -0.3,
                          fontWeight: entry.weight > 0.66 ? '800' : entry.weight > 0.33 ? '700' : '600',
                          // Lighter tags recede a touch so the heavy ones pop.
                          opacity: 0.55 + 0.45 * entry.weight,
                        }}
                      >
                        {`#${entry.name}`}
                      </Text>
                    </Pressable>
                  );
                })}
            </View>
          ) : (
            <Text style={[styles.empty, { color: palette.textSecondary }]}>
              {isLoading ? t('inbox.loading') : t('inbox.tagCloudEmpty')}
            </Text>
          )}
        </Animated.ScrollView>
      ) : (
      <AnimatedFlatList
        data={visible}
        keyExtractor={(item) => item.id}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
          useNativeDriver: true,
        })}
        scrollEventThrottle={16}
        // Keep the scrollbar clear of the floating header.
        scrollIndicatorInsets={{ top: headerHeight }}
        contentContainerStyle={[
          styles.list,
          viewMode === 'list' ? styles.listModeList : null,
          // Start the list below the floating header, and clear the Add button
          // so it never covers the last row.
          { paddingTop: headerHeight + 8, paddingBottom: insets.bottom + 96 },
        ]}
        ListHeaderComponent={
          <Text style={[styles.sectionLabel, { color: palette.textSecondary }]}>
            {sectionLabel}
          </Text>
        }
        ListEmptyComponent={
          <Text style={[styles.empty, { color: palette.textSecondary }]}>
            {isLoading
              ? t('inbox.loading')
              : searching
                ? t('inbox.emptySearch')
                : filter.kind !== 'all'
                  ? t('inbox.emptyView')
                  : t('inbox.emptyAll')}
          </Text>
        }
        extraData={viewMode}
        renderItem={({ item }) => {
          const status = statusLabel(item, t);
          const collectionName = getCollection(item.collection_id)?.name ?? null;
          const cardTags = getTagsForBookmark(item.id);
          // Pending AI suggestions = high-confidence suggested tags not yet
          // applied (see @/domain/ai-suggestions), surfaced so they're
          // reviewable from the list rather than buried in Detail.
          const appliedNames = new Set(cardTags.map((tag) => tag.name.toLowerCase()));
          const suggestionCount = pendingSuggestions(
            getEnrichment(item.id),
            appliedNames,
            getReviewedSuggestions(item.id),
          ).length;
          const openDetail = () =>
            router.push({ pathname: '/bookmark/[id]', params: { id: item.id } });
          const openLink = () => {
            if (item.url) {
              void Linking.openURL(item.url).catch(() => {});
            }
          };

          // Compact, single-line rows trade the preview image and inline meta
          // chips for density — more bookmarks visible per screen.
          if (viewMode === 'list') {
            return (
              <Pressable
                style={({ pressed }) => [
                  styles.listRow,
                  {
                    backgroundColor: palette.surfaceElevated,
                    borderColor: palette.border,
                    opacity: pressed ? 0.78 : 1,
                  },
                ]}
                onPress={openDetail}
                onLongPress={() => setMenuItem(item)}
              >
                <ItemIcon item={item} compact testID="inbox-list-monogram" />
                <View style={styles.listText}>
                  <Text
                    testID="inbox-list-title"
                    style={[styles.listTitle, { color: palette.text }]}
                    numberOfLines={1}
                  >
                    {displayTitle(item) ?? t('common.untitled')}
                  </Text>
                  {item.url ? (
                    <Text style={[styles.listUrl, { color: palette.textSecondary }]} numberOfLines={1}>
                      {item.url}
                    </Text>
                  ) : null}
                </View>
                {suggestionCount > 0 ? (
                  <View
                    accessibilityLabel={t('inbox.aiSuggestionsA11y', { count: suggestionCount })}
                    style={[styles.suggestBadge, { borderColor: palette.accent }]}
                  >
                    <Text style={[styles.suggestBadgeLabel, { color: palette.accent }]}>
                      ✨ {suggestionCount}
                    </Text>
                  </View>
                ) : null}
                {item.url ? (
                  <Pressable
                    accessibilityRole="link"
                    accessibilityLabel={t('common.openLink')}
                    hitSlop={8}
                    style={[styles.listOpen, { backgroundColor: palette.accentSoft }]}
                    onPress={openLink}
                  >
                    <Text style={[styles.cardOpenLabel, { color: palette.accent }]}>↗</Text>
                  </Pressable>
                ) : null}
              </Pressable>
            );
          }

          const metaParts = [
            ...(collectionName ? [t('inbox.inCollection', { name: collectionName })] : []),
            ...cardTags.slice(0, 3).map((tag) => `#${tag.name}`),
          ];
          return (
            <Card style={styles.card}>
              <Pressable onPress={openDetail} onLongPress={() => setMenuItem(item)}>
                {item.local_image_uri ?? item.preview_image_url ? (
                  <Image
                    testID="inbox-card-preview"
                    source={{ uri: (item.local_image_uri ?? item.preview_image_url)! }}
                    style={styles.cardPreview}
                  />
                ) : null}
                <View style={styles.cardBody}>
                  <View style={styles.cardTitleRow}>
                  <ItemIcon item={item} testID="inbox-card-monogram" />
                  <Text
                    testID="inbox-card-title"
                    style={[styles.cardTitle, { color: palette.text }]}
                    numberOfLines={1}
                  >
                    {displayTitle(item) ?? t('common.untitled')}
                  </Text>
                  {suggestionCount > 0 ? (
                    <View
                      accessibilityLabel={t('inbox.aiSuggestionsA11y', { count: suggestionCount })}
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
                  <View style={styles.metaChipRow}>
                    {metaParts.slice(0, 3).map((part) => (
                      <View key={part} style={[styles.metaChip, { backgroundColor: palette.mutedSurface }]}>
                        <Text style={[styles.metaChipLabel, { color: palette.accentText }]} numberOfLines={1}>
                          {part}
                        </Text>
                      </View>
                    ))}
                  </View>
                ) : null}
                  {status ? (
                    <Text style={[styles.cardStatus, { color: palette.accent }]}>{status}</Text>
                  ) : null}
                </View>
              </Pressable>
              {item.url ? (
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel={t('common.openLink')}
                  hitSlop={8}
                  style={[styles.cardOpen, { backgroundColor: palette.accentSoft }]}
                  onPress={openLink}
                >
                  <Text style={[styles.cardOpenLabel, { color: palette.accent }]}>{t('inbox.openExternal')}</Text>
                </Pressable>
              ) : null}
            </Card>
          );
        }}
      />
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('inbox.addBookmark')}
        onPress={() => router.push('/add')}
        style={({ pressed }) => [
          styles.fab,
          { backgroundColor: palette.accent, bottom: insets.bottom + 20, opacity: pressed ? 0.9 : 1 },
        ]}
      >
        <Ionicons name="add" size={34} color="#ffffff" />
      </Pressable>
      <ActionSheet
        visible={menuItem !== null}
        title={menuTitle}
        actions={menuActions}
        onClose={closeMenu}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    // Above the list so it floats over the scrolling rows.
    zIndex: 10,
  },
  list: {
    padding: 16,
    gap: 16,
  },
  listModeList: {
    gap: 8,
  },
  hero: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 8,
  },
  heroTitleBlock: {
    flex: 1,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginLeft: 12,
  },
  heroWordmark: {
    // Height drives the size; width follows from the asset's aspectRatio.
    height: 32,
    alignSelf: 'flex-start',
  },
  heroSubtitle: {
    fontSize: 15,
    marginTop: 2,
  },
  heroCountText: {
    fontSize: 13,
    fontWeight: '600',
    marginTop: 6,
  },
  accountButton: {
    alignItems: 'center',
    marginLeft: 12,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  accountCaption: {
    fontSize: 11,
    fontWeight: '600',
    marginTop: 4,
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
  suggestBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 12,
    paddingLeft: 14,
    paddingRight: 6,
  },
  suggestBannerMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
  },
  suggestBannerText: {
    flexShrink: 1,
    fontSize: 13,
    fontWeight: '600',
  },
  suggestBannerCta: {
    fontSize: 13,
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
  suggestBannerClose: {
    padding: 8,
  },
  searchWrap: {
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  searchInput: {
    borderRadius: 20,
    paddingVertical: 13,
    paddingHorizontal: 16,
    fontSize: 16,
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
    borderRadius: 999,
    paddingVertical: 7,
    paddingHorizontal: 13,
  },
  sortPillLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
  viewSegment: {
    marginLeft: 'auto',
    flexDirection: 'row',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    overflow: 'hidden',
  },
  viewSegmentButton: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shelf: {
    flexGrow: 0,
    // minHeight (NOT a fixed height): floors the viewport so a horizontal
    // ScrollView can't collapse onto its content on Android, while still letting
    // the row GROW to a taller pill (larger OS font/display sizes, or the taller
    // Samsung system font). A fixed height shorter than the real pill was
    // shaving the rounded edge even when the text inside rendered intact. Chips
    // are vertically centred via shelfContent.alignItems. Spacing is margin
    // (outside the scroll box, so it can't clip).
    minHeight: 42,
    marginTop: 8,
    marginBottom: 0,
  },
  shelfContent: {
    paddingHorizontal: 16,
    alignItems: 'center',
    // Match the shelf floor so the pill is centred in the row (and the row grows
    // to fit a taller pill rather than cropping it). No vertical padding here —
    // that would clip the chips' bottom edge on Android.
    minHeight: 42,
    gap: 8,
  },
  cloudWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    columnGap: 14,
    rowGap: 6,
    paddingTop: 8,
    paddingHorizontal: 6,
  },
  card: {
    borderRadius: 24,
    overflow: 'hidden',
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  listIcon: {
    width: 28,
    height: 28,
    borderRadius: 8,
  },
  listText: {
    flex: 1,
    gap: 2,
  },
  listTitle: {
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  listUrl: {
    fontSize: 12,
  },
  listOpen: {
    borderRadius: 999,
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardPreview: {
    width: '100%',
    height: 132,
  },
  cardBody: {
    padding: 18,
    gap: 7,
  },
  cardOpen: {
    position: 'absolute',
    right: 14,
    bottom: 14,
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 12,
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
    width: 34,
    height: 34,
    borderRadius: 10,
  },
  faviconTile: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: '#ffffff',
  },
  faviconImage: {
    width: '72%',
    height: '72%',
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
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: -0.2,
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
  metaChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingRight: 72,
  },
  metaChip: {
    borderRadius: 999,
    paddingVertical: 4,
    paddingHorizontal: 9,
  },
  metaChipLabel: {
    fontSize: 12,
    fontWeight: '700',
  },
  cardStatus: {
    fontSize: 12,
    fontWeight: '600',
  },
  fab: {
    position: 'absolute',
    right: 20,
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: 'center',
    justifyContent: 'center',
    // Float above the list with a soft shadow so it reads as the primary action.
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
});
