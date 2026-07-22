import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useT } from '@/i18n';
import { usePalette } from '@/theme';
import { pendingSuggestedFolder, pendingSummary, pendingSuggestions, suggestedFolderTokens } from '@/domain/ai-suggestions';
import type { SuggestedFolder } from '@/domain/ai-suggestions';
import { displayTitle } from '@/domain/item-display';
import { useBookmarks } from '@/store/bookmarks';
import type { SuggestedTag } from '@/domain/types';
import { FolderSuggestionLabel, folderChipA11yLabel } from '@/ui/folder-suggestion-chip';
import { useCaptureToast } from '@/ui/capture-toast';
import { Button } from '@/ui/Button';
import { ProposedSummary } from '@/ui/ProposedSummary';
import {
  acceptSuggestionBundle,
  dismissSuggestionBundle,
} from '@/domain/suggestion-actions';

// Matches the truncation safety net on the Detail screen (see bookmark/[id].tsx).
const MAX_NOTES_LENGTH = 10000;

// On wide (desktop-web) viewports, Review docks as a left-side sheet over the
// dimmed Inbox (mirrors Settings' right-docked sheet); this caps the panel
// width. No effect on phones (their width is already below the breakpoint).
const SHEET_PANEL_MAX_WIDTH = 720;

// Contains scroll chaining to this modal's ScrollView on web (mirrors
// Settings/Report) — without it, pulling past the top/bottom of the card list
// can rubber-band the transparentModal and expose the Inbox behind it.
const webOverscrollContain: StyleProp<ViewStyle> =
  Platform.OS === 'web' ? ({ overscrollBehavior: 'contain' } as ViewStyle) : undefined;

interface ReviewItem {
  id: string;
  title: string;
  suggestions: SuggestedTag[];
  folder: SuggestedFolder | null;
  // Every token identifying `folder`, so dismissing records them all (durable).
  folderTokens: string[];
  // Proposed-summary widget (mirrors Detail's ProposedSummary) — null when there's
  // no un-reviewed AI summary to offer as a note.
  summary: string | null;
  summaryTok: string | null;
  notes: string | null;
  // Mirrors Detail's "Edited since these suggestions" hint — true when the
  // enrichment behind this card's suggestions is stale (a title/notes edit
  // landed after the AI ran).
  stale: boolean;
}

export default function ReviewScreen() {
  const palette = usePalette();
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // Wide viewports present Review as a left-side sheet over a dimmed Inbox;
  // phones keep the full-screen layout (mirrors Settings' right-docked sheet).
  const { width, height } = useWindowDimensions();
  const asSheet = width >= 760;
  const { show: showToast } = useCaptureToast();
  const {
    inbox,
    collections,
    getTagsForBookmark,
    getEnrichment,
    getReviewedSuggestions,
    acceptSuggestedTags,
    addTagsToBookmark,
    markSuggestionsReviewed,
    assignCollection,
    createCollection,
    getDismissedFolderSuggestions,
    dismissFolderSuggestion,
    unseenSuggestionIds,
    clearUnseenSuggestions,
    getReviewedSummary,
    markSummaryReviewed,
    updateBookmarkFields,
  } = useBookmarks();
  const [busy, setBusy] = useState(false);

  // Entering Review means the user is witnessing every pending suggestion, so
  // clear the "new AI suggestions" markers that drive the Inbox banner. Keyed on
  // `unseenSuggestionIds` (not just the stable callback) so it also fires when
  // the persisted marker set finishes hydrating *after* this screen mounted —
  // e.g. a cold start / web reload landing straight on /review, where the store
  // is still loading on the first render. clearUnseenSuggestions no-ops on the
  // empty set, so the extra runs are cheap and it self-settles.
  useEffect(() => {
    clearUnseenSuggestions();
  }, [unseenSuggestionIds, clearUnseenSuggestions]);

  // Every inbox bookmark that still has at least one high-confidence,
  // un-applied tag suggestion OR a pending folder recommendation — the
  // centralized rules live in @/domain/ai-suggestions.
  const items = useMemo<ReviewItem[]>(() => {
    const result: ReviewItem[] = [];
    for (const bookmark of inbox) {
      const enrichment = getEnrichment(bookmark.id);
      const applied = new Set(getTagsForBookmark(bookmark.id).map((tag) => tag.name.toLowerCase()));
      const suggestions = pendingSuggestions(
        enrichment,
        applied,
        getReviewedSuggestions(bookmark.id),
      );
      // Durable folder dismissals (shared with Detail) — a folder waved off on
      // any screen stays gone here too, instead of the old session-only state.
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
      if (suggestions.length > 0 || folder || summary) {
        result.push({
          id: bookmark.id,
          title: displayTitle(bookmark) ?? t('common.untitled'),
          suggestions,
          folder,
          folderTokens: folder
            ? suggestedFolderTokens(folder, enrichment?.suggested_collection_name)
            : [],
          summary: summary?.text ?? null,
          summaryTok: summary?.token ?? null,
          notes: bookmark.notes,
          // Mirrors Detail's "Edited since these suggestions" hint.
          stale: enrichment?.status === 'stale',
        });
      }
    }
    return result;
  }, [
    inbox,
    collections,
    getDismissedFolderSuggestions,
    getTagsForBookmark,
    getEnrichment,
    getReviewedSuggestions,
    getReviewedSummary,
    t,
  ]);

  const accept = (id: string, suggestions: SuggestedTag[]) => {
    setBusy(true);
    void acceptSuggestionBundle(
      {
        acceptSuggestedTags,
        addTagsToBookmark,
        assignCollection,
        createCollection,
        dismissFolderSuggestion,
      },
      {
        bookmarkId: id,
        aiSuggestions: suggestions,
        folder: null,
        folderTokens: [],
        createCollectionError: t('detail.errorCreateCollection'),
      },
    ).finally(() => setBusy(false));
  };

  // Dismiss every pending suggestion for a bookmark: record the names as
  // reviewed so they stop driving the "✨" badge / this list, without applying
  // any tags. Synchronous — the reviewed-map update re-derives `items`, so the
  // card drops out on the next render.
  const dismiss = (id: string, suggestions: SuggestedTag[]) => {
    dismissSuggestionBundle({
      bookmarkId: id,
      aiSuggestionNames: suggestions.map((suggestion) => suggestion.name),
      folderTokens: [],
      markSuggestionsReviewed,
      dismissFolderSuggestion,
    });
  };

  // A move (the folder carries `from`, so filing in overwrites a user-chosen
  // collection_id) is reversible: show a "Moved to {to}" toast whose Undo files
  // the bookmark back into `from`. The chip already shows ~~from~~ → to, so the
  // user sees the move; the toast is the recovery path rather than a blocking
  // confirm. An add (no `from`) overwrites nothing, so no toast.
  const offerMoveUndo = (id: string, folder: SuggestedFolder) => {
    if (!folder.from) {
      return;
    }
    const fromId = folder.from.id;
    showToast(t('review.movedToast', { name: folder.name }), {
      label: t('common.undo'),
      onPress: () => assignCollection(id, fromId),
    });
  };

  // File the bookmark into the suggested folder — assigning an existing one, or
  // creating the proposed name first. Both paths are optimistic; once the
  // bookmark lives in the folder the suggestion stops surfacing on its own. The
  // shared action helper records the decision so a later Undo/move doesn't bring
  // the recommendation back. A create runs under `busy` so a second tap can't
  // mint a duplicate collection.
  const acceptFolder = (item: ReviewItem) => {
    const folder = item.folder;
    if (!folder) {
      return;
    }
    setBusy(true);
    void acceptSuggestionBundle(
      {
        acceptSuggestedTags,
        addTagsToBookmark,
        assignCollection,
        createCollection,
        dismissFolderSuggestion,
      },
      {
        bookmarkId: item.id,
        aiSuggestions: [],
        folder,
        folderTokens: item.folderTokens,
        createCollectionError: t('detail.errorCreateCollection'),
        onAcceptedFolder: (accepted) => offerMoveUndo(item.id, accepted),
      },
    )
      .finally(() => setBusy(false));
  };

  // Durably dismiss the folder recommendation under every token that identifies
  // it, mirroring the Detail screen — so it stays gone here, on Detail, and in
  // the Inbox/Settings counts (re-surfaces only if a later enrichment proposes a
  // genuinely different folder).
  const dismissFolder = (item: ReviewItem) => {
    dismissSuggestionBundle({
      bookmarkId: item.id,
      aiSuggestionNames: [],
      folderTokens: item.folderTokens,
      markSuggestionsReviewed,
      dismissFolderSuggestion,
    });
  };

  // Accept the proposed summary into the note — mirrors Detail's handleUseSummary
  // (sacred-fields rule: fills an empty note, appends to a non-empty one, never
  // overwrites). Durable: marking it reviewed keeps an identical re-pull quiet.
  const useSummaryAsNote = (item: ReviewItem) => {
    if (!item.summary || !item.summaryTok) {
      return;
    }
    const currentNotes = item.notes ?? '';
    const nextNotes = currentNotes.trim() === '' ? item.summary : `${currentNotes}\n\n${item.summary}`;
    const safeNotes = nextNotes.length > MAX_NOTES_LENGTH ? nextNotes.slice(0, MAX_NOTES_LENGTH) : nextNotes;
    updateBookmarkFields(item.id, { notes: safeNotes });
    markSummaryReviewed(item.id, item.summaryTok);
  };

  // Dismiss the proposed summary — durable, mirroring Detail's handleDismissSummary.
  const dismissSummary = (item: ReviewItem) => {
    if (item.summaryTok) {
      markSummaryReviewed(item.id, item.summaryTok);
    }
  };

  // Bulk "Accept" for a card: apply pending tags AND act on the folder for BOTH
  // kinds — file into an existing one, or create the proposed name then file in.
  // A move (folder carries `from`) offers an Undo toast rather than confirming.
  // The create path runs under `busy` (acceptFolder sets it) so a double-tap
  // can't mint a duplicate collection.
  //
  // The row is labeled "Accept all"/"Dismiss all" only when there are tags
  // (see the render below); a folder-only card gets the singular "Accept"/
  // "Dismiss", meaning that action is scoped to the folder alone. So the
  // summary rides along here (and in dismissAll below) only when there ARE
  // tags — otherwise a card with just a folder + a pending summary would have
  // its singular "Dismiss" silently take the unrelated summary with it.
  const acceptAll = (item: ReviewItem) => {
    setBusy(true);
    void acceptSuggestionBundle(
      {
        acceptSuggestedTags,
        addTagsToBookmark,
        assignCollection,
        createCollection,
        dismissFolderSuggestion,
      },
      {
        bookmarkId: item.id,
        aiSuggestions: item.suggestions,
        folder: item.folder,
        folderTokens: item.folderTokens,
        createCollectionError: t('detail.errorCreateCollection'),
        onAcceptedFolder: (folder) => offerMoveUndo(item.id, folder),
      },
    ).finally(() => setBusy(false));
    if (item.suggestions.length > 0) {
      useSummaryAsNote(item);
    }
  };

  // Bulk "Dismiss" for a card: mark pending tags reviewed, durably dismiss the
  // folder suggestion (both kinds), AND — only when the row is actually
  // labeled "Dismiss all" (tags present) — dismiss a pending summary too, so
  // the label stays honest (mirrors Detail's screen-level
  // handleDismissAllSuggestions). The singular folder-only "Dismiss" leaves an
  // accompanying summary alone; a summary-only card never reaches here at all
  // (this row isn't rendered for one).
  const dismissAll = (item: ReviewItem) => {
    dismissSuggestionBundle({
      bookmarkId: item.id,
      aiSuggestionNames: item.suggestions.map((suggestion) => suggestion.name),
      folderTokens: item.folderTokens,
      markSuggestionsReviewed,
      dismissFolderSuggestion,
    });
    if (item.suggestions.length > 0) {
      dismissSummary(item);
    }
  };

  const content =
    items.length === 0 ? (
      <View style={styles.emptyWrap}>
        <Text style={[styles.empty, { color: palette.textSecondary }]}>{t('review.empty')}</Text>
      </View>
    ) : (
      <ScrollView style={webOverscrollContain} contentContainerStyle={styles.container}>
      <Text style={[styles.sectionLabel, { color: palette.textSecondary }]}>
        {t('review.pendingHeader', { count: items.length })}
      </Text>
      {items.map((item) => (
        <View
          key={item.id}
          testID={`review-card-${item.id}`}
          style={[styles.card, { backgroundColor: palette.card }]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('review.goToA11y', { title: item.title })}
            style={styles.titleRow}
            onPress={() => router.push({ pathname: '/bookmark/[id]', params: { id: item.id } })}
          >
            <Text style={[styles.cardTitle, { color: palette.text }]} numberOfLines={2}>
              {item.title}
            </Text>
            <Text style={[styles.titleChevron, { color: palette.textSecondary }]}>›</Text>
          </Pressable>
          {item.stale ? (
            <Text style={[styles.hint, { color: palette.textSecondary }]}>{t('detail.aiStale')}</Text>
          ) : null}
          {(() => {
            // Keep bulk actions anchored near the title; suggestion chips below
            // can wrap without moving the "all" controls around. A card can now
            // be summary-only (no tags, no folder) — the bulk row has nothing to
            // act on then, so skip it entirely rather than show a no-op button;
            // the ProposedSummary widget below carries its own Use/Dismiss.
            if (item.suggestions.length === 0 && !item.folder) {
              return null;
            }
            const hasTags = item.suggestions.length > 0;
            const acceptLabel = hasTags ? t('review.acceptAll') : t('review.acceptOne');
            const acceptA11y = hasTags
              ? t('review.acceptAllA11y', { title: item.title })
              : t('review.acceptOneA11y', { title: item.title });
            const dismissLabel = hasTags ? t('review.dismissAll') : t('review.dismissOne');
            const dismissA11y = hasTags
              ? t('review.dismissAllA11y', { title: item.title })
              : t('review.dismissOneA11y', { title: item.title });
            return (
              <View testID={`review-action-row-${item.id}`} style={styles.actionRow}>
                <Button
                  variant="secondary"
                  size="sm"
                  icon="checkmark-circle-outline"
                  accessibilityLabel={acceptA11y}
                  disabled={busy}
                  style={styles.actionButton}
                  onPress={() => acceptAll(item)}
                >
                  {acceptLabel}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon="close-circle-outline"
                  accessibilityLabel={dismissA11y}
                  disabled={busy}
                  style={styles.actionButton}
                  onPress={() => dismissAll(item)}
                >
                  {dismissLabel}
                </Button>
              </View>
            );
          })()}
          <View testID={`review-chip-row-${item.id}`} style={styles.chipRow}>
            {/* Folder recommendation leads the row, rendered as an add (📁 → X)
                or a move (📁 ~~from~~ → X) with a ✕ dismiss; tags follow. */}
            {item.folder ? (
              <View style={[styles.folderChip, { borderColor: palette.accent }]}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={folderChipA11yLabel(t, item.folder, item.title)}
                  disabled={busy}
                  onPress={() => acceptFolder(item)}
                >
                  <Text style={styles.chipLabel}>
                    <FolderSuggestionLabel
                      t={t}
                      folder={item.folder}
                      accentColor={palette.accent}
                      secondaryColor={palette.textSecondary}
                    />
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('review.dismissFolderA11y', {
                    name: item.folder.name,
                    title: item.title,
                  })}
                  disabled={busy}
                  hitSlop={6}
                  onPress={() => dismissFolder(item)}
                >
                  <Text style={[styles.folderDismiss, { color: palette.textSecondary }]}>✕</Text>
                </Pressable>
              </View>
            ) : null}
            {item.suggestions.map((suggestion) => (
              <Pressable
                key={suggestion.name}
                accessibilityRole="button"
                accessibilityLabel={t('review.acceptTagA11y', {
                  name: suggestion.name,
                  title: item.title,
                })}
                disabled={busy}
                style={[styles.chip, { borderColor: palette.accent }]}
                onPress={() => accept(item.id, [suggestion])}
              >
                <Text style={[styles.chipLabel, { color: palette.accent }]}>
                  {t('review.tagChip', { name: suggestion.name })}
                </Text>
                <Text style={[styles.confidence, { color: palette.textSecondary }]}>
                  {t('review.confidence', { percent: Math.round(suggestion.confidence * 100) })}
                </Text>
              </Pressable>
            ))}
          </View>
          {item.summary
            ? (() => {
                const noteEmpty = (item.notes ?? '').trim() === '';
                return (
                  <ProposedSummary
                    summary={item.summary}
                    noteEmpty={noteEmpty}
                    busy={busy}
                    onUse={() => useSummaryAsNote(item)}
                    onDismiss={() => dismissSummary(item)}
                    useA11yLabel={t(noteEmpty ? 'review.summaryUseA11y' : 'review.summaryAppendA11y', {
                      title: item.title,
                    })}
                    dismissA11yLabel={t('review.summaryDismissA11y', { title: item.title })}
                  />
                );
              })()
            : null}
        </View>
      ))}
      </ScrollView>
    );

  // The Stack header is hidden for this screen, so Review supplies its own
  // header row (title + close) for both layouts — matching Settings/Report.
  const header = (
    <View style={[styles.header, { paddingTop: insets.top + 12, borderBottomColor: palette.border }]}>
      <Text style={[styles.headerTitle, { color: palette.text }]}>{t('nav.review')}</Text>
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

  // Review is a `transparentModal`, so the Inbox stays mounted behind it. On
  // web the modal container sizes to its content instead of the viewport,
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
          testID="review-sheet-backdrop"
          style={styles.sheetBackdrop}
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
          onPress={() => router.back()}
        />
      </View>
    );
  }

  return (
    <View testID="review-fullscreen" style={[styles.fullScreen, { backgroundColor: palette.background, height }]}>
      {header}
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  fullScreen: {
    flex: 1,
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
    fontSize: 20,
    fontWeight: '700',
  },
  headerClose: {
    padding: 4,
  },
  container: {
    padding: 16,
    gap: 12,
  },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  empty: {
    fontSize: 15,
    textAlign: 'center',
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  card: {
    borderRadius: 12,
    padding: 16,
    gap: 12,
  },
  hint: {
    fontSize: 13,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  cardTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
  },
  titleChevron: {
    fontSize: 24,
    fontWeight: '400',
    lineHeight: 24,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  folderChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  folderDismiss: {
    fontSize: 12,
    fontWeight: '600',
  },
  chipLabel: {
    fontSize: 14,
    fontWeight: '500',
  },
  confidence: {
    fontSize: 11,
    fontWeight: '600',
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  actionButton: {
    flex: 1,
    minWidth: 0,
  },
});
