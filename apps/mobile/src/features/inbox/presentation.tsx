import { collectionMatchKey } from '@/domain/collection-match';
import {
  MONOGRAM_COLORS,
  itemIcon,
  monogramIcon,
} from '@/domain/item-icon';
import { isYoutubeAvailabilityCandidate } from '@/domain/page-metadata';
import type { Bookmark } from '@/domain/types';
import { WEB_AMBIENT_BACKGROUND, styles } from '@/features/inbox/layout';
import { metadataStatusLabel, videoUnavailableLabel } from '@/i18n/status';
import type { TFunction } from '@/i18n/translate';
import { usePalette } from '@/theme';
import {
  useState,
  type ComponentProps,
  type ReactNode
} from 'react';
import {
  Animated,
  Image,
  Text,
  View,
  type StyleProp,
  type ViewStyle
} from 'react-native';

export function statusLabel(
  bookmark: Bookmark,
  t: TFunction,
): string | null {
  const parts: string[] = [];
  if (bookmark.metadata_status === 'pending') {
    parts.push(metadataStatusLabel(t, 'pending'));
  }
  // STASH-61 / STASH-71: purely a read of the persisted flag — no network call from the
  // card. Detection only ever happens on-demand from the Detail screen; this
  // just surfaces a result that's already been found. Guarded by candidate check
  // so playlists (STASH-71) never display "video unavailable".
  if (bookmark.video_unavailable && isYoutubeAvailabilityCandidate(bookmark.url ?? '')) {
    parts.push(videoUnavailableLabel(t));
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
export function queryTerms(query: string): string[] {
  return query
    .split(/\s+/)
    .map(collectionMatchKey)
    .filter(Boolean);
}

/** Whether a single label value (tag, site name) is hit by any query term. */
export function valueMatchesTerms(value: string | null | undefined, terms: string[]): boolean {
  if (!value || terms.length === 0) {
    return false;
  }
  const key = collectionMatchKey(value);
  if (!key) {
    return false;
  }
  return terms.some((term) => key.includes(term));
}

/**
 * The bookmark's leading glyph — its favicon when known, otherwise a colored
 * domain monogram. Shared by both Inbox layouts; `compact` shrinks it for the
 * dense list rows.
 */
export function ItemIcon({
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
      <View testID={testID} style={[sizeStyle, styles.faviconTile, { borderColor: palette.border }]}>
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

export function InboxRootSurface({
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
export function WebCrispAnimatedSurface({
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
