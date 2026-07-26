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
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  type StyleProp,
  Text,
  TextInput,
  useColorScheme,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { usePalette } from '@/theme';
import { AnonymousNudgeBanner } from '@/ui/AnonymousNudgeBanner';
import { Button } from '@/ui/Button';
import { Card } from '@/ui/Card';
import { Chip } from '@/ui/Chip';
import { SearchSuggestionShelf } from '@/ui/SearchSuggestionShelf';
import { ShelfEdge, useShelfEdges } from '@/ui/ShelfEdges';
import { useSearchSuggestions } from '@/hooks/useSearchSuggestions';
import {
  RECENT_SEARCHES_PREF_KEY,
  addRecent,
  parseRecents,
  removeRecent,
  serializeRecents,
} from '@/domain/recent-searches';
import type { SearchSuggestion } from '@/domain/search-suggestions';
import { pendingSuggestedFolder, pendingSummary, pendingSuggestions } from '@/domain/ai-suggestions';
import { collectionMatchKey } from '@/domain/collection-match';
import { collectionColorKey, type CollectionColorKey } from '@/domain/collection-color';
import { filterBookmarks, queryHasSearchTokens } from '@/domain/search';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { MONOGRAM_COLORS, itemIcon, monogramIcon } from '@/domain/item-icon';
import { accessibilityTitle, displayTitle, isTitleDerived, siteLabel } from '@/domain/item-display';
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
  DEFAULT_FOLDER_SORT,
  FOLDER_SORT_PREF_KEY,
  FOLDER_SORT_PRESETS,
  parseFolderSort,
  sameFolderSort,
  serializeFolderSort,
  sortFolderTiles,
  type FolderSortOption,
} from '@/domain/folder-sort';
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
import { syncFlush } from '@/ui/sync-flush';
import { useT } from '@/i18n';
import type { MessageKey } from '@/i18n/messages';
import type { TFunction } from '@/i18n/translate';
import { metadataStatusLabel, syncStatusLabel } from '@/i18n/status';
import { useBookmarks } from '@/store/bookmarks';
import { useSupabaseAuth } from '@/supabase/auth-provider';
import { ActionSheet, type SheetAction } from '@/ui/ActionSheet';
import { CreateCollectionDialog } from '@/ui/CreateCollectionDialog';
import { HighlightedText } from '@/ui/HighlightedText';
import { overlayLayer } from '@/ui/layering';
import { useCaptureToast } from '@/ui/capture-toast';
import type { Bookmark } from '@/domain/types';
import BookmarkDetailScreen from '@/app/bookmark/[id]';
import {
  INITIAL_HEADER_COLLAPSE_STATE,
  nextHeaderCollapseState,
  type HeaderCollapseState,
} from '@/domain/header-collapse';
import { shouldShowWordmarkFallback } from '@/domain/wordmark';
import { setHeroDiagnosticsSnapshot } from '@/feedback/hero-diagnostics-session';

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
  list: 'list-outline',
  folder: 'folder-outline',
};

// Translation key for each layout's human label (segmented-control a11y).
const VIEW_MODE_LABEL_KEY: Record<ViewMode, MessageKey> = {
  card: 'viewMode.card',
  list: 'viewMode.list',
  folder: 'viewMode.collection',
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

// Folder View's own sort menu (Collection tiles, not bookmarks) — a separate
// small set of labels/icons since its field union (name/count) doesn't
// overlap with the bookmark-level SORT_LABEL_KEY/SORT_ICON above.
const FOLDER_SORT_LABEL_KEY: Record<string, MessageKey> = {
  'name:asc': 'inbox.folderSortNameAsc',
  'name:desc': 'inbox.folderSortNameDesc',
  'count:desc': 'inbox.folderSortCountDesc',
  'count:asc': 'inbox.folderSortCountAsc',
};

const FOLDER_SORT_ICON: Record<FolderSortOption['field'], ComponentProps<typeof Ionicons>['name']> = {
  name: 'text-outline',
  count: 'layers-outline',
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
const WEB_MEDIUM_WEIGHT = Platform.select({ web: '500', default: '600' }) as '500' | '600';
const WEB_SEMIBOLD_WEIGHT = Platform.select({ web: '600', default: '700' }) as '600' | '700';
const WEB_BOLD_WEIGHT = Platform.select({ web: '700', default: '800' }) as '700' | '800';
const WEB_CARD_GRID_TOP_GAP = Platform.OS === 'web' ? 12 : 4;
const WEB_CARD_GRID_COLUMN_GAP = 16;
const LIST_PADDING = 16;
const CARD_PREVIEW_HEIGHT = Platform.select({ web: 124, default: 132 });
// Root cause of the reported "desktop browser: tap ✕, the field doesn't
// close" bug: a mousedown on this button blurs the still-focused search
// input *before* the click fires. That blur's own deferred empty-query
// auto-close (see the TextInput's onBlur below) had time to run first
// whenever there was any real gap between mouse-down and mouse-up (i.e. any
// actual human click, not a zero-delay synthetic one) — closing the field
// and flipping this same button back to its "search" icon so the click that
// followed reopened it instead of closing it. Only reproduced with a real
// held-then-released click, never with an instant synthetic one, which is
// why earlier Playwright repros (instant `.click()`) missed it. Web-only:
// preventing mousedown's default here stops the browser from shifting focus
// (and thus blurring) at all, so the click's own onPress deterministically
// decides open vs close. react-native-web's Pressable forwards unrecognized
// props like this straight to the underlying DOM node.
const preventMouseDownFocusSteal =
  Platform.OS === 'web' ? { onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault() } : null;
const WEB_AMBIENT_BACKGROUND = Platform.OS === 'web'
  ? ({
      backgroundImage:
        'radial-gradient(circle at 10% 0%, rgba(120, 184, 244, 0.16), transparent 42%), radial-gradient(circle at 90% 100%, rgba(238, 203, 105, 0.10), transparent 46%)',
      backgroundAttachment: 'fixed',
    } as ViewStyle)
  : null;

// A filler cell used to pad the last row of the multi-column card grid so the
// real cards on that row keep their column width. Never rendered as a card — the
// renderItem short-circuits it to an empty flex spacer.
type GridPlaceholder = { id: string; __placeholder: true; role?: 'selected-row' };
type InlineDetailItem = { id: string; __inlineDetail: true; bookmarkId: string; fullWidth?: boolean };
// Folder View tile — either a facet (the uncollected bucket or a real
// Collection, both tappable via `filter`) or the trailing "new folder"
// affordance (`kind: 'new'`, no `filter`).
type FolderTileItem = {
  id: string;
  __folderTile: true;
  kind: 'uncollected' | 'collection' | 'new';
  label?: string;
  count?: number;
  filter?: InboxFilter;
  colorKey?: CollectionColorKey;
};
type InboxListItem = Bookmark | GridPlaceholder | InlineDetailItem | FolderTileItem;

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

function InboxRootSurface({
  backgroundColor,
  children,
  shift,
  sliding,
}: {
  backgroundColor: string;
  children: ReactNode;
  shift: Animated.Value;
  sliding: boolean;
}) {
  return (
    <Animated.View
      style={[
        styles.container,
        { backgroundColor },
        WEB_AMBIENT_BACKGROUND,
        sliding ? { transform: [{ translateX: shift }] } : null,
      ]}
    >
      {children}
    </Animated.View>
  );
}

// On Chrome/web, even an identity transform on a broad ancestor rasterizes text
// and thumbnails into a softer composited layer. Keep the root transform out of
// the idle tree above, while preserving these focused overlay animations.
function WebCrispAnimatedSurface({
  animatedStyle,
  baseStyle,
  children,
  onLayout,
  pointerEvents,
  testID,
}: {
  animatedStyle: StyleProp<ViewStyle>;
  baseStyle: StyleProp<ViewStyle>;
  children: ReactNode;
  onLayout?: ComponentProps<typeof View>['onLayout'];
  pointerEvents?: ComponentProps<typeof View>['pointerEvents'];
  testID?: string;
}) {
  return (
    <Animated.View
      testID={testID}
      pointerEvents={pointerEvents}
      onLayout={onLayout}
      style={[baseStyle, animatedStyle]}
    >
      {children}
    </Animated.View>
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
      quiet={Platform.OS === 'web' && !active}
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
  const hasLocalName = t('app.nameLocal') !== t('app.name');
  const colorScheme = useColorScheme();
  const wmSet = hasLocalName ? WORDMARK.local : WORDMARK.en;
  const wordmark = { source: colorScheme === 'dark' ? wmSet.dark : wmSet.light, ratio: wmSet.ratio };
  const wordmarkLabel = hasLocalName ? `${t('app.name')} ${t('app.nameLocal')}` : t('app.name');
  // The wordmark is a pre-rendered PNG. If it ever fails to load — a browser that
  // blocks the asset, or a request dropped across the OAuth redirect (seen in a
  // Brave private window after sign-in) — fall back to plain text so the
  // top-left brand mark is never blank.
  const [wordmarkFailed, setWordmarkFailed] = useState(false);
  const [wordmarkLoaded, setWordmarkLoaded] = useState(Platform.OS !== 'web');
  const wordmarkWidth = Math.round(WORDMARK_HEIGHT * wordmark.ratio);
  const showWordmarkFallback = shouldShowWordmarkFallback({
    platform: Platform.OS,
    wordmarkFailed,
    wordmarkLoaded,
  });
  useEffect(() => {
    setWordmarkFailed(false);
    setWordmarkLoaded(Platform.OS !== 'web');
  }, [wordmark.source]);
  const {
    inbox,
    isLoading,
    isSyncing,
    loadError,
    getBookmark,
    getTagsForBookmark,
    getCollection,
    getEnrichment,
    getReviewedSuggestions,
    getDismissedFolderSuggestions,
    getReviewedSummary,
    unseenSuggestionIds,
    collections,
    trashBookmark,
    restoreBookmark,
    deleteBookmark,
    assignCollection,
    markBookmarkAccessed,
    createCollection,
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
  // STASH-33/34/35/36 root cause: the list has `keyboardDismissMode="on-drag"`
  // (below, near the FlatList) so scrolling the results dismisses the
  // keyboard. Opening search from a collapsed header forces a large relayout
  // in the same commit as the field mounting and requesting focus — an
  // incidental drag/scroll landing in that same window (a real finger's
  // residual movement from the opening tap, or scroll produced by the
  // header/list reflow itself) can register as a drag-start on the
  // underlying list and fire that on-drag dismiss milliseconds later. That's
  // indistinguishable at the JS level from a real blur/keyboardDidHide, so it
  // hits the exact same auto-close path every report has shown (confirmed:
  // STASH-37, first report on the build with this fix, showed the field
  // staying open). No local repro ever reproduced this — every synthetic
  // interaction tested (mouse clicks, Playwright's touchscreen.tap(),
  // simulated scroll) is perfectly still, unlike a real device.
  //
  // Fix: suppress on-drag dismissal for a short window right after opening
  // (long enough to absorb incidental drag/scroll from the opening itself,
  // short enough that a genuine subsequent drag still dismisses the keyboard
  // normally). Real state, not a ref: clearing it after the window needs to
  // actually re-render to put `keyboardDismissMode` back to "on-drag" on the
  // FlatList prop below — a ref write alone wouldn't do that without some
  // other, unrelated re-render happening to pick it up.
  const [suppressOnDragDismiss, setSuppressOnDragDismiss] = useState(false);
  const SUPPRESS_ON_DRAG_DISMISS_MS = 500;
  // A close-then-reopen within the window left the OLD timer armed, so it
  // could clear the NEW open's suppression early (a fast enough second open
  // would inherit however much time was left on the first one, not the full
  // 500ms) — caught in PR review, Codex. Track it so a fresh open cancels
  // any still-pending timer before arming its own, and clear it on unmount
  // too, so no stray setState fires after the component is gone.
  const suppressOnDragDismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (suppressOnDragDismissTimerRef.current !== null) {
        clearTimeout(suppressOnDragDismissTimerRef.current);
      }
    },
    [],
  );
  const openSearch = useCallback(() => {
    // Diagnostic trail for the "search icon tap does nothing but the list
    // scrolls slightly" report: if this breadcrumb is ABSENT for a tap the
    // user saw happen, the touch never reached JS (swallowed by the list's
    // scroll responder — the same hit-test class as STASH-7/STASH-8), not a
    // bug in this function. If it's present but the field still isn't
    // visible, the reveal-focus effect / collapse-state breadcrumbs below
    // narrow it further.
    trackBreadcrumb('search', 'open tap', {
      scrollY: Math.round(lastScrollYRef.current),
      collapsedBefore: headerCollapseRef.current.collapsed,
    });
    // Flush synchronously and call .focus() right after — inside the tap's
    // own call stack rather than a later effect. Some mobile browsers only
    // reliably honor a focus call made synchronously within the originating
    // gesture; this isn't what fixed STASH-33/34/35/36/37 (that was the
    // on-drag suppression below), but removing it has never been verified
    // safe on its own, so it stays as a defensive measure. Harmless on
    // native (`syncFlush` is a plain passthrough there — see
    // `ui/sync-flush.native.ts`).
    syncFlush(() => {
      setSearchOpen(true);
      setSuppressOnDragDismiss(true);
      // The search field itself mounts inside the web collapsible wrapper — if
      // that's currently collapsed, the field would mount off-screen: the hero
      // icon flips to "close" but there's nothing visible to type into (caught
      // in PR review). Force it expanded whenever search opens; harmless to
      // call on native, which doesn't read this state for anything visual.
      // Snapshot the real state first — restoreHeaderCollapseOnSearchClose
      // resumes the hysteresis from here instead of from scratch. The
      // collapsible wrapper's measured height comes along too: it re-measures
      // to the search-open layout's height (search input, no sort/browse row)
      // once search mounts, which can be shorter or taller than the normal
      // layout it reverts to on close — using the CURRENT (search-open)
      // height against the PRE-search anchor at close time compares against
      // the wrong threshold (caught in PR review, Codex).
      preSearchHeaderCollapseRef.current = headerCollapseRef.current;
      preSearchCollapsibleHeightRef.current = collapsibleHeightRef.current;
      const expanded = { collapsed: false, anchorScrollY: lastScrollYRef.current };
      headerCollapseRef.current = expanded;
      setHeaderCollapse(expanded);
    });
    searchRef.current?.focus();
    // The focus-on-open effect below is the fallback for any mount-order
    // race the synchronous call above missed.
    if (suppressOnDragDismissTimerRef.current !== null) {
      clearTimeout(suppressOnDragDismissTimerRef.current);
    }
    suppressOnDragDismissTimerRef.current = setTimeout(() => {
      suppressOnDragDismissTimerRef.current = null;
      setSuppressOnDragDismiss(false);
    }, SUPPRESS_ON_DRAG_DISMISS_MS);
  }, []);
  // While search is open, every scroll tick pins the header at
  // `{ collapsed: false, anchorScrollY: <wherever the user was> }` (see the
  // scroll listener below), so `headerCollapseRef.current` at close time holds
  // that pinned value, not the real pre-search hysteresis anchor. Continuing
  // from `INITIAL_HEADER_COLLAPSE_STATE` (as if the header had just now
  // scrolled to this position from the top) fixed the original stuck-expanded
  // bug (deep in a long list, no room to scroll further down and re-trigger a
  // collapse) but overcorrected: it discards a legitimate reveal that was
  // already in effect before search opened (scroll up, pause, scroll back
  // down a little — see domain/header-collapse.ts's reveal/collapse
  // hysteresis) and forces a full collapse on close instead (STASH report:
  // closing search made the whole top row vanish, not just the field).
  // `openSearch` snapshots the real pre-search state into
  // `preSearchHeaderCollapseRef` before pinning it expanded; continuing the
  // hysteresis from THAT anchor (rather than 0) at the current scroll offset
  // gets both right — an unmoved position stays exactly as it was, and a
  // position that moved far enough during search still collapses normally.
  // The collapsible height comes from that same pre-search snapshot too, not
  // the live `collapsibleHeightRef` — the search-open layout (search input,
  // no sort/browse row) can measure a different height than the normal
  // layout the header reverts to on close, so comparing the pre-search
  // anchor against the WRONG (search-open) height picked the wrong threshold
  // (caught in PR review, Codex).
  // Shared by every path that can close search — not just the explicit
  // closeSearch() below, but the empty-blur and native keyboardDidHide
  // auto-closes too, which set searchOpen false directly without going
  // through closeSearch (caught in PR review, Codex — the first version of
  // this fix only covered closeSearch).
  const restoreHeaderCollapseOnSearchClose = useCallback(() => {
    const restored = nextHeaderCollapseState(
      preSearchHeaderCollapseRef.current,
      lastScrollYRef.current,
      preSearchCollapsibleHeightRef.current,
    );
    headerCollapseRef.current = restored;
    if (Platform.OS === 'web') {
      setHeaderCollapse(restored);
    }
  }, []);
  // Fold the whole search UI away: blur, drop focus, and CLEAR the query
  // (Telegram-faithful — opening search always starts fresh). This is the
  // EXPLICIT close (the ✕ tap); the empty-blur and native keyboardDidHide
  // auto-closes below run their own version of the blur/clear steps (they
  // don't share this function), but both also call
  // restoreHeaderCollapseOnSearchClose.
  const closeSearch = useCallback(() => {
    trackBreadcrumb('search', 'close', { scrollY: Math.round(lastScrollYRef.current) });
    clearBlurHide();
    setSearchFocused(false);
    searchRef.current?.blur();
    setQuery('');
    setSearchOpen(false);
    restoreHeaderCollapseOnSearchClose();
  }, [clearBlurHide, restoreHeaderCollapseOnSearchClose]);
  // Move focus into the field once it has actually mounted (it only mounts while
  // searchOpen), raising the keyboard + carrying screen-reader focus — the same
  // thing `autoFocus` does, but driven by our open state. Runs after the mount
  // commit (the effect fires once the field is in the tree), so the ref is set.
  useEffect(() => {
    if (searchOpen) {
      // hasRef=false here would mean the field hadn't mounted yet when this
      // effect ran (a mount-order race), so .focus() below was a silent no-op.
      trackBreadcrumb('search', 'focus effect', { hasRef: searchRef.current != null });
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
          restoreHeaderCollapseOnSearchClose();
        }
      }, 0);
    });
    return () => sub.remove();
  }, [clearBlurHide, restoreHeaderCollapseOnSearchClose]);
  // The user's own recent searches (most-recent-first). Local-only: persisted in
  // the meta store as `pref.search.recents`, never enqueued or synced.
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [filter, setFilter] = useState<InboxFilter>(ALL_FILTER);
  const [sort, setSort] = useState<SortOption>(DEFAULT_SORT);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  // Folder View's own sort order — independent of `sort` above (see
  // domain/folder-sort.ts). Same `sortMenuOpen`/ActionSheet is reused for both;
  // which preset list and label/state it reflects branches on `viewMode`.
  const [folderSort, setFolderSort] = useState<FolderSortOption>(DEFAULT_FOLDER_SORT);
  const [viewMode, setViewMode] = useState<ViewMode>(DEFAULT_VIEW_MODE);
  // Folder View is transient (never persisted as the resting layout — see
  // domain/view-mode.ts). Tapping a folder tile drops the user back into
  // whichever item layout they were on before entering Folder View, so this
  // tracks that "last real layout" without touching the stored preference.
  const lastNonFolderViewModeRef = useRef<ViewMode>(
    viewMode === 'folder' ? DEFAULT_VIEW_MODE : viewMode,
  );
  useEffect(() => {
    if (viewMode !== 'folder') {
      lastNonFolderViewModeRef.current = viewMode;
    }
  }, [viewMode]);
  const [inlineDetailId, setInlineDetailId] = useState<string | null>(null);

  // Responsive multi-column card grid on wide (desktop-web) viewports. Only the
  // card layout flows into 2–3 columns; compact/list stay single-column. On
  // phones the width is below one column's worth (~380dp), so columns collapses
  // to 1 and the content cap falls back to the fixed 720px column — the current
  // phone behavior is preserved exactly with no Platform.OS branch.
  const { width: winWidth } = useWindowDimensions();
  const columns = viewMode === 'card'
    ? Math.min(3, Math.max(1, Math.floor(winWidth / 380)))
    // Folder View is always a fixed 2-column grid of tiles (phone and web
    // alike) — it isn't the responsive card grid, so it doesn't scale with
    // viewport width the way `card` does.
    : viewMode === 'folder'
      ? 2
      : 1;
  const contentMaxWidth =
    viewMode === 'card' && columns > 1 ? columns * 372 : CONTENT_MAX_WIDTH;
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
      Animated.timing(settingsShift, {
        toValue: -SETTINGS_PANEL_WIDTH / 2,
        duration: 200,
        useNativeDriver: true,
      }).start();
      return;
    }
    if (!sliding) {
      settingsShift.setValue(0);
      return;
    }
    Animated.timing(settingsShift, {
      toValue: 0,
      duration: 200,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) {
        setSliding(false);
      }
    });
  }, [settingsOpen, settingsShift, sliding]);

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
      // A summary-only card (no tags, no folder) is reviewable too — mirror
      // Review's inclusion rule here as well, so it isn't stranded off-badge.
      const summary = pendingSummary(
        bookmark.metadata_status,
        enrichment,
        getReviewedSummary(bookmark.id),
        bookmark.title,
      );
      if (pending.length > 0 || folder || summary) {
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
    getReviewedSummary,
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
      const summary = pendingSummary(
        bookmark.metadata_status,
        enrichment,
        getReviewedSummary(bookmark.id),
        bookmark.title,
      );
      if (pending.length > 0 || folder || summary) {
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
    getReviewedSummary,
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
  // Plain (non-Animated) mirror of the list's scroll offset, updated by the
  // same onScroll below. Cheap to read synchronously — used only to decide
  // whether the remount reset effect below actually mattered, for the
  // STASH-2B confirmation breadcrumb.
  const lastScrollYRef = useRef(0);
  const [headerHeight, setHeaderHeight] = useState(0);
  // Web only (see the render below): the hero row (wordmark/count/search/
  // settings) never moves at all on web — it isn't coupled to the collapse
  // mechanism in any way, so it structurally cannot be hidden by a stuck/stale
  // animation value the way the whole cluster could (Sentry STASH-2B,
  // STASH-2G). Only the content below it (sort/filter pills + browse/
  // suggestion shelf, measured separately as `collapsibleHeight`) collapses,
  // driven by `domain/header-collapse.ts` — state derived fresh from the
  // current scroll offset every tick instead of an accumulated Animated
  // value — and animated with a real CSS transition rather than JS-driven
  // Animated. Native is untouched: the whole cluster still collapses together
  // via `headerTranslate` below, exactly as before.
  //
  // Layout notes for the collapsible wrapper (both caught in PR review):
  // it's `position: absolute` on web (own top offset, own opaque background)
  // rather than a normal-flow sibling, so it does NOT contribute to the outer
  // surface's own layout height — a normal-flow sibling would, even once
  // translated away (transforms never affect layout), leaving the outer's
  // still-opaque, still-full-height background painted over list rows in the
  // "reclaimed" space. And it has to translate up by heroHeight PLUS its own
  // height to clear the screen entirely — by only its own height would just
  // bring its bottom edge to rest against the hero's, still overlapping (and
  // painting over, as the later sibling) the pinned hero.
  const [heroHeight, setHeroHeight] = useState(0);
  const [collapsibleHeight, setCollapsibleHeight] = useState(0);
  // closeSearch (declared earlier in this component) reads this via the ref,
  // not the state value directly, so it isn't forced to sit below this
  // declaration just to list it as a useCallback dependency.
  const collapsibleHeightRef = useRef(collapsibleHeight);
  collapsibleHeightRef.current = collapsibleHeight;
  const [headerCollapse, setHeaderCollapse] = useState<HeaderCollapseState>(
    INITIAL_HEADER_COLLAPSE_STATE,
  );
  // The web scroll listener below recomputes this on every scroll-event tick
  // via `nextHeaderCollapseState`, whose `anchorScrollY` changes on nearly
  // every tick while the user keeps scrolling in one direction (it tracks the
  // running extreme point — see domain/header-collapse.ts) — but render only
  // ever reads `.collapsed` (the translateY below). Promoting every tick
  // straight into React state forced a full InboxScreen re-render, and with
  // it every mounted card's heavy JSX in card view, at scroll-event frequency
  // (~60/sec) on web. This ref carries the full state between ticks so
  // anchor-tracking stays exact; `setHeaderCollapse` only fires when
  // `.collapsed` actually flips, which is the only thing render cares about.
  const headerCollapseRef = useRef<HeaderCollapseState>(INITIAL_HEADER_COLLAPSE_STATE);
  // The real (unpinned) collapse state from just before `openSearch` forced
  // `headerCollapseRef` expanded — see `restoreHeaderCollapseOnSearchClose`.
  const preSearchHeaderCollapseRef = useRef<HeaderCollapseState>(INITIAL_HEADER_COLLAPSE_STATE);
  // The collapsible wrapper's measured height from that same pre-search
  // moment — it re-measures once the search-open layout (search input, no
  // sort/browse row) mounts, which isn't necessarily the same height as the
  // normal layout the header reverts to on close.
  const preSearchCollapsibleHeightRef = useRef<number>(0);
  const isWebPlatform = Platform.OS === 'web';
  // `headerHeight` means "total expanded height" (used below for the list's
  // top padding/scroll inset and the filter bar's resting position) — native
  // still measures it directly off the one surface (unchanged); web derives
  // it as the sum of the two independently-measured pieces, since the outer
  // surface's own layout no longer includes the collapsible piece there.
  useEffect(() => {
    if (isWebPlatform) {
      setHeaderHeight(heroHeight + collapsibleHeight);
    }
  }, [isWebPlatform, heroHeight, collapsibleHeight]);
  // Keep a live snapshot of the hero's render state for `FloatingReportButton`
  // to read if the user files a "Report a problem" — see
  // `feedback/hero-diagnostics-session.ts` for why (recurring "hero not
  // visible" reports with no way to tell what actually happened).
  useEffect(() => {
    setHeroDiagnosticsSnapshot({
      collapsed: headerCollapse.collapsed,
      heroHeight,
      collapsibleHeight,
      wordmarkLoaded,
      wordmarkFailed,
      showWordmarkFallback,
    });
  }, [
    headerCollapse.collapsed,
    heroHeight,
    collapsibleHeight,
    wordmarkLoaded,
    wordmarkFailed,
    showWordmarkFallback,
  ]);
  useEffect(() => () => setHeroDiagnosticsSnapshot(null), []);
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
  // status-bar line so it never tucks under the notch. On web the hero is
  // pinned and never leaves `[0, heroHeight]` (see above), so the bar's
  // collapsed floor must stop at `heroHeight` instead of `insets.top` — the
  // native floor would tuck the bar's resting position back under the hero's
  // now-permanent footprint, hiding it (and its clear-filter action) behind
  // the hero (caught in PR review).
  const filterBarTranslate = useMemo(() => {
    if (!headerClamp || !headerHeight) {
      return 0;
    }
    const floor = isWebPlatform ? heroHeight : insets.top;
    return headerClamp.interpolate({
      inputRange: [0, headerHeight],
      outputRange: [0, -(headerHeight - floor)],
      extrapolate: 'clamp',
    });
  }, [headerClamp, headerHeight, insets.top, isWebPlatform, heroHeight]);
  // The FlatList remounts on a fresh `key` whenever `viewMode`/`columns`
  // changes (numColumns can't mutate on an existing instance), which resets
  // its native scroll position to the top — but nothing fires a fresh
  // onScroll(0) from a remount alone, so `scrollY` (driving the collapsing
  // header above) is left stale at whatever offset it held before the
  // switch. If the header was collapsed at that point, it stays collapsed —
  // the entire hero cluster invisible over a freshly top-scrolled list, with
  // no further scroll needed to trigger it. Resetting `scrollY` here keeps it
  // in sync with the list's actual (reset) position. (Sentry STASH-2B:
  // "Keepory 히어로가 안보임" — the hero not showing after a view-mode switch.)
  useEffect(() => {
    if (lastScrollYRef.current > 0) {
      trackBreadcrumb('header', 'reset scrollY on view-mode remount', {
        previousScrollY: Math.round(lastScrollYRef.current),
      });
    }
    scrollY.setValue(0);
    lastScrollYRef.current = 0;
    // Same reasoning for the web-only collapse state: a remount resets the
    // list to the top, so the collapsible row must not stay stuck collapsed.
    headerCollapseRef.current = INITIAL_HEADER_COLLAPSE_STATE;
    setHeaderCollapse(INITIAL_HEADER_COLLAPSE_STATE);
  }, [viewMode, columns, scrollY]);

  // Load the saved sort + view mode once, then persist any change. The guards
  // stop the initial defaults from clobbering the stored values before they
  // have loaded.
  const sortLoaded = useRef(false);
  const folderSortLoaded = useRef(false);
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
    getPreference(FOLDER_SORT_PREF_KEY)
      .then((raw) => {
        if (active) {
          setFolderSort(parseFolderSort(raw));
        }
      })
      .catch(() => {})
      .finally(() => {
        folderSortLoaded.current = true;
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
    if (!folderSortLoaded.current) {
      return;
    }
    void setPreference(FOLDER_SORT_PREF_KEY, serializeFolderSort(folderSort)).catch(() => {});
  }, [folderSort]);
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
  const { chips, hasUncollected, uncollectedCount, collectionCounts } = useMemo(() => {
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
      collectionCounts,
    };
  }, [inbox, getTagsForBookmark, getCollection]);

  // Folder View tiles. Deliberately NOT filtered down to `chips`' collection
  // entries — those only include a collection that already holds an Inbox
  // bookmark, so a just-created empty collection (see the "New folder" dialog
  // below) would never appear as a tile. Folder View reads as a directory of
  // every real Collection (à la Drive/Files, empty folders included), so it
  // iterates the full `collections` list instead and looks up each one's count
  // from the SAME per-collection tally the browse shelf computed (0 if absent)
  // — the two views still never disagree on a count, they just differ on
  // whether an empty collection gets a row at all.
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
        count: uncollectedCount,
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
        count: collectionCounts.get(collection.id) ?? 0,
        collection,
      }));
    const sortedCollections = sortFolderTiles(sortableCollections, folderSort);
    for (const { collection, count } of sortedCollections) {
      tiles.push({
        id: `__folder-c:${collection.id}`,
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
  }, [collections, collectionCounts, folderSort, hasUncollected, uncollectedCount, t]);

  // Pad to an even number of tiles so the trailing row keeps its column width
  // (mirrors the placeholder padding the card grid already does below).
  const folderGridData = useMemo<(FolderTileItem | GridPlaceholder)[]>(() => {
    if (folderTiles.length % 2 === 0) {
      return folderTiles;
    }
    return [...folderTiles, { id: '__folder-ph', __placeholder: true }];
  }, [folderTiles]);

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
  useEffect(() => {
    if (!inlineDetailId) {
      return;
    }
    const resolvedInlineId = getBookmark(inlineDetailId)?.id ?? inlineDetailId;
    if (resolvedInlineId !== inlineDetailId) {
      setInlineDetailId(resolvedInlineId);
      return;
    }
    if (!visible.some((bookmark) => bookmark.id === resolvedInlineId)) {
      setInlineDetailId(null);
    }
  }, [getBookmark, inlineDetailId, visible]);
  // In a multi-column card grid, pad rows with lightweight placeholders so real
  // cards keep their column width (flex: 1). When an inline detail is open on
  // web, finish the clicked card row, then insert a synthetic full-width detail
  // row before appending the remaining cards.
  const gridData = useMemo<InboxListItem[]>(() => {
    const withInlineDetail = (() => {
      if (Platform.OS !== 'web' || !inlineDetailId) {
        return visible;
      }
      const resolvedInlineDetailId = getBookmark(inlineDetailId)?.id ?? inlineDetailId;
      const index = visible.findIndex((bookmark) => bookmark.id === resolvedInlineDetailId);
      if (index === -1) {
        return visible;
      }
      if (columns > 1) {
        const rowEnd = index + (columns - (index % columns));
        const visibleRowEnd = Math.min(visible.length, rowEnd);
        const selectedRowFillers: GridPlaceholder[] = Array.from(
          { length: rowEnd - visibleRowEnd },
          (_, i) => ({ id: `__row-ph-${resolvedInlineDetailId}-${i}`, __placeholder: true, role: 'selected-row' }),
        );
        const detailRowFillers: GridPlaceholder[] = Array.from(
          { length: columns - 1 },
          (_, i) => ({ id: `__detail-ph-${resolvedInlineDetailId}-${i}`, __placeholder: true }),
        );
        return [
          ...visible.slice(0, visibleRowEnd),
          ...selectedRowFillers,
          {
            id: `__detail-${resolvedInlineDetailId}`,
            __inlineDetail: true as const,
            bookmarkId: resolvedInlineDetailId,
            fullWidth: true,
          },
          ...detailRowFillers,
          ...visible.slice(visibleRowEnd),
        ];
      }
      return [
        ...visible.slice(0, index + 1),
        {
          id: `__detail-${resolvedInlineDetailId}`,
          __inlineDetail: true as const,
          bookmarkId: resolvedInlineDetailId,
        },
        ...visible.slice(index + 1),
      ];
    })();
    if (columns <= 1 || withInlineDetail.length === 0) {
      return withInlineDetail;
    }
    const remainder = withInlineDetail.length % columns;
    if (remainder === 0) {
      return withInlineDetail;
    }
    const placeholders: GridPlaceholder[] = Array.from(
      { length: columns - remainder },
      (_, i) => ({ id: `__ph-${i}`, __placeholder: true }),
    );
    return [...withInlineDetail, ...placeholders];
  }, [visible, columns, inlineDetailId, getBookmark]);
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
  // Same one-shot easing for the tap-to-CLOSE reflow only: closing swaps the
  // field back for the sort row + shelf (the header's height changes again),
  // so animate that single commit instead of letting the top jump. Off the
  // header's native-driver translateY, so they don't fight. Native only.
  //
  // Deliberately NOT applied to the OPEN transition (searchOpen false→true):
  // `LayoutAnimation.Presets.easeInEaseOut`'s `create` config fades newly
  // mounted views in via opacity over its 300ms duration — which is exactly
  // the search TextInput on this commit. The focus-on-open effect below still
  // calls `.focus()` immediately and the keyboard still raises right away, but
  // the field itself (and the sort row fading out under `delete`) is still
  // animating into place for the next 300ms, so the tap reads as "doesn't
  // focus right away, just a slight momentary scroll" instead of an instant,
  // stable focus (confirmed with a spy on `configureNext` — see
  // `inbox-screen.test.tsx`, "opening search focuses the field immediately,
  // with no fade-in animation on the newly mounted input"). Leaving the open
  // transition un-eased matches web, which has no such animation and already
  // mounts the field solid on the same commit.
  const prevSearchOpen = useRef(searchOpen);
  if (prevSearchOpen.current !== searchOpen) {
    const wasOpen = prevSearchOpen.current;
    prevSearchOpen.current = searchOpen;
    if (Platform.OS !== 'web' && wasOpen && !searchOpen) {
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

  // The sort pill/menu shows one of two independent controls depending on the
  // active layout: Folder View's own name/count order, or the bookmark-level
  // date/accessed/name order everywhere else. Switching layouts never
  // disturbs the other control's state (see the two separate pref keys).
  const isFolderSort = viewMode === 'folder';
  const activeSortLabelKey = isFolderSort
    ? FOLDER_SORT_LABEL_KEY[serializeFolderSort(folderSort)]
    : SORT_LABEL_KEY[serializeSort(sort)];
  const activeSortIcon = isFolderSort ? FOLDER_SORT_ICON[folderSort.field] : SORT_ICON[sort.field];

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

  // Web-only browse-shelf overflow affordance (wheel-to-horizontal + edge
  // chevrons); see `useShelfEdges`. Recomputed on viewport-width and chip-count
  // changes. The search-suggestion shelf uses the same hook so the chip row
  // behaves identically whether or not search is open.
  const {
    shelfRef,
    canLeft: canShelfLeft,
    canRight: canShelfRight,
    updateEdges: updateShelfEdges,
    scrollBy: scrollShelfBy,
    isWeb,
  } = useShelfEdges(showShelf, [winWidth, chips.length]);
  const InboxList = (isWeb ? FlatList : AnimatedFlatList) as typeof FlatList;
  const listRef = useRef<FlatList<InboxListItem>>(null);
  const scrollToTop = useCallback(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
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
  const listPaddingTop = headerHeight + filterBarReserve + WEB_CARD_GRID_TOP_GAP;
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
    clearFacetParams();
  }, [searching, closeSearch, clearFacetParams]);

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
    // The user is now driving the filter from the shelf (the "All" chip clears
    // the facet; another chip moves to a different one), so the routed deep-link
    // param is stale — strip it so a web reload doesn't resurrect it over the
    // user's choice.
    clearFacetParams();
  }, [clearFacetParams]);

  // Tapping a Folder View tile behaves like tapping the matching BrowseChip
  // (same filter mechanism, same pinned filter bar), plus it drops the user
  // back into whichever item layout they were on before opening Folder View —
  // a transient switch, so it deliberately does NOT persist to
  // INBOX_VIEW_PREF_KEY the way the segmented-control toggle below does.
  const openFolderTile = useCallback(
    (target: InboxFilter) => {
      onSelectFilter(target);
      setViewMode(lastNonFolderViewModeRef.current);
    },
    [onSelectFilter],
  );

  // "New folder" tile → a minimal name-only dialog (CreateCollectionDialog),
  // Folder-View-scoped. Reuses the store's `createCollection` — the same
  // function CollectionPicker's inline "type to create" row (Bookmark Detail)
  // calls — rather than a second create-collection implementation.
  const [newFolderDialogOpen, setNewFolderDialogOpen] = useState(false);
  const [newFolderBusy, setNewFolderBusy] = useState(false);
  const [newFolderError, setNewFolderError] = useState<string | null>(null);
  const onNewFolderTilePress = useCallback(() => {
    setNewFolderError(null);
    setNewFolderDialogOpen(true);
  }, []);
  const closeNewFolderDialog = useCallback(() => {
    if (newFolderBusy) {
      return;
    }
    setNewFolderDialogOpen(false);
    setNewFolderError(null);
  }, [newFolderBusy]);
  const handleCreateFolder = useCallback(
    async (name: string) => {
      setNewFolderBusy(true);
      setNewFolderError(null);
      const result = await createCollection(name);
      setNewFolderBusy(false);
      if (result.collection) {
        // No filter/navigation change — the new (empty) collection just shows
        // up as its own tile in the grid already on screen (folderTiles is
        // derived from the live `collections` list, so this re-render alone
        // picks it up; see the comment above folderTiles).
        setNewFolderDialogOpen(false);
        return;
      }
      setNewFolderError(result.error ?? t('detail.errorCreateCollection'));
    },
    [createCollection, t],
  );

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

  // Wide-web-only: the Tags/Graph pills gain a visible label (like Sort already
  // has) once there's room, reusing the same breakpoint the wide-screen Settings
  // sheet gates on rather than inventing a new one.
  const showPillLabels = isWeb && winWidth >= SETTINGS_SHEET_MIN_WIDTH;

  return (
    <InboxRootSurface
      backgroundColor={palette.background}
      shift={settingsShift}
      sliding={sliding}
    >
      <WebCrispAnimatedSurface
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
        // On web, headerHeight is derived above from heroHeight+collapsibleHeight
        // instead (the collapsible piece is `position: absolute` there, so this
        // surface's own layout no longer includes it) — skip so the two don't
        // fight each other.
        onLayout={
          isWeb ? undefined : (event) => setHeaderHeight(event.nativeEvent.layout.height)
        }
        baseStyle={[styles.header, { backgroundColor: palette.background }]}
        // On web this outer surface never translates — the hero (its first
        // child, immediately below) stays fixed in place unconditionally; only
        // the inner wrapper further down (the collapsible content) moves. On
        // native the whole cluster still collapses together as one unit,
        // unchanged — except while search is open: pinned at 0 so the search
        // field (which lives in this same cluster on native) can't scroll out
        // from under the user mid-search, matching the web-side guard in the
        // scroll listener above. `headerTranslate` keeps updating live off
        // `scrollY` underneath, so un-pinning on close has no jump to correct.
        animatedStyle={{ transform: [{ translateY: isWeb || searchOpen ? 0 : headerTranslate }] }}
      >
        <View
          onLayout={(event) => setHeroHeight(event.nativeEvent.layout.height)}
          style={[
            styles.hero,
            { maxWidth: contentMaxWidth, paddingTop: insets.top + 6, position: 'relative', zIndex: 2 },
          ]}
        >
          {/* Compact single-row hero: the brand wordmark with the saved-count
              sitting inline on its baseline, and a bare settings gear. The old
              stacked tagline + count lines and the "설정" caption were pure
              vertical chrome that pushed the first card down ~40% of the
              screen, so they're folded away here to reclaim that space. */}
          <View style={styles.heroTitleBlock}>
            {/* The brand wordmark is a pre-rendered image (the Keepory duckling
                lockup) rather than bundled fonts — a few KB of PNG instead of
                multi-MB font files. Every locale uses the same lockup; a
                light/dark variant matches the theme. Tapping it scrolls the
                list back to the top, the same as tapping a title bar. */}
            <Pressable
              testID="inbox-hero-wordmark"
              accessibilityRole="button"
              accessibilityLabel={wordmarkLabel}
              accessibilityHint={t('inbox.scrollToTopA11y')}
              hitSlop={8}
              onPress={scrollToTop}
              style={[
                styles.heroWordmarkBox,
                { width: wordmarkWidth, height: WORDMARK_HEIGHT },
              ]}
            >
              <Image
                accessible={false}
                testID="inbox-wordmark-image"
                source={wordmark.source}
                resizeMode="contain"
                onLoad={() => setWordmarkLoaded(true)}
                // If the asset can't be loaded, keep the text wordmark visible
                // instead of leaving a blank space (see showWordmarkFallback).
                onError={() => {
                  setWordmarkFailed(true);
                  setWordmarkLoaded(false);
                }}
                // Size with an EXPLICIT width+height (derived from the asset ratio),
                // not height+aspectRatio. In this flex row, height+aspectRatio let
                // Yoga fall back toward the PNG's huge intrinsic size and the
                // wordmark blew up to fill the screen on native (the column layout
                // this came from constrained it via alignSelf:'flex-start'). An
                // explicit box removes that ambiguity.
                style={[
                  styles.heroWordmark,
                  { width: wordmarkWidth, height: WORDMARK_HEIGHT },
                  showWordmarkFallback ? styles.heroWordmarkHidden : null,
                ]}
              />
              {showWordmarkFallback ? (
                <Text
                  accessible={false}
                  testID="inbox-wordmark-fallback"
                  style={[styles.heroWordmarkFallback, { color: palette.text }]}
                  numberOfLines={1}
                >
                  {t('app.name')}
                </Text>
              ) : null}
            </Pressable>
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
                {...preventMouseDownFocusSteal}
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
        {/* Everything below the hero — error/session banners, search, sort/
            filter pills, browse shelf — is what actually collapses (see the
            state declaration above for the full rationale). On native this is
            a plain in-flow sibling with no style override — untouched, that
            platform's collapse still happens one level up via
            `headerTranslate`. overlayLayer(1) (below the hero's zIndex 2, see
            the hero View) so it never paints over the pinned hero
            mid-transition, even while passing through its rectangle on the
            way off-screen (caught in PR review — position/elevation alone
            don't control paint order between two absolutely-positioned
            siblings; z-index does). Using overlayLayer() rather than a bare
            zIndex — its elevation is a no-op on web but keeps this block out
            of the zIndex-without-elevation lint (STASH-7), which is a static
            text scan that can't see the `isWeb` runtime gate. */}
        <View
          testID="inbox-collapsible-header"
          onLayout={(event) => setCollapsibleHeight(event.nativeEvent.layout.height)}
          pointerEvents="box-none"
          style={
            isWeb
              ? ([
                  {
                    position: 'absolute',
                    top: heroHeight,
                    left: 0,
                    right: 0,
                    ...overlayLayer(1),
                    backgroundColor: palette.background,
                    transform: [
                      {
                        translateY: headerCollapse.collapsed
                          ? -(heroHeight + collapsibleHeight)
                          : 0,
                      },
                    ],
                    transition: 'transform 200ms ease-out',
                  },
                ] as unknown as StyleProp<ViewStyle>)
              : undefined
          }
        >
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
            <Text style={{ color: palette.danger, fontSize: 13, textAlign: 'center' }}>
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
                trackBreadcrumb('search', 'field focus');
                clearBlurHide();
                setSearchFocused(true);
              }}
              onBlur={() => {
                // Diagnostic for the "search icon tap does nothing, field never
                // appears" report: this is the ONLY place besides closeSearch()
                // that can drop searchOpen back to false, and closeSearch()
                // already logs its own breadcrumb — so an unexplained close with
                // no preceding 'close' breadcrumb means THIS path fired instead,
                // and this line pins down why (an empty query so soon after
                // opening that focus never stuck is exactly the "opens then
                // immediately, silently closes itself" symptom).
                trackBreadcrumb('search', 'field blur', {
                  queryEmpty: query.length === 0,
                  scrollY: Math.round(lastScrollYRef.current),
                });
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
                    trackBreadcrumb('search', 'auto-close on empty blur');
                    setSearchOpen(false);
                    restoreHeaderCollapseOnSearchClose();
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
            maxWidth={contentMaxWidth}
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
            accessibilityLabel={t('inbox.sortA11y', { label: t(activeSortLabelKey) })}
            onPress={() => setSortMenuOpen(true)}
            style={[styles.sortPill, styles.sortPillFlexible, { backgroundColor: palette.surface, borderColor: palette.border }]}
          >
            <Ionicons name={activeSortIcon} size={15} color={palette.textSecondary} />
            <Text style={[styles.sortPillLabel, { color: palette.text }]} numberOfLines={1}>
              {t(activeSortLabelKey)}
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
              {showPillLabels ? (
                <Text style={[styles.sortPillLabel, { color: palette.text }]} numberOfLines={1}>
                  {t('nav.browseTags')}
                </Text>
              ) : null}
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
              {showPillLabels ? (
                <Text style={[styles.sortPillLabel, { color: palette.text }]} numberOfLines={1}>
                  {t('nav.graph')}
                </Text>
              ) : null}
            </Pressable>
          ) : null}
          <View style={[styles.viewSegment, { backgroundColor: palette.surface, borderColor: palette.border }]}>
            {VIEW_MODES.map((mode) => {
              // Folder View has nothing to show without a real Collection to
              // tile — hide the toggle entirely rather than offering a mode
              // that always renders just the uncollected bucket + "New
              // folder". Mirrors the `inbox.length > 0` gate on the Tags/
              // Graph pills above, keyed on collection count instead.
              if (mode === 'folder' && collections.length === 0) {
                return null;
              }
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
                    color={active ? palette.accentText : palette.textSecondary}
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
              contentContainerStyle={[styles.shelfContent, isWeb ? styles.shelfContentWeb : null]}
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
                  quiet={Platform.OS === 'web' && !hasNewSuggestions}
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
        </View>
      </WebCrispAnimatedSurface>
      {showFilterBar && scope ? (
        // Pinned active-filter bar: its OWN non-translating layer between the
        // header (zIndex 10, which must stay above so it covers the bar when
        // revealed) and the list. It rides the header's diffClamp but clamps at
        // the safe-area top, so its clear/back action stays tappable while
        // scrolled to the bottom. Resting top = headerHeight; it slides up from
        // there. Opaque base so list rows can't bleed through the tint.
        <WebCrispAnimatedSurface
          testID="inbox-filter-bar"
          // box-none for the same reason as the header: its elevation
          // (overlayLayer, STASH-7) would otherwise capture touches across the
          // whole rect — and across the dead zone the collapse translateY
          // leaves behind on Android — eating taps meant for the list. The
          // opaque filterBarInner child still fills and owns the visible strip,
          // so the clear action stays tappable.
          pointerEvents="box-none"
          onLayout={(event) => setFilterBarHeight(event.nativeEvent.layout.height)}
          baseStyle={[
            styles.filterBar,
            {
              top: headerHeight,
              backgroundColor: palette.background,
              borderBottomColor: palette.border,
            },
          ]}
          // Rides the same shared `headerClamp` as the header (see its
          // definition above), so while search is open it needs the same pin:
          // otherwise this bar keeps riding up toward its floor as the results
          // list scrolls even though the header above it is now pinned at 0,
          // and ends up sliding under the still-expanded, opaque header —
          // hiding its own clear action (caught in PR review, Codex).
          animatedStyle={{ transform: [{ translateY: searchOpen ? 0 : filterBarTranslate }] }}
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
        </WebCrispAnimatedSurface>
      ) : null}
      <InboxList
        ref={listRef}
        testID="inbox-list"
        data={viewMode === 'folder' ? folderGridData : gridData}
        keyExtractor={(item) => item.id}
        // Remount when the column count changes: FlatList forbids mutating
        // numColumns on an existing instance.
        key={`grid-${viewMode}-${columns}`}
        numColumns={columns}
        columnWrapperStyle={columns > 1 ? { gap: WEB_CARD_GRID_COLUMN_GAP } : undefined}
        style={isWeb ? styles.webListNoTransform : undefined}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
          useNativeDriver: !isWeb,
          listener: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
            const y = event.nativeEvent.contentOffset.y;
            lastScrollYRef.current = y;
            // `headerCollapseRef` is tracked on BOTH platforms — not just
            // web. `setHeaderCollapse` below (the actual React state) still
            // only drives web's CSS-transform collapsible wrapper; native's
            // real collapse animation is the separate Animated.diffClamp
            // `headerTranslate`, untouched here. But native needs SOME
            // synchronous "is the header currently collapsed" signal too,
            // for openSearch's focus-defer decision — this ref used to only
            // update in the web branch, so on the native APK (where
            // STASH-33/34/35 also reports) it stayed stuck at the initial
            // `collapsed: false` forever and the defer branch never ran for
            // the exact case it targets (caught in PR review, Codex).
            if (searchOpen) {
              // While the search UI is open, scroll must never collapse it
              // out from under the user — openSearch forced it expanded on
              // open, and it should stay that way regardless of how far
              // they scroll through results, until they explicitly close
              // search. Keep tracking the anchor (not just freezing it) so
              // a later close doesn't compare against a stale point and
              // collapse immediately.
              headerCollapseRef.current = { collapsed: false, anchorScrollY: y };
            } else {
              const next = nextHeaderCollapseState(headerCollapseRef.current, y, collapsibleHeight);
              const flipped = next.collapsed !== headerCollapseRef.current.collapsed;
              headerCollapseRef.current = next;
              if (isWeb && flipped) {
                setHeaderCollapse(next);
              }
            }
          },
        })}
        scrollEventThrottle={16}
        // Dragging the results dismisses the keyboard (→ keyboardDidHide drops the
        // focused state and the suggestion shelf). The shelf's own ScrollView owns
        // keyboardShouldPersistTaps for its chips; this list doesn't need it.
        // Suppressed for a brief window right after opening search
        // (suppressOnDragDismiss) — see the comment above openSearch,
        // STASH-33/34/35/36: a real finger's incidental movement from the
        // SAME tap that opened search can register as a drag-start on this
        // list and fire an on-drag dismiss milliseconds later, which is
        // indistinguishable from a real one and closes search right back up.
        keyboardDismissMode={suppressOnDragDismiss ? 'none' : 'on-drag'}
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
          <>
            {/* Anonymous-account nudge: inline, above the list content, below the
                search/filter shelf (which lives outside the list). Renders nothing
                until the user is anonymous with a real (2+) library and hasn't
                dismissed it durably. */}
            <AnonymousNudgeBanner
              isAnonymous={auth.status === 'anonymous'}
              bookmarkCount={inbox.length}
            />
            {/* The section label only earns its vertical space while searching,
                where the match COUNT is real information. In the default/faceted
                state it's redundant chrome: a newest-first list obviously leads
                with the newest item, and a narrowed view is already named by the
                pinned filter bar — so drop it to lift the first card up the screen.
                (Still hidden on a zero-result search, where the recovery card
                already says "no matches", to avoid a double-negative.) */}
            {searching && visible.length > 0 ? (
              <Text style={[styles.sectionLabel, { color: palette.textSecondary }]}>
                {sectionLabel}
              </Text>
            ) : null}
          </>
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
            // First run: teach the real capture path for THIS platform. Native's
            // whole point is the share sheet; web has no share intent
            // (expo-share-intent is a no-op there — see share/), so it must not
            // promise a "Share a link from any app" flow that doesn't exist here.
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
              {isWeb ? (
                <>
                  <View style={styles.emptyHintRow} testID="inbox-empty-web-step">
                    <Ionicons
                      name="add-circle-outline"
                      size={18}
                      color={palette.accent}
                      style={styles.emptyHintIcon}
                    />
                    <Text style={[styles.emptyHintText, { color: palette.textSecondary }]}>
                      {t('inbox.emptyHintWebStep')}
                    </Text>
                  </View>
                  <View style={[styles.emptyDivider, { backgroundColor: palette.border }]} />
                  <Text style={[styles.emptyHintFallback, { color: palette.textSecondary }]}>
                    {t('inbox.emptyHintWebNote')}
                  </Text>
                  {/* No live Play Store listing yet (see docs/development/play-store.md),
                      so this is a soft, disabled pill rather than a link to nowhere. */}
                  <Button variant="ghost" size="sm" disabled style={styles.emptyPlatformPill}>
                    {t('inbox.emptyHintWebGetAndroid')}
                  </Button>
                </>
              ) : (
                <>
                  <View style={styles.emptyHintRow} testID="inbox-empty-step-1">
                    <Text style={[styles.emptyStepNumber, { color: palette.accent }]}>1</Text>
                    <Ionicons
                      name="share-outline"
                      size={18}
                      color={palette.accent}
                      style={styles.emptyHintIcon}
                    />
                    <Text style={[styles.emptyHintText, { color: palette.textSecondary }]}>
                      {t('inbox.emptyHintStep1')}
                    </Text>
                  </View>
                  <View style={styles.emptyHintRow} testID="inbox-empty-step-2">
                    <Text style={[styles.emptyStepNumber, { color: palette.accent }]}>2</Text>
                    <Ionicons
                      name="bookmark-outline"
                      size={18}
                      color={palette.accent}
                      style={styles.emptyHintIcon}
                    />
                    <Text style={[styles.emptyHintText, { color: palette.textSecondary }]}>
                      {t('inbox.emptyHintStep2')}
                    </Text>
                  </View>
                  <View style={[styles.emptyDivider, { backgroundColor: palette.border }]} />
                  <Text style={[styles.emptyHintFallback, { color: palette.textSecondary }]}>
                    {t('inbox.emptyHintFallback')}
                  </Text>
                  <Button
                    variant="ghost"
                    size="sm"
                    style={styles.emptyPlatformPill}
                    onPress={() => void Linking.openURL('https://keepory.app').catch(() => {})}
                  >
                    {t('inbox.emptyHintGetWeb')}
                  </Button>
                </>
              )}
            </View>
          )
        }
        extraData={`${viewMode}|${searching}|${debouncedQuery}`}
        renderItem={({ item }) => {
          // A grid-padding filler: render an empty flex cell so the real cards
          // on the final row keep their column width instead of stretching.
          if ('__placeholder' in item) {
            return (
              <View
                testID={item.role === 'selected-row' ? 'inbox-grid-selected-row-filler' : 'inbox-grid-filler'}
                style={{ flex: 1 }}
              />
            );
          }
          if ('__inlineDetail' in item) {
            const detail = (
              <BookmarkDetailScreen
                inlineId={item.bookmarkId}
                onInlineClose={() => setInlineDetailId(null)}
                markAccessOnMount={false}
                hidePreviewHero={viewMode === 'card'}
              />
            );
            const detailWidth =
              contentMaxWidth - LIST_PADDING * 2 - WEB_CARD_GRID_COLUMN_GAP * (columns - 1);
            return item.fullWidth ? (
              <View testID="inbox-inline-detail-row" style={{ width: detailWidth }}>{detail}</View>
            ) : detail;
          }
          if ('__folderTile' in item) {
            if (item.kind === 'new') {
              return (
                <Pressable
                  testID="folder-tile-new"
                  accessibilityRole="button"
                  accessibilityLabel={t('inbox.newCollectionA11y')}
                  onPress={onNewFolderTilePress}
                  style={[styles.folderTile, styles.folderTileNew, { borderColor: palette.border }]}
                >
                  <Ionicons name="add-outline" size={22} color={palette.textSecondary} />
                  <Text style={[styles.folderTileLabel, { color: palette.textSecondary }]} numberOfLines={1}>
                    {t('inbox.newCollection')}
                  </Text>
                </Pressable>
              );
            }
            const tileIcon = item.kind === 'uncollected' ? 'file-tray-outline' : 'folder-outline';
            const tileColor = item.kind === 'uncollected' ? palette.mutedSurface : palette[item.colorKey ?? 'accentSoft'];
            return (
              <Pressable
                testID={`folder-tile-${item.id}`}
                accessibilityRole="button"
                accessibilityLabel={item.label}
                onPress={() => item.filter && openFolderTile(item.filter)}
                style={[styles.folderTile, { backgroundColor: tileColor }]}
              >
                <Ionicons name={tileIcon} size={26} color={palette.text} />
                <Text style={[styles.folderTileLabel, { color: palette.text }]} numberOfLines={1}>
                  {item.label}
                </Text>
                <Text style={[styles.folderTileCount, { color: palette.textSecondary }]}>
                  {t('inbox.collectionTileCount', { count: item.count ?? 0 })}
                </Text>
              </Pressable>
            );
          }
          const status = statusLabel(item, t);
          const collectionName = getCollection(item.collection_id)?.name ?? null;
          const cardTags = getTagsForBookmark(item.id);
          // Pending AI suggestions = high-confidence suggested tags not yet
          // applied PLUS a pending folder recommendation PLUS a pending summary
          // (see @/domain/ai-suggestions), surfaced so they're reviewable from
          // the list rather than buried in Detail. Counts the folder/summary too
          // so a folder- or summary-only bookmark still shows the "✨" badge,
          // matching the banner/Settings/Review inclusion rule.
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
              : 0) +
            (pendingSummary(
              item.metadata_status,
              cardEnrichment,
              getReviewedSummary(item.id),
              item.title,
            )
              ? 1
              : 0);
          const openDetail = () => {
            if (Platform.OS === 'web') {
              setInlineDetailId((current) => (current === item.id ? null : item.id));
              return;
            }
            router.push({ pathname: '/bookmark/[id]', params: { id: item.id } });
          };
          const openLink = () => {
            if (item.url) {
              markBookmarkAccessed(item.id);
              void Linking.openURL(item.url).catch(() => {});
            }
          };

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
          const visibleMetaParts = metaParts.slice(0, Platform.OS === 'web' && !searching ? 2 : 3);
          const siteLabelText = siteLabel(item);
          // The clean site label is always the primary, persistent text (STASH-39).
          // A query term can additionally match only in the URL's path/query
          // string, not in the label — e.g. "98765" against
          // https://example.com/article/98765, possibly alongside another term
          // that DOES match the label (site_name "WIRED" + "98765" in the URL).
          // filterBookmarks ANDs terms, so when any term is covered only by the
          // URL, show it as a second line in addition to the label — not instead
          // of it, so a simultaneous label-only match stays visible too
          // (AGENTS.md: search highlights title and URL matches).
          const termHiddenByLabel = (term: string) =>
            valueMatchesTerms(item.url, [term]) && !valueMatchesTerms(siteLabelText, [term]);
          const showUrlMatchLine = Boolean(
            searching && item.url && searchTerms.some(termHiddenByLabel),
          );

          // List density view mode: compact row layout featuring thumbnail image
          // with quick-open badge, title/url/tags in middle, and overflow menu.
          if (viewMode === 'list') {
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
                accessible={false}
              >
                <Pressable
                  accessibilityRole={item.url ? 'link' : 'button'}
                  accessibilityLabel={item.url ? t('common.openLink') : (accessibilityTitle(item) ?? t('common.untitled'))}
                  onPress={item.url ? openLink : openDetail}
                  onLongPress={() => setMenuItem(item)}
                  hitSlop={6}
                  style={({ pressed }) => [
                    styles.compactThumbWrap,
                    {
                      borderColor: item.url ? palette.accent : palette.border,
                      opacity: pressed ? 0.75 : 1,
                    },
                  ]}
                >
                  {thumbUri ? (
                    <Image
                      testID="inbox-compact-thumb"
                      source={{ uri: thumbUri }}
                      style={[styles.compactThumb, { backgroundColor: palette.mutedSurface }]}
                    />
                  ) : (
                    <ItemIcon item={item} testID="inbox-list-monogram" />
                  )}
                  {item.url ? (
                    <View style={[styles.thumbMiniBadge, { backgroundColor: palette.accent, borderColor: palette.surfaceElevated }]}>
                      <Ionicons name="open-outline" size={11} color="#ffffff" />
                    </View>
                  ) : null}
                </Pressable>
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
                      {
                        color: isTitleDerived(item) ? palette.textSecondary : palette.text,
                        fontWeight: isTitleDerived(item) ? WEB_MEDIUM_WEIGHT : WEB_SEMIBOLD_WEIGHT,
                      },
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
                      text={siteLabelText}
                      query={highlightQuery}
                      highlightStyle={highlightStyle}
                    />
                  ) : null}
                  {showUrlMatchLine && item.url ? (
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
                {suggestionCount > 0 ? (
                  <View
                    accessibilityLabel={t('inbox.aiSuggestionsA11y', { count: suggestionCount })}
                    style={[styles.suggestBadge, { backgroundColor: palette.accentSoft, borderColor: palette.accent }]}
                  >
                    <Text style={[styles.suggestBadgeLabel, { color: palette.accentText }]}>
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
              </Pressable>
            );
          }

          const previewUri = item.local_image_uri ?? item.preview_image_url ?? null;
          const cardElement = (
            <Card style={styles.card}>
              <View
                // Container for card layout
                accessible={false}
              >
                {previewUri ? (
                  <View style={styles.cardPreviewContainer}>
                    <Pressable
                      testID="inbox-card-preview"
                      accessible={false}
                      onPress={openDetail}
                      onLongPress={() => setMenuItem(item)}
                      style={StyleSheet.absoluteFill}
                    >
                      <Image
                        source={{ uri: previewUri }}
                        style={styles.cardPreview}
                      />
                    </Pressable>
                    {item.url ? (
                      <Pressable
                        accessibilityRole="link"
                        accessibilityLabel={t('common.openLink')}
                        onPress={openLink}
                        onLongPress={() => setMenuItem(item)}
                        hitSlop={6}
                        style={styles.previewRibbon}
                      >
                        <Text style={styles.previewRibbonText} numberOfLines={1}>
                          {siteLabel(item)}
                        </Text>
                        <Ionicons name="open-outline" size={12} color="#ffffff" />
                      </Pressable>
                    ) : null}
                  </View>
                ) : null}
                {!previewUri && item.url ? (
                  // Mirrors the ribbon's position over a preview image: the
                  // site-name + open-link pill sits above the title instead
                  // of below it, so the "where does this link go" affordance
                  // lands in the same place regardless of preview image. The
                  // row itself opens the detail view so the space to the
                  // left of the pill is tappable too, not just dead space.
                  <Pressable
                    accessible={false}
                    onPress={openDetail}
                    onLongPress={() => setMenuItem(item)}
                    style={styles.cardUrlRowTop}
                  >
                    <Pressable
                      accessibilityRole="link"
                      accessibilityLabel={t('common.openLink')}
                      onPress={openLink}
                      onLongPress={() => setMenuItem(item)}
                      hitSlop={6}
                      style={[styles.cardUrlOpenPill, { backgroundColor: palette.accentSoft, borderColor: palette.accent }]}
                    >
                      <HighlightedText
                        style={[styles.cardUrlOpenPillText, { color: palette.accentText }]}
                        numberOfLines={1}
                        text={siteLabelText}
                        query={highlightQuery}
                        highlightStyle={highlightStyle}
                      />
                      <Ionicons name="open-outline" size={13} color={palette.accentText} />
                    </Pressable>
                  </Pressable>
                ) : null}
                <View
                  style={[
                    styles.cardBody,
                    Platform.OS === 'web' && columns > 1 && !previewUri ? styles.cardBodyTextOnlyWeb : null,
                  ]}
                >
                  <View style={styles.cardTitleRow}>
                    {/* Not independently labelled: it's a supplementary tap
                        target over the same action the title/link pill
                        already exposes to screen readers, so it stays out
                        of the accessibility tree rather than duplicating
                        the "Open link" label. */}
                    <Pressable
                      accessible={false}
                      onPress={item.url ? openLink : openDetail}
                      onLongPress={() => setMenuItem(item)}
                      hitSlop={6}
                    >
                      <ItemIcon item={item} testID="inbox-card-monogram" />
                    </Pressable>
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
                        {
                          color: isTitleDerived(item) ? palette.textSecondary : palette.text,
                          fontWeight: isTitleDerived(item) ? WEB_MEDIUM_WEIGHT : WEB_BOLD_WEIGHT,
                        },
                      ]}
                      numberOfLines={1}
                      text={displayTitle(item) ?? t('common.untitled')}
                      query={highlightQuery}
                      highlightStyle={highlightStyle}
                    />
                  </Pressable>
                  {suggestionCount > 0 ? (
                    <View
                      accessibilityLabel={t('inbox.aiSuggestionsA11y', { count: suggestionCount })}
                      style={[styles.suggestBadge, { backgroundColor: palette.accentSoft, borderColor: palette.accent }]}
                    >
                      <Text style={[styles.suggestBadgeLabel, { color: palette.accentText }]}>
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
                {showUrlMatchLine && item.url ? (
                  <HighlightedText
                    style={[styles.cardUrl, { color: palette.textSecondary }]}
                    numberOfLines={1}
                    text={item.url}
                    query={highlightQuery}
                    highlightStyle={highlightStyle}
                  />
                ) : null}
                {visibleMetaParts.length > 0 ? (
                  <View style={styles.metaChipRow}>
                    {visibleMetaParts.map((part) => (
                      <View
                        key={part}
                        style={[
                          styles.metaChip,
                          Platform.OS === 'web'
                            ? { backgroundColor: palette.surface, borderColor: palette.border }
                            : { backgroundColor: palette.mutedSurface },
                        ]}
                      >
                        <Text
                          style={[
                            styles.metaChipLabel,
                            { color: Platform.OS === 'web' ? palette.textSecondary : palette.accentText },
                          ]}
                          numberOfLines={1}
                        >
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
              </View>
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
        actions={
          isFolderSort
            ? FOLDER_SORT_PRESETS.map((option) => ({
                key: serializeFolderSort(option),
                label: t(FOLDER_SORT_LABEL_KEY[serializeFolderSort(option)]),
                icon: FOLDER_SORT_ICON[option.field],
                selected: sameFolderSort(option, folderSort),
                onPress: () => {
                  setFolderSort(option);
                  setSortMenuOpen(false);
                },
              }))
            : SORT_PRESETS.map((option) => ({
                key: serializeSort(option),
                label: t(SORT_LABEL_KEY[serializeSort(option)]),
                icon: SORT_ICON[option.field],
                selected: sameSort(option, sort),
                onPress: () => {
                  setSort(option);
                  setSortMenuOpen(false);
                },
              }))
        }
        onClose={() => setSortMenuOpen(false)}
      />
      <CreateCollectionDialog
        visible={newFolderDialogOpen}
        busy={newFolderBusy}
        error={newFolderError}
        onCreate={handleCreateFolder}
        onClose={closeNewFolderDialog}
      />
    </InboxRootSurface>
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
    padding: LIST_PADDING,
    gap: 10,
    width: '100%',
    alignSelf: 'center',
  },
  webListNoTransform: {
    transform: [],
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
    paddingBottom: 8,
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
  heroWordmarkBox: {
    // Concrete width+height are set inline from WORDMARK_HEIGHT × the asset
    // ratio. flexShrink:0 so the row never squeezes it.
    flexShrink: 0,
    justifyContent: 'center',
    position: 'relative',
  },
  heroWordmark: {
    left: 0,
    position: 'absolute',
    top: 0,
  },
  heroWordmarkHidden: {
    opacity: 0,
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
    width: 38,
    height: 38,
    borderRadius: 19,
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
  // Leading "1"/"2" marker on each teach row, making the 2-step order explicit
  // rather than implied by top-to-bottom position alone.
  emptyStepNumber: {
    fontSize: 13,
    fontWeight: '700',
    marginRight: 8,
    marginTop: 1,
    width: 14,
  },
  emptyDivider: {
    width: 160,
    height: StyleSheet.hairlineWidth,
    marginVertical: 14,
  },
  emptyHintFallback: {
    fontSize: 12,
    textAlign: 'center',
    maxWidth: 280,
  },
  emptyPlatformPill: {
    marginTop: 14,
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
    fontWeight: WEB_SEMIBOLD_WEIGHT,
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
    paddingVertical: 8,
    paddingHorizontal: 14,
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
  shelfContentWeb: {
    gap: 10,
  },
  // Web-only browse-shelf wrapper (positions the ShelfEdge overlays). Referenced
  // only behind Platform.OS === 'web', so it never touches the native layout.
  // The edge/fade/button styles live with `ShelfEdge` in @/ui/ShelfEdges.
  shelfWrap: {
    position: 'relative',
    width: '100%',
    alignSelf: 'center',
  },
  card: {
    borderRadius: 28,
    overflow: 'hidden',
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 13,
    paddingHorizontal: 16,
  },
  listIcon: {
    width: 28,
    height: 28,
    borderRadius: 8,
  },
  listText: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  // Compact rows are a touch taller than list rows to give the thumbnail and the
  // extra meta line room without crowding — still roughly half a card's height.
  compactRow: {
    alignItems: 'center',
    paddingVertical: 10,
  },
  compactThumbWrap: {
    position: 'relative',
    width: 48,
    height: 48,
    borderRadius: 12,
    borderWidth: 1.5,
    overflow: 'visible',
    alignItems: 'center',
    justifyContent: 'center',
  },
  compactThumb: {
    width: 44,
    height: 44,
    borderRadius: 10,
  },
  thumbMiniBadge: {
    position: 'absolute',
    bottom: -3,
    right: -3,
    borderRadius: 999,
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
  compactMeta: {
    fontSize: 12,
    fontWeight: WEB_MEDIUM_WEIGHT,
    marginTop: 1,
  },
  listTitle: {
    fontSize: 15,
    fontWeight: WEB_SEMIBOLD_WEIGHT,
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
  cardPreviewContainer: {
    position: 'relative',
    width: '100%',
    height: CARD_PREVIEW_HEIGHT,
  },
  cardPreview: {
    width: '100%',
    height: CARD_PREVIEW_HEIGHT,
  },
  previewRibbon: {
    position: 'absolute',
    top: 10,
    right: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(15, 23, 42, 0.75)',
    borderRadius: 999,
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.3)',
  },
  previewRibbonText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: WEB_SEMIBOLD_WEIGHT,
    maxWidth: 140,
  },
  cardBody: {
    padding: 16,
    gap: 9,
  },
  cardBodyTextOnlyWeb: {
    paddingVertical: 13,
    gap: 6,
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
    fontWeight: WEB_SEMIBOLD_WEIGHT,
  },
  cardTitlePressable: {
    flex: 1,
    minWidth: 0,
  },
  cardTitle: {
    flex: 1,
    fontSize: 19,
    fontWeight: WEB_BOLD_WEIGHT,
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
    fontWeight: WEB_SEMIBOLD_WEIGHT,
  },
  cardUrlRowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 14,
  },
  cardUrl: {
    flexShrink: 1,
    fontSize: Platform.select({ web: 12, default: 13 }),
    lineHeight: Platform.select({ web: 16, default: undefined }),
  },
  cardUrlOpenPill: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  cardUrlOpenPillText: {
    fontSize: 11,
    fontWeight: WEB_SEMIBOLD_WEIGHT,
    maxWidth: 140,
  },
  metaChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  metaChip: {
    borderRadius: 999,
    borderWidth: Platform.select({ web: StyleSheet.hairlineWidth, default: 0 }),
    paddingVertical: Platform.select({ web: 2, default: 4 }),
    paddingHorizontal: Platform.select({ web: 8, default: 9 }),
  },
  metaChipLabel: {
    fontSize: Platform.select({ web: 11, default: 12 }),
    fontWeight: Platform.select({ web: WEB_MEDIUM_WEIGHT, default: WEB_SEMIBOLD_WEIGHT }),
  },
  cardStatus: {
    fontSize: 12,
    fontWeight: WEB_MEDIUM_WEIGHT,
  },
  folderTile: {
    flex: 1,
    minHeight: 116,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 16,
  },
  folderTileNew: {
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
    backgroundColor: 'transparent',
  },
  folderTileLabel: {
    fontSize: 14,
    fontWeight: WEB_SEMIBOLD_WEIGHT,
    textAlign: 'center',
    maxWidth: '100%',
  },
  folderTileCount: {
    fontSize: 12,
    fontWeight: WEB_MEDIUM_WEIGHT,
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
