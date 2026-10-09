import { ProtectedImage } from '@/ui/ProtectedImage';
import BookmarkDetailScreen from '@/app/bookmark/[id]';
import { pendingSuggestedFolder, pendingSuggestions, pendingSummary } from '@/domain/ai-suggestions';
import {
  type InboxFilter
} from '@/domain/filter';
import { accessibilityTitle, displayTitle, isTitleDerived, siteLabel } from '@/domain/item-display';
import {
  didPreviewImageLoad,
  markPreviewImageFailed,
  markPreviewImageLoaded,
  selectPreviewImageUri
} from '@/domain/preview-image-cache';
import { memoBodyFormat, textForDisplay } from '@/domain/text-format';
import type { AIEnrichment, Bookmark, Collection, Tag } from '@/domain/types';
import {
  type ViewMode
} from '@/domain/view-mode';
import { LIST_PADDING, WEB_CARD_GRID_COLUMN_GAP, WEB_MEDIUM_WEIGHT, WEB_SEMIBOLD_WEIGHT, styles } from '@/features/inbox/layout';
import { ItemIcon, statusLabel, valueMatchesTerms } from '@/features/inbox/presentation';
import type { InboxListItem } from '@/features/inbox/types';
import type { TFunction } from '@/i18n/translate';
import { uiMetrics, usePalette } from '@/theme';
import { Card } from '@/ui/Card';
import { HighlightedText } from '@/ui/HighlightedText';
import { Ionicons } from '@expo/vector-icons';
import type { ImperativeRouter } from 'expo-router';
import { PostHogMaskView } from 'posthog-react-native';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import {
  ActivityIndicator,
  Image,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ImageLoadEvent,
  type NativeSyntheticEvent
} from 'react-native';
interface Props {
  setInlineDetailId: Dispatch<SetStateAction<string | null>>;
  viewMode: ViewMode;
  contentMaxWidth: number;
  columns: number;
  folderSelectionMode: boolean;
  t: TFunction;
  onNewFolderTilePress: () => void;
  palette: ReturnType<typeof usePalette>;
  openFolderTile: (target: InboxFilter) => void;
  selectedFolderIds: Set<string>;
  collections: Collection[];
  toggleFolderSelect: (id: string) => void;
  enterFolderSelectionMode: (initialId?: string) => void;
  setFolderMenuItem: Dispatch<SetStateAction<Collection | null>>;
  getCollection: (id: string | null) => Collection | undefined;
  getTagsForBookmark: (id: string) => Tag[];
  getEnrichment: (bookmarkId: string) => AIEnrichment | undefined;
  getReviewedSuggestions: (bookmarkId: string) => Set<string>;
  getDismissedFolderSuggestions: (bookmarkId: string) => Set<string>;
  getReviewedSummary: (bookmarkId: string) => Set<string>;
  isNavigatingRef: RefObject<boolean>;
  router: ImperativeRouter;
  openingBookmarkTimerRef: RefObject<ReturnType<typeof setTimeout> | null>;
  setOpeningBookmarkId: Dispatch<SetStateAction<string | null>>;
  openingBookmarkId: string | null;
  markBookmarkAccessed: (id: string) => void;
  searching: boolean;
  searchTerms: string[];
  selectedIds: Set<string>;
  selectionMode: boolean;
  toggleSelect: (id: string) => void;
  enterSelectionMode: (initialId?: string) => void;
  highlightQuery: string;
  highlightStyle: { backgroundColor: "#c9941c" | "#eecb69"; color: "#151b26"; };
  setMenuItem: Dispatch<SetStateAction<Bookmark | null>>;
}

export function createInboxItemRenderer({
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
}: Props) {
  return (({ item }: { item: InboxListItem }) => {
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
        if (folderSelectionMode) {
          return null;
        }
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
      if (item.kind === 'uncollected') {
        return (
          <Pressable
            testID={`folder-tile-${item.id}`}
            accessibilityRole="button"
            accessibilityLabel={item.label}
            disabled={folderSelectionMode}
            onPress={() => item.filter && openFolderTile(item.filter)}
            style={[
              styles.folderTile,
              { backgroundColor: palette.mutedSurface },
              folderSelectionMode ? { opacity: 0.4 } : null,
            ]}
          >
            <Ionicons name="file-tray-outline" size={26} color={palette.text} />
            <Text style={[styles.folderTileLabel, { color: palette.text }]} numberOfLines={1}>
              {item.label}
            </Text>
            <Text style={[styles.folderTileCount, { color: palette.textSecondary }]}>
              {t('inbox.collectionTileCount', { count: item.count ?? 0 })}
            </Text>
          </Pressable>
        );
      }
      const collectionId = item.collectionId;
      const isFolderSelected = Boolean(collectionId && selectedFolderIds.has(collectionId));
      const collectionObj = collectionId ? collections.find((c) => c.id === collectionId) ?? null : null;
      const tileColor = palette[item.colorKey ?? 'accentSoft'];

      const handleFolderPress = () => {
        if (folderSelectionMode) {
          if (collectionId) {
            toggleFolderSelect(collectionId);
          }
        } else if (item.filter) {
          openFolderTile(item.filter);
        }
      };

      const handleFolderLongPress = () => {
        if (!collectionId) {
          return;
        }
        if (folderSelectionMode) {
          toggleFolderSelect(collectionId);
        } else {
          enterFolderSelectionMode(collectionId);
        }
      };

      return (
        <Pressable
          testID={`folder-tile-${item.id}`}
          accessibilityRole={folderSelectionMode ? 'checkbox' : 'button'}
          accessibilityState={folderSelectionMode ? { checked: isFolderSelected } : undefined}
          accessibilityLabel={item.label}
          onPress={handleFolderPress}
          onLongPress={handleFolderLongPress}
          style={[
            styles.folderTile,
            { backgroundColor: tileColor },
            isFolderSelected
              ? { borderWidth: 2, borderColor: palette.accent }
              : { borderWidth: 2, borderColor: 'transparent' },
          ]}
        >
          {folderSelectionMode ? (
            <View style={styles.folderTileSelectBadge}>
              <Ionicons
                name={isFolderSelected ? 'checkmark-circle' : 'ellipse-outline'}
                size={20}
                color={isFolderSelected ? palette.accent : palette.textSecondary}
              />
            </View>
          ) : (
            <Pressable
              testID={`folder-more-${item.id}`}
              accessibilityRole="button"
              accessibilityLabel={t('folder.menuTitle')}
              onPress={(e) => {
                e.stopPropagation?.();
                if (collectionObj) {
                  setFolderMenuItem(collectionObj);
                }
              }}
              hitSlop={8}
              style={styles.folderTileMoreButton}
            >
              <Ionicons name="ellipsis-horizontal" size={16} color={palette.textSecondary} />
            </Pressable>
          )}
          <Ionicons name="folder-outline" size={26} color={palette.text} />
          <PostHogMaskView style={styles.maskMaxWidth}>
            <Text style={[styles.folderTileLabel, { color: palette.text }]} numberOfLines={1}>
              {item.label}
            </Text>
          </PostHogMaskView>
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
      if (isNavigatingRef.current) {
        return;
      }
      isNavigatingRef.current = true;
      // Push route immediately so the user experiences zero artificial delay.
      router.push({ pathname: '/bookmark/[id]', params: { id: item.id } });

      // Only show a busy indicator if mounting/navigation takes longer
      // than a noticeable threshold (a real delay), avoiding an immediate
      // re-render of the entire inbox for fast transitions.
      if (openingBookmarkTimerRef.current !== null) {
        clearTimeout(openingBookmarkTimerRef.current);
      }
      openingBookmarkTimerRef.current = setTimeout(() => {
        openingBookmarkTimerRef.current = null;
        setOpeningBookmarkId(item.id);
      }, 150);
    };
    const isOpening = openingBookmarkId === item.id;
    const openLink = () => {
      if (item.url) {
        markBookmarkAccessed(item.id);
        void Linking.openURL(item.url).catch(() => { });
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
    const visibleMetaParts = [
      ...(item.content_type === 'text' ? [{ key: 'content-type-text', type: 'type' as const, label: t('inbox.memoType') }] : []),
      ...(item.content_type === 'image' ? [{ key: 'content-type-image', type: 'type' as const, label: t('inbox.photoType') }] : []),
      ...(collectionName ? [{ key: `collection-${item.collection_id ?? collectionName}`, type: 'collection' as const, label: collectionName }] : []),
      ...orderedTags.slice(0, 2).map((tag) => ({ key: `tag-${tag.id}`, type: 'tag' as const, label: `#${tag.name}` })),
      ...(orderedTags.length > 2 ? [{ key: 'tags-overflow', type: 'overflow' as const, label: `+${orderedTags.length - 2}` }] : []),
    ];
    const siteLabelText = siteLabel(item);
    const memoPreview =
      item.content_type === 'text' && item.title?.trim() && item.description?.trim()
        ? textForDisplay(item.description, memoBodyFormat(item))
        : null;
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

    const isSelected = selectedIds.has(item.id);
    const handleItemPress = selectionMode ? () => toggleSelect(item.id) : openDetail;
    const handleItemLongPress = selectionMode ? () => toggleSelect(item.id) : () => enterSelectionMode(item.id);

    // List density view mode: compact row layout featuring thumbnail image
    // with a quick-open thumbnail, title/source/organization, and overflow.
    if (viewMode === 'list') {
      const thumbUri = selectPreviewImageUri(item.local_image_uri, item.preview_image_url);
      const compactMeta = [
        ...(collectionName ? [collectionName] : []),
        ...orderedTags.map((tag) => `#${tag.name}`),
      ].join('  ·  ');
      return (
        <Pressable
          testID={`inbox-list-row-${item.id}`}
          style={({ pressed }) => [
            styles.listRow,
            styles.compactRow,
            {
              backgroundColor: isSelected ? palette.accentSoft : 'transparent',
              borderColor: isSelected ? palette.accent : palette.border,
              borderBottomWidth: isSelected ? 1.5 : StyleSheet.hairlineWidth,
              opacity: pressed ? 0.78 : 1,
            },
          ]}
          onPress={handleItemPress}
          onLongPress={handleItemLongPress}
          accessible={false}
        >
          {selectionMode ? (
            <Pressable
              testID={`inbox-select-checkbox-${item.id}`}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: isSelected }}
              accessibilityLabel={
                isSelected
                  ? t('inbox.deselectItemA11y', { title: displayTitle(item) ?? t('common.untitled') })
                  : t('inbox.selectItemA11y', { title: displayTitle(item) ?? t('common.untitled') })
              }
              onPress={() => toggleSelect(item.id)}
              hitSlop={8}
              style={styles.selectionCheckWrap}
            >
              <Ionicons
                name={isSelected ? 'checkmark-circle' : 'ellipse-outline'}
                size={22}
                color={isSelected ? palette.accent : palette.textSecondary}
              />
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole={selectionMode ? 'button' : item.url ? 'link' : 'button'}
            accessibilityLabel={item.url ? t('common.openLink') : (accessibilityTitle(item) ?? t('common.untitled'))}
            onPress={selectionMode ? () => toggleSelect(item.id) : item.url ? openLink : openDetail}
            onLongPress={handleItemLongPress}
            hitSlop={6}
            style={({ pressed }) => [
              styles.compactThumbWrap,
              {
                opacity: pressed ? 0.75 : 1,
              },
            ]}
          >
            {thumbUri ? (
              <ProtectedImage
                testID="inbox-compact-thumb"
                uri={thumbUri}
                style={[styles.compactThumb, { backgroundColor: palette.mutedSurface }]}
                onError={() => markPreviewImageFailed(thumbUri)}
                onLoad={(event: ImageLoadEvent) => {
                  if (!didPreviewImageLoad(event.nativeEvent)) {
                    markPreviewImageFailed(thumbUri);
                  } else {
                    markPreviewImageLoaded(thumbUri);
                  }
                }}
              />
            ) : (
              <ItemIcon item={item} testID="inbox-list-monogram" />
            )}
          </Pressable>
          <Pressable
            style={styles.listText}
            accessibilityRole={selectionMode ? 'checkbox' : 'button'}
            accessibilityLabel={selectionMode ? (isSelected ? t('inbox.deselectItemA11y', { title: displayTitle(item) ?? t('common.untitled') }) : t('inbox.selectItemA11y', { title: displayTitle(item) ?? t('common.untitled') })) : (accessibilityTitle(item) ?? t('common.untitled'))}
            accessibilityHint={selectionMode ? undefined : t('inbox.openBookmarkHint')}
            accessibilityState={selectionMode ? { checked: isSelected } : { busy: isOpening }}
            onPress={handleItemPress}
            onLongPress={handleItemLongPress}
          >
            <HighlightedText
              testID="inbox-list-title"
              style={[
                styles.listTitle,
                {
                  lineHeight: 22,
                  color: isTitleDerived(item) ? palette.textSecondary : palette.text,
                  fontWeight: isTitleDerived(item) ? WEB_MEDIUM_WEIGHT : WEB_SEMIBOLD_WEIGHT,
                },
              ]}
              numberOfLines={2}
              text={displayTitle(item) ?? t('common.untitled')}
              query={highlightQuery}
              highlightStyle={highlightStyle}
            />
            {memoPreview ? (
              <HighlightedText
                style={[styles.listUrl, { color: palette.textSecondary, lineHeight: 20 }]}
                numberOfLines={1}
                text={memoPreview}
                query={highlightQuery}
                highlightStyle={highlightStyle}
              />
            ) : null}
            {item.url ? (
              <HighlightedText
                style={[styles.listUrl, { color: palette.textSecondary, lineHeight: 20 }]}
                numberOfLines={1}
                text={siteLabelText}
                query={highlightQuery}
                highlightStyle={highlightStyle}
              />
            ) : null}
            {showUrlMatchLine && item.url ? (
              <HighlightedText
                style={[styles.listUrl, { color: palette.textSecondary, lineHeight: 20 }]}
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
                    key={part.key}
                    accessible
                    accessibilityLabel={part.label}
                    style={[
                      styles.metaChip,
                      Platform.OS === 'web'
                        ? { backgroundColor: palette.surface, borderColor: palette.border }
                        : { backgroundColor: palette.mutedSurface },
                    ]}
                  >
                    {part.type === 'collection' ? <Ionicons name="folder-outline" size={12} color={palette.textSecondary} /> : null}
                    <PostHogMaskView style={{ flexShrink: 1 }}>
                      <Text
                        style={[
                          styles.metaChipLabel,
                          { color: Platform.OS === 'web' ? palette.textSecondary : palette.accentText },
                        ]}
                        numberOfLines={1}
                      >
                        {part.label}
                      </Text>
                    </PostHogMaskView>
                  </View>
                ))}
              </View>
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
          {!selectionMode ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('inbox.moreActions')}
              hitSlop={8}
              style={styles.moreButton}
              onPress={() => setMenuItem(item)}
            >
              <Ionicons name="ellipsis-horizontal" size={18} color={palette.textSecondary} />
            </Pressable>
          ) : null}
          {isOpening ? (
            <View
              testID="inbox-bookmark-opening"
              pointerEvents="auto"
              style={[styles.bookmarkOpeningOverlay, { backgroundColor: palette.accentSoft }]}
            >
              <ActivityIndicator color={palette.accent} />
            </View>
          ) : null}
        </Pressable>
      );
    }

    const previewUri = selectPreviewImageUri(item.local_image_uri, item.preview_image_url);
    const cardElement = (
      <Card
        testID={`inbox-card-${item.id}`}
        style={[
          styles.card,
          isOpening ? { borderColor: palette.accent } : null,
          isSelected
            ? {
              borderColor: palette.accent,
              borderWidth: 2,
              backgroundColor: palette.accentSoft,
            }
            : null,
        ]}
      >
        <Pressable
          // Container for card layout
          accessible={false}
          onPress={selectionMode ? () => toggleSelect(item.id) : undefined}
          onLongPress={handleItemLongPress}
        >
          {previewUri || selectionMode ? (
            <View style={[styles.cardPreviewContainer, !previewUri ? { height: 32 } : null]}>
              <Pressable
                testID="inbox-card-preview"
                accessible={false}
                tabIndex={-1}
                onPress={handleItemPress}
                onLongPress={handleItemLongPress}
                style={({ pressed }) => [
                  StyleSheet.absoluteFill,
                  { opacity: pressed ? 0.82 : 1 },
                ]}
              >
                {previewUri ? (
                  <ProtectedImage
                    testID="inbox-card-preview-image"
                    uri={previewUri}
                    style={styles.cardPreview}
                    onError={() => markPreviewImageFailed(previewUri)}
                    onLoad={(event: ImageLoadEvent) => {
                      if (!didPreviewImageLoad(event.nativeEvent)) {
                        markPreviewImageFailed(previewUri);
                      } else {
                        markPreviewImageLoaded(previewUri);
                      }
                    }}
                  />
                ) : null}
              </Pressable>
              {selectionMode ? (
                <Pressable
                  testID={`inbox-select-checkbox-${item.id}`}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: isSelected }}
                  accessibilityLabel={
                    isSelected
                      ? t('inbox.deselectItemA11y', { title: displayTitle(item) ?? t('common.untitled') })
                      : t('inbox.selectItemA11y', { title: displayTitle(item) ?? t('common.untitled') })
                  }
                  onPress={() => toggleSelect(item.id)}
                  hitSlop={8}
                  style={[
                    styles.cardSelectionIndicator,
                    isSelected
                      ? { backgroundColor: palette.accent, borderColor: palette.accent }
                      : { backgroundColor: 'rgba(0,0,0,0.4)', borderColor: '#ffffff' },
                  ]}
                >
                  {isSelected ? (
                    <Ionicons name="checkmark" size={14} color="#ffffff" />
                  ) : null}
                </Pressable>
              ) : null}
              {previewUri && item.url && siteLabelText ? (
                <Pressable
                  testID={`inbox-card-source-${item.id}`}
                  accessibilityRole={selectionMode ? 'checkbox' : 'link'}
                  accessibilityLabel={
                    selectionMode
                      ? t(isSelected ? 'inbox.deselectItemA11y' : 'inbox.selectItemA11y', { title: displayTitle(item) ?? t('common.untitled') })
                      : t('common.openLink')
                  }
                  accessibilityState={selectionMode ? { checked: isSelected } : undefined}
                  onPress={selectionMode ? () => toggleSelect(item.id) : openLink}
                  onLongPress={handleItemLongPress}
                  style={({ pressed }) => [
                    styles.cardPreviewBadgeWrap,
                    { opacity: pressed ? 0.75 : 1 },
                  ]}
                >
                  <View style={styles.cardPreviewBadge}>
                    <HighlightedText
                      style={styles.cardPreviewBadgeText}
                      numberOfLines={1}
                      text={siteLabelText}
                      query={highlightQuery}
                      highlightStyle={highlightStyle}
                    />
                  </View>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          <View style={styles.cardBody}>
            {!previewUri ? (
              <View style={styles.cardCompactHeader}>
                <Pressable
                  accessible={false}
                  tabIndex={-1}
                  onPress={selectionMode ? () => toggleSelect(item.id) : (item.url ? openLink : openDetail)}
                  onLongPress={handleItemLongPress}
                  hitSlop={6}
                >
                  <ItemIcon item={item} testID="inbox-card-monogram" />
                </Pressable>
                <View style={styles.cardCompactTitleCol}>
                  <Pressable
                    style={styles.cardTitlePressable}
                    accessibilityRole={selectionMode ? 'checkbox' : 'button'}
                    accessibilityLabel={selectionMode ? (isSelected ? t('inbox.deselectItemA11y', { title: displayTitle(item) ?? t('common.untitled') }) : t('inbox.selectItemA11y', { title: displayTitle(item) ?? t('common.untitled') })) : (accessibilityTitle(item) ?? t('common.untitled'))}
                    accessibilityHint={selectionMode ? undefined : t('inbox.openBookmarkHint')}
                    accessibilityState={selectionMode ? { checked: isSelected } : { busy: isOpening }}
                    onPress={handleItemPress}
                    onLongPress={handleItemLongPress}
                  >
                    <HighlightedText
                      testID="inbox-card-title"
                      style={[
                        styles.cardTitle,
                        {
                          lineHeight: 22,
                          color: isTitleDerived(item) ? palette.textSecondary : palette.text,
                          fontWeight: isTitleDerived(item) ? WEB_MEDIUM_WEIGHT : WEB_SEMIBOLD_WEIGHT,
                        },
                      ]}
                      numberOfLines={2}
                      text={displayTitle(item) ?? t('common.untitled')}
                      query={highlightQuery}
                      highlightStyle={highlightStyle}
                    />
                  </Pressable>
                  {item.url ? (
                    <Pressable
                      accessibilityRole={selectionMode ? 'checkbox' : 'link'}
                      accessibilityLabel={selectionMode
                        ? t(isSelected ? 'inbox.deselectItemA11y' : 'inbox.selectItemA11y', { title: displayTitle(item) ?? t('common.untitled') })
                        : t('common.openLink')}
                      accessibilityState={selectionMode ? { checked: isSelected } : undefined}
                      onPress={selectionMode ? () => toggleSelect(item.id) : openLink}
                      onLongPress={handleItemLongPress}
                      style={{ minHeight: uiMetrics.touchTarget, justifyContent: 'center' }}
                      hitSlop={8}
                    >
                      <HighlightedText
                        style={[styles.cardUrl, { color: palette.textSecondary }]}
                        numberOfLines={1}
                        text={siteLabelText}
                        query={highlightQuery}
                        highlightStyle={highlightStyle}
                      />
                    </Pressable>
                  ) : null}
                </View>
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
                {!selectionMode ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('inbox.moreActions')}
                    hitSlop={8}
                    style={[styles.moreButton, styles.cardMoreButton]}
                    onPress={() => setMenuItem(item)}
                  >
                    <Ionicons name="ellipsis-horizontal" size={18} color={palette.textSecondary} />
                  </Pressable>
                ) : null}
              </View>
            ) : (
              <View style={styles.cardTitleRow}>
                <Pressable
                  style={styles.cardTitlePressable}
                  accessibilityRole={selectionMode ? 'checkbox' : 'button'}
                  accessibilityLabel={selectionMode ? (isSelected ? t('inbox.deselectItemA11y', { title: displayTitle(item) ?? t('common.untitled') }) : t('inbox.selectItemA11y', { title: displayTitle(item) ?? t('common.untitled') })) : (accessibilityTitle(item) ?? t('common.untitled'))}
                  accessibilityHint={selectionMode ? undefined : t('inbox.openBookmarkHint')}
                  accessibilityState={selectionMode ? { checked: isSelected } : { busy: isOpening }}
                  onPress={handleItemPress}
                  onLongPress={handleItemLongPress}
                >
                  <HighlightedText
                    testID="inbox-card-title"
                    style={[
                      styles.cardTitle,
                      {
                        lineHeight: 22,
                        color: isTitleDerived(item) ? palette.textSecondary : palette.text,
                        fontWeight: isTitleDerived(item) ? WEB_MEDIUM_WEIGHT : WEB_SEMIBOLD_WEIGHT,
                      },
                    ]}
                    numberOfLines={2}
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
                {!selectionMode ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('inbox.moreActions')}
                    hitSlop={8}
                    style={[styles.moreButton, styles.cardMoreButton]}
                    onPress={() => setMenuItem(item)}
                  >
                    <Ionicons name="ellipsis-horizontal" size={18} color={palette.textSecondary} />
                  </Pressable>
                ) : null}
              </View>
            )}
            {memoPreview ? (
              <HighlightedText
                style={[styles.memoPreviewText, { color: palette.textSecondary }]}
                numberOfLines={3}
                text={memoPreview}
                query={highlightQuery}
                highlightStyle={highlightStyle}
              />
            ) : null}
            {showUrlMatchLine && item.url ? (
              // Standalone (not inside a labeled Pressable, unlike the
              // title above) — `accessible` + `accessibilityLabel` give
              // VoiceOver/TalkBack the real URL as one announced unit;
              // the masked Text inside HighlightedText has no accessible
              // ancestor of its own otherwise.
              <View accessible accessibilityLabel={item.url}>
                <HighlightedText
                  style={[styles.cardUrl, { color: palette.textSecondary }]}
                  numberOfLines={1}
                  text={item.url}
                  query={highlightQuery}
                  highlightStyle={highlightStyle}
                />
              </View>
            ) : null}
            {visibleMetaParts.length > 0 ? (
              <View style={styles.metaChipRow}>
                {visibleMetaParts.map((part) => (
                  <View
                    key={part.key}
                    accessible
                    accessibilityLabel={part.label}
                    style={[
                      styles.metaChip,
                      Platform.OS === 'web'
                        ? { backgroundColor: palette.surface, borderColor: palette.border }
                        : { backgroundColor: palette.mutedSurface },
                    ]}
                  >
                    {part.type === 'collection' ? <Ionicons name="folder-outline" size={12} color={palette.textSecondary} /> : null}
                    <PostHogMaskView style={{ flexShrink: 1 }}>
                      <Text
                        style={[
                          styles.metaChipLabel,
                          { color: Platform.OS === 'web' ? palette.textSecondary : palette.accentText },
                        ]}
                        numberOfLines={1}
                      >
                        {part.label}
                      </Text>
                    </PostHogMaskView>
                  </View>
                ))}
              </View>
            ) : null}
            {status ? (
              <Text style={[styles.cardStatus, { color: palette.accent }]}>{status}</Text>
            ) : null}
          </View>
        </Pressable>
        {isOpening ? (
          <View
            testID="inbox-bookmark-opening"
            pointerEvents="auto"
            style={[styles.bookmarkOpeningOverlay, { backgroundColor: palette.accentSoft }]}
          >
            <ActivityIndicator color={palette.accent} />
          </View>
        ) : null}
      </Card>
    );
    // In a multi-column grid each cell must claim its column width (flex:
    // 1) so cards don't collapse to content width. Single-column leaves the
    // card unwrapped — the native/phone path is byte-for-byte unchanged.
    return columns > 1 ? <View style={{ flex: 1 }}>{cardElement}</View> : cardElement;
  });
}
