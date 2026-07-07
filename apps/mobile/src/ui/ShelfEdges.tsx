import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { usePalette } from '@/theme';

// Stops for the edge fade. expo-linear-gradient is NOT a dependency, so instead
// of a true gradient the fade is a few absolutely-positioned strips whose
// palette.background opacity ramps from transparent to opaque toward the clipped
// edge — enough of a scrim to seat the chevron button and hint at overflow.
const SHELF_FADE_STOPS = [0, 0.1, 0.24, 0.44, 0.68, 0.9];

/**
 * Web-only edge affordance: a fade scrim plus a round chevron button (styled
 * like the sort pill) that scrolls a horizontal shelf toward `side`. Rendered
 * only when the shelf can actually scroll that way, so the small-library case
 * stays clean. Shared by the Inbox browse shelf and the search-suggestion shelf
 * so both chip rows behave identically on web.
 */
export function ShelfEdge({
  side,
  label,
  onPress,
}: {
  side: 'left' | 'right';
  label: string;
  onPress: () => void;
}) {
  const palette = usePalette();
  // Right edge: opaque at the right, fading left. Left edge is the mirror.
  const stops = side === 'right' ? SHELF_FADE_STOPS : [...SHELF_FADE_STOPS].reverse();
  return (
    // box-none so chips under the scrim stay tappable; only the button captures.
    <View
      pointerEvents="box-none"
      style={[styles.shelfEdge, side === 'right' ? styles.shelfEdgeRight : styles.shelfEdgeLeft]}
    >
      <View pointerEvents="none" style={styles.shelfFade}>
        {stops.map((opacity, index) => (
          <View key={index} style={{ flex: 1, backgroundColor: palette.background, opacity }} />
        ))}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        style={[styles.shelfNavButton, { backgroundColor: palette.background, borderColor: palette.border }]}
      >
        <Ionicons
          name={side === 'right' ? 'chevron-forward' : 'chevron-back'}
          size={16}
          color={palette.textSecondary}
        />
      </Pressable>
    </View>
  );
}

/**
 * Web-only horizontal-shelf overflow affordance. On desktop web a horizontal
 * row renders as a clipped `div`: the mouse wheel scrolls the page, not the row,
 * so chips past the edge are unreachable with no visible signal. This hook
 * translates vertical wheel to horizontal scroll and tracks whether each edge
 * can scroll, so the caller can render `ShelfEdge` chevrons. Native is untouched
 * — everything here is gated on `Platform.OS === 'web'`.
 *
 * @param active Whether the shelf is currently mounted/visible (mirrors the
 *   caller's render gate); the wheel listener and edge tracking only run while
 *   true.
 * @param geometryDeps Values that change the clipped geometry (viewport width,
 *   item count); the edge flags are recomputed whenever one changes.
 */
export function useShelfEdges(active: boolean, geometryDeps: DependencyList) {
  const isWeb = Platform.OS === 'web';
  const shelfRef = useRef<ScrollView>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);
  // `getScrollableNode()` returns the underlying DOM `div` on web.
  const node = useCallback(
    () => (isWeb ? (shelfRef.current?.getScrollableNode() as HTMLElement | null) : null),
    [isWeb],
  );
  const updateEdges = useCallback(() => {
    const n = node();
    if (!n) return;
    setCanLeft(n.scrollLeft > 0);
    setCanRight(n.scrollLeft + n.clientWidth < n.scrollWidth - 1);
  }, [node]);
  const scrollBy = useCallback(
    (direction: 1 | -1) => {
      const n = node();
      if (!n) return;
      shelfRef.current?.scrollTo({
        x: n.scrollLeft + direction * n.clientWidth * 0.8,
        animated: true,
      });
    },
    [node],
  );
  // Translate vertical wheel to horizontal scroll on the shelf itself. Needs a
  // native DOM listener with { passive: false } so preventDefault can stop the
  // page from scrolling instead.
  useEffect(() => {
    if (!isWeb || !active) return;
    const n = node();
    if (!n) return;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const before = n.scrollLeft;
      n.scrollLeft += event.deltaY;
      // Only swallow the page's vertical scroll when the shelf actually moved.
      // scrollLeft clamps itself, so a short row (no overflow) or one already at
      // its edge stays put — and we must let the wheel fall through to the page
      // instead of trapping it under the shelf's hover area.
      if (n.scrollLeft !== before) event.preventDefault();
    };
    n.addEventListener('wheel', onWheel, { passive: false });
    return () => n.removeEventListener('wheel', onWheel);
  }, [isWeb, active, node]);
  // Recompute the edge flags on mount and whenever the clipped geometry can
  // change (the caller's geometryDeps). onScroll and onLayout on the ScrollView
  // cover the interactive/measure cases.
  useEffect(() => {
    if (!isWeb || !active) return;
    updateEdges();
    // geometryDeps is spread so a width/count change re-measures the edges.
  }, [isWeb, active, updateEdges, ...geometryDeps]);
  return { shelfRef, canLeft, canRight, updateEdges, scrollBy, isWeb };
}

const styles = StyleSheet.create({
  shelfEdge: {
    position: 'absolute',
    // Offset by the shelf's marginTop so the fade/button center on the chip row.
    top: 6,
    bottom: 0,
    width: 48,
    justifyContent: 'center',
  },
  shelfEdgeRight: {
    right: 0,
    alignItems: 'flex-end',
    paddingRight: 4,
  },
  shelfEdgeLeft: {
    left: 0,
    alignItems: 'flex-start',
    paddingLeft: 4,
  },
  shelfFade: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
  },
  shelfNavButton: {
    width: 30,
    height: 30,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
