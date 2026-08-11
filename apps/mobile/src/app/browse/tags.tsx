import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PostHogMaskView } from 'posthog-react-native';

import { nextFacetNonce } from '@/domain/facet-nonce';
import { filterBookmarks } from '@/domain/search';
import { ALL_FILTER, UNCOLLECTED_FILTER, filterByFacet, type InboxFilter } from '@/domain/filter';
import { MONOGRAM_COLORS, monogramColorIndex } from '@/domain/item-icon';
import { countTagsForBookmarks } from '@/domain/tag-counts';
import {
  buildTagCloud,
  tagCloudFontSize,
  TAG_CLOUD_MAX_ENTRIES,
  TAG_CLOUD_MAX_FONT,
  type TagCloudEntry,
} from '@/domain/tag-cloud';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useT } from '@/i18n';
import { trackBreadcrumb } from '@/observability/sentry';
import { useBookmarks } from '@/store/bookmarks';
import { usePalette } from '@/theme';

// The two surfaces toggled by the segmented control at the top of the route.
type TagView = 'cloud' | 'all';

// A conservative floor for the adaptive cloud cap: render at least this many of
// the busiest tags before the container's height has been measured, and never
// fewer once it has. Picked low enough never to overflow a small screen and high
// enough to look like a cloud on the first paint.
const ADAPTIVE_CLOUD_MIN = 24;
// Coarse glyph metrics used purely to *estimate* how many tags fill one screen.
// The real wrapping is done by native flexbox — these only pick N, and a small
// over/underfill is cosmetic (see the plan's adaptive-cap section).
const AVG_TAG_WIDTH = 96; // average rendered "#tag" pill width, px
const AVG_ROW_HEIGHT = TAG_CLOUD_MAX_FONT + 6; // max font + the cloud's rowGap

/**
 * Parse the route's `scope` param into an InboxFilter. Shapes:
 *   `collection:<id>` → that folder; `uncollected` → the no-collection set;
 *   absent/anything else → All. Only the facet is carried across navigation
 *   (search is a per-route, debounced field), so this is the whole scope state.
 */
function parseScope(raw: string | undefined): InboxFilter {
  if (!raw) {
    return ALL_FILTER;
  }
  if (raw === 'uncollected') {
    return UNCOLLECTED_FILTER;
  }
  if (raw.startsWith('collection:')) {
    const id = raw.slice('collection:'.length);
    return id ? { kind: 'collection', id } : ALL_FILTER;
  }
  return ALL_FILTER;
}

/**
 * Browse-by-tag route. A dedicated, isolated screen (so a keystroke only
 * re-renders this surface, never the 2400-line Inbox) with two surfaces toggled
 * by a segmented control: an adaptive-capped, non-scrolling word cloud and a
 * virtualized full list. One debounced search field at the top drives a
 * co-occurrence view — typing filters the facet-scoped bookmark set via
 * `filterBookmarks`, and both surfaces rebuild from the tags those matches carry
 * (so typing a tag name surfaces it plus its co-occurring tags). Tapping a tag
 * navigates back to the root Inbox with that tag's facet applied.
 */
export default function BrowseTagsScreen() {
  const palette = usePalette();
  const t = useT();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const navigation = useNavigation();
  // Wide viewports present Browse Tags as a left-side sheet over a dimmed
  // Inbox; phones keep the full-screen layout (mirrors Settings' sheet).
  const { width, height } = useWindowDimensions();
  const asSheet = width >= 760;
  const { inbox, isLoading, getTagsForBookmark, getCollection } = useBookmarks();

  const params = useLocalSearchParams<{ scope?: string | string[] }>();
  const scopeParam = Array.isArray(params.scope) ? params.scope[0] : params.scope;
  const scope = useMemo(() => parseScope(scopeParam), [scopeParam]);

  const [view, setView] = useState<TagView>('cloud');
  const [query, setQuery] = useState('');
  // Debounce the query on the same ~140ms cadence as the Inbox so the per-
  // keystroke rebuild settles once per typing pause, not once per keystroke.
  const debouncedQuery = useDebouncedValue(query, 140);

  // Tag ids accessor for the facet filter (mirrors index.tsx's tagIdsFor).
  const tagIdsFor = useCallback(
    (id: string) => getTagsForBookmark(id).map((tag) => tag.id),
    [getTagsForBookmark],
  );

  // The facet-scoped working set (collection / uncollected / all), before search.
  // Drives the library-empties→back guard: an empty scoped set means the facet
  // has no bookmarks at all, distinct from a search that simply matches none.
  const facetScoped = useMemo(
    () => filterByFacet(inbox, scope, tagIdsFor),
    [inbox, scope, tagIdsFor],
  );

  // Co-occurrence search: narrow the scoped set by the query (matching titles,
  // tags, folders, sites — exactly index.tsx ~L761-768), then aggregate the tags
  // those matching bookmarks carry. `filterBookmarks` matches tag names too, so
  // this one field also serves "find my #react".
  const filtered = useMemo(
    () =>
      filterBookmarks(facetScoped, debouncedQuery, {
        tagNames: (b) => getTagsForBookmark(b.id).map((tag) => tag.name),
        collectionName: (b) => getCollection(b.collection_id)?.name,
      }),
    [facetScoped, debouncedQuery, getTagsForBookmark, getCollection],
  );

  // Frequency-ranked cloud entries for the matching bookmarks. Wrapped in a
  // perf breadcrumb (Phase-0 before/after delta) reporting only durations and
  // counts — NEVER tag names (hard rule). `scoped` = bookmarks fed in, `total`
  // = distinct tags out.
  const ranked = useMemo<TagCloudEntry[]>(() => {
    const start = performance.now();
    const counts = countTagsForBookmarks(
      filtered.map((b) => b.id),
      getTagsForBookmark,
    );
    const built = buildTagCloud(counts);
    trackBreadcrumb('browse', 'tags build', {
      ms: Math.round(performance.now() - start),
      scoped: filtered.length,
      total: built.length,
    });
    return built;
  }, [filtered, getTagsForBookmark]);

  // Adaptive cap: measure the cloud container's available height, estimate how
  // many top tags fill ~one screen, and render only that many. The estimate is
  // cosmetic — native flexbox does the real wrapping, N is bounded, so a small
  // over/underfill never freezes or mis-wraps. `null` until measured → the
  // conservative floor renders on the first paint.
  const [cloudWidth, setCloudWidth] = useState<number | null>(null);
  const [cloudHeight, setCloudHeight] = useState<number | null>(null);
  const onCloudLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setCloudWidth(width);
    setCloudHeight(height);
  }, []);
  const adaptiveCap = useMemo(() => {
    if (cloudWidth === null || cloudHeight === null || cloudHeight <= 0) {
      return ADAPTIVE_CLOUD_MIN;
    }
    const perRow = Math.max(1, Math.floor(cloudWidth / AVG_TAG_WIDTH));
    const rows = Math.max(1, Math.floor(cloudHeight / AVG_ROW_HEIGHT));
    const estimate = perRow * rows;
    // Clamp to [floor, total]; also bound by the same hard ceiling the cloud
    // ever rendered so a huge measured viewport can't reintroduce the freeze.
    return Math.min(
      ranked.length,
      Math.max(ADAPTIVE_CLOUD_MIN, Math.min(estimate, TAG_CLOUD_MAX_ENTRIES)),
    );
  }, [cloudWidth, cloudHeight, ranked.length]);

  // The capped cloud slice (already frequency-ranked, so this keeps the busiest
  // tags). The list surface shows ALL ranked entries.
  const cloudEntries = useMemo(() => ranked.slice(0, adaptiveCap), [ranked, adaptiveCap]);

  const onTagPress = useCallback(
    (entry: TagCloudEntry) => {
      // COUNTS + opaque id only — never the tag name (hard rule).
      trackBreadcrumb('browse', 'cloud tag tap', { view, cloud: ranked.length });
      // A monotonic nonce so re-selecting the SAME tag still re-applies the facet
      // on the root Inbox (its handler dedupes by tag + nonce — see index.tsx).
      // It MUST come from the shared module counter, not a per-screen ref:
      // dismissTo tears this screen down, so a ref would reset to 0 and re-emit
      // the same nonce on every visit, and the Inbox would skip the re-selection
      // as already-consumed (STASH-D).
      const nonce = nextFacetNonce();
      // dismissTo, NOT navigate: this removes /browse/tags from the stack while
      // handing the tag facet to the root Inbox beneath it, so repeated
      // Browse→tag cycles can't grow the stack and native Back can't land on a
      // stale tag browser. Reached cold (no Inbox beneath — e.g. a deep link)?
      // dismissTo falls back to a replace, so there's still no dangling browse
      // screen left behind.
      router.dismissTo({ pathname: '/', params: { tag: entry.id, t: nonce } });
    },
    [router, view, ranked.length],
  );

  // Drop the facet and re-browse the whole library (scoped-empty recovery).
  const onBrowseAll = useCallback(() => {
    router.navigate('/browse/tags');
  }, [router]);

  // Cloud overflow footer → the full (frequency-ranked) list. COUNTS only, never
  // a tag name (hard rule): `cloud` = chips actually shown, `total` = all tags.
  const onShowAll = useCallback(() => {
    trackBreadcrumb('browse', 'cloud show all', {
      cloud: cloudEntries.length,
      total: ranked.length,
    });
    setView('all');
  }, [cloudEntries.length, ranked.length]);

  // Library-empties guard: if the underlying scoped set is empty (the facet has
  // no bookmarks at all — NOT merely a zero-result search), there's nothing to
  // browse, so pop back. Don't fire while loading (facets are empty mid-load) or
  // while the user is mid-typing a search (a search-zero is a recovery point, not
  // a dead end). Guard the "only screen in the stack" case so back() can't crash
  // on a cold deep-link.
  const isTyping = query.trim().length > 0;
  useEffect(() => {
    if (isLoading || isTyping) {
      return;
    }
    if (facetScoped.length > 0) {
      return;
    }
    // The whole library is empty too → All scope also has nothing; still pop if
    // we can, otherwise stay put (a cold deep-link with an empty library).
    if (navigation.canGoBack?.()) {
      router.back();
    }
  }, [isLoading, isTyping, facetScoped.length, navigation, router]);

  // Header title reflects the scope: "Tags" / "Tags in {name}" / "Tags · Inbox"
  // (the no-collection bucket is labelled "Inbox" everywhere, #232). The Stack
  // header is hidden for this screen, so this drives the screen's own header
  // row below instead of navigation.setOptions.
  const scopeName =
    scope.kind === 'collection' ? (getCollection(scope.id)?.name?.trim() ?? '') : '';
  const headerTitle = useMemo(() => {
    if (scope.kind === 'collection' && scopeName) {
      return t('inbox.tagsTitleScoped', { name: scopeName });
    }
    if (scope.kind === 'uncollected') {
      return t('inbox.tagsTitleUncollected');
    }
    return t('inbox.tagsTitle');
  }, [scope.kind, scopeName, t]);

  const searching = debouncedQuery.trim().length > 0;
  // Empty-state classification for the rendered surface.
  const showSkeleton = isLoading;
  const isEmpty = !showSkeleton && ranked.length === 0;
  // A real zero-result search (the scope has bookmarks, the query just matched
  // none / their tags). Distinct from a scope that simply has no tagged items.
  const isSearchZero = isEmpty && searching;
  const isScopedEmpty = isEmpty && !searching && scope.kind !== 'all';
  const isGlobalEmpty = isEmpty && !searching && scope.kind === 'all';

  function renderEmpty() {
    if (showSkeleton) {
      return (
        <Text style={[styles.emptyText, { color: palette.textSecondary }]}>{t('inbox.loading')}</Text>
      );
    }
    if (isSearchZero) {
      const message = t('inbox.tagsSearchZero', { query: debouncedQuery.trim() });
      return (
        // Contains the user's own search text — masked, with an outer
        // accessible label since it's standalone (no Pressable ancestor).
        // `alignSelf: 'stretch'` overrides the parent's `alignItems: center`
        // for this wrapper specifically, so it fills the available width
        // (as a direct Text child implicitly would) instead of shrinking to
        // the message's unwrapped intrinsic width and running off-screen.
        <View accessible accessibilityLabel={message} style={styles.maskStretch}>
          <PostHogMaskView>
            <Text style={[styles.emptyText, { color: palette.textSecondary }]}>{message}</Text>
          </PostHogMaskView>
        </View>
      );
    }
    if (isScopedEmpty) {
      const message =
        scope.kind === 'uncollected'
          ? t('inbox.tagsUncollectedEmpty')
          : t('inbox.tagsScopedEmpty', { name: scopeName });
      return (
        <View style={styles.emptyState}>
          {/* Sometimes a fixed string (uncollected case), sometimes a
              collection name — masked unconditionally either way. */}
          <View accessible accessibilityLabel={message} style={styles.maskStretch}>
            <PostHogMaskView>
              <Text style={[styles.emptyText, { color: palette.textSecondary }]}>{message}</Text>
            </PostHogMaskView>
          </View>
          <Pressable
            accessibilityRole="button"
            testID="browse-tags-browse-all"
            onPress={onBrowseAll}
            style={({ pressed }) => [
              styles.browseAll,
              { backgroundColor: palette.accentSoft, opacity: pressed ? 0.7 : 1 },
            ]}
          >
            <Ionicons name="pricetags-outline" size={16} color={palette.accent} />
            <Text style={[styles.browseAllLabel, { color: palette.accent }]}>
              {t('inbox.tagsBrowseAll')}
            </Text>
          </Pressable>
        </View>
      );
    }
    // Global empty.
    return (
      <View style={styles.emptyState}>
        <Ionicons
          name="pricetags-outline"
          size={40}
          color={palette.textSecondary}
          style={styles.emptyGlyph}
        />
        <Text style={[styles.emptyText, { color: palette.textSecondary }]}>
          {t('inbox.tagCloudEmpty')}
        </Text>
      </View>
    );
  }

  const content = (
    <View
      testID="browse-tags-screen"
      style={[
        styles.container,
        { backgroundColor: palette.background, paddingBottom: insets.bottom },
      ]}
    >
      <View style={styles.searchWrap}>
        <TextInput
          testID="browse-tags-search"
          style={[styles.searchInput, { backgroundColor: palette.card, color: palette.text }]}
          placeholder={t('inbox.tagSearchPlaceholder')}
          placeholderTextColor={palette.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          value={query}
          onChangeText={setQuery}
          clearButtonMode="while-editing"
        />
      </View>
      <View style={[styles.segment, { backgroundColor: palette.surface, borderColor: palette.border }]}>
        {(['cloud', 'all'] as const).map((mode) => {
          const active = view === mode;
          return (
            <Pressable
              key={mode}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={
                mode === 'cloud' ? t('inbox.tagViewCloudA11y') : t('inbox.tagViewAllA11y')
              }
              testID={`browse-tags-view-${mode}`}
              onPress={() => setView(mode)}
              style={[styles.segmentButton, active ? { backgroundColor: palette.accentSoft } : null]}
            >
              <Text
                style={[
                  styles.segmentLabel,
                  { color: active ? palette.accentText : palette.textSecondary },
                ]}
              >
                {mode === 'cloud' ? t('inbox.tagViewCloud') : t('inbox.tagViewAll')}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {isEmpty || showSkeleton ? (
        <View style={styles.emptyWrap}>{renderEmpty()}</View>
      ) : view === 'cloud' ? (
        // Non-scrolling, native flexbox wrap — Yoga measures glyphs so CJK/한글
        // wrapping is exact. onLayout feeds the adaptive cap.
        <View
          testID="browse-tags-cloud"
          style={styles.cloudArea}
          onLayout={onCloudLayout}
        >
          <View style={styles.cloudWrap}>
            {cloudEntries.map((entry) => {
              const size = tagCloudFontSize(entry.weight);
              const color = MONOGRAM_COLORS[monogramColorIndex(entry.name)];
              return (
                <Pressable
                  key={entry.id}
                  testID="browse-tags-cloud-tag"
                  accessibilityRole="button"
                  accessibilityLabel={t('inbox.tagCloudTagA11y', {
                    name: entry.name,
                    count: entry.count,
                  })}
                  hitSlop={6}
                  onPress={() => onTagPress(entry)}
                >
                  <PostHogMaskView>
                    <Text
                      style={{
                        color,
                        fontSize: size,
                        lineHeight: Math.round(size * 1.12),
                        letterSpacing: -0.3,
                        fontWeight: entry.weight > 0.66 ? '800' : entry.weight > 0.33 ? '700' : '600',
                        opacity: 0.55 + 0.45 * entry.weight,
                      }}
                    >
                      {`#${entry.name}`}
                    </Text>
                  </PostHogMaskView>
                </Pressable>
              );
            })}
          </View>
          {ranked.length > cloudEntries.length ? (
            <Pressable
              testID="browse-tags-show-all"
              accessibilityRole="button"
              accessibilityLabel={t('inbox.tagCloudShowAllA11y', { count: ranked.length })}
              hitSlop={10}
              onPress={onShowAll}
              style={({ pressed }) => [
                styles.showAll,
                {
                  backgroundColor: palette.surface,
                  borderColor: palette.border,
                  opacity: pressed ? 0.7 : 1,
                },
              ]}
            >
              <Text style={[styles.showAllLabel, { color: palette.textSecondary }]}>
                {t('inbox.tagCloudShowAll', { count: ranked.length })}
              </Text>
              <Ionicons name="chevron-forward" size={14} color={palette.textSecondary} />
            </Pressable>
          ) : null}
        </View>
      ) : (
        <FlatList
          testID="browse-tags-list"
          style={webOverscrollContain}
          data={ranked}
          keyExtractor={(item) => item.id}
          // Fixed row height → getItemLayout, so hundreds of tags scroll without
          // measuring each row.
          getItemLayout={(_data, index) => ({
            length: LIST_ROW_HEIGHT,
            offset: LIST_ROW_HEIGHT * index,
            index,
          })}
          contentContainerStyle={styles.listContent}
          keyboardDismissMode="on-drag"
          renderItem={({ item }) => {
            const color = MONOGRAM_COLORS[monogramColorIndex(item.name)];
            return (
              <Pressable
                testID="browse-tags-list-row"
                accessibilityRole="button"
                accessibilityLabel={t('inbox.tagCloudTagA11y', {
                  name: item.name,
                  count: item.count,
                })}
                onPress={() => onTagPress(item)}
                style={({ pressed }) => [styles.listRow, { opacity: pressed ? 0.6 : 1 }]}
              >
                <View style={[styles.listDot, { backgroundColor: color }]} />
                <PostHogMaskView style={styles.maskFlex}>
                  <Text style={[styles.listName, { color: palette.text }]} numberOfLines={1}>
                    {`#${item.name}`}
                  </Text>
                </PostHogMaskView>
                <Text style={[styles.listCount, { color: palette.textSecondary }]}>
                  {t('inbox.tagListCount', { count: item.count })}
                </Text>
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );

  // The Stack header is hidden for this screen, so it supplies its own header
  // row (title + close) for both layouts — matching Settings/Report/Review.
  const header = (
    <View style={[styles.header, { paddingTop: insets.top + 12, borderBottomColor: palette.border, backgroundColor: palette.background }]}>
      {/* `accessible` + `accessibilityLabel` give VoiceOver/TalkBack the real
          title as one announced unit (standalone, no Pressable ancestor);
          `headerTitle`'s flex: 1 also has to live on this wrapper since an
          unstyled PostHogMaskView wouldn't inherit it. Masked unconditionally
          even though it's sometimes the fixed "All Tags" string, since it's
          also sometimes a collection name. */}
      <View accessible accessibilityLabel={headerTitle} style={styles.headerTitle}>
        <PostHogMaskView>
          <Text style={[styles.headerTitle, { color: palette.text }]} numberOfLines={1}>
            {headerTitle}
          </Text>
        </PostHogMaskView>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('common.close')}
        onPress={() => router.back()}
        hitSlop={8}
        style={({ pressed }) => [styles.headerClose, pressed && { opacity: 0.6 }]}
      >
        <Ionicons name="close" size={24} color={palette.text} />
      </Pressable>
    </View>
  );

  // This screen is a `transparentModal`, so the Inbox stays mounted behind it.
  // On web the modal container sizes to its content instead of the viewport,
  // which collapses a `flex: 1` root to content height and lets the Inbox
  // bleed through. Pin both layouts to the real viewport height so the opaque
  // background always covers the full screen (a no-op on native).
  if (asSheet) {
    // Left-docked sheet: panel first in the row (pushed to the left), then the
    // flex:1 backdrop filling the remaining space on the right; tapping the
    // backdrop closes.
    return (
      <View style={[styles.sheetOverlay, { height }]}>
        <View style={[styles.sheetPanel, { backgroundColor: palette.background, borderColor: palette.border }]}>
          {header}
          {content}
        </View>
        <Pressable
          testID="browse-tags-sheet-backdrop"
          style={styles.sheetBackdrop}
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
          onPress={() => router.back()}
        />
      </View>
    );
  }

  return (
    <View testID="browse-tags-fullscreen" style={[styles.fullScreen, { backgroundColor: palette.background, height }]}>
      {header}
      {content}
    </View>
  );
}

// Fixed list-row height for getItemLayout (dot + name + count badge + padding).
const LIST_ROW_HEIGHT = 48;

// On wide (desktop-web) viewports, Browse Tags docks as a left-side sheet over
// the dimmed Inbox (mirrors Settings' right-docked sheet); this caps the panel
// width. No effect on phones (their width is already below the breakpoint).
const SHEET_PANEL_MAX_WIDTH = 720;

// Contains scroll chaining to the tag list on web (mirrors Settings/Report) —
// without it, pulling past the top/bottom of the list can rubber-band the
// transparentModal and expose the Inbox behind it.
const webOverscrollContain: StyleProp<ViewStyle> =
  Platform.OS === 'web' ? ({ overscrollBehavior: 'contain' } as ViewStyle) : undefined;

const styles = StyleSheet.create({
  fullScreen: {
    flex: 1,
  },
  // Applied to the PostHogMaskView wrapping the tag-name Text below — that
  // Text's own `flex: 1` (in `listName`) no longer sizes the row once it's
  // nested inside an unstyled wrapper View; the flex must live on the
  // wrapper for a long tag name to still shrink to the space beside the count.
  maskFlex: {
    flex: 1,
  },
  // Applied to a masked wrapper inside an `alignItems: 'center'` container —
  // overrides that centering for this one child so it stretches to the
  // available width instead of shrinking to its content's intrinsic width.
  maskStretch: {
    alignSelf: 'stretch',
  },
  sheetOverlay: {
    flex: 1,
    flexDirection: 'row',
  },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  sheetPanel: {
    width: '100%',
    maxWidth: SHEET_PANEL_MAX_WIDTH,
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: {
    flex: 1,
    marginRight: 12,
    fontSize: 20,
    fontWeight: '700',
  },
  headerClose: {
    padding: 4,
  },
  container: {
    flex: 1,
  },
  searchWrap: {
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  searchInput: {
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === 'ios' ? 12 : 8,
    fontSize: 15,
  },
  segment: {
    flexDirection: 'row',
    alignSelf: 'center',
    marginTop: 12,
    marginBottom: 4,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 3,
  },
  segmentButton: {
    paddingHorizontal: 22,
    paddingVertical: 7,
    borderRadius: 999,
  },
  segmentLabel: {
    fontSize: 14,
    fontWeight: '700',
  },
  cloudArea: {
    flex: 1,
    paddingHorizontal: 6,
    paddingTop: 12,
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
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 24,
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    height: LIST_ROW_HEIGHT,
  },
  listDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  listName: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: -0.2,
  },
  listCount: {
    fontSize: 13,
  },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  emptyState: {
    alignItems: 'center',
  },
  emptyGlyph: {
    marginBottom: 12,
  },
  emptyText: {
    fontSize: 15,
    textAlign: 'center',
  },
  browseAll: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 16,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  browseAllLabel: {
    fontSize: 14,
    fontWeight: '700',
  },
  // Muted overflow pill pinned below the cloud wrap. Reads as a control, not a
  // tag: surface fill, hairline border, secondary text, no # / monogram / weight.
  showAll: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: 6,
    marginTop: 16,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  showAllLabel: {
    fontSize: 15,
    fontWeight: '600',
  },
});
