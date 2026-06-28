import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import {
  Alert,
  Animated,
  BackHandler,
  FlatList,
  Image,
  Keyboard,
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
import { SearchSuggestionShelf } from '@/ui/SearchSuggestionShelf';
import { useSearchSuggestions } from '@/hooks/useSearchSuggestions';
import {
  RECENT_SEARCHES_PREF_KEY,
  addRecent,
  parseRecents,
  removeRecent,
  serializeRecents,
} from '@/domain/recent-searches';
import type { SearchSuggestion } from '@/domain/search-suggestions';
import { pendingSuggestedFolder, pendingSuggestions } from '@/domain/ai-suggestions';
import { collectionMatchKey } from '@/domain/collection-match';
import { filterBookmarks, queryHasSearchTokens } from '@/domain/search';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { MONOGRAM_COLORS, itemIcon, monogramIcon } from '@/domain/item-icon';
import { displayTitle } from '@/domain/item-display';
import {
  ALL_FILTER,
  UNCOLLECTED_FILTER,
  filterByFacet,
  sameFilter,
  type InboxFilter,
} from '@/domain/filter';
import {
  DEFAULT_SORT,
  INBOX_SORT_PREF_KEY,
  SORT_PRESETS,
  parseSort,
  sameSort,
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
import { getPreference, setPreference } from '@/storage/preferences';
import { trackBreadcrumb } from '@/observability/sentry';
import { useT } from '@/i18n';
import type { MessageKey } from '@/i18n/messages';
import type { TFunction } from '@/i18n/translate';
import { metadataStatusLabel, syncStatusLabel } from '@/i18n/status';
import { useBookmarks } from '@/store/bookmarks';
import { ActionSheet, type SheetAction } from '@/ui/ActionSheet';
import { HighlightedText } from '@/ui/HighlightedText';
import { overlayLayer } from '@/ui/layering';
import { useCaptureToast } from '@/ui/capture-toast';
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

/**
 * Normalize a query into the same per-token keys the search engine uses
 * (`collectionMatchKey`: NFKC + lowercase + strip non-alphanumerics), so the
 * card can tell WHICH of its values a result matched on. Mirrors the tokenizing
 * in `@/domain/search` — kept in lockstep so "what we show as the reason" agrees
 * with "what actually matched".
 */
function queryTerms(query: string): string[] {
  return query
    .split(/\s+/)
    .map(collectionMatchKey)
    .filter(Boolean);
}

/** Whether a single label value (tag, site name) is hit by any query term. */
function valueMatchesTerms(value: string | null | undefined, terms: string[]): boolean {
  if (!value || terms.length === 0) {
    return false;
  }
  const key = collectionMatchKey(value);
  if (!key) {
    return false;
  }
  return terms.some((term) => key.includes(term));
}

interface FacetChip {
  key: string;
  label: string;
  filter: InboxFilter;
  icon?: keyof typeof Ionicons.glyphMap;
  // How many bookmarks the facet holds. Set for the "container" chips (folders
  // and the Inbox/no-collection set) so their weight is visible at a glance;
  // left undefined for #tag chips (the tag cloud is their frequency view).
  count?: number;
}

// Glyph for each layout in the view-mode segmented control.
const VIEW_MODE_ICON: Record<ViewMode, ComponentProps<typeof Ionicons>['name']> = {
  card: 'albums-outline',
  compact: 'reorder-four-outline',
  list: 'list-outline',
};

// Translation key for each layout's human label (segmented-control a11y).
const VIEW_MODE_LABEL_KEY: Record<ViewMode, MessageKey> = {
  card: 'viewMode.card',
  compact: 'viewMode.compact',
  list: 'viewMode.list',
};

// Friendly label + icon for each sort preset, keyed by its serialized form.
// Phrasing each order as a whole choice ("Newest", "Recently opened") reads
// kinder than a field pill plus an abstract ascending/descending toggle.
const SORT_LABEL_KEY: Record<string, MessageKey> = {
  'date:desc': 'inbox.sortNewest',
  'date:asc': 'inbox.sortOldest',
  'accessed:desc': 'inbox.sortRecentlyOpened',
  'accessed:asc': 'inbox.sortLeastRecentlyOpened',
  'name:asc': 'inbox.sortNameAsc',
  'name:desc': 'inbox.sortNameDesc',
};

const SORT_ICON: Record<SortOption['field'], ComponentProps<typeof Ionicons>['name']> = {
  date: 'calendar-outline',
  accessed: 'time-outline',
  name: 'text-outline',
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

// Rendered height of the hero wordmark in dp; its width is this × the asset
// ratio. Kept as a constant so the Image's explicit width and height stay in
// lockstep (see heroWordmark / the hero Image).
const WORDMARK_HEIGHT = 30;

/**
 * One pill in the Inbox browse shelf. Memoized so a filter change (which
 * re-renders the whole screen) only re-renders the chips whose `active` flag
 * actually flips — not all of them. With a large library the shelf can hold
 * well over a hundred tag chips, and re-rendering every one on each tap was
 * what made a chip tap feel dead for seconds after drilling in from the tag
 * cloud. `target` comes straight from the (memoized) chip list / module-level
 * filter constants and `onSelect` is referentially stable, so memo's prop
 * compare holds across taps.
 */
const BrowseChip = memo(function BrowseChip({
  target,
  label,
  icon,
  count,
  active,
  onSelect,
}: {
  target: InboxFilter;
  label: string;
  icon?: keyof typeof Ionicons.glyphMap;
  count?: number;
  active: boolean;
  onSelect: (target: InboxFilter) => void;
}) {
  return (
    <Chip
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={() => onSelect(target)}
      variant={active ? 'selected' : 'default'}
      icon={icon}
      count={count}
    >
      {label}
    </Chip>
  );
});

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
    getDismissedFolderSuggestions,
    unseenSuggestionIds,
    clearUnseenSuggestions,
    collections,
    trashBookmark,
    restoreBookmark,
    deleteBookmark,
    assignCollection,
    markBookmarkAccessed,
  } = useBookmarks();
  const { show: showToast } = useCaptureToast();
  const [query, setQuery] = useState('');
  // The TextInput stays bound to `query` (instant echo), but the derived work —
  // filtering, sorting, the searching flag, the section label — keys off this
  // debounced copy so an O(C) collection lookup per bookmark doesn't re-run on
  // every keystroke and the match count doesn't flicker mid-type.
  const debouncedQuery = useDebouncedValue(query, 140);
  // Whether the search field holds focus — drives the suggestion shelf (shown
  // only while focused with an empty query).
  const [searchFocused, setSearchFocused] = useState(false);
  // Tapping a suggestion chip blurs the TextInput FIRST on native (iOS/Android),
  // which would unmount the shelf mid-gesture and drop the tap into the void. So
  // we defer the hide one tick: a chip's onPress runs synchronously before the
  // deferred blur lands, and tag/folder taps (which intentionally blur) cancel
  // the timer and hide immediately. The ref lets us clear a pending hide on
  // re-focus and on unmount so we never setState after teardown.
  const blurHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearBlurHide = useCallback(() => {
    if (blurHideTimer.current !== null) {
      clearTimeout(blurHideTimer.current);
      blurHideTimer.current = null;
    }
  }, []);
  useEffect(() => clearBlurHide, [clearBlurHide]);
  const searchRef = useRef<TextInput>(null);
  // On native, dismissing the keyboard with the Back button / interactive swipe
  // (or an on-drag list scroll) does NOT fire the TextInput's onBlur — so without
  // this the focused-only suggestion shelf would stay stranded on screen with no
  // keyboard, and the Browse row (gated on !searchFocused) would never return.
  // When the keyboard hides, drop the focused state and blur the field (Android
  // keeps native focus after a Back-button dismiss, so blur() is needed for the
  // next tap to re-fire onFocus). Route the hide through the SAME deferred timer
  // the onBlur path uses, so a same-gesture chip onPress still resolves against a
  // mounted shelf — native hide ordering isn't guaranteed. The shelf's own
  // ScrollView sets keyboardShouldPersistTaps="handled", so a chip tap never
  // dismisses the keyboard and this can't fire mid-tap. Web has no soft keyboard.
  useEffect(() => {
    if (Platform.OS === 'web') {
      return;
    }
    const sub = Keyboard.addListener('keyboardDidHide', () => {
      clearBlurHide();
      blurHideTimer.current = setTimeout(() => {
        blurHideTimer.current = null;
        setSearchFocused(false);
        searchRef.current?.blur();
      }, 0);
    });
    return () => sub.remove();
  }, [clearBlurHide]);
  // The user's own recent searches (most-recent-first). Local-only: persisted in
  // the meta store as `pref.search.recents`, never enqueued or synced.
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [filter, setFilter] = useState<InboxFilter>(ALL_FILTER);
  const [sort, setSort] = useState<SortOption>(DEFAULT_SORT);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
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
      const enrichment = getEnrichment(bookmark.id);
      const pending = pendingSuggestions(enrichment, applied, getReviewedSuggestions(bookmark.id));
      // A folder-only recommendation (no pending tags) is reviewable too, so it
      // must keep the banner up — mirror the Review screen's inclusion rule, and
      // honor durable folder dismissals so a waved-off folder stops counting.
      const folder = pendingSuggestedFolder(
        enrichment,
        collections,
        bookmark.collection_id,
        getDismissedFolderSuggestions(bookmark.id),
      );
      if (pending.length > 0 || folder) {
        count += 1;
      }
    }
    return count;
  }, [
    unseenSuggestionIds,
    inbox,
    collections,
    getTagsForBookmark,
    getEnrichment,
    getReviewedSuggestions,
    getDismissedFolderSuggestions,
  ]);

  // Every inbox bookmark still worth reviewing — a pending (un-applied,
  // un-reviewed) tag suggestion OR a pending folder recommendation — regardless
  // of whether it arrived "unseen". This drives the *persistent* review banner:
  // the Review screen's entry point now lives here on the Inbox (it used to be a
  // row in Settings), so the banner stands as long as anything is left to
  // review, escalating to the "new" styling only while `newSuggestionsCount`
  // marks fresh arrivals. Mirrors the Review list's inclusion rule exactly.
  const pendingReviewCount = useMemo(() => {
    let count = 0;
    for (const bookmark of inbox) {
      const applied = new Set(getTagsForBookmark(bookmark.id).map((tag) => tag.name.toLowerCase()));
      const enrichment = getEnrichment(bookmark.id);
      const pending = pendingSuggestions(enrichment, applied, getReviewedSuggestions(bookmark.id));
      const folder = pendingSuggestedFolder(
        enrichment,
        collections,
        bookmark.collection_id,
        getDismissedFolderSuggestions(bookmark.id),
      );
      if (pending.length > 0 || folder) {
        count += 1;
      }
    }
    return count;
  }, [
    inbox,
    collections,
    getTagsForBookmark,
    getEnrichment,
    getReviewedSuggestions,
    getDismissedFolderSuggestions,
  ]);

  // Whether the review banner is in its escalated "new arrivals" state (accent
  // alert + acknowledge ✕) vs the calm standing "to review" entry.
  const hasNewSuggestions = newSuggestionsCount > 0;

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
  // The pinned active-filter bar is measured separately (it lives in its own
  // non-translating layer below the header). When it's showing, both scroll
  // containers reserve extra top padding for it so the first rows aren't hidden.
  const [filterBarHeight, setFilterBarHeight] = useState(0);
  // Both the header and the pinned filter bar ride the SAME diffClamp source, so
  // they collapse in lockstep off one scroll listener. The header slides fully
  // out of view; the bar only rides up until it meets the safe-area top line,
  // then stops — so its clear/back action stays reachable while scrolled.
  const headerClamp = useMemo(
    () => (headerHeight ? Animated.diffClamp(scrollY, 0, headerHeight) : null),
    [scrollY, headerHeight],
  );
  const headerTranslate = useMemo(() => {
    if (!headerClamp || !headerHeight) {
      return 0;
    }
    return headerClamp.interpolate({
      inputRange: [0, headerHeight],
      outputRange: [0, -headerHeight],
      extrapolate: 'clamp',
    });
  }, [headerClamp, headerHeight]);
  // The bar rests at `headerHeight` (just under the revealed header) and rides up
  // by `headerHeight - insets.top` as the header collapses, stopping at the
  // status-bar line so it never tucks under the notch.
  const filterBarTranslate = useMemo(() => {
    if (!headerClamp || !headerHeight) {
      return 0;
    }
    return headerClamp.interpolate({
      inputRange: [0, headerHeight],
      outputRange: [0, -(headerHeight - insets.top)],
      extrapolate: 'clamp',
    });
  }, [headerClamp, headerHeight, insets.top]);

  // Load the saved sort + view mode once, then persist any change. The guards
  // stop the initial defaults from clobbering the stored values before they
  // have loaded.
  const sortLoaded = useRef(false);
  const viewLoaded = useRef(false);
  // Mirror the sort-pref guard: don't let the initial empty default clobber the
  // stored recents before they load.
  const recentsLoaded = useRef(false);
  // True while a recents persist write is in flight. The focus re-read (below)
  // must NOT clobber a just-submitted recent with a stale store read before its
  // async write commits — so it skips while this is set.
  const recentsDirty = useRef(false);
  useEffect(() => {
    let active = true;
    getPreference(RECENT_SEARCHES_PREF_KEY)
      .then((raw) => {
        if (active) {
          setRecentSearches(parseRecents(raw));
        }
      })
      .catch(() => {})
      .finally(() => {
        recentsLoaded.current = true;
      });
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
        // parseViewMode degrades any legacy stored 'cloud' to Cards — the cloud
        // is a transient toggle now, never a persisted/cold-start layout, so the
        // stored pref is always a real item layout (card/list).
        setViewMode(parseViewMode(raw));
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
    if (!recentsLoaded.current) {
      return;
    }
    // Local-only persistence (meta store, like the sort pref) — never enqueued
    // or synced. Search strings are user content and stay on-device. Mark the
    // write in-flight so a focus re-read can't race ahead of it and drop a
    // just-submitted recent.
    recentsDirty.current = true;
    void setPreference(RECENT_SEARCHES_PREF_KEY, serializeRecents(recentSearches))
      .catch(() => {})
      .finally(() => {
        recentsDirty.current = false;
      });
  }, [recentSearches]);
  // Re-read recents whenever the Inbox regains focus. The list is loaded once on
  // mount (above), but "Clear search history" in Settings writes the empty list
  // straight to the meta store without touching this screen's state — so on the
  // way back we re-read storage to reflect the clear (and any other cross-screen
  // change). Guarded by `recentsLoaded` so it never runs before the initial load
  // settled, and skipped on the very first focus (the mount load already ran).
  // Local-only read; nothing is fetched or synced.
  const recentsFocusReady = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!recentsLoaded.current || !recentsFocusReady.current) {
        recentsFocusReady.current = true;
        return;
      }
      // A recents write from THIS screen is in flight — the in-memory list is
      // newer than the store, so re-reading now would drop the pending entry.
      // Skip; the persisted value already matches what we'd reload.
      if (recentsDirty.current) {
        return;
      }
      let active = true;
      getPreference(RECENT_SEARCHES_PREF_KEY)
        .then((raw) => {
          if (active) {
            setRecentSearches(parseRecents(raw));
          }
        })
        .catch(() => {});
      return () => {
        active = false;
      };
    }, []),
  );

  // Browse facet handed in by another screen (e.g. tapping a tag in Bookmark
  // Detail, or picking one on the /browse/tags route). Those callers navigate
  // back to THIS root Inbox with the facet as a param plus a monotonic `t` nonce,
  // so re-selecting the SAME tag re-applies it. A plain effect keyed on the param
  // value wouldn't re-fire when the value is unchanged, so we re-read params on
  // focus and consume them once per (param, nonce) pair: the focus callback runs
  // on every return to this screen, and the consumed-ref dedupe stops a single
  // arrival from re-applying on unrelated re-focuses (e.g. a sheet dismissal).
  const params = useLocalSearchParams<{
    tag?: string | string[];
    collection?: string | string[];
    t?: string | string[];
  }>();
  const paramTag = Array.isArray(params.tag) ? params.tag[0] : params.tag;
  const paramCollection = Array.isArray(params.collection)
    ? params.collection[0]
    : params.collection;
  const paramNonce = Array.isArray(params.t) ? params.t[0] : params.t;
  // The last (facet + nonce) we applied, so a re-focus that carries the same
  // routed facet doesn't reset a filter the user has since changed by hand.
  const consumedFacetRef = useRef<string | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (!paramTag && !paramCollection) {
        return;
      }
      // Key on the facet AND the nonce: the same tag re-selected from the route
      // arrives with a fresh nonce, so it re-applies even though the facet value
      // is unchanged; an unrelated re-focus carries the same key and is skipped.
      const key = `${paramTag ? `tag:${paramTag}` : `collection:${paramCollection}`}#${paramNonce ?? ''}`;
      if (consumedFacetRef.current === key) {
        return;
      }
      consumedFacetRef.current = key;
      setFilter(
        paramTag ? { kind: 'tag', id: paramTag } : { kind: 'collection', id: paramCollection! },
      );
    }, [paramTag, paramCollection, paramNonce]),
  );

  const tagIdsFor = useCallback(
    (id: string) => getTagsForBookmark(id).map((tag) => tag.id),
    [getTagsForBookmark],
  );

  // Browse facets derived from what is actually in the Inbox, so every chip
  // leads to at least one bookmark and the bar stays empty for fresh installs.
  const { chips, hasUncollected, uncollectedCount } = useMemo(() => {
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
      uncollectedCount: uncollected,
    };
  }, [inbox, getTagsForBookmark, getCollection]);

  const facetFiltered = useMemo(
    () => filterByFacet(inbox, filter, tagIdsFor),
    [inbox, filter, tagIdsFor],
  );

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

  const filtered = useMemo(
    () =>
      filterBookmarks(facetFiltered, debouncedQuery, {
        tagNames: (b) => getTagsForBookmark(b.id).map((tag) => tag.name),
        collectionName: (b) => getCollection(b.collection_id)?.name,
      }),
    [facetFiltered, debouncedQuery, getTagsForBookmark, getCollection],
  );
  const visible = useMemo(() => sortBookmarks(filtered, sort), [filtered, sort]);
  // A query is only a search when it produces at least one real search token. A
  // query that is purely punctuation/symbols ("...", "-", "!!!") normalizes to
  // zero tokens, so `filterBookmarks` returns everything — treating that as a
  // search would mislabel the full library as "Matches (all)". Gate the searching
  // flag on real tokens so such a query falls back to the normal Inbox (recent/
  // facet section + the focus-empty suggestion shelf). `searchTerms`, the site
  // chip / matched-tag reason UI, the empty-search recovery, and the section
  // label all key off this one flag, so they stay consistent.
  const searching = queryHasSearchTokens(debouncedQuery);
  // Normalized terms of the settled query, used to surface WHY each result
  // matched (site-name chip, promoting a matched tag) when searching.
  const searchTerms = useMemo(
    () => (searching ? queryTerms(debouncedQuery) : []),
    [searching, debouncedQuery],
  );
  // Highlight the matched spans in result titles/URLs while searching. Empty
  // string when not searching, so `HighlightedText` renders a plain label.
  const highlightQuery = searching ? debouncedQuery : '';
  const highlightStyle = { backgroundColor: palette.highlight, color: palette.highlightText };
  // Suggestion shelf. A pure projection of already-loaded state — no fetch/sync
  // fires on focus or keystroke. Phase 2: thread the DEBOUNCED query so the shelf
  // re-filters on the same ~140ms cadence as the results list and the two update
  // in the same frame (never momentarily disagree). On an empty query the builder
  // yields the Phase-1 focus-empty shelf; on a non-empty query it yields the
  // query-filtered, best-match-first chips (or none when nothing matches).
  const suggestions = useSearchSuggestions(recentSearches, debouncedQuery);
  // Show the suggestion shelf whenever the field is focused and there is
  // something to suggest. Phase 2 (§13.2) drops the empty-query requirement: a
  // non-empty query that matches nothing yields zero suggestions, so this same
  // condition cleanly produces the typing-no-match "hide the shelf" state.
  const showSuggestions = searchFocused && suggestions.length > 0;
  // The browse shelf is suppressed for the WHOLE focused state (§13.2, widening
  // Phase-1 Q1): while focused at most one chip row may show — the suggestion
  // shelf — never the browse shelf. The browse shelf returns only on blur. This
  // also keeps it hidden in the typing-no-match case, where neither row shows.
  const showShelf = chips.length > 0 && !searchFocused;
  // On a brand-new (empty) library the search/sort/view controls are just cold
  // chrome over a "nothing here yet" screen — fold them away so the first run
  // is all about the first save. Keyed on the unfiltered library, not the
  // current view, so a search/filter that yields zero rows still keeps the
  // controls (the user needs them to clear the query or facet).
  const showControls = inbox.length > 0 || searching;

  // Record a submitted query into recents (trim + case-insensitive dedupe-to-
  // front + cap). The ONLY write path for recents — never on every keystroke.
  const recordRecent = useCallback((raw: string) => {
    setRecentSearches((current) => addRecent(current, raw));
  }, []);

  // Apply a tag/folder facet from a suggestion, mirroring the browse-shelf chip
  // path: set the facet so the matching bookmarks are immediately visible.
  const applySuggestionFacet = useCallback((target: InboxFilter) => {
    setFilter(target);
  }, []);

  // Tap a suggestion chip (§5): a recent FILLS the query and keeps the keyboard
  // up to edit; a tag/folder APPLIES the facet, clears the query, and blurs so
  // the shelf closes onto the filtered list.
  const onPickSuggestion = useCallback(
    (suggestion: SearchSuggestion) => {
      if (suggestion.kind === 'recent') {
        setQuery(suggestion.query ?? suggestion.label);
        return;
      }
      if (suggestion.filter) {
        applySuggestionFacet(
          suggestion.filter.kind === 'tag'
            ? { kind: 'tag', id: suggestion.filter.id }
            : { kind: 'collection', id: suggestion.filter.id },
        );
      }
      setQuery('');
      // A tag/folder is a destination: dismiss the shelf now. Hide synchronously
      // (don't wait for the deferred blur) and cancel any pending blur timer so
      // there's no second, late setState.
      clearBlurHide();
      setSearchFocused(false);
      searchRef.current?.blur();
    },
    [applySuggestionFacet, clearBlurHide],
  );

  // Long-press a recent chip to remove just that entry (Q2, locked).
  const onRemoveRecentSuggestion = useCallback((suggestion: SearchSuggestion) => {
    const target = suggestion.query ?? suggestion.label;
    setRecentSearches((current) => removeRecent(current, target));
  }, []);

  const activeChip = chips.find((chip) => sameFilter(chip.filter, filter));
  // Facet-scoped search placeholder (B4): a pure projection of the active facet,
  // not stored — so it reverts for free when the facet clears. `All` keeps the
  // generic placeholder; a folder/tag/uncollected facet labels the field with
  // the scope it's searching within. `activeChip.label` is already the
  // caller-decorated name (bare collection name, or `#tag`), so it feeds the
  // `{name}` template directly; uncollected has no chip, so use its own label.
  const searchPlaceholder = useMemo(() => {
    if (filter.kind === 'uncollected') {
      return t('inbox.searchPlaceholderScoped', {
        name: t('inbox.searchPlaceholderUncollected'),
      });
    }
    if (filter.kind !== 'all' && activeChip) {
      return t('inbox.searchPlaceholderScoped', { name: activeChip.label });
    }
    return t('inbox.searchPlaceholder');
  }, [filter.kind, activeChip, t]);
  const sectionLabel = searching
    ? t('inbox.sectionMatches', { count: visible.length })
    : filter.kind === 'uncollected'
      ? t('inbox.sectionNoCollection', { count: visible.length })
      : activeChip
        ? t('inbox.sectionFacet', { label: activeChip.label, count: visible.length })
        : t('inbox.sectionRecent');

  // Sticky active-filter bar (rendered inside the floating header). The list is
  // "narrowed" whenever a facet is applied or a real search is running; the bar
  // tells the user that and offers a one-tap way back out. Precedence peels the
  // most-recently-added layer first: a live search clears before the underlying
  // facet.
  const narrowed = filter.kind !== 'all' || searching;
  // The pinned active-filter bar shows under the same gates as before — only its
  // position changed (its own layer, no longer inside the collapsing header).
  const showFilterBar = showControls && narrowed && !searchFocused;
  // Both scroll containers reserve room for the floating header, plus the pinned
  // filter bar's measured height when it's showing. When the bar is absent this
  // collapses back to the header-only inset (no leftover gap).
  const filterBarReserve = showFilterBar ? filterBarHeight : 0;
  const listPaddingTop = headerHeight + filterBarReserve + 8;
  const scrollInsetTop = headerHeight + filterBarReserve;
  const scope = useMemo((): {
    text: string;
    icon: ComponentProps<typeof Ionicons>['name'];
    action: 'clear-search' | 'clear-facet';
    a11y: string;
  } | null => {
    if (searching) {
      return {
        text: t('inbox.scopeSearch', { query: debouncedQuery.trim() }),
        icon: 'search-outline',
        action: 'clear-search',
        a11y: t('inbox.scopeClearSearchA11y'),
      };
    }
    if (filter.kind === 'all') {
      return null;
    }
    const label =
      filter.kind === 'uncollected' ? t('inbox.filterNoCollection') : (activeChip?.label ?? '');
    return {
      text: t('inbox.scopeFiltered', { label }),
      icon: 'funnel-outline',
      action: 'clear-facet',
      a11y: t('inbox.scopeClearA11y'),
    };
  }, [searching, debouncedQuery, filter.kind, activeChip, t]);

  // Run the scope bar's trailing action: clear a live search first, otherwise
  // clear the facet back to All.
  const onScopeAction = useCallback(() => {
    if (searching) {
      setQuery('');
      return;
    }
    setFilter(ALL_FILTER);
  }, [searching]);

  // Android hardware back peels the active narrowing layer instead of quitting
  // the app — the same most-recently-added-layer-first model as the scope bar's
  // X (a live search clears before the underlying facet). Without this, landing
  // on the root Inbox already narrowed (e.g. after picking a tag in /browse/tags,
  // which dismisses that route and applies the facet here, or after a search)
  // made back exit straight to the home screen. Only an un-narrowed Inbox returns
  // false so the OS handles back normally; the handler is registered via
  // useFocusEffect, so it's inactive (and can't swallow back) whenever a child
  // route — settings, the add modal, a bookmark — is on top. Keyed on the raw
  // `query` (not the debounced `searching`) so text typed within the debounce
  // window is still clearable. iOS has no hardware back, so this is a no-op there.
  useFocusEffect(
    useCallback(() => {
      const onBack = () => {
        if (query.length > 0) {
          setQuery('');
          return true;
        }
        if (filter.kind !== 'all') {
          setFilter(ALL_FILTER);
          return true;
        }
        return false;
      };
      const subscription = BackHandler.addEventListener('hardwareBackPress', onBack);
      return () => subscription.remove();
    }, [query, filter.kind]),
  );

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
          accessibilityLabel: t('inbox.inboxNoCollectionA11y'),
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
          markBookmarkAccessed(item.id);
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
        // A trash is recoverable, but the recovery path (Settings → Trash) is
        // not obvious — so offer an immediate one-tap Undo right where it happened.
        showToast(t('toast.trashed'), {
          label: t('common.undo'),
          onPress: () => restoreBookmark(item.id),
        });
      },
    });
    return actions;
  }, [menuItem, menuMode, collections, assignCollection, trashBookmark, restoreBookmark, showToast, markBookmarkAccessed, closeMenu, t]);

  const menuTitle =
    menuMode === 'move'
      ? t('inbox.moveToCollectionTitle')
      : ((menuItem ? displayTitle(menuItem) : null) ?? t('common.untitled'));

  // Latest view/header context for the chip-tap diagnostic breadcrumb, held in a
  // ref so the tap handler can stay referentially stable. That stability is what
  // lets the memoized BrowseChips skip re-rendering on every facet change — the
  // whole point of the perf fix — while the breadcrumb still reports live
  // context. A plain render-time snapshot; it never re-renders.
  const chipTapCtx = useRef({ view: viewMode, header: 0 });
  chipTapCtx.current = {
    view: viewMode,
    header: Math.round(headerHeight),
  };
  const onSelectFilter = useCallback((target: InboxFilter) => {
    // Diagnostic trail for the "tag-cloud chips go dead after narrowing to a
    // folder on Android" report: if this breadcrumb is ABSENT when the user
    // says a chip tap did nothing, the touch never reached JS (a native
    // hit-test issue with the floating header), not our filter logic. Ids are
    // opaque UUIDs — no user content.
    const ctx = chipTapCtx.current;
    trackBreadcrumb('browse', 'chip tap', {
      target: 'id' in target ? `${target.kind}:${target.id}` : target.kind,
      view: ctx.view,
      header: ctx.header,
    });
    setFilter(target);
  }, []);

  // Open the dedicated tag-browse route, carrying the current facet as its scope
  // so the cloud/list there opens already scoped to what the user was browsing.
  // A live search isn't carried (the route has its own search field); the facet
  // is the durable scope.
  const openBrowseTags = useCallback(() => {
    const scopeParam =
      filter.kind === 'collection'
        ? `collection:${filter.id}`
        : filter.kind === 'uncollected'
          ? 'uncollected'
          : undefined;
    router.push(scopeParam ? `/browse/tags?scope=${scopeParam}` : '/browse/tags');
  }, [router, filter]);

  return (
    <View style={[styles.container, { backgroundColor: palette.background }]}>
      <Animated.View
        // The cluster is absolutely positioned so it floats over the list and
        // can translate out of view. It needs an opaque background so list rows
        // sliding underneath stay hidden while it is partly collapsed.
        // onLayout re-fires whenever the cluster's height changes, including the
        // suggestion-shelf↔browse-shelf swap on focus/blur (both shelves mount
        // inside this measured view), so headerHeight — and the list's keyed-off
        // paddingTop — re-flow to the new height and don't go stale.
        //
        // box-none: the elevation that keeps this overlay winning touches over
        // the cloud's full-screen ScrollView (overlayLayer, STASH-7) otherwise
        // captures EVERY touch inside the laid-out rect on Android — including
        // transparent regions and the dead zone left behind when the collapse
        // translateY moves the view but not its elevation hit-rect. box-none
        // makes the container itself transparent to touches while its real
        // children (chips, sort pill, cloud toggle, banner) stay tappable, so
        // taps in empty space fall through to the cloud/list (STASH-7/STASH-8).
        pointerEvents="box-none"
        onLayout={(event) => setHeaderHeight(event.nativeEvent.layout.height)}
        style={[
          styles.header,
          { backgroundColor: palette.background, transform: [{ translateY: headerTranslate }] },
        ]}
      >
        <View style={[styles.hero, { paddingTop: insets.top + 10 }]}>
          {/* Compact single-row hero: the brand wordmark with the saved-count
              sitting inline on its baseline, and a bare settings gear. The old
              stacked tagline + count lines and the "설정" caption were pure
              vertical chrome that pushed the first card down ~40% of the
              screen, so they're folded away here to reclaim that space. */}
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
              // Size with an EXPLICIT width+height (derived from the asset ratio),
              // not height+aspectRatio. In this flex row, height+aspectRatio let
              // Yoga fall back toward the PNG's huge intrinsic size and the
              // wordmark blew up to fill the screen on native (the column layout
              // this came from constrained it via alignSelf:'flex-start'). An
              // explicit box removes that ambiguity.
              style={[
                styles.heroWordmark,
                { width: Math.round(WORDMARK_HEIGHT * wordmark.ratio), height: WORDMARK_HEIGHT },
              ]}
            />
            <Text
              style={[styles.heroCountText, { color: palette.textSecondary }]}
              numberOfLines={1}
            >
              {t('inbox.savedCount', { count: inbox.length })}
            </Text>
          </View>
          {/* Single settings entry point. Account sign-in/management lives
              inside Settings (the account card), so the hero stays focused on
              bookmarks rather than carrying a second, redundant account button. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('inbox.settingsA11y')}
            hitSlop={8}
            onPress={() => router.push('/settings')}
          >
            <View style={[styles.avatar, { backgroundColor: palette.surface, borderColor: palette.border }]}>
              <Ionicons name="settings-sharp" size={20} color={palette.text} />
            </View>
          </Pressable>
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
        {pendingReviewCount > 0 ? (
          // The Review screen's standing entry point (it used to be a Settings
          // row). Persistent while anything is left to review; it escalates to
          // the accent "new AI suggestions" alert — with a ✕ that acknowledges
          // the fresh arrivals — only while `newSuggestionsCount` marks unseen
          // ones, then settles back to the calm "to review" entry. The ✕ never
          // hides the banner outright; it only downgrades the wording, so the
          // way back into Review is always one tap from the Inbox.
          <View
            testID="review-banner"
            style={[
              styles.suggestBanner,
              hasNewSuggestions
                ? { backgroundColor: palette.accentSoft }
                : {
                    backgroundColor: palette.card,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: palette.border,
                    paddingRight: 14,
                  },
            ]}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                hasNewSuggestions
                  ? t('inbox.newSuggestionsA11y', { count: newSuggestionsCount })
                  : t('inbox.reviewPendingA11y', { count: pendingReviewCount })
              }
              onPress={() => router.push('/review')}
              style={({ pressed }) => [styles.suggestBannerMain, { opacity: pressed ? 0.7 : 1 }]}
            >
              <Text
                style={[
                  styles.suggestBannerText,
                  { color: hasNewSuggestions ? palette.accent : palette.text },
                ]}
                numberOfLines={1}
              >
                {hasNewSuggestions
                  ? t('inbox.newSuggestions', { count: newSuggestionsCount })
                  : t('inbox.reviewPending', { count: pendingReviewCount })}
              </Text>
              <Text style={[styles.suggestBannerCta, { color: palette.accent }]}>
                {t('inbox.newSuggestionsReview')}
              </Text>
            </Pressable>
            {hasNewSuggestions ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('inbox.newSuggestionsDismiss')}
                hitSlop={8}
                onPress={() => clearUnseenSuggestions()}
                style={({ pressed }) => [styles.suggestBannerClose, { opacity: pressed ? 0.5 : 1 }]}
              >
                <Ionicons name="close" size={18} color={palette.accent} />
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {showControls ? (
          <View style={styles.searchWrap}>
            <TextInput
              ref={searchRef}
              style={[styles.searchInput, { backgroundColor: palette.card, color: palette.text }]}
              placeholder={searchPlaceholder}
              placeholderTextColor={palette.textSecondary}
              autoCapitalize="none"
              autoCorrect={false}
              value={query}
              onChangeText={setQuery}
              onFocus={() => {
                // A re-focus cancels any pending deferred hide from a prior blur.
                clearBlurHide();
                setSearchFocused(true);
              }}
              onBlur={() => {
                // Defer the hide so a suggestion chip's onPress (which fires after
                // the native blur) resolves against a still-mounted shelf. A real
                // dismissal still settles on the next tick.
                clearBlurHide();
                blurHideTimer.current = setTimeout(() => {
                  blurHideTimer.current = null;
                  setSearchFocused(false);
                }, 0);
              }}
              // Submit (keyboard "search"/return) is the only recents write path:
              // the debounced search already reflects the text, so we just record.
              returnKeyType="search"
              onSubmitEditing={(event) => recordRecent(event.nativeEvent.text)}
              clearButtonMode="while-editing"
            />
          </View>
        ) : null}
        {showSuggestions ? (
          <SearchSuggestionShelf
            suggestions={suggestions}
            onPick={onPickSuggestion}
            onRemoveRecent={onRemoveRecentSuggestion}
            query={debouncedQuery}
          />
        ) : null}
        {showControls && !showSuggestions ? (
        <View style={styles.sortRow}>
          {/* No "Browse" caption: the Sort pill, Tags pill, and view segment are
              self-evident controls, and the caption's width was forcing the
              view segment to wrap onto its own near-empty second row. Dropping
              it lets all three sit on one line, reclaiming that row. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('inbox.sortA11y', { label: t(SORT_LABEL_KEY[serializeSort(sort)]) })}
            onPress={() => setSortMenuOpen(true)}
            style={[styles.sortPill, styles.sortPillFlexible, { backgroundColor: palette.surface, borderColor: palette.border }]}
          >
            <Ionicons name={SORT_ICON[sort.field]} size={15} color={palette.textSecondary} />
            <Text style={[styles.sortPillLabel, { color: palette.text }]} numberOfLines={1}>
              {t(SORT_LABEL_KEY[serializeSort(sort)])}
            </Text>
            <Ionicons name="chevron-down" size={14} color={palette.textSecondary} />
          </Pressable>
          {inbox.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('inbox.browseTagsA11y')}
              testID="inbox-browse-tags-toggle"
              onPress={openBrowseTags}
              style={[
                styles.sortPill,
                { backgroundColor: palette.surface, borderColor: palette.border },
              ]}
            >
              <Ionicons name="pricetags-outline" size={15} color={palette.textSecondary} />
              <Text style={[styles.sortPillLabel, { color: palette.text }]}>
                {t('inbox.browseTags')}
              </Text>
            </Pressable>
          ) : null}
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
                  onPress={() => {
                    setViewMode(mode);
                    void setPreference(INBOX_VIEW_PREF_KEY, serializeViewMode(mode)).catch(() => {});
                  }}
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
        ) : null}
        {showShelf ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            testID="browse-shelf"
            style={styles.shelf}
            contentContainerStyle={styles.shelfContent}
          >
            <BrowseChip
              target={ALL_FILTER}
              label={t('inbox.filterAll')}
              active={sameFilter(ALL_FILTER, filter)}
              onSelect={onSelectFilter}
            />
            {hasUncollected ? (
              <BrowseChip
                target={UNCOLLECTED_FILTER}
                label={t('inbox.filterNoCollection')}
                icon="file-tray-outline"
                count={uncollectedCount}
                active={sameFilter(UNCOLLECTED_FILTER, filter)}
                onSelect={onSelectFilter}
              />
            ) : null}
            {chips.map((chip) => (
              <BrowseChip
                key={chip.key}
                target={chip.filter}
                label={chip.label}
                icon={chip.icon}
                count={chip.count}
                active={sameFilter(chip.filter, filter)}
                onSelect={onSelectFilter}
              />
            ))}
          </ScrollView>
        ) : null}
      </Animated.View>
      {showFilterBar && scope ? (
        // Pinned active-filter bar: its OWN non-translating layer between the
        // header (zIndex 10, which must stay above so it covers the bar when
        // revealed) and the list. It rides the header's diffClamp but clamps at
        // the safe-area top, so its clear/back action stays tappable while
        // scrolled to the bottom. Resting top = headerHeight; it slides up from
        // there. Opaque base so list rows can't bleed through the tint.
        <Animated.View
          testID="inbox-filter-bar"
          // box-none for the same reason as the header: its elevation
          // (overlayLayer, STASH-7) would otherwise capture touches across the
          // whole rect — and across the dead zone the collapse translateY
          // leaves behind on Android — eating taps meant for the list. The
          // opaque filterBarInner child still fills and owns the visible strip,
          // so the clear action stays tappable.
          pointerEvents="box-none"
          onLayout={(event) => setFilterBarHeight(event.nativeEvent.layout.height)}
          style={[
            styles.filterBar,
            {
              top: headerHeight,
              backgroundColor: palette.background,
              borderBottomColor: palette.border,
              transform: [{ translateY: filterBarTranslate }],
            },
          ]}
        >
          <View style={[styles.filterBarInner, { backgroundColor: palette.accentSoft }]}>
            <Ionicons name={scope.icon} size={16} color={palette.accentText} style={styles.filterBarIcon} />
            <Text style={[styles.filterBarText, { color: palette.accentText }]} numberOfLines={1}>
              {scope.text}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={scope.a11y}
              testID="inbox-filter-clear"
              hitSlop={8}
              onPress={onScopeAction}
              style={({ pressed }) => [
                styles.filterBarAction,
                { borderColor: palette.accent, opacity: pressed ? 0.6 : 1 },
              ]}
            >
              <Ionicons name="close" size={16} color={palette.accentText} />
            </Pressable>
          </View>
        </Animated.View>
      ) : null}
      <AnimatedFlatList
        data={visible}
        keyExtractor={(item) => item.id}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
          useNativeDriver: true,
        })}
        scrollEventThrottle={16}
        // Dragging the results dismisses the keyboard (→ keyboardDidHide drops the
        // focused state and the suggestion shelf). The shelf's own ScrollView owns
        // keyboardShouldPersistTaps for its chips; this list doesn't need it.
        keyboardDismissMode="on-drag"
        // Keep the scrollbar clear of the floating header (and the pinned filter
        // bar when it's showing).
        scrollIndicatorInsets={{ top: scrollInsetTop }}
        contentContainerStyle={[
          styles.list,
          viewMode !== 'card' ? styles.listModeList : null,
          // Start the list below the floating header (and the pinned filter bar
          // when active), and clear the Add button so it never covers the last row.
          { paddingTop: listPaddingTop, paddingBottom: insets.bottom + 96 },
        ]}
        ListHeaderComponent={
          // On a zero-result search the empty-search recovery card already
          // states "no matches"; suppress the "0 results" section label so the
          // two don't stack into a redundant double-negative.
          searching && visible.length === 0 ? null : (
            <Text style={[styles.sectionLabel, { color: palette.textSecondary }]}>
              {sectionLabel}
            </Text>
          )
        }
        ListEmptyComponent={
          isLoading ? (
            <Text style={[styles.empty, { color: palette.textSecondary }]}>{t('inbox.loading')}</Text>
          ) : searching ? (
            // A zero-result search is a recovery point, not a dead end: explain
            // the broadened scope (tags/folders/sites are searchable) and offer
            // a visible Clear control (Android's keyboard has no native one).
            <View testID="inbox-empty-search" style={styles.emptySearch}>
              <Text style={[styles.empty, styles.emptySearchTitle, { color: palette.textSecondary }]}>
                {t('inbox.emptySearch')}
              </Text>
              <Text style={[styles.emptySearchHint, { color: palette.textSecondary }]}>
                {t('inbox.emptySearchHint')}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('inbox.clearSearchA11y')}
                onPress={() => setQuery('')}
                style={({ pressed }) => [
                  styles.clearSearchButton,
                  { backgroundColor: palette.accentSoft, opacity: pressed ? 0.7 : 1 },
                ]}
              >
                <Ionicons name="close-circle-outline" size={16} color={palette.accent} />
                <Text style={[styles.clearSearchLabel, { color: palette.accent }]}>
                  {t('inbox.clearSearch')}
                </Text>
              </Pressable>
            </View>
          ) : filter.kind !== 'all' ? (
            // A facet/filter with zero rows: not the first-run case, so keep the
            // terse "nothing in this view" line rather than the onboarding card.
            <Text style={[styles.empty, { color: palette.textSecondary }]}>{t('inbox.emptyView')}</Text>
          ) : (
            // First run: teach the share-sheet capture (the app's whole point),
            // not just "add below" — otherwise Stash reads as a manual URL box.
            <View style={styles.emptyState} testID="inbox-empty-onboarding">
              <Ionicons
                name="bookmarks-outline"
                size={40}
                color={palette.textSecondary}
                style={styles.emptyGlyph}
              />
              <Text style={[styles.emptyTitle, { color: palette.text }]}>
                {t('inbox.emptyTitle')}
              </Text>
              <View style={styles.emptyHintRow}>
                <Ionicons
                  name="share-outline"
                  size={18}
                  color={palette.accent}
                  style={styles.emptyHintIcon}
                />
                <Text style={[styles.emptyHintText, { color: palette.textSecondary }]}>
                  {t('inbox.emptyHintShare')}
                </Text>
              </View>
              <View style={styles.emptyHintRow}>
                <Ionicons
                  name="add-circle-outline"
                  size={18}
                  color={palette.accent}
                  style={styles.emptyHintIcon}
                />
                <Text style={[styles.emptyHintText, { color: palette.textSecondary }]}>
                  {t('inbox.emptyHintAdd')}
                </Text>
              </View>
            </View>
          )
        }
        extraData={`${viewMode}|${searching}|${debouncedQuery}`}
        renderItem={({ item }) => {
          const status = statusLabel(item, t);
          const collectionName = getCollection(item.collection_id)?.name ?? null;
          const cardTags = getTagsForBookmark(item.id);
          // Pending AI suggestions = high-confidence suggested tags not yet
          // applied PLUS a pending folder recommendation (see
          // @/domain/ai-suggestions), surfaced so they're reviewable from the
          // list rather than buried in Detail. Counts the folder too so a
          // folder-only bookmark still shows the "✨" badge, matching the
          // banner/Settings/Review inclusion rule.
          const appliedNames = new Set(cardTags.map((tag) => tag.name.toLowerCase()));
          const cardEnrichment = getEnrichment(item.id);
          const suggestionCount =
            pendingSuggestions(cardEnrichment, appliedNames, getReviewedSuggestions(item.id))
              .length +
            (pendingSuggestedFolder(
              cardEnrichment,
              collections,
              item.collection_id,
              getDismissedFolderSuggestions(item.id),
            )
              ? 1
              : 0);
          const openDetail = () =>
            router.push({ pathname: '/bookmark/[id]', params: { id: item.id } });
          const openLink = () => {
            if (item.url) {
              markBookmarkAccessed(item.id);
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
                  <HighlightedText
                    testID="inbox-list-title"
                    style={[styles.listTitle, { color: palette.text }]}
                    numberOfLines={1}
                    text={displayTitle(item) ?? t('common.untitled')}
                    query={highlightQuery}
                    highlightStyle={highlightStyle}
                  />
                  {item.url ? (
                    <HighlightedText
                      style={[styles.listUrl, { color: palette.textSecondary }]}
                      numberOfLines={1}
                      text={item.url}
                      query={highlightQuery}
                      highlightStyle={highlightStyle}
                    />
                  ) : null}
                </View>
                {/* While the "new AI suggestions" banner is announcing, suppress
                    the per-card ✨ badge so the same item isn't shouted twice on
                    one screen; dismissing the banner brings the badges back. */}
                {suggestionCount > 0 && newSuggestionsCount === 0 ? (
                  <View
                    accessibilityLabel={t('inbox.aiSuggestionsA11y', { count: suggestionCount })}
                    style={[styles.suggestBadge, { backgroundColor: palette.accentSoft, borderColor: palette.accent }]}
                  >
                    <Text style={[styles.suggestBadgeLabel, { color: palette.accent }]}>
                      ✨ {suggestionCount}
                    </Text>
                  </View>
                ) : null}
                {/* Explicit overflow so the move/share/trash actions aren't
                    hidden behind a long-press only — the sole reach for a
                    note/image row that has no ↗ open button. */}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('inbox.moreActions')}
                  hitSlop={8}
                  style={styles.moreButton}
                  onPress={() => setMenuItem(item)}
                >
                  <Ionicons name="ellipsis-horizontal" size={18} color={palette.textSecondary} />
                </Pressable>
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

          // In search mode, make sure a tag that the query matched is among the
          // shown tags — otherwise a result matched via a 4th+ tag looks random.
          // Promote matching tags to the front, then take the first three.
          const orderedTags = searching
            ? [...cardTags].sort((a, b) => {
                const am = valueMatchesTerms(a.name, searchTerms) ? 0 : 1;
                const bm = valueMatchesTerms(b.name, searchTerms) ? 0 : 1;
                return am - bm;
              })
            : cardTags;
          const metaParts = [
            ...(collectionName ? [t('inbox.inCollection', { name: collectionName })] : []),
            ...orderedTags.slice(0, 3).map((tag) => `#${tag.name}`),
          ];
          // Surface the site name only when it's the reason this result matched
          // (generated site metadata, kept visually distinct from the user-
          // authored chips above so we never blur the two). When the match came
          // from the title or a tag, that's already explained — an unexplained
          // site chip would just be noise competing with the user's own fields.
          const showSiteChip = searching && valueMatchesTerms(item.site_name, searchTerms);

          // Compact sits between cards and the dense list: it keeps the card's
          // thumbnail (a real visual cue) but at list density — a small leading
          // image plus one collapsed meta line, so more bookmarks fit per screen
          // without losing "which one was this?" recognition. The preview image
          // is generated metadata, so it's purely a thumbnail; the title/URL/meta
          // beside it stay the user-vs-generated split the cards already draw.
          if (viewMode === 'compact') {
            const thumbUri = item.local_image_uri ?? item.preview_image_url ?? null;
            const compactMeta = metaParts.join('  ·  ');
            return (
              <Pressable
                style={({ pressed }) => [
                  styles.listRow,
                  styles.compactRow,
                  {
                    backgroundColor: palette.surfaceElevated,
                    borderColor: palette.border,
                    opacity: pressed ? 0.78 : 1,
                  },
                ]}
                onPress={openDetail}
                onLongPress={() => setMenuItem(item)}
              >
                {thumbUri ? (
                  <Image
                    testID="inbox-compact-thumb"
                    source={{ uri: thumbUri }}
                    style={[styles.compactThumb, { backgroundColor: palette.mutedSurface }]}
                  />
                ) : (
                  <ItemIcon item={item} testID="inbox-compact-monogram" />
                )}
                <View style={styles.listText}>
                  <HighlightedText
                    testID="inbox-compact-title"
                    style={[styles.listTitle, { color: palette.text }]}
                    numberOfLines={1}
                    text={displayTitle(item) ?? t('common.untitled')}
                    query={highlightQuery}
                    highlightStyle={highlightStyle}
                  />
                  {item.url ? (
                    <HighlightedText
                      style={[styles.listUrl, { color: palette.textSecondary }]}
                      numberOfLines={1}
                      text={item.url}
                      query={highlightQuery}
                      highlightStyle={highlightStyle}
                    />
                  ) : null}
                  {compactMeta ? (
                    <Text style={[styles.compactMeta, { color: palette.accentText }]} numberOfLines={1}>
                      {compactMeta}
                    </Text>
                  ) : null}
                </View>
                {suggestionCount > 0 && newSuggestionsCount === 0 ? (
                  <View
                    accessibilityLabel={t('inbox.aiSuggestionsA11y', { count: suggestionCount })}
                    style={[styles.suggestBadge, { backgroundColor: palette.accentSoft, borderColor: palette.accent }]}
                  >
                    <Text style={[styles.suggestBadgeLabel, { color: palette.accent }]}>
                      ✨ {suggestionCount}
                    </Text>
                  </View>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('inbox.moreActions')}
                  hitSlop={8}
                  style={styles.moreButton}
                  onPress={() => setMenuItem(item)}
                >
                  <Ionicons name="ellipsis-horizontal" size={18} color={palette.textSecondary} />
                </Pressable>
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
                  <HighlightedText
                    testID="inbox-card-title"
                    style={[styles.cardTitle, { color: palette.text }]}
                    numberOfLines={1}
                    text={displayTitle(item) ?? t('common.untitled')}
                    query={highlightQuery}
                    highlightStyle={highlightStyle}
                  />
                  {suggestionCount > 0 && newSuggestionsCount === 0 ? (
                    <View
                      accessibilityLabel={t('inbox.aiSuggestionsA11y', { count: suggestionCount })}
                      style={[styles.suggestBadge, { backgroundColor: palette.accentSoft, borderColor: palette.accent }]}
                    >
                      <Text style={[styles.suggestBadgeLabel, { color: palette.accent }]}>
                        ✨ {suggestionCount}
                      </Text>
                    </View>
                  ) : null}
                  {/* Always-present overflow: the discoverable way into
                      move/share/trash, not a long-press a user must guess. */}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('inbox.moreActions')}
                    hitSlop={8}
                    style={[styles.moreButton, styles.cardMoreButton]}
                    onPress={() => setMenuItem(item)}
                  >
                    <Ionicons name="ellipsis-horizontal" size={18} color={palette.textSecondary} />
                  </Pressable>
                </View>
                {item.url ? (
                  <HighlightedText
                    style={[styles.cardUrl, { color: palette.textSecondary }]}
                    numberOfLines={1}
                    text={item.url}
                    query={highlightQuery}
                    highlightStyle={highlightStyle}
                  />
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
                {showSiteChip ? (
                  // Generated site metadata — styled as a neutral, outlined site
                  // chip (not the filled accent meta chips) so it never reads as
                  // a user-typed value.
                  <View style={styles.siteChipRow}>
                    <View
                      testID="inbox-card-site"
                      style={[styles.siteChip, { borderColor: palette.border, backgroundColor: palette.surface }]}
                    >
                      <Text
                        style={[styles.siteChipLabel, { color: palette.textSecondary }]}
                        numberOfLines={1}
                      >
                        {t('inbox.siteChip', { name: item.site_name! })}
                      </Text>
                    </View>
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
      <ActionSheet
        visible={sortMenuOpen}
        title={t('inbox.sortMenuTitle')}
        actions={SORT_PRESETS.map((option) => ({
          key: serializeSort(option),
          label: t(SORT_LABEL_KEY[serializeSort(option)]),
          icon: SORT_ICON[option.field],
          selected: sameSort(option, sort),
          onPress: () => {
            setSort(option);
            setSortMenuOpen(false);
          },
        }))}
        onClose={() => setSortMenuOpen(false)}
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
    // Float above the list for paint AND touch — see overlayLayer (STASH-7).
    ...overlayLayer(10),
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
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 8,
  },
  heroTitleBlock: {
    flex: 1,
    // Wordmark and saved-count share one row, bottoms aligned so the count
    // reads as sitting on the wordmark's baseline.
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
  },
  heroWordmark: {
    // Concrete width+height are set inline from WORDMARK_HEIGHT × the asset
    // ratio (see the Image above). flexShrink:0 so the row never squeezes it.
    flexShrink: 0,
  },
  heroCountText: {
    fontSize: 13,
    fontWeight: '600',
    // Nudge off the very bottom so it lines up with the wordmark's baseline
    // rather than its descender edge.
    marginBottom: 2,
    flexShrink: 1,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
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
  emptySearch: {
    alignItems: 'center',
    paddingVertical: 32,
    gap: 12,
  },
  emptySearchTitle: {
    paddingVertical: 0,
  },
  emptySearchHint: {
    fontSize: 13,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  clearSearchButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    paddingVertical: 9,
    paddingHorizontal: 16,
    marginTop: 4,
  },
  clearSearchLabel: {
    fontSize: 14,
    fontWeight: '700',
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 40,
    paddingHorizontal: 24,
  },
  emptyGlyph: {
    marginBottom: 16,
    opacity: 0.7,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 20,
  },
  emptyHintRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    alignSelf: 'stretch',
    maxWidth: 320,
    marginBottom: 12,
  },
  emptyHintIcon: {
    marginRight: 10,
    marginTop: 1,
  },
  emptyHintText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
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
  filterBar: {
    // Pinned, edge-to-edge toolbar strip in its own layer. Between the header
    // (zIndex 10) and the list (default 0) so the header covers it when revealed
    // and it covers the rows. An opaque background plus a hairline bottom border
    // make it read as an intentional toolbar, not a floating pill.
    position: 'absolute',
    left: 0,
    right: 0,
    // Between the header (10) and the list (0), winning touches over the list so
    // its clear action stays tappable while scrolling — see overlayLayer
    // (STASH-7).
    ...overlayLayer(5),
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  filterBarInner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 16,
    paddingRight: 8,
    paddingVertical: 8,
  },
  filterBarIcon: {
    marginRight: 8,
  },
  filterBarText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
  },
  filterBarAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 10,
  },
  searchWrap: {
    paddingHorizontal: 16,
    paddingTop: 10,
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
    // Wrap on overflow so the rightmost control (the view segment) is never
    // clipped off-screen: with three view modes the caption + Sort pill + Tags
    // pill + segment can exceed a narrow 320–360dp width (worse with Korean
    // labels / large text), more than the Sort label's truncation can absorb.
    // `gap` doubles as the row gap when a control wraps to a second line; wide
    // phones still render everything on one line.
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  sortPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingVertical: 7,
    paddingHorizontal: 13,
  },
  sortPillFlexible: {
    // The Sort pill carries the only long label in the controls row; let it
    // shrink and truncate (numberOfLines={1}) so adding the Tags toggle can't
    // shove the view segment off the right edge on a narrow device.
    flexShrink: 1,
    minWidth: 0,
  },
  sortPillLabel: {
    fontSize: 14,
    fontWeight: '600',
    flexShrink: 1,
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
    marginTop: 6,
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
  // Compact rows are a touch taller than list rows to give the thumbnail and the
  // extra meta line room without crowding — still roughly half a card's height.
  compactRow: {
    alignItems: 'center',
    paddingVertical: 10,
  },
  compactThumb: {
    width: 52,
    height: 52,
    borderRadius: 12,
  },
  compactMeta: {
    fontSize: 12,
    fontWeight: '600',
    marginTop: 1,
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
  moreButton: {
    width: 32,
    height: 32,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardMoreButton: {
    marginLeft: 'auto',
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
  siteChipRow: {
    flexDirection: 'row',
    paddingRight: 72,
  },
  siteChip: {
    flexShrink: 1,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 3,
    paddingHorizontal: 9,
  },
  siteChipLabel: {
    fontSize: 12,
    fontWeight: '600',
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
