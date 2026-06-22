import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { useT } from '@/i18n';
import { usePalette } from '@/theme';
import { pendingSuggestions } from '@/domain/ai-suggestions';
import { displayTitle } from '@/domain/item-display';
import { useBookmarks } from '@/store/bookmarks';
import type { SuggestedTag } from '@/domain/types';

interface ReviewItem {
  id: string;
  title: string;
  suggestions: SuggestedTag[];
}

export default function ReviewScreen() {
  const palette = usePalette();
  const t = useT();
  const router = useRouter();
  const {
    inbox,
    getTagsForBookmark,
    getEnrichment,
    getReviewedSuggestions,
    acceptSuggestedTags,
    markSuggestionsReviewed,
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
  // un-applied suggestion — the centralized rule lives in @/domain/ai-suggestions.
  const items = useMemo<ReviewItem[]>(() => {
    const result: ReviewItem[] = [];
    for (const bookmark of inbox) {
      const applied = new Set(getTagsForBookmark(bookmark.id).map((tag) => tag.name.toLowerCase()));
      const suggestions = pendingSuggestions(
        getEnrichment(bookmark.id),
        applied,
        getReviewedSuggestions(bookmark.id),
      );
      if (suggestions.length > 0) {
        result.push({
          id: bookmark.id,
          title: displayTitle(bookmark) ?? t('common.untitled'),
          suggestions,
        });
      }
    }
    return result;
  }, [inbox, getTagsForBookmark, getEnrichment, getReviewedSuggestions, t]);

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
                  ＋ {suggestion.name}
                </Text>
                <Text style={[styles.confidence, { color: palette.textSecondary }]}>
                  {t('review.confidence', { percent: Math.round(suggestion.confidence * 100) })}
                </Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.actionRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('review.acceptAllA11y', { title: item.title })}
              disabled={busy}
              hitSlop={6}
              onPress={() => accept(item.id, item.suggestions)}
            >
              <Text style={[styles.link, { color: palette.accent }]}>{t('review.acceptAll')}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('review.dismissAllA11y', { title: item.title })}
              disabled={busy}
              hitSlop={6}
              onPress={() => dismiss(item.id, item.suggestions)}
            >
              <Text style={[styles.link, { color: palette.textSecondary }]}>
                {t('review.dismissAll')}
              </Text>
            </Pressable>
          </View>
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
