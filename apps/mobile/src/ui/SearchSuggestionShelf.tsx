import { useEffect, useRef } from 'react';
import { Animated, ScrollView, StyleSheet, Text } from 'react-native';

import { usePalette } from '@/theme';
import { Chip } from '@/ui/Chip';
import { useT } from '@/i18n';
import type { SearchSuggestion } from '@/domain/search-suggestions';

/** Reveal/dismiss timings (ms), per the design spec §6. */
const REVEAL_MS = 140;
const DISMISS_MS = 120;

/** The leading glyph for each chip family (recents/folders carry an icon). */
const KIND_ICON = {
  recent: 'time-outline',
  folder: 'folder-outline',
  // Tags render bare (the `#` prefix carries the meaning), matching the browse
  // shelf's tag chips — no icon.
  tag: undefined,
} as const;

interface SearchSuggestionShelfProps {
  suggestions: SearchSuggestion[];
  /** Tap: fill the query (recent) or apply a facet (tag/folder). See §5. */
  onPick: (suggestion: SearchSuggestion) => void;
  /** Long-press a recent chip to remove just that entry (Phase-1 Q2). */
  onRemoveRecent?: (suggestion: SearchSuggestion) => void;
  /**
   * The active (debounced) query, when typing. Phase 2 (§13.7): swaps the
   * ScrollView's a11y region label to announce the rail is a FILTERED set
   * matching the query, rather than the generic "Search suggestions". Empty/
   * absent in the focus-empty state, where the generic label is correct.
   */
  query?: string;
}

/**
 * The focused-empty search suggestion shelf: a single horizontally-scrolling row
 * of chips offering the user's recent searches, top tags, and top folders.
 *
 * Presentational only — all ordering/cap/dedupe logic lives in
 * `buildSearchSuggestions` (ST-2); this component just renders what it's fed.
 * It mounts a brief opacity reveal (§6) so the shelf fades in rather than
 * snapping. It is designed to live INSIDE the collapsing header cluster (so it
 * translates with the header and its chips stay hittable on Android) — the
 * parent (`index.tsx`) is responsible for that placement.
 */
export function SearchSuggestionShelf({
  suggestions,
  onPick,
  onRemoveRecent,
  query = '',
}: SearchSuggestionShelfProps) {
  const palette = usePalette();
  const t = useT();
  // A single container-opacity Animated.Value (§6): no translateX/height on the
  // chips, to avoid fighting the header's own translateY transform.
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const reveal = Animated.timing(opacity, {
      toValue: 1,
      duration: REVEAL_MS,
      useNativeDriver: true,
    });
    reveal.start();
    return () => {
      // Snappier dismiss than the reveal; the parent unmounts us, so this is the
      // fade that plays as the component tears down on blur.
      reveal.stop();
      Animated.timing(opacity, {
        toValue: 0,
        duration: DISMISS_MS,
        useNativeDriver: true,
      }).start();
    };
  }, [opacity]);

  return (
    <Animated.View style={{ opacity }}>
      <Text
        style={[styles.affordance, { color: palette.textSecondary }]}
      >
        {t('search.shelfAffordance')}
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        testID="search-suggestion-shelf"
        accessibilityLabel={
          query.trim() ? t('search.shelfFilteredA11y', { query: query.trim() }) : t('search.shelfA11y')
        }
        style={styles.shelf}
        contentContainerStyle={styles.shelfContent}
      >
        {suggestions.map((suggestion) => {
          const chipQuery = suggestion.query ?? suggestion.label;
          const a11yLabel =
            suggestion.kind === 'recent'
              ? t('search.recentChipA11y', { query: chipQuery })
              : suggestion.kind === 'tag'
                ? t('search.tagChipA11y', { name: suggestion.label.replace(/^#/, '') })
                : t('search.folderChipA11y', { name: suggestion.label });
          // Removing a recent is a destructive action only reachable by
          // long-press for sighted users; expose it to VoiceOver/TalkBack as an
          // accessibility action so screen-reader users can delete it too.
          const removable = suggestion.kind === 'recent' && onRemoveRecent;
          return (
            <Chip
              key={suggestion.key}
              testID={`suggestion-${suggestion.kind}-${suggestion.key}`}
              accessibilityRole="button"
              accessibilityLabel={a11yLabel}
              accessibilityActions={
                removable ? [{ name: 'delete', label: t('search.removeRecentA11y', { query: chipQuery }) }] : undefined
              }
              onAccessibilityAction={
                removable
                  ? (event) => {
                      if (event.nativeEvent.actionName === 'delete') {
                        onRemoveRecent!(suggestion);
                      }
                    }
                  : undefined
              }
              icon={KIND_ICON[suggestion.kind]}
              onPress={() => onPick(suggestion)}
              // Long-press a recent to remove just that entry (no destructive
              // confirm — it's one search string). Tags/folders have no remove.
              onLongPress={removable ? () => onRemoveRecent!(suggestion) : undefined}
            >
              {suggestion.label}
            </Chip>
          );
        })}
      </ScrollView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // A quieter notch (11pt) than the "Browse" sortCaption (13pt) so it reads as a
  // section hint, not a control. Aligned to the chips at paddingHorizontal 16.
  affordance: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: 16,
    marginTop: 8,
  },
  // Same floor as the browse shelf (`styles.shelf` in index.tsx): minHeight (not
  // a fixed height) so the horizontal ScrollView can't collapse on Android while
  // still growing for taller system fonts.
  shelf: {
    flexGrow: 0,
    minHeight: 42,
    marginTop: 4,
    marginBottom: 0,
  },
  shelfContent: {
    paddingHorizontal: 16,
    alignItems: 'center',
    minHeight: 42,
    gap: 8,
  },
});
