import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { useT } from '@/i18n';
import { usePalette } from '@/theme';
import { pendingSuggestedFolder, pendingSuggestions, suggestedFolderTokens } from '@/domain/ai-suggestions';
import type { SuggestedFolder } from '@/domain/ai-suggestions';
import { displayTitle } from '@/domain/item-display';
import { useBookmarks } from '@/store/bookmarks';
import type { SuggestedTag } from '@/domain/types';
import { FolderSuggestionLabel, folderChipA11yLabel } from '@/ui/folder-suggestion-chip';
import { useCaptureToast } from '@/ui/capture-toast';

interface ReviewItem {
  id: string;
  title: string;
  suggestions: SuggestedTag[];
  folder: SuggestedFolder | null;
  // Every token identifying `folder`, so dismissing records them all (durable).
  folderTokens: string[];
}

export default function ReviewScreen() {
  const palette = usePalette();
  const t = useT();
  const router = useRouter();
  const { show: showToast } = useCaptureToast();
  const {
    inbox,
    collections,
    getTagsForBookmark,
    getEnrichment,
    getReviewedSuggestions,
    acceptSuggestedTags,
    markSuggestionsReviewed,
    assignCollection,
    createCollection,
    getDismissedFolderSuggestions,
    dismissFolderSuggestion,
    unseenSuggestionIds,
    clearUnseenSuggestions,
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
      if (suggestions.length > 0 || folder) {
        result.push({
          id: bookmark.id,
          title: displayTitle(bookmark) ?? t('common.untitled'),
          suggestions,
          folder,
          folderTokens: suggestedFolderTokens(folder, enrichment?.suggested_collection_name),
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
    t,
  ]);

  const accept = (id: string, suggestions: SuggestedTag[]) => {
    setBusy(true);
    void acceptSuggestedTags(id, suggestions).finally(() => setBusy(false));
  };

  // Dismiss every pending suggestion for a bookmark: record the names as
  // reviewed so they stop driving the "✨" badge / this list, without applying
  // any tags. Synchronous — the reviewed-map update re-derives `items`, so the
  // card drops out on the next render.
  const dismiss = (id: string, suggestions: SuggestedTag[]) => {
    markSuggestionsReviewed(
      id,
      suggestions.map((suggestion) => suggestion.name),
    );
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
  // bookmark lives in the folder the suggestion stops surfacing on its own. A
  // create runs under `busy` so a second tap can't mint a duplicate collection.
  const acceptFolder = (id: string, folder: SuggestedFolder) => {
    if (folder.kind === 'existing') {
      assignCollection(id, folder.id);
      offerMoveUndo(id, folder);
      return;
    }
    setBusy(true);
    void createCollection(folder.name)
      .then((result) => {
        if (result.collection) {
          assignCollection(id, result.collection.id);
          offerMoveUndo(id, folder);
        }
      })
      .finally(() => setBusy(false));
  };

  // Durably dismiss the folder recommendation under every token that identifies
  // it, mirroring the Detail screen — so it stays gone here, on Detail, and in
  // the Inbox/Settings counts (re-surfaces only if a later enrichment proposes a
  // genuinely different folder).
  const dismissFolder = (item: ReviewItem) => {
    for (const token of item.folderTokens) {
      dismissFolderSuggestion(item.id, token);
    }
  };

  // Bulk "Accept" for a card: apply pending tags AND act on the folder for BOTH
  // kinds — file into an existing one, or create the proposed name then file in.
  // A move (folder carries `from`) offers an Undo toast rather than confirming.
  // The create path runs under `busy` (acceptFolder sets it) so a double-tap
  // can't mint a duplicate collection.
  const acceptAll = (item: ReviewItem) => {
    if (item.suggestions.length > 0) {
      accept(item.id, item.suggestions);
    }
    if (item.folder) {
      acceptFolder(item.id, item.folder);
    }
  };

  // Bulk "Dismiss" for a card: mark pending tags reviewed AND durably dismiss the
  // folder suggestion (both kinds, never confirms).
  const dismissAll = (item: ReviewItem) => {
    if (item.suggestions.length > 0) {
      dismiss(item.id, item.suggestions);
    }
    if (item.folder) {
      dismissFolder(item);
    }
  };

  if (items.length === 0) {
    return (
      <View style={styles.emptyWrap}>
        <Text style={[styles.empty, { color: palette.textSecondary }]}>{t('review.empty')}</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={[styles.sectionLabel, { color: palette.textSecondary }]}>
        {t('review.pendingHeader', { count: items.length })}
      </Text>
      {items.map((item) => (
        <View key={item.id} style={[styles.card, { backgroundColor: palette.card }]}>
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
          <View style={styles.chipRow}>
            {/* Folder recommendation leads the row, rendered as an add (📁 → X)
                or a move (📁 ~~from~~ → X) with a ✕ dismiss; tags follow. */}
            {item.folder ? (
              <View style={[styles.folderChip, { borderColor: palette.accent }]}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={folderChipA11yLabel(t, item.folder, item.title)}
                  disabled={busy}
                  onPress={() => acceptFolder(item.id, item.folder!)}
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
          {(() => {
            // The bulk row acts on tags + folder and is shown whenever a card has
            // either. "Accept all"/"Dismiss all" when there are tags (those act on
            // tags AND the folder, both kinds); a folder-only card collapses to
            // the singular "Accept"/"Dismiss". Every item in the list qualifies,
            // so this row effectively always renders.
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
              <View style={styles.actionRow}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={acceptA11y}
                  disabled={busy}
                  hitSlop={6}
                  onPress={() => acceptAll(item)}
                >
                  <Text style={[styles.link, { color: palette.accent }]}>{acceptLabel}</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={dismissA11y}
                  disabled={busy}
                  hitSlop={6}
                  onPress={() => dismissAll(item)}
                >
                  <Text style={[styles.link, { color: palette.textSecondary }]}>{dismissLabel}</Text>
                </Pressable>
              </View>
            );
          })()}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
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
    gap: 20,
  },
  link: {
    fontSize: 14,
    fontWeight: '600',
  },
});
