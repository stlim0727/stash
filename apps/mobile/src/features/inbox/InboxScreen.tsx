import { AccountLibraryNotice } from '@/ui/AccountLibraryNotice';
import { useNetworkOffline } from '@/ui/use-network-offline';
import { createInboxItemRenderer } from '@/features/inbox/InboxItemRenderer';
import { AnimatedFlatList, CONTENT_MAX_WIDTH, FOLDER_SORT_ICON, FOLDER_SORT_LABEL_KEY, SETTINGS_PANEL_WIDTH, SETTINGS_SHEET_MIN_WIDTH, SORT_ICON, SORT_LABEL_KEY, VIEW_MODE_ICON, VIEW_MODE_LABEL_KEY, WEB_CARD_GRID_COLUMN_GAP, WEB_CARD_GRID_TOP_GAP, preventMouseDownFocusSteal, styles } from '@/features/inbox/layout';
import { InboxRootSurface, WebCrispAnimatedSurface, queryTerms } from '@/features/inbox/presentation';
import { type GridPlaceholder, type InboxListItem } from '@/features/inbox/types';
import { useInboxResults } from '@/features/inbox/use-inbox-results';
import { useInboxSearch } from '@/features/inbox/use-inbox-search';
import { useInboxSelection } from '@/features/inbox/use-inbox-selection';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, usePathname, useRouter } from 'expo-router';
import { PostHogMaskView } from 'posthog-react-native';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps
} from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  BackHandler,
  FlatList,
  LayoutAnimation,
  Linking,
  Platform,
  Pressable,
  Share,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle
} from 'react-native';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { pendingSuggestedFolder, pendingSuggestions, pendingSummary } from '@/domain/ai-suggestions';
import { registerDetailOpenListener } from '@/domain/detail-navigation-signal';
import {
  ALL_FILTER,
  UNCOLLECTED_FILTER,
  sameFilter,
  type InboxFilter
} from '@/domain/filter';
import {
  DEFAULT_FOLDER_SORT,
  FOLDER_SORT_PREF_KEY,
  FOLDER_SORT_PRESETS,
  parseFolderSort,
  sameFolderSort,
  serializeFolderSort,
  type FolderSortOption
} from '@/domain/folder-sort';
import {
  INITIAL_HEADER_COLLAPSE_STATE,
  nextHeaderCollapseState,
  type HeaderCollapseState,
} from '@/domain/header-collapse';
import { displayTitle } from '@/domain/item-display';
import {
  usePreviewImageFailuresVersion
} from '@/domain/preview-image-cache';
import {
  RECENT_SEARCHES_PREF_KEY,
  addRecent,
  parseRecents,
  removeRecent,
  serializeRecents,
} from '@/domain/recent-searches';
import type { SearchSuggestion } from '@/domain/search-suggestions';
import {
  DEFAULT_SORT,
  INBOX_SORT_PREF_KEY,
  SORT_PRESETS,
  parseSort,
  sameSort,
  serializeSort,
  type SortOption
} from '@/domain/sort';
import type { Bookmark, Collection } from '@/domain/types';
import {
  DEFAULT_VIEW_MODE,
  INBOX_VIEW_PREF_KEY,
  parseViewMode,
  serializeViewMode,
  type ViewMode,
} from '@/domain/view-mode';
import { setHeroDiagnosticsSnapshot } from '@/feedback/hero-diagnostics-session';
import { useOpenReport } from '@/feedback/open-report';
import { useSearchSuggestions } from '@/hooks/useSearchSuggestions';
import { useT } from '@/i18n';
import { trackBreadcrumb } from '@/observability/sentry';
import { getPreference, setPreference } from '@/storage/preferences';
import { useBookmarks } from '@/store/bookmarks';
import { useSupabaseAuth } from '@/supabase/auth-provider';
import { usePalette } from '@/theme';
import { ActionSheet, type SheetAction } from '@/ui/ActionSheet';
import { AnonymousNudgeBanner } from '@/ui/AnonymousNudgeBanner';
import { BulkActionBar } from '@/ui/BulkActionBar';
import { BulkTagDialog } from '@/ui/BulkTagDialog';
import { Button } from '@/ui/Button';
import { useCaptureToast } from '@/ui/capture-toast';
import { CreateCollectionDialog } from '@/ui/CreateCollectionDialog';
import { DeleteCollectionDialog } from '@/ui/DeleteCollectionDialog';
import { FolderBulkActionBar } from '@/ui/FolderBulkActionBar';
import { overlayLayer } from '@/ui/layering';
import { LibraryHeader } from '@/ui/LibraryHeader';
import { LibraryStatus } from '@/ui/LibraryStatus';
import { MergeCollectionsDialog } from '@/ui/MergeCollectionsDialog';
import { RenameCollectionDialog } from '@/ui/RenameCollectionDialog';
import { SearchSuggestionShelf } from '@/ui/SearchSuggestionShelf';
import { splashCoordinator } from '@/ui/splash-coordinator';
import { TutorialModal } from '@/ui/TutorialModal';


export default function InboxScreen() {
  usePreviewImageFailuresVersion();
  const palette = usePalette();
  const t = useT();
  const rawInsets = useSafeAreaInsets();
  const insets = rawInsets ?? { top: 0, bottom: 0, left: 0, right: 0 };
  const router = useRouter();
  const { openReport, capturing } = useOpenReport('/');
  const [homeMenuOpen, setHomeMenuOpen] = useState(false);
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const auth = useSupabaseAuth();
  const offline = useNetworkOffline();
  const {
    inbox,
    queue,
    isLoading,
    isSyncing,
    syncNow,
    syncPaused,
    librarySyncFlow,
    accountLibraryState = 'ready',
    accountTransferCount = 0,
    dismissAccountTransfer,
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
    isResettingLibrary,
    trashBookmark,
    restoreBookmark,
    deleteBookmark,
    assignCollection,
    addTagsToBookmarks,
    markBookmarkAccessed,
    createCollection,
    renameCollection,
    deleteCollection,
    deleteCollections,
    mergeCollections,
    refreshBookmarkPreview,
  } = useBookmarks();
  const { show: showToast } = useCaptureToast();
  const [openingBookmarkId, setOpeningBookmarkId] = useState<string | null>(null);
  const openingBookmarkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isNavigatingRef = useRef(false);
  // Detail navigation is triggered immediately on tap to eliminate artificial
  // frame delays. If opening experiences a real delay (>150ms), show the busy
  // indicator on the card. When returning to the Inbox (gaining focus), clear the
  // timer and reset the busy state. Do not cancel on blur, so slow transitions
  // still display progress feedback while the Inbox remains visible. When Detail
  // mounts, it emits a signal so we cancel any pending timer immediately, avoiding
  // background re-renders of the large Inbox list when navigation was fast.
  useFocusEffect(
    useCallback(() => {
      if (openingBookmarkTimerRef.current !== null) {
        clearTimeout(openingBookmarkTimerRef.current);
        openingBookmarkTimerRef.current = null;
      }
      setOpeningBookmarkId(null);
      isNavigatingRef.current = false;
    }, []),
  );
  useEffect(() => {
    const unregister = registerDetailOpenListener(() => {
      if (openingBookmarkTimerRef.current !== null) {
        clearTimeout(openingBookmarkTimerRef.current);
        openingBookmarkTimerRef.current = null;
      }
      setOpeningBookmarkId(null);
      isNavigatingRef.current = false;
    });
    return () => {
      unregister();
      if (openingBookmarkTimerRef.current !== null) {
        clearTimeout(openingBookmarkTimerRef.current);
      }
    };
  }, []);


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
  const isWeb = Platform.OS === 'web';
  const isWebPlatform = isWeb;
  const {
    query,
    setQuery,
    debouncedQuery,
    searching,
    queryRef,
    searchOpen,
    setSearchOpen,
    searchFocused,
    setSearchFocused,
    blurHideTimer,
    clearBlurHide,
    searchRef,
    suppressOnDragDismiss,
    openSearch,
    restoreHeaderCollapseOnSearchClose,
    closeSearch,
  } = useInboxSearch({
    lastScrollYRef,
    headerCollapseRef,
    preSearchHeaderCollapseRef,
    preSearchCollapsibleHeightRef,
    collapsibleHeightRef,
    setHeaderCollapse,
  });
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

  // Long-press action menu: which bookmark it targets, and whether it's showing
  // the top-level actions or the "move to collection" picker. Null item = closed.
  const [menuItem, setMenuItem] = useState<Bookmark | null>(null);
  const [menuMode, setMenuMode] = useState<'main' | 'move'>('main');

  // Multi-select state: whether selection mode is active, the set of selected
  // bookmark IDs, and bulk action progression state.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkRefreshing, setBulkRefreshing] = useState(false);
  const [bulkMoveSheetOpen, setBulkMoveSheetOpen] = useState(false);
  const [bulkMoveFolderCreateTarget, setBulkMoveFolderCreateTarget] = useState<string[] | null>(null);
  const [bulkTagDialogOpen, setBulkTagDialogOpen] = useState(false);
  const [bulkTagBusy, setBulkTagBusy] = useState(false);
  const [bulkTagError, setBulkTagError] = useState<string | null>(null);

  // Folder View multi-select and collection management states
  const [folderSelectionMode, setFolderSelectionMode] = useState(false);
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(new Set());
  const [folderMenuItem, setFolderMenuItem] = useState<Collection | null>(null);

  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Collection | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteTargets, setDeleteTargets] = useState<Collection[]>([]);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [mergeSources, setMergeSources] = useState<Collection[]>([]);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [mergeBusy, setMergeBusy] = useState(false);
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
      wordmarkLoaded: true,
      wordmarkFailed: false,
      showWordmarkFallback: false,
    });
  }, [
    headerCollapse.collapsed,
    heroHeight,
    collapsibleHeight,
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
  const [viewOptionsReady, setViewOptionsReady] = useState(false);
  // Mirror the sort-pref guard: don't let the initial empty default clobber the
  // stored recents before they load.
  const recentsLoaded = useRef(false);
  const [recentsReady, setRecentsReady] = useState(false);
  // True while a recents persist write is in flight. The focus re-read (below)
  // must NOT clobber a just-submitted recent with a stale store read before its
  // async write commits — so it skips while this is set.
  const recentsDirty = useRef(false);
  useEffect(() => {
    if (isLoading) return;
    let active = true;
    getPreference(RECENT_SEARCHES_PREF_KEY)
      .then((raw) => {
        if (active) {
          setRecentSearches(parseRecents(raw));
        }
      })
      .catch(() => { })
      .finally(() => {
        recentsLoaded.current = true;
        if (active) setRecentsReady(true);
      });
    const sortRead = getPreference(INBOX_SORT_PREF_KEY)
      .then((raw) => {
        if (active) {
          setSort(parseSort(raw));
        }
      })
      .catch(() => { })
      .finally(() => {
        sortLoaded.current = true;
      });
    const folderSortRead = getPreference(FOLDER_SORT_PREF_KEY)
      .then((raw) => {
        if (active) {
          setFolderSort(parseFolderSort(raw));
        }
      })
      .catch(() => { })
      .finally(() => {
        folderSortLoaded.current = true;
      });
    const viewRead = getPreference(INBOX_VIEW_PREF_KEY)
      .then((raw) => {
        if (!active) {
          return;
        }
        // Restore explicit choices, including legacy compact/cloud mappings.
        setViewMode(parseViewMode(raw));
      })
      .catch(() => { })
      .finally(() => {
        viewLoaded.current = true;
      });
    void Promise.all([sortRead, folderSortRead, viewRead]).then(() => {
      if (active) setViewOptionsReady(true);
    });
    return () => {
      active = false;
    };
  }, [isLoading]);
  // Signal to the startup splash coordinator that the Inbox list layout and
  // its restored view preferences have committed, allowing the native splash
  // screen to dismiss smoothly without exposing an unhydrated loading state
  // or layout jump.
  useEffect(() => {
    if ((viewOptionsReady && !isLoading) || loadError) {
      splashCoordinator.signalInboxReady();
    }
  }, [viewOptionsReady, isLoading, loadError]);
  useEffect(() => {
    if (!sortLoaded.current) {
      return;
    }
    void setPreference(INBOX_SORT_PREF_KEY, serializeSort(sort)).catch(() => { });
  }, [sort]);
  useEffect(() => {
    if (!folderSortLoaded.current) {
      return;
    }
    void setPreference(FOLDER_SORT_PREF_KEY, serializeFolderSort(folderSort)).catch(() => { });
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
      .catch(() => { })
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
        .catch(() => { });
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
  const {
    tagIdsFor,
    chips,
    hasUncollected,
    collectionCounts,
    facetFiltered,
    clearFacetParams,
    filtered,
    visible,
    folderCollectionCounts,
    folderUncollectedCount,
    folderTiles,
    folderGridData,
  } = useInboxResults({
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
  });
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
  const [newFolderDialogOpen, setNewFolderDialogOpen] = useState(false);
  const {
    exitSelectionMode,
    enterSelectionMode,
    toggleSelect,
    allVisibleSelected,
    toggleSelectAll,
    exitFolderSelectionMode,
    enterFolderSelectionMode,
    toggleFolderSelect,
    selectableCollectionIds,
    allFoldersSelected,
    toggleSelectAllFolders,
    openRenameDialog,
    handleRenameFolder,
    openDeleteFolderDialog,
    handleDeleteFolders,
    openMergeFolderDialog,
    handleMergeFolders,
    deleteBookmarkCount,
    availableMergeTargets,
    folderMenuActions,
    handleBulkRefresh,
    handleBulkDelete,
    handleOpenBulkMove,
    handleBulkMoveToCollection,
    existingTagsForBulk,
    handleOpenBulkTag,
    handleBulkApplyTag,
  } = useInboxSelection({
    setSelectionMode,
    setSelectedIds,
    setBulkMoveSheetOpen,
    setNewFolderDialogOpen,
    setBulkMoveFolderCreateTarget,
    setBulkTagDialogOpen,
    setBulkTagError,
    clearBlurHide,
    setSearchFocused,
    searchRef,
    searchOpen,
    searching,
    closeSearch,
    visible,
    selectedIds,
    setFolderSelectionMode,
    setSelectedFolderIds,
    collections,
    selectedFolderIds,
    setRenameTarget,
    setRenameError,
    setRenameDialogOpen,
    renameTarget,
    setRenameBusy,
    renameCollection,
    showToast,
    t,
    setDeleteTargets,
    setDeleteDialogOpen,
    deleteTargets,
    setDeleteBusy,
    deleteCollection,
    deleteCollections,
    folderSelectionMode,
    filter,
    setFilter,
    setMergeSources,
    setMergeError,
    setMergeDialogOpen,
    mergeSources,
    setMergeBusy,
    mergeCollections,
    inbox,
    folderMenuItem,
    setFolderMenuItem,
    viewMode,
    selectionMode,
    isResettingLibrary,
    bulkRefreshing,
    setBulkRefreshing,
    refreshBookmarkPreview,
    trashBookmark,
    restoreBookmark,
    assignCollection,
    getTagsForBookmark,
    setBulkTagBusy,
    addTagsToBookmarks,
  });
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
  // The sort pill/menu shows one of two independent controls depending on the
  // active layout: Folder View's own name/count order, or the bookmark-level
  // date/accessed/name order everywhere else. Switching layouts never
  // disturbs the other control's state (see the two separate pref keys).
  const isFolderSort = viewMode === 'folder';
  // Record a submitted query into recents (trim + case-insensitive dedupe-to-
  // front + cap). The ONLY write path for recents — never on every keystroke.
  const recordRecent = useCallback((raw: string) => {
    if (!recentsLoaded.current) return;
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
  const showControls = inbox.length > 0 || searching || viewMode === 'folder';
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
      text: t('inbox.scopeFiltered', { label, count: visible.length }),
      icon: 'funnel-outline',
      action: 'clear-facet',
      a11y: t('inbox.scopeClearA11y'),
    };
  }, [searching, debouncedQuery, filter.kind, activeChip, visible.length, t]);

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
        if (folderSelectionMode) {
          exitFolderSelectionMode();
          return true;
        }
        if (selectionMode) {
          exitSelectionMode();
          return true;
        }
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
    }, [folderSelectionMode, exitFolderSelectionMode, selectionMode, exitSelectionMode, searchOpen, filter.kind, closeSearch]),
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
          void Linking.openURL(item.url!).catch(() => { });
        },
      });
    }
    const shareValue =
      item.url ??
      (item.content_type === 'text' && item.description?.trim() ? item.description : null);
    if (shareValue) {
      actions.push({
        key: 'share',
        label: t('common.share'),
        icon: 'share-social-outline',
        onPress: () => {
          closeMenu();
          void Share.share({
            message: shareValue,
            ...(item.url ? { url: item.url } : {}),
            title: item.title ?? undefined,
          }).catch(() => { });
        },
      });
    }
    actions.push({
      key: 'select',
      label: t('inbox.selectAction'),
      icon: 'checkbox-outline',
      onPress: () => {
        closeMenu();
        enterSelectionMode(item.id);
      },
    });
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
  }, [menuItem, menuMode, collections, assignCollection, trashBookmark, restoreBookmark, showToast, markBookmarkAccessed, closeMenu, enterSelectionMode, t]);

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
  const [newFolderBusy, setNewFolderBusy] = useState(false);
  const [newFolderError, setNewFolderError] = useState<string | null>(null);
  const [tutorialOpen, setTutorialOpen] = useState(false);
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
    setBulkMoveFolderCreateTarget(null);
  }, [newFolderBusy]);
  const handleCreateFolder = useCallback(
    async (name: string) => {
      setNewFolderBusy(true);
      setNewFolderError(null);
      const result = await createCollection(name);
      setNewFolderBusy(false);
      if (result.collection) {
        if (bulkMoveFolderCreateTarget && bulkMoveFolderCreateTarget.length > 0) {
          for (const id of bulkMoveFolderCreateTarget) {
            assignCollection(id, result.collection.id);
          }
          showToast(
            t('toast.movedToCollection', {
              count: bulkMoveFolderCreateTarget.length,
              name: result.collection.name,
            }),
          );
          setBulkMoveFolderCreateTarget(null);
          exitSelectionMode();
        }
        // No filter/navigation change — the new (empty) collection just shows
        // up as its own tile in the grid already on screen (folderTiles is
        // derived from the live `collections` list, so this re-render alone
        // picks it up; see the comment above folderTiles).
        setNewFolderDialogOpen(false);
        return;
      }
      setNewFolderError(result.error ?? t('detail.errorCreateCollection'));
    },
    [createCollection, bulkMoveFolderCreateTarget, assignCollection, showToast, exitSelectionMode, t],
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

  return (
    <InboxRootSurface
      backgroundColor={palette.background}
      shift={settingsShift}
      sliding={sliding}
    >
      <WebCrispAnimatedSurface
        testID="inbox-header-surface"
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
        // Do not leave an identity transform on web. The hero is structurally
        // pinned there, so translateY(0) has no visual purpose, but it still
        // promotes this absolute header to a composited layer. The RN-web
        // Image inside the hero paints through a negative-z background child;
        // keeping that image inside the unnecessary transformed layer caused
        // intermittent Chrome paint loss even though onLoad and layout both
        // reported success (STASH-53).
        animatedStyle={
          isWeb ? null : { transform: [{ translateY: searchOpen ? 0 : headerTranslate }] }
        }
      >
        <View
          onLayout={(event) => setHeroHeight(event.nativeEvent.layout.height)}
          style={[
            styles.hero,
            {
              maxWidth: Math.min(winWidth, contentMaxWidth),
              paddingTop: insets.top,
              minHeight: 56 + insets.top,
              position: 'relative',
              zIndex: 2,
            },
          ]}
        >
          {/* Compact single-row hero: the brand wordmark with the saved-count
              sitting inline on its baseline, and a bare settings gear. The old
              stacked tagline + count lines and the "설정" caption were pure
              vertical chrome that pushed the first card down ~40% of the
              screen, so they're folded away here to reclaim that space. */}
          {folderSelectionMode ? (
            <View style={styles.selectionHeroRow}>
              <Pressable
                testID="folder-selection-select-all"
                accessibilityRole="button"
                accessibilityLabel={allFoldersSelected ? t('inbox.deselectAll') : t('inbox.selectAll')}
                disabled={selectableCollectionIds.length === 0}
                hitSlop={8}
                onPress={toggleSelectAllFolders}
                style={({ pressed }) => [
                  styles.selectionSelectAllButton,
                  selectableCollectionIds.length === 0 ? { opacity: 0.4 } : pressed ? { opacity: 0.7 } : null,
                ]}
              >
                <Ionicons
                  name={allFoldersSelected ? 'checkmark-circle' : 'ellipse-outline'}
                  size={22}
                  color={allFoldersSelected ? palette.accent : palette.textSecondary}
                />
                <Text
                  style={[
                    styles.selectionSelectAllLabel,
                    { color: allFoldersSelected ? palette.accent : palette.text },
                  ]}
                  numberOfLines={1}
                >
                  {allFoldersSelected ? t('inbox.deselectAll') : t('inbox.selectAll')}
                </Text>
              </Pressable>
              <Text
                testID="folder-selection-count"
                style={[styles.selectionCountText, { color: palette.textSecondary }]}
                numberOfLines={1}
              >
                {t('folder.selectedCount', { count: selectedFolderIds.size })}
              </Text>
              <View style={{ flex: 1 }} />
              <Pressable
                testID="folder-selection-close"
                accessibilityRole="button"
                accessibilityLabel={t('inbox.cancelSelectionA11y')}
                hitSlop={8}
                onPress={exitFolderSelectionMode}
                style={({ pressed }) => [
                  styles.selectionCancelButton,
                  { opacity: pressed ? 0.7 : 1 },
                ]}
              >
                <Text style={[styles.selectionCancelLabel, { color: palette.text }]}>
                  {t('common.cancel')}
                </Text>
              </Pressable>
            </View>
          ) : selectionMode ? (
            <View style={styles.selectionHeroRow}>
              <Pressable
                testID="inbox-selection-select-all"
                accessibilityRole="button"
                accessibilityLabel={allVisibleSelected ? t('inbox.deselectAll') : t('inbox.selectAll')}
                disabled={visible.length === 0}
                hitSlop={8}
                onPress={toggleSelectAll}
                style={({ pressed }) => [
                  styles.selectionSelectAllButton,
                  visible.length === 0 ? { opacity: 0.4 } : pressed ? { opacity: 0.7 } : null,
                ]}
              >
                <Ionicons
                  name={allVisibleSelected ? 'checkmark-circle' : 'ellipse-outline'}
                  size={22}
                  color={allVisibleSelected ? palette.accent : palette.textSecondary}
                />
                <Text
                  style={[
                    styles.selectionSelectAllLabel,
                    { color: allVisibleSelected ? palette.accent : palette.text },
                  ]}
                  numberOfLines={1}
                >
                  {allVisibleSelected ? t('inbox.deselectAll') : t('inbox.selectAll')}
                </Text>
              </Pressable>
              <Text
                testID="inbox-selection-count"
                style={[styles.selectionCountText, { color: palette.textSecondary }]}
                numberOfLines={1}
              >
                {t('inbox.selectedCount', { count: selectedIds.size })}
              </Text>
              <View style={{ flex: 1 }} />
              <Pressable
                testID="inbox-selection-close"
                accessibilityRole="button"
                accessibilityLabel={t('inbox.cancelSelectionA11y')}
                hitSlop={8}
                onPress={exitSelectionMode}
                style={({ pressed }) => [
                  styles.selectionCancelButton,
                  { opacity: pressed ? 0.7 : 1 },
                ]}
              >
                <Text style={[styles.selectionCancelLabel, { color: palette.text }]}>
                  {t('common.cancel')}
                </Text>
              </Pressable>
            </View>
          ) : (
            <LibraryHeader count={accountLibraryState !== 'ready' && inbox.length === 0 ? null : inbox.length} unread={newSuggestionsCount}
              menuOpen={homeMenuOpen} disabled={capturing} onTop={scrollToTop}
              onMenu={() => setHomeMenuOpen(true)}
              status={<LibraryStatus inline bookmarks={inbox} queue={queue} authStatus={auth.status}
                flow={librarySyncFlow} scopeKey={auth.userId}
                loading={isLoading} loadError={loadError} syncing={isSyncing} paused={syncPaused}
                signIn={() => router.push({ pathname: '/settings', params: { focus: 'account' } })} />} />
          )}
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
              : styles.collapsibleHeaderNative
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
          <View style={[styles.searchWrap, { maxWidth: contentMaxWidth }]}>
            <View style={[styles.searchField, { backgroundColor: palette.card, borderColor: palette.controlBorder }]}>
              <Pressable
                testID="inbox-search-open"
                accessibilityRole="button"
                accessibilityLabel={searchOpen ? t('inbox.searchCloseA11y') : t('inbox.searchOpenA11y')}
                disabled={selectionMode || !recentsReady}
                onPress={() => (searchOpen ? closeSearch() : openSearch())}
                style={styles.searchAction}
                {...preventMouseDownFocusSteal}
              >
                <Ionicons name={searchOpen ? 'close' : 'search'} size={20} color={palette.textSecondary} />
              </Pressable>
              <TextInput
                ref={searchRef}
                testID="inbox-search-input"
                accessibilityLabel={searchPlaceholder}
                editable={!selectionMode && recentsReady}
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
                  if (!searchOpen) openSearch();
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
                    if (query.length === 0 && !selectionMode) {
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
          </View>
          {showSuggestions ? (
            <SearchSuggestionShelf
              suggestions={suggestions}
              maxWidth={contentMaxWidth}
              onPick={onPickSuggestion}
              onRemoveRecent={onRemoveRecentSuggestion}
              query={debouncedQuery}
            />
          ) : null}
          {(isLoading || showControls || collections.length > 0) && !selectionMode && !folderSelectionMode && !searchFocused && !searchOpen ? (
            <View testID="inbox-filter-options-row" style={[styles.filterOptionsRow, { maxWidth: contentMaxWidth }]}>
              <Pressable testID="inbox-scope-picker" accessibilityRole="button"
                accessibilityLabel={t('inbox.scopePickerA11y')}
                accessibilityState={{ expanded: viewMode === 'folder' ? false : scopeMenuOpen, disabled: viewMode === 'folder' || isLoading }}
                disabled={viewMode === 'folder' || isLoading}
                onPress={() => setScopeMenuOpen(true)}
                style={[styles.scopePicker, { borderColor: palette.controlBorder, opacity: viewMode === 'folder' || isLoading ? 0.5 : 1 }]}>
                <Text numberOfLines={1} ellipsizeMode="tail" style={[styles.viewOptionsLabel, { color: palette.text }]}>
                  {viewMode === 'folder' || filter.kind === 'all' ? t('inbox.filterAll') : filter.kind === 'uncollected' ? t('inbox.filterNoCollection') : activeChip?.label ?? t('inbox.filterAll')}
                </Text>
                {viewMode !== 'folder' ? <Ionicons name="chevron-down" size={14} color={palette.textSecondary} /> : null}
              </Pressable>
              <View testID="inbox-view-actions" style={styles.viewActions}>
                <View testID="inbox-view-mode-control" style={[styles.viewModeControl, { backgroundColor: palette.surface, borderColor: palette.border }]}>
                  {(['card', 'list', 'folder'] as const).map((mode) => (
                    <Pressable
                      key={mode}
                      testID={`inbox-view-${mode}`}
                      accessibilityRole="button"
                      accessibilityLabel={t(VIEW_MODE_LABEL_KEY[mode])}
                      accessibilityState={{ selected: viewMode === mode, disabled: isLoading || !viewOptionsReady }}
                      disabled={isLoading || !viewOptionsReady}
                      onPress={() => {
                        setViewMode(mode);
                        void setPreference(INBOX_VIEW_PREF_KEY, serializeViewMode(mode)).catch(() => { });
                        setSortMenuOpen(false);
                      }}
                      style={({ pressed }) => [styles.viewModeButton, {
                        backgroundColor: viewMode === mode ? palette.mutedSurface : 'transparent',
                        opacity: pressed || isLoading || !viewOptionsReady ? 0.6 : 1,
                      }]}
                    >
                      <Ionicons name={VIEW_MODE_ICON[mode]} size={20} color={viewMode === mode ? palette.text : palette.textSecondary} />
                    </Pressable>
                  ))}
                </View>
                <Pressable testID="inbox-view-options" accessibilityRole="button"
                  accessibilityLabel={t('inbox.viewOptions')}
                  accessibilityState={{ disabled: isLoading || !viewOptionsReady }} disabled={isLoading || !viewOptionsReady}
                  onPress={() => setSortMenuOpen(true)} style={styles.viewOptions}>
                  <Ionicons name="ellipsis-horizontal" size={18} color={palette.textSecondary} />
                </Pressable>
              </View>
            </View>
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
            {/* `accessible` + `accessibilityLabel` give VoiceOver/TalkBack the
                real filter text as one announced unit (standalone — not
                inside a labeled Pressable, unlike the clear button beside
                it); `styles.filterBarText`'s flex: 1 also has to live on this
                wrapper since an unstyled PostHogMaskView wouldn't inherit it. */}
            <View accessible accessibilityLabel={scope.text} style={styles.filterBarText}>
              <PostHogMaskView>
                <Text style={[styles.filterBarText, { color: palette.accentText }]} numberOfLines={1}>
                  {scope.text}
                </Text>
              </PostHogMaskView>
            </View>
            {filter.kind === 'collection' ? (() => {
              const activeCollection = collections.find((c) => c.id === filter.id);
              if (!activeCollection) return null;
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('folder.menuTitle')}
                  testID="inbox-filter-collection-menu"
                  hitSlop={8}
                  onPress={() => setFolderMenuItem(activeCollection)}
                  style={({ pressed }) => [
                    styles.filterBarAction,
                    styles.filterBarOptions,
                    { borderColor: palette.accent, opacity: pressed ? 0.6 : 1 },
                  ]}
                >
                  <Ionicons name="ellipsis-horizontal" size={16} color={palette.accentText} />
                </Pressable>
              );
            })() : null}
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
          viewMode === 'list' ? styles.listModeList : viewMode === 'folder' ? styles.folderGridList : null,
          // Start the list below the floating header (and the pinned filter bar
          // when active), and clear the Add button so it never covers the last row.
          { paddingTop: listPaddingTop, paddingBottom: insets.bottom + (selectionMode ? 120 : 88) },
        ]}
        ListHeaderComponent={
          <>
            <AccountLibraryNotice state={accountLibraryState} transferredCount={accountTransferCount} onDismiss={dismissAccountTransfer}
              offline={offline} paused={syncPaused}
              onRetry={() => { void syncNow({ force: true }); }} onSettings={() => router.push('/settings')} />
            <LibraryStatus bookmarks={inbox} queue={queue} authStatus={auth.status}
              flow={librarySyncFlow} scopeKey={auth.userId}
              loading={isLoading} loadError={loadError} syncing={isSyncing} paused={syncPaused}
              signIn={() => router.push({ pathname: '/settings', params: { focus: 'account' } })}
            />
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
          ) : accountLibraryState !== 'ready' ? <View /> : searching ? (
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
              {auth.status === 'anonymous' || auth.status === 'signed_out' ? (
                <View style={styles.emptyAccount} testID="inbox-empty-account">
                  <Text style={[styles.emptyAccountBenefit, { color: palette.textSecondary }]}>
                    {t('inbox.emptySignInBenefit')}
                  </Text>
                  <Button
                    size="md"
                    style={styles.emptySignInButton}
                    onPress={() => router.push({ pathname: '/settings', params: { focus: 'account' } })}
                    testID="inbox-empty-sign-in"
                  >
                    {t('settings.account.signIn')}
                  </Button>
                  <Text style={[styles.emptyAccountReassurance, { color: palette.textSecondary }]}>
                    {t('inbox.emptySignInOptional')}
                  </Text>
                </View>
              ) : null}
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
                </>
              )}
              <Pressable
                accessibilityRole="button"
                style={({ pressed }) => [styles.emptyTutorialButton, { opacity: pressed ? 0.7 : 1 }]}
                onPress={() => setTutorialOpen(true)}
                testID="inbox-empty-tutorial-button"
                accessibilityLabel={t('inbox.emptyTutorialA11y')}
              >
                <Text style={[styles.emptyTutorialLabel, { color: palette.accentText }]}>
                  {t('inbox.emptyTutorialButton')}
                </Text>
              </Pressable>
            </View>
          )
        }
        extraData={`${viewMode}|${searching}|${debouncedQuery}`}
        renderItem={createInboxItemRenderer({
          setInlineDetailId,
          viewMode,
          contentMaxWidth,
          columns,
          folderSelectionMode,
          t,
          onNewFolderTilePress,
          palette,
          openFolderTile,
          selectedFolderIds,
          collections,
          toggleFolderSelect,
          enterFolderSelectionMode,
          setFolderMenuItem,
          getCollection,
          getTagsForBookmark,
          getEnrichment,
          getReviewedSuggestions,
          getDismissedFolderSuggestions,
          getReviewedSummary,
          isNavigatingRef,
          router,
          openingBookmarkTimerRef,
          setOpeningBookmarkId,
          openingBookmarkId,
          markBookmarkAccessed,
          searching,
          searchTerms,
          selectedIds,
          selectionMode,
          toggleSelect,
          enterSelectionMode,
          highlightQuery,
          highlightStyle,
          setMenuItem,
        })}
      />
      {folderSelectionMode ? (
        <FolderBulkActionBar
          selectedCount={selectedFolderIds.size}
          onMerge={() => {
            const targets = collections.filter((c) => selectedFolderIds.has(c.id));
            openMergeFolderDialog(targets);
          }}
          onDelete={() => {
            const targets = collections.filter((c) => selectedFolderIds.has(c.id));
            openDeleteFolderDialog(targets);
          }}
          onRename={
            selectedFolderIds.size === 1
              ? () => {
                const targetId = Array.from(selectedFolderIds)[0];
                const targetCol = collections.find((c) => c.id === targetId);
                if (targetCol) {
                  openRenameDialog(targetCol);
                }
              }
              : undefined
          }
          maxWidth={contentMaxWidth}
          bottomInset={insets.bottom}
        />
      ) : !selectionMode ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('inbox.addBookmark')}
          onPress={() => router.push('/add')}
          style={({ pressed }) => [
            styles.fab,
            { backgroundColor: palette.accent, bottom: insets.bottom + 16, right: insets.right + 16, opacity: pressed ? 0.9 : 1 },
          ]}
        >
          <Ionicons name="add" size={34} color="#ffffff" />
        </Pressable>
      ) : (
        <BulkActionBar
          selectedCount={selectedIds.size}
          isRefreshing={bulkRefreshing}
          onRefresh={handleBulkRefresh}
          onMove={handleOpenBulkMove}
          onTag={handleOpenBulkTag}
          onDelete={handleBulkDelete}
          maxWidth={contentMaxWidth}
          bottomInset={insets.bottom}
        />
      )}
      <ActionSheet
        visible={homeMenuOpen}
        title={t('inbox.menuA11y')}
        onClose={() => setHomeMenuOpen(false)}
        actions={[
          ...(auth.status !== 'authenticated'
            ? [
                {
                  key: 'sign-in',
                  testID: 'inbox-menu-sign-in',
                  label: t('settings.account.signIn'),
                  icon: 'log-in-outline' as const,
                  onPress: () => {
                    setHomeMenuOpen(false);
                    router.push({ pathname: '/settings', params: { focus: 'account' } });
                  },
                },
              ]
            : []),
          {
            key: 'review', testID: 'inbox-menu-review', label: t('inbox.aiReviewMenu', { count: newSuggestionsCount }), icon: 'sparkles-outline', onPress: () => {
              setHomeMenuOpen(false);
              router.push('/review');
            }
          },
          {
            key: 'tags', label: t('nav.browseTags'), icon: 'pricetags-outline', onPress: () => {
              setHomeMenuOpen(false);
              openBrowseTags();
            }
          },
          {
            key: 'graph', label: t('nav.graph'), icon: 'git-network-outline', onPress: () => {
              setHomeMenuOpen(false);
              router.push('/graph');
            }
          },
          {
            key: 'settings', label: t('nav.settings'), icon: 'settings-outline', onPress: () => {
              setHomeMenuOpen(false);
              router.push('/settings');
            }
          },
          {
            key: 'report', label: t('settings.report.label'), icon: 'chatbubble-ellipses-outline', onPress: () => {
              setHomeMenuOpen(false);
              void openReport();
            }
          },
        ]}
      />
      <ActionSheet visible={scopeMenuOpen} title={t('inbox.scopePickerA11y')} actionsMask
        onClose={() => setScopeMenuOpen(false)} actions={[
          { key: 'all', label: t('inbox.filterAll'), selected: sameFilter(ALL_FILTER, filter), onPress: () => { onSelectFilter(ALL_FILTER); setScopeMenuOpen(false); } },
          ...(hasUncollected ? [{ key: 'uncollected', label: t('inbox.filterNoCollection'), icon: 'file-tray-outline' as const, selected: sameFilter(UNCOLLECTED_FILTER, filter), onPress: () => { onSelectFilter(UNCOLLECTED_FILTER); setScopeMenuOpen(false); } }] : []),
          ...chips.map((chip) => ({ key: chip.key, label: chip.label, icon: chip.icon, selected: sameFilter(chip.filter, filter), onPress: () => { onSelectFilter(chip.filter); setScopeMenuOpen(false); } })),
        ]} />
      <ActionSheet
        visible={bulkMoveSheetOpen}
        title={t('inbox.bulkMoveTitle', { count: selectedIds.size })}
        actionsMask
        actions={[
          {
            key: 'inbox',
            label: t('inbox.inboxNoCollection'),
            icon: 'file-tray-outline',
            onPress: () => handleBulkMoveToCollection(null),
          },
          ...collections.map((col) => ({
            key: col.id,
            label: col.name,
            icon: 'folder-outline' as const,
            onPress: () => handleBulkMoveToCollection(col.id),
          })),
          {
            key: 'new-folder',
            label: t('inbox.newCollection'),
            icon: 'add-outline' as const,
            onPress: () => {
              setBulkMoveSheetOpen(false);
              setBulkMoveFolderCreateTarget(Array.from(selectedIds));
              setNewFolderError(null);
              setNewFolderDialogOpen(true);
            },
          },
        ]}
        onClose={() => setBulkMoveSheetOpen(false)}
      />
      <ActionSheet
        visible={menuItem !== null}
        title={menuTitle}
        // Main mode's title is the bookmark's own title (content); move mode's
        // title is a fixed string but its actions become collection names
        // (content) instead — the two invert together.
        titleMask={menuMode !== 'move'}
        actions={menuActions}
        actionsMask={menuMode === 'move'}
        onClose={closeMenu}
      />
      <ActionSheet
        visible={sortMenuOpen}
        title={t('inbox.viewOptions')}
        actions={[
          ...(isFolderSort && collections.length > 0 ? [{
            key: 'select-collections',
            testID: 'folder-select-button',
            label: t('folder.selectAction'),
            icon: 'checkmark-circle-outline' as const,
            onPress: () => {
              setSortMenuOpen(false);
              enterFolderSelectionMode();
            },
          }] : []),
          ...(isFolderSort
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
            }))),
        ]}
        onClose={() => setSortMenuOpen(false)}
      />
      <BulkTagDialog
        visible={bulkTagDialogOpen}
        selectedCount={selectedIds.size}
        existingTags={existingTagsForBulk}
        busy={bulkTagBusy}
        error={bulkTagError}
        onApplyTag={handleBulkApplyTag}
        onClose={() => {
          setBulkTagDialogOpen(false);
          setBulkTagError(null);
        }}
      />
      <ActionSheet
        visible={folderMenuItem !== null}
        title={folderMenuItem?.name ?? t('folder.menuTitle')}
        titleMask
        actions={folderMenuActions}
        onClose={() => setFolderMenuItem(null)}
      />
      <RenameCollectionDialog
        visible={renameDialogOpen}
        busy={renameBusy}
        error={renameError}
        initialName={renameTarget?.name ?? ''}
        onRename={handleRenameFolder}
        onClose={() => {
          if (!renameBusy) {
            setRenameDialogOpen(false);
            setRenameTarget(null);
            setRenameError(null);
          }
        }}
      />
      <DeleteCollectionDialog
        visible={deleteDialogOpen}
        busy={deleteBusy}
        collectionCount={deleteTargets.length}
        collectionName={deleteTargets.length === 1 ? deleteTargets[0].name : undefined}
        bookmarkCount={deleteBookmarkCount}
        onDeleteKeep={() => handleDeleteFolders('uncategorize')}
        onDeleteTrash={() => handleDeleteFolders('trash')}
        onClose={() => {
          if (!deleteBusy) {
            setDeleteDialogOpen(false);
            setDeleteTargets([]);
          }
        }}
      />
      <MergeCollectionsDialog
        visible={mergeDialogOpen}
        busy={mergeBusy}
        error={mergeError}
        sourceCollections={mergeSources}
        availableTargets={availableMergeTargets}
        collectionCounts={collectionCounts}
        onMerge={handleMergeFolders}
        onClose={() => {
          if (!mergeBusy) {
            setMergeDialogOpen(false);
            setMergeSources([]);
            setMergeError(null);
          }
        }}
      />
      <CreateCollectionDialog
        visible={newFolderDialogOpen}
        busy={newFolderBusy}
        error={newFolderError}
        onCreate={handleCreateFolder}
        onClose={closeNewFolderDialog}
      />
      <TutorialModal
        visible={tutorialOpen}
        onClose={() => setTutorialOpen(false)}
      />
    </InboxRootSurface>
  );
}
