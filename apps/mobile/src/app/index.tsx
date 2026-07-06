import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, usePathname, useRouter } from 'expo-router';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  BackHandler,
  FlatList,
  Image,
  Keyboard,
  LayoutAnimation,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  useWindowDimensions,
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
import { accessibilityTitle, displayTitle } from '@/domain/item-display';
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
import { useSupabaseAuth } from '@/supabase/auth-provider';
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

// Pre-rendered brand wordmark: the Keepory duckling lockup (mascot + "Keepory")
// baked into PNGs, each with a light/dark variant (navy text on light, near-white
// on dark; the duckling is unchanged). The Korean locale reuses the same lockup —
// the brand name is "Keepory" in every locale. `ratio` is the asset's intrinsic
// width/height so the Image can be sized by height alone.
const WORDMARK = {
  en: {
    ratio: 4.27,
    light: require('../../assets/images/wordmark-en-light.png'),
    dark: require('../../assets/images/wordmark-en-dark.png'),
  },
  local: {
    ratio: 4.27,
    light: require('../../assets/images/wordmark-ko-light.png'),
    dark: require('../../assets/images/wordmark-ko-dark.png'),
  },
};

// Rendered height of the hero wordmark in dp; its width is this × the asset
// ratio. Kept as a constant so the Image's explicit width and height stay in
// lockstep (see heroWordmark / the hero Image).
const WORDMARK_HEIGHT = 28;

// On wide (desktop-web) viewports, cap the content column and center it so
// cards, the header, and the browse shelf don't stretch edge-to-edge. No effect
// on phones (their width is already below this), so it reads as a web-only
// improvement while staying a single cross-platform rule.
const CONTENT_MAX_WIDTH = 720;

// The wide-screen Settings sheet docks on the right at this width (mirrors
// `sheetPanel.maxWidth` in settings.tsx) over a threshold shared with its
// `asSheet` rule. When it's open we slide the whole Inbox left by half this
// width so the content re-centers in the visible region (window − panel)
// instead of hiding its right column behind the panel — a translate, not a
// re-layout, so the card grid keeps its column count and sizes.
const SETTINGS_PANEL_WIDTH = 460;
const SETTINGS_SHEET_MIN_WIDTH = 760;

// A filler cell used to pad the last row of the multi-column card grid so the
// real cards on that row keep their column width. Never rendered as a card — the
// renderItem short-circuits it to an empty flex spacer.
type GridPlaceholder = { id: string; __placeholder: true };

/**
 * Web-only positioning shell for the browse shelf. On native it renders NOTHING
 * of its own — just its children — so the iOS/Android tree is byte-for-byte
 * unchanged. On web it wraps the clipped ScrollView in a relatively-positioned
 * box matching the shelf's centered content column, so the edge fades/buttons
 * pin to the real clipped edges (the 720px box) rather than the window edges.
 */
function ShelfContainer({
  web,
  maxWidth,
  children,
}: {
  web: boolean;
  maxWidth: number;
  children: ReactNode;
}) {
  if (!web) return <>{children}</>;
  return <View style={[styles.shelfWrap, { maxWidth }]}>{children}</View>;
}

// Stops for the edge fade. expo-linear-gradient is NOT a dependency, so instead
// of a true gradient the fade is a few absolutely-positioned strips whose
// palette.background opacity ramps from transparent to opaque toward the clipped
// edge — enough of a scrim to seat the chevron button and hint at overflow.
const SHELF_FADE_STOPS = [0, 0.15, 0.35, 0.6, 0.82, 1];

/**
 * Web-only edge affordance: a fade scrim plus a round chevron button (styled
 * like the sort pill) that scrolls the shelf toward `side`. Rendered only when
 * the shelf can actually scroll that way, so the small-library case stays clean.
 */
function ShelfEdge({
  side,
  label,
  onPress,
}: {
  side: 'left' | 'right';
  label: string;
  onPress: () => void;
}) {
  const palette = usePalette();
  // Right edge: opaque at the right, fading left. Left edge is the mirror.
  const stops = side === 'right' ? SHELF_FADE_STOPS : [...SHELF_FADE_STOPS].reverse();
  return (
    // box-none so chips under the scrim stay tappable; only the button captures.
    <View
      pointerEvents="box-none"
      style={[styles.shelfEdge, side === 'right' ? styles.shelfEdgeRight : styles.shelfEdgeLeft]}
    >
      <View pointerEvents="none" style={styles.shelfFade}>
        {stops.map((opacity, index) => (
          <View key={index} style={{ flex: 1, backgroundColor: palette.background, opacity }} />
        ))}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        style={[styles.shelfNavButton, { backgroundColor: palette.surface, borderColor: palette.border }]}
      >
        <Ionicons
          name={side === 'right' ? 'chevron-forward' : 'chevron-back'}
          size={16}
          color={palette.textSecondary}
        />
      </Pressable>
    </View>
  );
}

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
  const auth = useSupabaseAuth();
  // Pick the wordmark variant that matches the active light/dark theme. If a
  // locale ever ships a native form (app.nameLocal differs from app.name) the
  // bilingual lockup is used; today every locale shares the "Keepory" lockup.
  // The a11y label mirrors what sighted users see (e.g. "Keepory").
  const scheme = useColorScheme();
  const hasLocalName = t('app.nameLocal') !== t('app.name');
  const wmSet = hasLocalName ? WORDMARK.local : WORDMARK.en;
  const wordmark = { source: scheme === 'dark' ? wmSet.dark : wmSet.light, ratio: wmSet.ratio };
  const wordmarkLabel = hasLocalName ? `${t('app.name')} ${t('app.nameLocal')}` : t('app.name');
  // The wordmark is a pre-rendered PNG. If it ever fails to load — a browser that
  // blocks the asset, or a request dropped across the OAuth redirect (seen in a
  // Brave private window after sign-in) — fall back to plain text so the
  // top-left brand mark is never blank.
  const [wordmarkFailed, setWordmarkFailed] = useState(false);
  const {
    inbox,
    isLoading,
    isSyncing,
    loadError,
    getTagsForBookmark,
    getCollection,
    getEnrichment,
    getReviewedSuggestions,
    getDismissedFolderSuggestions,
    unseenSuggestionIds,
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
  // Latest query for listeners that must not re-subscribe on each keystroke
  // (keyboardDidHide below reads this to decide whether an empty search folds
  // away without re-registering the listener every keystroke).
  const queryRef = useRef(query);
  queryRef.current = query;
  // Telegram-style tap-to-open: the search field is NOT persistently shown — it
  // mounts only when the user taps the hero magnifier, so the resting top stays
  // thin. A live query (`searching`) can only become true WHILE this is open
  // (query is settable only via the mounted field or a suggestion tap), so
  // searchOpen is the single source of truth for "the search UI is up".
  const [searchOpen, setSearchOpen] = useState(false);
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
  const openSearch = useCallback(() => {
    // The focus-on-open effect below moves focus into the field once it mounts.
    setSearchOpen(true);
  }, []);
  // Fold the whole search UI away: blur, drop focus, and CLEAR the query
  // (Telegram-faithful — opening search always starts fresh). Every close path
  // funnels through here so the invariant "query is non-empty ⇒ search is open"
  // holds and there's never an orphaned live search behind a hidden field.
  const closeSearch = useCallback(() => {
    clearBlurHide();
    setSearchFocused(false);
    searchRef.current?.blur();
    setQuery('');
    setSearchOpen(false);
  }, [clearBlurHide]);
  // Move focus into the field once it has actually mounted (it only mounts while
  // searchOpen), raising the keyboard + carrying screen-reader focus — the same
  // thing `autoFocus` does, but driven by our open state. Runs after the mount
  // commit (the effect fires once the field is in the tree), so the ref is set.
  useEffect(() => {
    if (searchOpen) {
      searchRef.current?.focus();
    }
  }, [searchOpen]);
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
        // Keyboard dismissed with nothing typed (Back button / interactive
        // swipe never fire onBlur) → fold the search UI away to keep the top
        // thin. A live query keeps the field up (the "results, keyboard down"
        // state); a recent-suggestion tap leaves a query so it won't close.
        if (queryRef.current.length === 0) {
          setSearchOpen(false);
        }
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

  // Responsive multi-column card grid on wide (desktop-web) viewports. Only the
  // card layout flows into 2–3 columns; compact/list stay single-column. On
  // phones the width is below one column's worth (~380dp), so columns collapses
  // to 1 and the content cap falls back to the fixed 720px column — the current
  // phone behavior is preserved exactly with no Platform.OS branch.
  const { width: winWidth } = useWindowDimensions();
  const columns = viewMode === 'card' ? Math.min(3, Math.max(1, Math.floor(winWidth / 380))) : 1;
  const contentMaxWidth = columns > 1 ? columns * 372 : CONTENT_MAX_WIDTH;
  // The suggest/session banners are cards carrying a 16px horizontal margin
  // (styles.suggestBanner), so capping them with `width: '100%'` would lay out
  // as full width PLUS 32px of margin and overflow the row on phones. Give them
  // an explicit width that already subtracts that gutter, then cap to the shared
  // content column so they align with the other centered header rows.
  const bannerWidth = Math.min(winWidth - 32, contentMaxWidth);

  // Slide the Inbox aside for the wide-screen Settings sheet. Settings is a
  // separate route presented as a transparent modal on top, so the Inbox stays
  // mounted underneath; `usePathname` re-renders it when that route comes and
  // goes. When the sheet is docked (wide viewport only), translate the whole
  // screen left by half the panel width so the content re-centers in the
  // visible region rather than tucking its right column behind the panel. The
  // shift is animated so it reads as the content making room, not a jump.
  const pathname = usePathname();
  const settingsOpen = pathname === '/settings' && winWidth >= SETTINGS_SHEET_MIN_WIDTH;
  const settingsShift = useRef(new Animated.Value(0)).current;
  // A permanent `transform` on the root promotes the whole screen to its own
  // GPU layer on web, and Chrome then drops subpixel text antialiasing for
  // everything underneath — every label and thumbnail renders softer/blurrier.
  // The slide is a no-op almost all the time (the sheet only docks on wide
  // viewports), so keep the transform out of the tree entirely unless the sheet
  // is open or still animating shut; idle Inbox stays crisp.
  const [sliding, setSliding] = useState(false);
  useEffect(() => {
    if (settingsOpen) {
      setSliding(true);
    }
    Animated.timing(settingsShift, {
      toValue: settingsOpen ? -SETTINGS_PANEL_WIDTH / 2 : 0,
      duration: 200,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished && !settingsOpen) {
        setSliding(false);
      }
    });
  }, [settingsOpen, settingsShift]);

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
  // In a multi-column card grid, pad the final row up to a full multiple of
  // `columns` with lightweight placeholders so the last row's real cards keep
  // their column width (flex: 1) instead of stretching across the leftover
  // space. Single-column (phones, compact/list) passes `visible` through
  // untouched, so those paths are byte-for-byte unchanged.
  const gridData = useMemo<(Bookmark | GridPlaceholder)[]>(() => {
    if (columns <= 1 || visible.length === 0) {
      return visible;
    }
    const remainder = visible.length % columns;
    if (remainder === 0) {
      return visible;
    }
    const placeholders: GridPlaceholder[] = Array.from(
      { length: columns - remainder },
      (_, i) => ({ id: `__ph-${i}`, __placeholder: true }),
    );
    return [...visible, ...placeholders];
  }, [visible, columns]);
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
  // "Search results, keyboard down" — a settled search with the field blurred.
  // In this state the header slims: the sort-controls row and the browse shelf
  // fold away so the blue results ribbon (pinned at `top: headerHeight`) rises to
  // sit right under the search input, instead of being split off by two rows the
  // user isn't browsing with mid-search. Keyed on the DEBOUNCED `searching` (not
  // the raw query) so the header reflows once per search enter/exit, never on
  // each keystroke; and on `!searchFocused` so the focused suggestion-shelf
  // behavior is untouched — this only reshapes the blurred results screen.
  const slimSearchHeader = searching && !searchFocused;
  // Smooth the one reflow at the moment that state toggles (search enter/exit,
  // including blur→confirm). configureNext animates only the NEXT commit's layout
  // changes, so gating it on the slim flag flipping keeps it a single easing —
  // it never fires per keystroke — and it stays off the header's native-driver
  // translateY, so the two don't fight. Native only (no-op/irrelevant on web).
  const prevSlimSearchHeader = useRef(slimSearchHeader);
  if (prevSlimSearchHeader.current !== slimSearchHeader) {
    prevSlimSearchHeader.current = slimSearchHeader;
    if (Platform.OS !== 'web') {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    }
  }
  // Same one-shot easing for the tap-to-open reflow: opening swaps the sort row
  // + shelf for the field (the header's height changes), so animate that single
  // commit instead of letting the top jump. Off the native-driver translateY, so
  // they don't fight. Native only.
  const prevSearchOpen = useRef(searchOpen);
  if (prevSearchOpen.current !== searchOpen) {
    prevSearchOpen.current = searchOpen;
    if (Platform.OS !== 'web') {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    }
  }
  // The browse shelf is suppressed for the WHOLE focused state (§13.2, widening
  // Phase-1 Q1): while focused at most one chip row may show — the suggestion
  // shelf — never the browse shelf. The browse shelf returns only on blur. It's
  // also folded away in the slimmed search-results state (above). This also keeps
  // it hidden in the typing-no-match case, where neither row shows.
  // The shelf shows when there's anything to put on it — facet chips OR the
  // review chip (which now lives here instead of a banner). Without the
  // pendingReviewCount term a brand-new user with suggestions but no folders
  // yet would have an empty facet set and lose the Review entry point entirely.
  const showShelf =
    (chips.length > 0 || pendingReviewCount > 0) &&
    !searchFocused &&
    !slimSearchHeader &&
    !searchOpen;
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
      // A tag/folder is a destination: fold the whole search UI away onto the
      // filtered list (Telegram closes search on picking a result). closeSearch
      // clears the query, blurs, and drops searchOpen in one funnel.
      closeSearch();
    },
    [applySuggestionFacet, closeSearch],
  );

  // Long-press a recent chip to remove just that entry (Q2, locked).
  const onRemoveRecentSuggestion = useCallback((suggestion: SearchSuggestion) => {
    const target = suggestion.query ?? suggestion.label;
    setRecentSearches((current) => removeRecent(current, target));
  }, []);

  // --- Web-only browse-shelf overflow affordance ---------------------------
  // On desktop web the horizontal shelf renders as a clipped `div`; the mouse
  // wheel scrolls the page, not the row, so chips past the right edge are
  // unreachable with no visible signal. These pieces (all Platform.OS === 'web')
  // translate vertical wheel to horizontal scroll and surface edge fades +
  // chevron buttons. Native is untouched — the wrapper, listeners, and scroll
  // handlers below only mount on web.
  const isWeb = Platform.OS === 'web';
  const shelfRef = useRef<ScrollView>(null);
  const [canShelfLeft, setCanShelfLeft] = useState(false);
  const [canShelfRight, setCanShelfRight] = useState(false);
  // `getScrollableNode()` returns the underlying DOM `div` on web.
  const shelfNode = useCallback(
    () => (isWeb ? (shelfRef.current?.getScrollableNode() as HTMLElement | null) : null),
    [isWeb],
  );
  const updateShelfEdges = useCallback(() => {
    const node = shelfNode();
    if (!node) return;
    setCanShelfLeft(node.scrollLeft > 0);
    setCanShelfRight(node.scrollLeft + node.clientWidth < node.scrollWidth - 1);
  }, [shelfNode]);
  const scrollShelfBy = useCallback(
    (direction: 1 | -1) => {
      const node = shelfNode();
      if (!node) return;
      shelfRef.current?.scrollTo({
        x: node.scrollLeft + direction * node.clientWidth * 0.8,
        animated: true,
      });
    },
    [shelfNode],
  );
  // Translate vertical wheel to horizontal scroll on the shelf itself. Needs a
  // native DOM listener with { passive: false } so preventDefault can stop the
  // page from scrolling instead.
  useEffect(() => {
    if (!isWeb || !showShelf) return;
    const node = shelfNode();
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const before = node.scrollLeft;
      node.scrollLeft += event.deltaY;
      // Only swallow the page's vertical scroll when the shelf actually moved.
      // scrollLeft clamps itself, so a short row (no overflow) or one already at
      // its edge stays put — and we must let the wheel fall through to the page
      // instead of trapping it under the shelf's hover area.
      if (node.scrollLeft !== before) event.preventDefault();
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [isWeb, showShelf, shelfNode]);
  // Recompute the edge flags on mount and whenever the clipped geometry can
  // change: viewport width (useWindowDimensions) and chip count. onScroll and
  // onLayout below cover the interactive/measure cases.
  useEffect(() => {
    if (!isWeb || !showShelf) return;
    updateShelfEdges();
  }, [isWeb, showShelf, winWidth, chips.length, updateShelfEdges]);

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
  const listPaddingTop = headerHeight + filterBarReserve + 4;
  const scrollInsetTop = headerHeight + filterBarReserve;
  const scope = useMemo((): {
    text: string;
    icon: ComponentProps<typeof Ionicons>['name'];
    action: 'clear-search' | 'clear-facet';
    a11y: string;
  } | null => {
    if (searching) {
      // Search runs inside the active facet, so the banner names the scope it's
      // searching within (Inbox/no-collection, a folder, or a #tag). `All` has
      // no scope to name and keeps the bare "Results for …" form.
      const scopeName =
        filter.kind === 'all'
          ? null
          : filter.kind === 'uncollected'
            ? t('inbox.filterNoCollection')
            : (activeChip?.label ?? null);
      return {
        text: scopeName
          ? t('inbox.scopeSearchIn', { query: debouncedQuery.trim(), scope: scopeName })
          : t('inbox.scopeSearch', { query: debouncedQuery.trim() }),
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

  // Run the scope bar's trailing action: close a live search first (folds the
  // tap-to-open field away and clears the query, leaving any underlying facet in
  // place), otherwise clear the facet back to All.
  const onScopeAction = useCallback(() => {
    if (searching) {
      closeSearch();
      return;
    }
    setFilter(ALL_FILTER);
  }, [searching, closeSearch]);

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
  // window is still clearable. Android-only: hardware back doesn't exist on iOS,
  // and react-native-web's BackHandler is an unsupported stub that console.errors
  // on subscribe — which `installConsoleCapture`/Sentry would log as a false error
  // on every Inbox focus/keystroke — so we never subscribe off Android.
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'android') {
        return;
      }
      const onBack = () => {
        // Peel the search UI first (closeSearch also clears any live query), then
        // the facet — same most-recently-added-layer-first model as before, with
        // searchOpen now standing in for the old raw-query check.
        if (searchOpen) {
          closeSearch();
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
    }, [searchOpen, filter.kind, closeSearch]),
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
    <Animated.View
      style={[
        styles.container,
        { backgroundColor: palette.background },
        sliding ? { transform: [{ translateX: settingsShift }] } : null,
      ]}
    >
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
        <View style={[styles.hero, { maxWidth: contentMaxWidth, paddingTop: insets.top + 6 }]}>
          {/* Compact single-row hero: the brand wordmark with the saved-count
              sitting inline on its baseline, and a bare settings gear. The old
              stacked tagline + count lines and the "설정" caption were pure
              vertical chrome that pushed the first card down ~40% of the
              screen, so they're folded away here to reclaim that space. */}
          <View style={styles.heroTitleBlock}>
            {/* The brand wordmark is a pre-rendered image (the Keepory duckling
                lockup) rather than bundled fonts — a few KB of PNG instead of
                multi-MB font files. Every locale uses the same lockup; a
                light/dark variant matches the theme. */}
            {wordmarkFailed ? (
              <Text
                accessibilityRole="header"
                accessibilityLabel={wordmarkLabel}
                style={[styles.heroWordmarkFallback, { color: palette.text }]}
                numberOfLines={1}
              >
                {t('app.name')}
              </Text>
            ) : (
              <Image
                accessibilityRole="header"
                accessibilityLabel={wordmarkLabel}
                source={wordmark.source}
                resizeMode="contain"
                // If the asset can't be loaded, show the text wordmark instead of
                // a blank space (see wordmarkFailed above).
                onError={() => setWordmarkFailed(true)}
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
            )}
            <Text
              style={[styles.heroCountText, { color: palette.textSecondary }]}
              numberOfLines={1}
            >
              {t('inbox.savedCount', { count: inbox.length })}
            </Text>
          </View>
          {/* Right-side hero actions: a tap-to-open search magnifier (morphs to
              ✕ while open — the search field mounts below only when this is
              tapped, keeping the resting top thin, à la Telegram) and the single
              settings entry point. Account sign-in/management lives inside
              Settings, so the hero stays focused on bookmarks. */}
          <View style={styles.heroActions}>
            {inbox.length > 0 ? (
              <Pressable
                testID="inbox-search-open"
                accessibilityRole="button"
                accessibilityLabel={searchOpen ? t('inbox.searchCloseA11y') : t('inbox.searchOpenA11y')}
                accessibilityState={{ expanded: searchOpen }}
                hitSlop={8}
                onPress={() => (searchOpen ? closeSearch() : openSearch())}
              >
                <View style={[styles.avatar, { backgroundColor: palette.surface, borderColor: palette.border }]}>
                  <Ionicons name={searchOpen ? 'close' : 'search'} size={20} color={palette.text} />
                </View>
              </Pressable>
            ) : null}
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
        </View>
        {loadError ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('inbox.reportStorageProblem')}
            onPress={() => router.push('/report')}
            style={({ pressed }) => [
              styles.errorBanner,
              { alignSelf: 'center', width: '100%', maxWidth: contentMaxWidth },
              { backgroundColor: palette.card, opacity: pressed ? 0.7 : 1 },
            ]}
          >
            <Text style={{ color: '#d93636', fontSize: 13, textAlign: 'center' }}>
              {t('inbox.storageError')}
            </Text>
          </Pressable>
        ) : null}
        {auth.status === 'session_expired' ? (
          // A signed-in account's session expired on launch. The local bookmarks
          // are preserved (not dropped), but cloud sync is paused until the user
          // signs back in. Route to Settings, where the sign-in buttons live.
          <Pressable
            testID="session-expired-banner"
            accessibilityRole="button"
            accessibilityLabel={t('inbox.sessionExpiredA11y')}
            onPress={() => router.push('/settings')}
            style={({ pressed }) => [
              styles.suggestBanner,
              { alignSelf: 'center', width: bannerWidth },
              {
                backgroundColor: palette.card,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: palette.border,
                paddingRight: 14,
                opacity: pressed ? 0.7 : 1,
              },
            ]}
          >
            <View style={styles.suggestBannerMain}>
              <Text style={[styles.suggestBannerText, { color: palette.text }]} numberOfLines={1}>
                {t('inbox.sessionExpired')}
              </Text>
              <Text style={[styles.suggestBannerCta, { color: palette.accent }]}>
                {t('inbox.sessionExpiredCta')}
              </Text>
            </View>
          </Pressable>
        ) : null}
        {searchOpen ? (
          <View style={[styles.searchWrap, { maxWidth: contentMaxWidth }]}>
            <TextInput
              ref={searchRef}
              testID="inbox-search-input"
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
                  // Blurred with nothing typed → fold the search UI away (keep
                  // the top thin). A live query keeps the field up so the user
                  // can read results / refine with the keyboard down (the
                  // existing slimSearchHeader "results, keyboard down" state).
                  if (query.length === 0) {
                    setSearchOpen(false);
                  }
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
        {showControls && !showSuggestions && !slimSearchHeader && !searchOpen ? (
        <View style={[styles.sortRow, { maxWidth: contentMaxWidth }]}>
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
            </Pressable>
          ) : null}
          {inbox.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('graph.openA11y')}
              testID="inbox-graph-open"
              onPress={() => router.push('/graph')}
              style={[
                styles.sortPill,
                { backgroundColor: palette.surface, borderColor: palette.border },
              ]}
            >
              <Ionicons name="git-network-outline" size={15} color={palette.textSecondary} />
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
          <ShelfContainer web={isWeb} maxWidth={contentMaxWidth}>
            <ScrollView
              ref={shelfRef}
              horizontal
              showsHorizontalScrollIndicator={false}
              testID="browse-shelf"
              style={[styles.shelf, { maxWidth: contentMaxWidth }]}
              contentContainerStyle={styles.shelfContent}
              // Web-only: track the clipped geometry so the edge affordances
              // appear/disappear as the user scrolls or the row is measured.
              onScroll={isWeb ? updateShelfEdges : undefined}
              onLayout={isWeb ? updateShelfEdges : undefined}
              scrollEventThrottle={isWeb ? 16 : undefined}
            >
              {pendingReviewCount > 0 ? (
                // The Review entry point rides here as the first chip (it used
                // to be a full-width banner above the search — folded into the
                // shelf to keep the top area thin, à la Telegram's folder row).
                // It's an ACTION, not a facet: it routes to /review rather than
                // re-scoping the list. Accent-filled while unseen suggestions are
                // fresh, calm otherwise; visiting Review is the acknowledgment
                // (review.tsx clears the unseen set on focus), so there's no ✕.
                <Chip
                  testID="review-chip"
                  accessibilityRole="button"
                  accessibilityLabel={
                    hasNewSuggestions
                      ? t('inbox.newSuggestionsA11y', { count: newSuggestionsCount })
                      : t('inbox.reviewPendingA11y', { count: pendingReviewCount })
                  }
                  variant={hasNewSuggestions ? 'accent' : 'default'}
                  onPress={() => router.push('/review')}
                >
                  {hasNewSuggestions
                    ? t('inbox.newSuggestions', { count: newSuggestionsCount })
                    : t('inbox.reviewPending', { count: pendingReviewCount })}
                </Chip>
              ) : null}
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
            {isWeb && canShelfLeft ? (
              <ShelfEdge
                side="left"
                label={t('inbox.shelfPrevA11y')}
                onPress={() => scrollShelfBy(-1)}
              />
            ) : null}
            {isWeb && canShelfRight ? (
              <ShelfEdge
                side="right"
                label={t('inbox.shelfMoreA11y')}
                onPress={() => scrollShelfBy(1)}
              />
            ) : null}
          </ShelfContainer>
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
        data={gridData}
        keyExtractor={(item) => item.id}
        // Remount when the column count changes: FlatList forbids mutating
        // numColumns on an existing instance.
        key={`grid-${viewMode}-${columns}`}
        numColumns={columns}
        columnWrapperStyle={columns > 1 ? { gap: 16 } : undefined}
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
          { maxWidth: contentMaxWidth },
          viewMode !== 'card' ? styles.listModeList : null,
          // Start the list below the floating header (and the pinned filter bar
          // when active), and clear the Add button so it never covers the last row.
          { paddingTop: listPaddingTop, paddingBottom: insets.bottom + 96 },
        ]}
        ListHeaderComponent={
          // The section label only earns its vertical space while searching,
          // where the match COUNT is real information. In the default/faceted
          // state it's redundant chrome: a newest-first list obviously leads
          // with the newest item, and a narrowed view is already named by the
          // pinned filter bar — so drop it to lift the first card up the screen.
          // (Still hidden on a zero-result search, where the recovery card
          // already says "no matches", to avoid a double-negative.)
          searching && visible.length > 0 ? (
            <Text style={[styles.sectionLabel, { color: palette.textSecondary }]}>
              {sectionLabel}
            </Text>
          ) : null
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
          ) : isSyncing ? (
            // Signed in and a pull is in flight, but the local cache is still
            // empty — the several-seconds-empty gap after sign-in (fresh install
            // or an account switch that replaced the cache). Show a progress
            // state, NOT the "your stash is empty" onboarding: until the first
            // pull completes we don't actually know the account is empty, and
            // flashing the empty card reads as if signing in lost the user's
            // data. When the pull lands the rows replace this; a genuinely empty
            // account falls through to the onboarding once isSyncing clears.
            <View style={styles.emptyState} testID="inbox-syncing">
              <ActivityIndicator color={palette.accent} style={styles.emptyGlyph} />
              <Text style={[styles.emptyTitle, { color: palette.text }]}>
                {t('inbox.syncing')}
              </Text>
              <Text style={[styles.emptySearchHint, { color: palette.textSecondary }]}>
                {t('inbox.syncingHint')}
              </Text>
            </View>
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
          // A grid-padding filler: render an empty flex cell so the real cards
          // on the final row keep their column width instead of stretching.
          if ('__placeholder' in item) {
            return <View testID="inbox-grid-filler" style={{ flex: 1 }} />;
          }
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
                // accessible={false} demotes the row to a plain container: a
                // Pressable is accessible by default, which would otherwise add a
                // second, noisy a11y target (label inferred from the raw URL +
                // sibling action text) and collapse the nested controls. With it
                // off, only the inner title button and the ↗ / … buttons below
                // are focusable.
                accessible={false}
              >
                <ItemIcon item={item} compact testID="inbox-list-monogram" />
                {/* The title/body is the accessible "open details" button; the
                    row container above is accessible={false} so the nested ↗ / …
                    buttons remain independently focusable. */}
                <Pressable
                  style={styles.listText}
                  accessibilityRole="button"
                  accessibilityLabel={accessibilityTitle(item) ?? t('common.untitled')}
                  accessibilityHint={t('inbox.openBookmarkHint')}
                  onPress={openDetail}
                  onLongPress={() => setMenuItem(item)}
                >
                  <HighlightedText
                    testID="inbox-list-title"
                    style={[
                      styles.listTitle,
                      { color: item.title_is_derived ? palette.textSecondary : palette.text },
                    ]}
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
                </Pressable>
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
                // See the list branch: keep the row a plain container so the
                // nested title button and ↗ / … controls stay independently
                // focusable instead of being swallowed by a noisy row target.
                accessible={false}
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
                <Pressable
                  style={styles.listText}
                  accessibilityRole="button"
                  accessibilityLabel={accessibilityTitle(item) ?? t('common.untitled')}
                  accessibilityHint={t('inbox.openBookmarkHint')}
                  onPress={openDetail}
                  onLongPress={() => setMenuItem(item)}
                >
                  <HighlightedText
                    testID="inbox-compact-title"
                    style={[
                      styles.listTitle,
                      { color: item.title_is_derived ? palette.textSecondary : palette.text },
                    ]}
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
                </Pressable>
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

          const cardElement = (
            <Card style={styles.card}>
              <Pressable
                onPress={openDetail}
                onLongPress={() => setMenuItem(item)}
                // See the list branch: keep the card a plain container so the
                // nested title button and the sibling … control stay
                // independently focusable.
                accessible={false}
              >
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
                  {/* Only the title is the accessible "open details" button so
                      the sibling … overflow button stays independently
                      focusable; the whole card remains tappable visually. */}
                  <Pressable
                    style={styles.cardTitlePressable}
                    accessibilityRole="button"
                    accessibilityLabel={accessibilityTitle(item) ?? t('common.untitled')}
                    accessibilityHint={t('inbox.openBookmarkHint')}
                    onPress={openDetail}
                    onLongPress={() => setMenuItem(item)}
                  >
                    <HighlightedText
                      testID="inbox-card-title"
                      style={[
                        styles.cardTitle,
                        { color: item.title_is_derived ? palette.textSecondary : palette.text },
                      ]}
                      numberOfLines={1}
                      text={displayTitle(item) ?? t('common.untitled')}
                      query={highlightQuery}
                      highlightStyle={highlightStyle}
                    />
                  </Pressable>
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
                  <View style={styles.cardUrlRow}>
                    <HighlightedText
                      style={[styles.cardUrl, { color: palette.textSecondary }]}
                      numberOfLines={1}
                      text={item.url}
                      query={highlightQuery}
                      highlightStyle={highlightStyle}
                    />
                    <Pressable
                      accessibilityRole="link"
                      accessibilityLabel={t('common.openLink')}
                      hitSlop={12}
                      style={[styles.cardUrlOpen, { backgroundColor: palette.accentSoft }]}
                      onPress={openLink}
                    >
                      <Text style={[styles.cardOpenLabel, { color: palette.accent }]}>↗</Text>
                    </Pressable>
                  </View>
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
            </Card>
          );
          // In a multi-column grid each cell must claim its column width (flex:
          // 1) so cards don't collapse to content width. Single-column leaves the
          // card unwrapped — the native/phone path is byte-for-byte unchanged.
          return columns > 1 ? <View style={{ flex: 1 }}>{cardElement}</View> : cardElement;
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
    </Animated.View>
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
    gap: 6,
    width: '100%',
    alignSelf: 'center',
  },
  listModeList: {
    gap: 8,
  },
  hero: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 4,
    width: '100%',
    alignSelf: 'center',
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
  // Text stand-in when the wordmark PNG fails to load, sized to sit on the same
  // baseline as the saved-count beside it.
  heroWordmarkFallback: {
    flexShrink: 0,
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: -0.5,
    lineHeight: WORDMARK_HEIGHT,
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
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Right-side hero action cluster: the search magnifier and the settings gear
  // sit as twin round buttons.
  heroActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
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
    marginTop: 8,
    borderRadius: 12,
    paddingLeft: 14,
    paddingRight: 6,
  },
  suggestBannerMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
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
    // Packed almost flush under the title (Telegram-style), so the top reads as
    // one tight title→search unit rather than two spaced bands.
    paddingTop: 2,
    width: '100%',
    alignSelf: 'center',
  },
  searchInput: {
    borderRadius: 18,
    paddingVertical: 9,
    paddingHorizontal: 16,
    fontSize: 16,
  },
  sortRow: {
    flexDirection: 'row',
    alignItems: 'center',
    // Single row, never wrapped: the Sort pill, Tags pill, and view segment all
    // share one line. The Sort pill (sortPillFlexible: flexShrink 1 + minWidth 0,
    // label numberOfLines={1}) is the only flexible item, so on a narrow width
    // it truncates its label — "Recently opened" → "Recently op…", its leading
    // icon still naming the field — instead of shoving the rightmost view
    // segment onto a wasteful second line. An earlier `flexWrap: 'wrap'` did
    // exactly that, so we drop it; the view segment (marginLeft: 'auto') stays
    // pinned right and is never clipped because the Sort pill yields the space.
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 4,
    width: '100%',
    alignSelf: 'center',
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
    width: 36,
    height: 36,
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
    minHeight: 38,
    marginTop: 2,
    marginBottom: 0,
    width: '100%',
    alignSelf: 'center',
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
  // Web-only browse-shelf overflow affordance. These styles are only referenced
  // behind Platform.OS === 'web', so they never touch the native layout.
  shelfWrap: {
    position: 'relative',
    width: '100%',
    alignSelf: 'center',
  },
  shelfEdge: {
    position: 'absolute',
    // Offset by the shelf's marginTop so the fade/button center on the chip row.
    top: 6,
    bottom: 0,
    width: 48,
    justifyContent: 'center',
  },
  shelfEdgeRight: {
    right: 0,
    alignItems: 'flex-end',
    paddingRight: 4,
  },
  shelfEdgeLeft: {
    left: 0,
    alignItems: 'flex-start',
    paddingLeft: 4,
  },
  shelfFade: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
  },
  shelfNavButton: {
    width: 30,
    height: 30,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
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
    padding: 14,
    gap: 7,
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
  cardTitlePressable: {
    flex: 1,
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
  cardUrlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  cardUrl: {
    flex: 1,
    fontSize: 13,
  },
  cardUrlOpen: {
    borderRadius: 999,
    height: 22,
    minWidth: 26,
    paddingHorizontal: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  metaChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
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
