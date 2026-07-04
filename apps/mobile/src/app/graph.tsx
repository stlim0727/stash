import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  InteractionManager,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import Svg, { Circle, Line, Text as SvgText } from 'react-native-svg';

import { nextFacetNonce } from '@/domain/facet-nonce';
import {
  buildSettledGraph,
  layoutTickBudget,
  UNTAGGED_HUB_ID,
  type DeriveGraphInput,
  type PositionedNode,
  type SettledGraph,
} from '@/domain/graph';
import type { BookmarkTag, Tag } from '@/domain/types';
import { useT } from '@/i18n';
import { useBookmarks } from '@/store/bookmarks';
import { usePalette } from '@/theme';

// Node sizing (in layout/viewBox units — the settled layout spans ~1000 units).
// Hubs scale by degree with a sqrt so a very busy tag doesn't dwarf the canvas;
// bookmark nodes stay small so hubs read as the anchors.
const HUB_MIN_R = 22;
const HUB_MAX_R = 70;
const BOOKMARK_R = 9;
const EDGE_WIDTH = 1.4;
const LABEL_SIZE = 24;
// Padding around the settled bounds so hub circles + labels aren't clipped at
// the fit-to-bounds edge. A high-degree hub sitting on the boundary spans up to
// HUB_MAX_R, and its label sits a further ~LABEL_SIZE below the circle (with
// another line-height of glyph beneath the baseline), so the pad has to clear
// the radius plus the full label drop or the busiest hub clips at the edge.
const VIEWBOX_PAD = HUB_MAX_R + LABEL_SIZE * 2;
// Pinch-zoom clamps.
const MIN_SCALE = 0.4;
const MAX_SCALE = 6;

function hubRadius(degree: number): number {
  return Math.min(HUB_MAX_R, Math.max(HUB_MIN_R, HUB_MIN_R + 8 * Math.sqrt(degree)));
}

function touchDistance(a: { pageX: number; pageY: number }, b: { pageX: number; pageY: number }): number {
  return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
}

/**
 * Bipartite tag-graph view (read-only). Reconstructs the graph input from the
 * store's public surface (inbox + per-bookmark tags — the raw tag tables aren't
 * exposed), settles it ONCE via the pure domain layer, and renders the static
 * positions as an SVG the user can pan/zoom. No live simulation ever runs on the
 * JS thread. Tapping a bookmark opens its detail; tapping a tag hub hands that
 * facet to the root Inbox.
 */
export default function GraphScreen() {
  const palette = usePalette();
  const t = useT();
  const router = useRouter();
  const { inbox, getTagsForBookmark } = useBookmarks();

  // Content signature of the tag topology: sorted bookmark ids each joined with
  // their sorted tag ids. The store's `inbox` is a fresh `.filter().sort()` array
  // on every context-value recompute (verified in store/bookmarks.tsx — the memo
  // that builds `value` depends on `queue`/`isSyncing`/`lastPulledAt`/
  // `loadedBookmarks`, all of which churn on a background pull/enrich), so keying
  // the settle on the array reference would re-settle — and re-scramble the
  // layout under the user — on any sync, even one that changed no tags. Keying on
  // this signature instead resettles ONLY when the topology actually changes.
  const signature = useMemo(() => {
    const parts: string[] = [];
    for (const bookmark of inbox) {
      const tagIds = getTagsForBookmark(bookmark.id)
        .map((tag) => tag.id)
        .sort();
      parts.push(`${bookmark.id}:${tagIds.join(',')}`);
    }
    parts.sort();
    return parts.join('|');
  }, [inbox, getTagsForBookmark]);

  // Rebuild the derive-input from what the store exposes. deriveGraph only reads
  // bookmark_id/tag_id from links and id/name/slug from tags, so this is exact.
  // Keyed on the topology signature so a background sync that changed no tags
  // yields the same input reference and never triggers a resettle.
  const input = useMemo<DeriveGraphInput>(() => {
    const tagsById = new Map<string, Tag>();
    const bookmarkTags: BookmarkTag[] = [];
    for (const bookmark of inbox) {
      for (const tag of getTagsForBookmark(bookmark.id)) {
        tagsById.set(tag.id, tag);
        bookmarkTags.push({
          bookmark_id: bookmark.id,
          tag_id: tag.id,
          source: tag.source,
          confidence: null,
          created_at: tag.created_at,
        });
      }
    }
    return { bookmarks: inbox, tags: [...tagsById.values()], bookmarkTags };
    // Intentionally keyed on `signature`, not the churning `inbox`/accessor refs.
  }, [signature]);

  // The settle is O(ticks·n²) and would block the JS thread through the screen's
  // slide-in if run during render — enough to trip Stash's 2s hang detector on a
  // large stash. So we hold the result in state and compute it in an effect AFTER
  // `runAfterInteractions`, letting the screen paint and the navigation animation
  // finish first. Deterministic seeded layout, so it only runs once per topology.
  const [settled, setSettled] = useState<SettledGraph | null>(null);
  useEffect(() => {
    if (input.bookmarks.length === 0) {
      // Nothing to lay out — the empty state renders; skip the settle entirely.
      return;
    }
    let cancelled = false;
    // Re-settling replaces every position, so show the loading state meanwhile
    // rather than a stale graph.
    setSettled(null);
    const handle = InteractionManager.runAfterInteractions(() => {
      if (cancelled) {
        return;
      }
      // Upper bound on the derived node count (bookmarks + distinct tags + the
      // possible single untagged hub). layoutTickBudget is non-increasing in n,
      // so an overestimate only ever spends fewer ticks — never over budget.
      const n = input.bookmarks.length + input.tags.length + 1;
      const result = buildSettledGraph(input, { ticks: layoutTickBudget(n) });
      if (!cancelled) {
        setSettled(result);
      }
    });
    return () => {
      cancelled = true;
      handle.cancel();
    };
  }, [input]);

  const nodeById = useMemo(() => {
    const map = new Map<string, PositionedNode>();
    for (const node of settled?.nodes ?? []) {
      map.set(node.id, node);
    }
    return map;
  }, [settled]);

  // Fit-to-bounds: a padded viewBox over the settled bounds, centered by the
  // Svg's preserveAspectRatio="xMidYMid meet". Guard zero-span (all-collapsed).
  const viewBox = useMemo(() => {
    const b = settled?.bounds;
    if (!b) {
      return `0 0 1 1`;
    }
    const spanX = b.width || 1;
    const spanY = b.height || 1;
    return `${b.min_x - VIEWBOX_PAD} ${b.min_y - VIEWBOX_PAD} ${spanX + VIEWBOX_PAD * 2} ${
      spanY + VIEWBOX_PAD * 2
    }`;
  }, [settled]);

  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setViewport({ w: width, h: height });
  };

  // Pan/zoom over the static canvas — zero new deps: PanResponder drives an
  // Animated transform on the outer view. Taps fall through to the SVG nodes
  // (onStartShouldSet = false); only a drag or a two-finger pinch claims the
  // responder.
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(1)).current;
  const lastScale = useRef(1);
  const liveScale = useRef(1);
  const pinch = useRef<{ startDist: number; startScale: number } | null>(null);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (event, gesture) =>
          event.nativeEvent.touches.length >= 2 ||
          Math.abs(gesture.dx) > 4 ||
          Math.abs(gesture.dy) > 4,
        onPanResponderGrant: () => {
          translateX.extractOffset();
          translateY.extractOffset();
        },
        onPanResponderMove: (event, gesture) => {
          const touches = event.nativeEvent.touches;
          if (touches.length >= 2) {
            const dist = touchDistance(touches[0], touches[1]);
            if (!pinch.current) {
              pinch.current = { startDist: dist, startScale: lastScale.current };
            }
            const next = Math.min(
              MAX_SCALE,
              Math.max(MIN_SCALE, (pinch.current.startScale * dist) / pinch.current.startDist),
            );
            liveScale.current = next;
            scale.setValue(next);
          } else if (!pinch.current) {
            translateX.setValue(gesture.dx);
            translateY.setValue(gesture.dy);
          }
        },
        onPanResponderRelease: () => {
          translateX.flattenOffset();
          translateY.flattenOffset();
          lastScale.current = liveScale.current;
          pinch.current = null;
        },
        onPanResponderTerminate: () => {
          translateX.flattenOffset();
          translateY.flattenOffset();
          lastScale.current = liveScale.current;
          pinch.current = null;
        },
      }),
    [translateX, translateY, scale],
  );

  // Reset the pan/zoom transform to identity, which restores the initial
  // fit-to-bounds view: the fit itself lives in the SVG's viewBox +
  // preserveAspectRatio, so an untransformed canvas IS the fitted canvas. Lets a
  // user who flung the graph off-screen get back without a way-out dead end.
  const recenter = () => {
    translateX.setOffset(0);
    translateX.setValue(0);
    translateY.setOffset(0);
    translateY.setValue(0);
    scale.setValue(1);
    lastScale.current = 1;
    liveScale.current = 1;
    pinch.current = null;
  };

  const openBookmark = (bookmarkId: string) => {
    router.push({ pathname: '/bookmark/[id]', params: { id: bookmarkId } });
  };
  const applyTagFacet = (tagId: string) => {
    // Exactly how /browse/tags hands a facet to the root Inbox: dismiss this
    // pushed route and re-apply the tag on the Inbox beneath, with a fresh nonce
    // so re-selecting the same tag still re-applies.
    router.dismissTo({ pathname: '/', params: { tag: tagId, t: nextFacetNonce() } });
  };

  // No active bookmarks → a calm, intentional empty state (never a blank canvas).
  // This short-circuits BEFORE the loading state: an empty stash shows the empty
  // state, not a spinner. `input.bookmarks` is the active inbox, which is exactly
  // what deriveGraph keeps, so an empty input means an empty graph.
  if (input.bookmarks.length === 0) {
    return (
      <View
        testID="graph-empty"
        style={[styles.emptyContainer, { backgroundColor: palette.background }]}
      >
        <Ionicons name="git-network-outline" size={44} color={palette.textSecondary} />
        <Text style={[styles.emptyTitle, { color: palette.text }]}>{t('graph.empty')}</Text>
        <Text style={[styles.emptyHint, { color: palette.textSecondary }]}>
          {t('graph.emptyHint')}
        </Text>
      </View>
    );
  }

  // There ARE bookmarks but the off-render-path settle hasn't produced a layout
  // yet → a light loading state while the map builds.
  if (settled === null) {
    return (
      <View
        testID="graph-loading"
        style={[styles.emptyContainer, { backgroundColor: palette.background }]}
      >
        <ActivityIndicator color={palette.accent} />
        <Text style={[styles.emptyHint, { color: palette.textSecondary }]}>
          {t('graph.building')}
        </Text>
      </View>
    );
  }

  // Everything sits under the single untagged hub → surface the "add tags" hint.
  const hasTags = settled.nodes.some((node) => node.kind === 'tag');

  const w = viewport.w || 320;
  const h = viewport.h || 320;

  return (
    <View
      testID="graph-screen"
      style={[styles.container, { backgroundColor: palette.background }]}
      onLayout={onLayout}
    >
      <Animated.View
        {...panResponder.panHandlers}
        style={[
          StyleSheet.absoluteFill,
          { transform: [{ translateX }, { translateY }, { scale }] },
        ]}
      >
        <Svg width={w} height={h} viewBox={viewBox} preserveAspectRatio="xMidYMid meet">
          {settled.edges.map((edge, i) => {
            const source = nodeById.get(edge.source);
            const target = nodeById.get(edge.target);
            if (!source || !target) {
              return null;
            }
            return (
              <Line
                key={`e${i}`}
                x1={source.x}
                y1={source.y}
                x2={target.x}
                y2={target.y}
                stroke={palette.border}
                strokeWidth={EDGE_WIDTH}
                strokeOpacity={0.55}
              />
            );
          })}
          {settled.nodes.map((node) => {
            if (node.kind === 'bookmark') {
              return (
                <Circle
                  key={node.id}
                  testID={`graph-bookmark-${node.bookmark_id}`}
                  cx={node.x}
                  cy={node.y}
                  r={BOOKMARK_R}
                  fill={palette.textSecondary}
                  fillOpacity={0.55}
                  accessibilityLabel={t('graph.bookmarkA11y', { title: node.label })}
                  onPress={() => openBookmark(node.bookmark_id)}
                />
              );
            }
            const isUntagged = node.kind === 'untagged-hub';
            const r = hubRadius(node.degree);
            return (
              <Circle
                key={node.id}
                testID={isUntagged ? 'graph-untagged-hub' : `graph-tag-${node.tag_id}`}
                cx={node.x}
                cy={node.y}
                r={r}
                fill={isUntagged ? palette.textSecondary : palette.accent}
                fillOpacity={isUntagged ? 0.4 : 0.92}
                stroke={isUntagged ? palette.border : palette.accentText}
                strokeWidth={1.5}
                accessibilityLabel={
                  isUntagged
                    ? t('graph.untaggedA11y', { count: node.degree })
                    : t('graph.tagA11y', { name: node.label, count: node.degree })
                }
                // The untagged hub stays a no-op on tap: routing to the Inbox's
                // "uncollected" facet would be semantically wrong (that's a
                // collections concept, not a tag). The real fix is a dedicated
                // untagged-tag facet, deferred.
                onPress={isUntagged ? undefined : () => applyTagFacet(node.tag_id)}
              />
            );
          })}
          {settled.nodes.map((node) => {
            if (node.kind === 'bookmark') {
              return null;
            }
            const r = hubRadius(node.degree);
            return (
              <SvgText
                key={`l${node.id}`}
                x={node.x}
                y={node.y + r + LABEL_SIZE}
                fill={palette.text}
                fontSize={LABEL_SIZE}
                fontWeight="700"
                textAnchor="middle"
              >
                {node.id === UNTAGGED_HUB_ID ? t('graph.untaggedLabel') : node.label}
              </SvgText>
            );
          })}
        </Svg>
      </Animated.View>

      {!hasTags ? (
        <View pointerEvents="none" style={styles.hint}>
          <Text style={[styles.hintText, { color: palette.textSecondary }]}>
            {t('graph.untaggedHint')}
          </Text>
        </View>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('graph.recenterA11y')}
        testID="graph-recenter"
        hitSlop={8}
        onPress={recenter}
        style={({ pressed }) => [
          styles.recenter,
          {
            backgroundColor: palette.surface,
            borderColor: palette.border,
            opacity: pressed ? 0.6 : 1,
          },
        ]}
      >
        <Ionicons name="locate-outline" size={22} color={palette.text} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    overflow: 'hidden',
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  emptyHint: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 21,
  },
  hint: {
    position: 'absolute',
    left: 24,
    right: 24,
    bottom: 28,
    alignItems: 'center',
  },
  hintText: {
    fontSize: 14,
    textAlign: 'center',
  },
  recenter: {
    position: 'absolute',
    right: 20,
    bottom: 28,
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    // elevation (no zIndex) keeps Android paint + touch in agreement so the
    // control can't go visible-but-dead over the pan surface (STASH-7).
    elevation: 3,
  },
});
