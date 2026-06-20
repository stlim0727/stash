import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useT } from '@/i18n';
import { usePalette } from '@/theme';
import { pendingSuggestions } from '@/domain/ai-suggestions';
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
  const { inbox, getTagsForBookmark, getEnrichment, getReviewedSuggestions, acceptSuggestedTags } =
    useBookmarks();
  const [busy, setBusy] = useState(false);

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
          title: bookmark.title ?? bookmark.url ?? t('common.untitled'),
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
          <Text style={[styles.cardTitle, { color: palette.text }]} numberOfLines={2}>
            {item.title}
          </Text>
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
          {item.suggestions.length > 1 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('review.acceptAllA11y', { title: item.title })}
              disabled={busy}
              onPress={() => accept(item.id, item.suggestions)}
            >
              <Text style={[styles.link, { color: palette.accent }]}>{t('review.acceptAll')}</Text>
            </Pressable>
          ) : null}
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
  cardTitle: {
    fontSize: 16,
    fontWeight: '600',
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
  link: {
    fontSize: 14,
    fontWeight: '600',
  },
});
