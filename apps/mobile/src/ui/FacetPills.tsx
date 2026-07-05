import { Ionicons } from '@expo/vector-icons';
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';

import { sameFilter, type InboxFilter } from '@/domain/filter';
import { useT } from '@/i18n';
import { usePalette } from '@/theme';
import { Chip } from '@/ui/Chip';

export interface FacetChip {
  key: string;
  label: string;
  filter: InboxFilter;
  icon?: keyof typeof Ionicons.glyphMap;
  // How many bookmarks the facet holds. Set for the "container" chips (folders
  // and the Inbox/no-collection set) so their weight is visible at a glance;
  // left undefined for #tag chips (the tag cloud is their frequency view).
  count?: number;
}

/**
 * One pill in the Inbox browse shelf. Memoized so a filter change (which
 * re-renders the whole screen) only re-renders the chips whose `active` flag
 * actually flips — not all of them. With a large library the shelf can hold
 * well over a hundred tag chips, and re-rendering every one on each tap was
 * what made a chip tap feel dead for seconds after drilling in from the tag
 * cloud. `target` comes straight from the (memoized) chip list / module-level
 * filter constants and `onSelect` is referentially stable, so memo's prop
 * compare holds across taps.
 */
const BrowseChip = memo(function BrowseChip({
  target,
  label,
  icon,
  count,
  active,
  onSelect,
}: {
  target: InboxFilter;
  label: string;
  icon?: keyof typeof Ionicons.glyphMap;
  count?: number;
  active: boolean;
  onSelect: (target: InboxFilter) => void;
}) {
  return (
    <Chip
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={() => onSelect(target)}
      variant={active ? 'selected' : 'default'}
      icon={icon}
      count={count}
    >
      {label}
    </Chip>
  );
});

/**
 * Web-only positioning shell for the browse shelf. On native it renders NOTHING
 * of its own — just its children — so the iOS/Android tree is byte-for-byte
 * unchanged. On web it wraps the clipped ScrollView in a relatively-positioned
 * box matching the shelf's centered content column, so the edge fades/buttons
 * pin to the real clipped edges (the 720px box) rather than the window edges.
 */
function ShelfContainer({
  web,
  maxWidth,
  children,
}: {
  web: boolean;
  maxWidth: number;
  children: ReactNode;
}) {
  if (!web) return <>{children}</>;
  return <View style={[styles.shelfWrap, { maxWidth }]}>{children}</View>;
}

// Stops for the edge fade. expo-linear-gradient is NOT a dependency, so instead
// of a true gradient the fade is a few absolutely-positioned strips whose
// palette.background opacity ramps from transparent to opaque toward the clipped
// edge — enough of a scrim to seat the chevron button and hint at overflow.
const SHELF_FADE_STOPS = [0, 0.15, 0.35, 0.6, 0.82, 1];

/**
 * Web-only edge affordance: a fade scrim plus a round chevron button (styled
 * like the sort pill) that scrolls the shelf toward `side`. Rendered only when
 * the shelf can actually scroll that way, so the small-library case stays clean.
 */
function ShelfEdge({
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
        style={[styles.shelfNavButton, { backgroundColor: palette.surface, borderColor: palette.border }]}
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
 * The horizontal, scrollable facet-pill row ("browse shelf"). Given a full,
 * ordered `chips` list — the caller prepends the All / no-collection chips — it
 * renders one memoized pill each and marks the one matching `activeFilter`.
 * Extracted from the Inbox so Library/Tags can reuse the exact same row.
 *
 * On desktop web the row is a clipped `div`; the mouse wheel scrolls the page,
 * not the row, so chips past the right edge are unreachable with no visible
 * signal. The pieces below (all Platform.OS === 'web') translate vertical wheel
 * to horizontal scroll and surface edge fades + chevron buttons. Native is
 * untouched — the wrapper, listeners, and scroll handlers only mount on web.
 */
export function FacetPills({
  chips,
  activeFilter,
  onSelect,
  maxWidth,
}: {
  chips: FacetChip[];
  activeFilter: InboxFilter;
  onSelect: (target: InboxFilter) => void;
  maxWidth: number;
}) {
  const t = useT();
  const isWeb = Platform.OS === 'web';
  const { width: winWidth } = useWindowDimensions();
  const shelfRef = useRef<ScrollView>(null);
  const [canShelfLeft, setCanShelfLeft] = useState(false);
  const [canShelfRight, setCanShelfRight] = useState(false);
  // `getScrollableNode()` returns the underlying DOM `div` on web.
  const shelfNode = useCallback(
    () => (isWeb ? (shelfRef.current?.getScrollableNode() as HTMLElement | null) : null),
    [isWeb],
  );
  const updateShelfEdges = useCallback(() => {
    const node = shelfNode();
    if (!node) return;
    setCanShelfLeft(node.scrollLeft > 0);
    setCanShelfRight(node.scrollLeft + node.clientWidth < node.scrollWidth - 1);
  }, [shelfNode]);
  const scrollShelfBy = useCallback(
    (direction: 1 | -1) => {
      const node = shelfNode();
      if (!node) return;
      shelfRef.current?.scrollTo({
        x: node.scrollLeft + direction * node.clientWidth * 0.8,
        animated: true,
      });
    },
    [shelfNode],
  );
  // Translate vertical wheel to horizontal scroll on the shelf itself. Needs a
  // native DOM listener with { passive: false } so preventDefault can stop the
  // page from scrolling instead.
  useEffect(() => {
    if (!isWeb) return;
    const node = shelfNode();
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const before = node.scrollLeft;
      node.scrollLeft += event.deltaY;
      // Only swallow the page's vertical scroll when the shelf actually moved.
      // scrollLeft clamps itself, so a short row (no overflow) or one already at
      // its edge stays put — and we must let the wheel fall through to the page
      // instead of trapping it under the shelf's hover area.
      if (node.scrollLeft !== before) event.preventDefault();
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [isWeb, shelfNode]);
  // Recompute the edge flags on mount and whenever the clipped geometry can
  // change: viewport width (useWindowDimensions) and chip count. onScroll and
  // onLayout below cover the interactive/measure cases.
  useEffect(() => {
    if (!isWeb) return;
    updateShelfEdges();
  }, [isWeb, winWidth, chips.length, updateShelfEdges]);

  return (
    <ShelfContainer web={isWeb} maxWidth={maxWidth}>
      <ScrollView
        ref={shelfRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        testID="browse-shelf"
        style={[styles.shelf, { maxWidth }]}
        contentContainerStyle={styles.shelfContent}
        // Web-only: track the clipped geometry so the edge affordances
        // appear/disappear as the user scrolls or the row is measured.
        onScroll={isWeb ? updateShelfEdges : undefined}
        onLayout={isWeb ? updateShelfEdges : undefined}
        scrollEventThrottle={isWeb ? 16 : undefined}
      >
        {chips.map((chip) => (
          <BrowseChip
            key={chip.key}
            target={chip.filter}
            label={chip.label}
            icon={chip.icon}
            count={chip.count}
            active={sameFilter(chip.filter, activeFilter)}
            onSelect={onSelect}
          />
        ))}
      </ScrollView>
      {isWeb && canShelfLeft ? (
        <ShelfEdge side="left" label={t('inbox.shelfPrevA11y')} onPress={() => scrollShelfBy(-1)} />
      ) : null}
      {isWeb && canShelfRight ? (
        <ShelfEdge side="right" label={t('inbox.shelfMoreA11y')} onPress={() => scrollShelfBy(1)} />
      ) : null}
    </ShelfContainer>
  );
}

const styles = StyleSheet.create({
  shelf: {
    flexGrow: 0,
    // minHeight (NOT a fixed height): floors the viewport so a horizontal
    // ScrollView can't collapse onto its content on Android, while still letting
    // the row GROW to a taller pill (larger OS font/display sizes, or the taller
    // Samsung system font). A fixed height shorter than the real pill was
    // shaving the rounded edge even when the text inside rendered intact. Chips
    // are vertically centred via shelfContent.alignItems. Spacing is margin
    // (outside the scroll box, so it can't clip).
    minHeight: 42,
    marginTop: 6,
    marginBottom: 0,
    width: '100%',
    alignSelf: 'center',
  },
  shelfContent: {
    paddingHorizontal: 16,
    alignItems: 'center',
    // Match the shelf floor so the pill is centred in the row (and the row grows
    // to fit a taller pill rather than cropping it). No vertical padding here —
    // that would clip the chips' bottom edge on Android.
    minHeight: 42,
    gap: 8,
  },
  // Web-only browse-shelf overflow affordance. These styles are only referenced
  // behind Platform.OS === 'web', so they never touch the native layout.
  shelfWrap: {
    position: 'relative',
    width: '100%',
    alignSelf: 'center',
  },
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
