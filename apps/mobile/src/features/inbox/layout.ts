import {
  type FolderSortOption
} from '@/domain/folder-sort';
import {
  type SortOption
} from '@/domain/sort';
import {
  type ViewMode
} from '@/domain/view-mode';
import type { MessageKey } from '@/i18n/messages';
import { uiMetrics } from '@/theme';
import { overlayLayer } from '@/ui/layering';
import { Ionicons } from '@expo/vector-icons';
import {
  type ComponentProps
} from 'react';
import {
  Animated,
  FlatList,
  Platform,
  StyleSheet,
  type ViewStyle
} from 'react-native';

// Glyph for each layout in the view-mode segmented control.
export const VIEW_MODE_ICON: Record<ViewMode, ComponentProps<typeof Ionicons>['name']> = {
  card: 'grid-outline',
  list: 'list-outline',
  folder: 'folder-outline',
};

// Translation key for each layout's human label (segmented-control a11y).
export const VIEW_MODE_LABEL_KEY: Record<ViewMode, MessageKey> = {
  card: 'viewMode.card',
  list: 'viewMode.list',
  folder: 'viewMode.collection',
};

// Friendly label + icon for each sort preset, keyed by its serialized form.
// Phrasing each order as a whole choice ("Newest", "Recently opened") reads
// kinder than a field pill plus an abstract ascending/descending toggle.
export const SORT_LABEL_KEY: Record<string, MessageKey> = {
  'date:desc': 'inbox.sortNewest',
  'date:asc': 'inbox.sortOldest',
  'accessed:desc': 'inbox.sortRecentlyOpened',
  'accessed:asc': 'inbox.sortLeastRecentlyOpened',
  'name:asc': 'inbox.sortNameAsc',
  'name:desc': 'inbox.sortNameDesc',
};

export const SORT_ICON: Record<SortOption['field'], ComponentProps<typeof Ionicons>['name']> = {
  date: 'calendar-outline',
  accessed: 'time-outline',
  name: 'text-outline',
};

// Folder View's own sort menu (Collection tiles, not bookmarks) — a separate
// small set of labels/icons since its field union (name/count) doesn't
// overlap with the bookmark-level SORT_LABEL_KEY/SORT_ICON above.
export const FOLDER_SORT_LABEL_KEY: Record<string, MessageKey> = {
  'name:asc': 'inbox.folderSortNameAsc',
  'name:desc': 'inbox.folderSortNameDesc',
  'count:desc': 'inbox.folderSortCountDesc',
  'count:asc': 'inbox.folderSortCountAsc',
};

export const FOLDER_SORT_ICON: Record<FolderSortOption['field'], ComponentProps<typeof Ionicons>['name']> = {
  name: 'text-outline',
  count: 'layers-outline',
};

// The list that drives the collapsing header. Animated.FlatList lets the
// scroll position feed an Animated.Value over the native driver; the cast keeps
// FlatList's generic item typing (Animated.FlatList erases it to `any`).
export const AnimatedFlatList = Animated.FlatList as unknown as typeof FlatList;

// On wide (desktop-web) viewports, cap the content column and center it so
// cards, the header, and the browse shelf don't stretch edge-to-edge. No effect
// on phones (their width is already below this), so it reads as a web-only
// improvement while staying a single cross-platform rule.
export const CONTENT_MAX_WIDTH = 720;

// The wide-screen Settings sheet docks on the right at this width (mirrors
// `sheetPanel.maxWidth` in settings.tsx) over a threshold shared with its
// `asSheet` rule. When it's open we slide the whole Inbox left by half this
// width so the content re-centers in the visible region (window − panel)
// instead of hiding its right column behind the panel — a translate, not a
// re-layout, so the card grid keeps its column count and sizes.
export const SETTINGS_PANEL_WIDTH = 460;

export const SETTINGS_SHEET_MIN_WIDTH = 760;

export const WEB_MEDIUM_WEIGHT = Platform.select({ web: '500', default: '600' }) as '500' | '600';

export const WEB_SEMIBOLD_WEIGHT = Platform.select({ web: '600', default: '700' }) as '600' | '700';

export const WEB_BOLD_WEIGHT = Platform.select({ web: '700', default: '800' }) as '700' | '800';

export const WEB_CARD_GRID_TOP_GAP = Platform.OS === 'web' ? 12 : 4;

export const WEB_CARD_GRID_COLUMN_GAP = 16;

export const LIST_PADDING = 16;

export const CARD_PREVIEW_HEIGHT = 140;

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
export const preventMouseDownFocusSteal =
  Platform.OS === 'web' ? { onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault() } : null;

export const WEB_AMBIENT_BACKGROUND = Platform.OS === 'web'
  ? ({
    backgroundImage:
      'radial-gradient(circle at 10% 0%, rgba(120, 184, 244, 0.16), transparent 42%), radial-gradient(circle at 90% 100%, rgba(238, 203, 105, 0.10), transparent 46%)',
    backgroundAttachment: 'fixed',
  } as ViewStyle)
  : null;

export const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  // Applied to the PostHogMaskView wrapping the folder-tile label — see the
  // usage site for why this needs to be forwarded onto the wrapper too.
  maskMaxWidth: {
    maxWidth: '100%',
  },
  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    width: '100%',
    maxWidth: '100%',
    // Float above the list for paint AND touch — see overlayLayer (STASH-7).
    ...overlayLayer(10),
  },
  collapsibleHeaderNative: {
    width: '100%',
    maxWidth: '100%',
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
    gap: 0,
  },
  folderGridList: {
    gap: WEB_CARD_GRID_COLUMN_GAP,
  },
  hero: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: uiMetrics.screenGutter,
    paddingTop: 0,
    paddingBottom: 0,
    width: '100%',
    maxWidth: '100%',
    alignSelf: 'center',
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
  emptyAccount: {
    alignItems: 'center',
    width: '100%',
    maxWidth: 320,
    marginTop: -4,
    marginBottom: 24,
  },
  emptyAccountBenefit: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  emptySignInButton: {
    alignSelf: 'stretch',
    minHeight: 48,
    marginTop: 16,
  },
  emptyAccountReassurance: {
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: 10,
  },
  emptyTutorialButton: {
    marginTop: 14,
    minHeight: 48,
    minWidth: 48,
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  emptyTutorialLabel: {
    fontSize: 14,
    textAlign: 'center',
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
    paddingHorizontal: uiMetrics.screenGutter,
    width: '100%',
    alignSelf: 'center',
  },
  searchField: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: uiMetrics.radius,
    minHeight: 48,
  },
  searchAction: {
    minWidth: 48,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    minHeight: 48,
    borderRadius: uiMetrics.radius,
    paddingVertical: 8,
    paddingHorizontal: 8,
    fontSize: 16,
  },
  filterOptionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: uiMetrics.screenGutter,
    paddingVertical: 8,
    gap: 8,
    width: '100%',
    alignSelf: 'center',
  },
  viewModeControl: {
    flexDirection: 'row',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    padding: 3,
  },
  viewModeButton: {
    width: 48,
    minHeight: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scopePicker: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 48,
    flex: 1,
    minWidth: 0,
    borderWidth: 1,
    borderRadius: 10,
    padding: 8,
  },
  viewActions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    gap: 4,
  },
  viewOptions: {
    width: 48,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewOptionsLabel: {
    fontSize: 14,
    fontWeight: '600',
    flexShrink: 1,
  },
  card: {
    position: 'relative',
    borderRadius: uiMetrics.radius,
    overflow: 'hidden',
  },
  bookmarkOpeningOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.82,
  },
  listRow: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 0,
    minHeight: 88,
    paddingVertical: 13,
    paddingHorizontal: 0,
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
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  compactThumb: {
    width: 48,
    height: 48,
    borderRadius: 12,
  },
  compactMeta: {
    fontSize: 14,
    fontWeight: WEB_MEDIUM_WEIGHT,
    marginTop: 1,
  },
  listTitle: {
    fontSize: 16,
    fontWeight: WEB_SEMIBOLD_WEIGHT,
    letterSpacing: -0.2,
  },
  listUrl: {
    fontSize: 14,
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
  cardPreviewBadgeWrap: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    minHeight: uiMetrics.touchTarget,
    minWidth: uiMetrics.touchTarget,
    justifyContent: 'flex-end',
    alignItems: 'flex-start',
    paddingLeft: 8,
    paddingBottom: 8,
    maxWidth: '85%',
    ...overlayLayer(3),
  },
  cardPreviewBadge: {
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.75)',
    borderRadius: 999,
    paddingVertical: 3,
    paddingHorizontal: 8,
    ...Platform.select({
      web: {
        backdropFilter: 'blur(8px)',
      },
    }),
  },
  cardPreviewBadgeText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '600',
    flexShrink: 1,
  },
  cardBody: {
    padding: 12,
    gap: 4,
  },
  cardBodyTextOnlyWeb: {
    paddingVertical: 13,
    gap: 6,
  },
  cardOpenLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
  cardCompactHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  cardCompactTitleCol: {
    flex: 1,
    minWidth: 0,
    gap: 2,
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
    fontSize: 16,
    fontWeight: WEB_SEMIBOLD_WEIGHT,
    letterSpacing: -0.2,
  },
  memoPreviewText: {
    fontSize: 14,
    lineHeight: 20,
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
  cardUrl: {
    flexShrink: 1,
    fontSize: Platform.select({ web: 12, default: 13 }),
    lineHeight: Platform.select({ web: 16, default: undefined }),
  },
  metaChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  metaChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
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
    position: 'relative',
  },
  folderTileSelectBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    ...overlayLayer(2),
  },
  folderTileMoreButton: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    ...overlayLayer(2),
  },
  filterBarOptions: {
    padding: 6,
    borderRadius: 8,
    marginRight: 2,
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
    right: 16,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    // Float above the list with a soft shadow so it reads as the primary action.
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  selectionHeroRow: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    minHeight: 40,
    gap: 8,
  },
  selectionSelectAllButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  selectionSelectAllLabel: {
    fontSize: 15,
    fontWeight: '600',
  },
  selectionCountText: {
    fontSize: 14,
    fontWeight: '500',
  },
  selectionCancelButton: {
    paddingVertical: 6,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectionCancelLabel: {
    fontSize: 15,
    fontWeight: '600',
  },
  selectionCheckWrap: {
    marginRight: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  cardSelectionIndicator: {
    position: 'absolute',
    top: 10,
    left: 10,
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1.5,
    justifyContent: 'center',
    alignItems: 'center',
    ...overlayLayer(3),
  },
});
