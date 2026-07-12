import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  InteractionManager,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type ViewStyle,
  useWindowDimensions,
} from 'react-native';
import Svg, { Circle, Line, Text as SvgText } from 'react-native-svg';

import { nextFacetNonce } from '@/domain/facet-nonce';
import {
  deriveCoOccurrenceGraph,
  deriveGraph,
  layoutGraph,
  layoutTickBudget,
  UNTAGGED_HUB_ID,
  type DeriveGraphInput,
  type PositionedNode,
  type SettledGraph,
} from '@/domain/graph';
import { resolveHubLabels, type HubLabelInput } from '@/domain/graph-labels';
import type { BookmarkTag, Tag } from '@/domain/types';
import { useT } from '@/i18n';
import { getPreference, setPreference } from '@/storage/preferences';
import { useBookmarks } from '@/store/bookmarks';
import { usePalette } from '@/theme';

// The two graph views. `bipartite` (default) is the bookmark↔tag map; `cooccurrence`
// is the tags-only graph where tag–tag edges are weighted by shared bookmarks. The
// choice is persisted in the repository meta store (same KV as the inbox layout).
type GraphMode = 'bipartite' | 'cooccurrence';
const GRAPH_MODES: GraphMode[] = ['bipartite', 'cooccurrence'];
const GRAPH_MODE_PREF_KEY = 'pref.graph.mode';
const GRAPH_MODE_LABEL_KEY: Record<GraphMode, 'graph.modeBipartite' | 'graph.modeCooccurrence'> = {
  bipartite: 'graph.modeBipartite',
  cooccurrence: 'graph.modeCooccurrence',
};
function parseGraphMode(raw: string | null | undefined): GraphMode {
  return raw === 'cooccurrence' ? 'cooccurrence' : 'bipartite';
}

// Node sizing (in layout/viewBox units — the settled layout spans ~1000 units).
// Hubs scale by degree with a sqrt so a very busy tag doesn't dwarf the canvas;
// bookmark nodes stay small so hubs read as the anchors. The range is wide and
// the coefficient steep so a popular tag reads visibly bigger than a lonely one
// (the sqrt still keeps one giant tag from swallowing the canvas, and the clamp
// pins the busiest hub to HUB_MAX_R). VIEWBOX_PAD below derives from HUB_MAX_R,
// so the bounds padding tracks this max and the busiest hub never clips.
const HUB_MIN_R = 18;
const HUB_MAX_R = 54;
const BOOKMARK_R = 9;
const EDGE_WIDTH = 1.4;
const EDGE_OPACITY = 0.72;
const LABEL_SIZE = 24;
// Padding around the settled bounds so hub circles + labels aren't clipped at
// the fit-to-bounds edge. A high-degree hub sitting on the boundary spans up to
// HUB_MAX_R, and its label sits below (or, after the render-side declutter,
// ABOVE) the circle — one line-height plus up to the declutter's bounded nudge
// (2*LABEL_SIZE, see maxLabelOffset). So the pad clears the radius plus a full
// nudged label on EITHER side or an edge hub clips. The viewBox pads min and max
// symmetrically, so this covers both an above- and a below-flipped edge label.
const VIEWBOX_PAD = HUB_MAX_R + LABEL_SIZE * 3;
// Pinch-zoom clamps.
export const MIN_SCALE = 0.4;
export const MAX_SCALE = 6;
// How much fitted content must stay on-screen at the pan extremes: a minimum
// visible sliver so the graph can be swept nearly off the viewport (uncaged pan)
// yet never fully leaves. Per axis it's a fraction of that axis's viewport,
// capped so a very tall/wide viewport doesn't demand an oversized sliver.
const MIN_VISIBLE_FRACTION = 0.15;
const MIN_VISIBLE_CAP = 80;
// Pinch throttle: only push a new scale to the Animated value once the pinch has
// moved this far since the last applied scale, so we re-rasterize the SVG far less
// often per pinch. The exact final scale is always committed on gesture end.
const SCALE_APPLY_STEP = 0.02;
// Web-only: promote the transformed layer to its own compositor layer so a
// translate/scale composites cheaply instead of repainting the whole vector SVG
// each frame. `willChange` isn't in RN's ViewStyle, so it lives behind this cast
// and is only ever applied under Platform.OS === 'web'.
const WEB_COMPOSITE_LAYER = { willChange: 'transform' } as unknown as ViewStyle;

export function graphCanvasSize(
  measured: { w: number; h: number },
  windowSize: { width: number; height: number },
): { w: number; h: number } {
  return {
    w: measured.w || windowSize.width || 320,
    h: measured.h || windowSize.height || 320,
  };
}

function hubRadius(degree: number): number {
  return Math.min(HUB_MAX_R, Math.max(HUB_MIN_R, HUB_MIN_R + 10 * Math.sqrt(degree)));
}

export function clampToRange(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// Max translate (in screen px) per axis: allow panning until only a minimum
// sliver of the fitted NODE content remains on-screen — never let it leave
// entirely, but otherwise don't cage it. `fittedNodeExtent` is the on-screen span
// of the drawable NODE bbox at scale 1 for this axis (fitScale * unpadded node
// span, fitScale being the preserveAspectRatio="…meet" fit); at scale `s` the span
// is fittedNodeExtent * s. The node bbox is centered in the viewport at identity
// (symmetric VIEWBOX_PAD), so its near edge fully clears the viewport once the
// transform translates (span + viewport)/2; we stop MIN_VISIBLE short of that so a
// sliver of REAL NODE content — not padding — always stays. Using the node extent
// (not the padded viewBox span) is what prevents a hard fling from parking the
// viewport over pure padding (a blank canvas). Per-axis, so the letterboxed axis
// gets its correct, tighter bound.
export function maxPanOffset(scale: number, viewportDim: number, fittedNodeExtent: number): number {
  const contentExtent = fittedNodeExtent * scale;
  const minVisible = Math.min(viewportDim * MIN_VISIBLE_FRACTION, MIN_VISIBLE_CAP);
  return Math.max(0, (contentExtent + viewportDim) / 2 - minVisible);
}

export function anchoredPanForScale(input: {
  pan: { x: number; y: number };
  focal: { x: number; y: number };
  viewport: { w: number; h: number };
  startScale: number;
  nextScale: number;
}): { x: number; y: number } {
  const ratio = input.nextScale / input.startScale;
  const focalFromCenter = {
    x: input.focal.x - input.viewport.w / 2,
    y: input.focal.y - input.viewport.h / 2,
  };
  return {
    x: input.pan.x + (1 - ratio) * (focalFromCenter.x - input.pan.x),
    y: input.pan.y + (1 - ratio) * (focalFromCenter.y - input.pan.y),
  };
}

export function panWithPinchFocalDelta(input: {
  anchoredPan: { x: number; y: number };
  startFocal: { x: number; y: number };
  currentFocal: { x: number; y: number };
}): { x: number; y: number } {
  return {
    x: input.anchoredPan.x + input.currentFocal.x - input.startFocal.x,
    y: input.anchoredPan.y + input.currentFocal.y - input.startFocal.y,
  };
}

function touchDistance(a: { pageX: number; pageY: number }, b: { pageX: number; pageY: number }): number {
  return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
}

type PinchTouch = { pageX: number; pageY: number };

export function touchCenterInViewport(
  a: PinchTouch,
  b: PinchTouch,
  containerOrigin: { x: number; y: number },
) {
  return {
    x: (a.pageX + b.pageX) / 2 - containerOrigin.x,
    y: (a.pageY + b.pageY) / 2 - containerOrigin.y,
  };
}

export function pinchStartSnapshot(input: {
  touches: readonly [PinchTouch, PinchTouch];
  lastScale: number;
  panOffset: { x: number; y: number };
  containerOrigin: { x: number; y: number };
}) {
  return {
    startDist: touchDistance(input.touches[0], input.touches[1]),
    startScale: input.lastScale,
    startPan: { x: input.panOffset.x, y: input.panOffset.y },
    startFocal: touchCenterInViewport(input.touches[0], input.touches[1], input.containerOrigin),
  };
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
  const windowSize = useWindowDimensions();

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
    // minSharedDegree: 2 keeps only tags shared by ≥2 bookmarks — the shared
    // backbone — instead of a cloud of single-use tags. Bookmarks whose only tags
    // were filtered out fall back to the untagged hub (handled in the domain layer).
    return { bookmarks: inbox, tags: [...tagsById.values()], bookmarkTags, minSharedDegree: 2 };
    // Intentionally keyed on `signature`, not the churning `inbox`/accessor refs.
  }, [signature]);

  // Bipartite ⇄ co-occurrence view. Defaults to bipartite; the persisted choice
  // loads once on mount (a stored 'cooccurrence' flips it, which re-settles). The
  // ref guard drops a late pref-load that would otherwise clobber a tap the user
  // made before persistence resolved. Declared BEFORE the settle effect so `mode`
  // flows into its dependency array (the settle re-runs when the view changes).
  const [mode, setMode] = useState<GraphMode>('bipartite');
  const modeChosen = useRef(false);
  useEffect(() => {
    let active = true;
    getPreference(GRAPH_MODE_PREF_KEY)
      .then((raw) => {
        if (active && !modeChosen.current) {
          setMode(parseGraphMode(raw));
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  const selectMode = useCallback((next: GraphMode) => {
    modeChosen.current = true;
    setMode(next);
    void setPreference(GRAPH_MODE_PREF_KEY, next).catch(() => {});
  }, []);

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
      // Derive first, then size the tick budget from the graph the user will
      // actually see. Co-occurrence can drop most historical tags as isolates,
      // so budgeting from raw input.tags would starve a small visible graph.
      const graph =
        mode === 'cooccurrence' ? deriveCoOccurrenceGraph(input) : deriveGraph(input);
      const options = { ticks: layoutTickBudget(graph.nodes.length) };
      // Same off-render-path settle for both views — only the derive differs.
      const result = layoutGraph(graph, options);
      if (!cancelled) {
        setSettled(result);
      }
    });
    return () => {
      cancelled = true;
      handle.cancel();
    };
  }, [input, mode]);

  const nodeById = useMemo(() => {
    const map = new Map<string, PositionedNode>();
    for (const node of settled?.nodes ?? []) {
      map.set(node.id, node);
    }
    return map;
  }, [settled]);

  // Resolve hub-label positions ONCE per settled graph (the mass-weighting can
  // pull two popular hubs close enough that their default below-labels collide).
  // Keyed on `settled` (content-stable) + `t` (only churns on locale change), so
  // this never runs per pan/zoom frame. Returns a per-hub id → placement map the
  // label render looks up.
  const labelById = useMemo(() => {
    const map = new Map<string, ReturnType<typeof resolveHubLabels>[number]>();
    if (!settled) {
      return map;
    }
    const hubs: HubLabelInput[] = [];
    for (const node of settled.nodes) {
      if (node.kind === 'bookmark') {
        continue;
      }
      hubs.push({
        id: node.id,
        x: node.x,
        y: node.y,
        r: hubRadius(node.degree),
        text: node.id === UNTAGGED_HUB_ID ? t('graph.untaggedLabel') : node.label,
        degree: node.degree,
      });
    }
    for (const placement of resolveHubLabels(hubs, LABEL_SIZE)) {
      map.set(placement.id, placement);
    }
    return map;
  }, [settled, t]);

  // Padded viewBox dimensions over the settled bounds. The pan clamp derives the
  // per-axis fitted content extent from these (fitScale * vbDim), so it's kept
  // alongside the viewBox string. Guard zero-span (all-collapsed).
  const vbSize = useMemo(() => {
    const b = settled?.bounds;
    if (!b) {
      return { w: 1, h: 1 };
    }
    const spanX = b.width || 1;
    const spanY = b.height || 1;
    return { w: spanX + VIEWBOX_PAD * 2, h: spanY + VIEWBOX_PAD * 2 };
  }, [settled]);

  // Fit-to-bounds: a padded viewBox over the settled bounds, centered by the
  // Svg's preserveAspectRatio="xMidYMid meet".
  const viewBox = useMemo(() => {
    const b = settled?.bounds;
    if (!b) {
      return `0 0 1 1`;
    }
    return `${b.min_x - VIEWBOX_PAD} ${b.min_y - VIEWBOX_PAD} ${vbSize.w} ${vbSize.h}`;
  }, [settled, vbSize]);

  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const containerRef = useRef<View>(null);
  const containerOriginRef = useRef({ x: 0, y: 0 });
  // The pan clamp reads the live viewport from a ref (not the state) because the
  // panResponder is memoized and would otherwise close over a stale {w,h}.
  const viewportRef = useRef({ w: 0, h: 0 });
  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    viewportRef.current = { w: width, h: height };
    setViewport({ w: width, h: height });
    containerRef.current?.measureInWindow((x, y) => {
      containerOriginRef.current = { x, y };
    });
  };
  const canvasSize = graphCanvasSize(viewport, windowSize);
  useEffect(() => {
    if (viewportRef.current.w === 0 || viewportRef.current.h === 0) {
      viewportRef.current = canvasSize;
    }
  }, [canvasSize]);
  // The memoized panResponder also needs the current viewBox size to derive the
  // fitted content extent for the clamp; mirror it into a ref for the same reason.
  const vbSizeRef = useRef({ w: 1, h: 1 });
  useEffect(() => {
    vbSizeRef.current = vbSize;
  }, [vbSize]);

  // Whether a pan/pinch gesture is currently active. Drives a TRANSIENT
  // raster/composite hint: promoting the layer to a cached texture keeps the
  // gesture smooth, but leaving it promoted scales that cached bitmap and blurs
  // on zoom-in. So it's on only while interacting and off at rest, letting the
  // static view re-render as crisp vector SVG at the settled zoom.
  const [interacting, setInteracting] = useState(false);

  // Pan/zoom over the static canvas — zero new deps: PanResponder drives an
  // Animated transform on the outer view. Taps fall through to the SVG nodes
  // (onStartShouldSet = false); only a drag or a two-finger pinch claims the
  // responder.
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(1)).current;
  const lastScale = useRef(1);
  const liveScale = useRef(1);
  // Last scale actually pushed to the Animated value — the pinch throttle applies
  // a new scale only when it drifts SCALE_APPLY_STEP from this.
  const appliedScale = useRef(1);
  // Committed effective pan (screen px) and the value it held at gesture start.
  // extractOffset/flattenOffset move the accumulated pan between the Animated
  // value's offset and value, neither cheaply readable, so we track it ourselves
  // to clamp the ABSOLUTE resulting position rather than just the frame delta.
  const panOffset = useRef({ x: 0, y: 0 });
  const panStart = useRef({ x: 0, y: 0 });
  const pinch = useRef<{
    startDist: number;
    startScale: number;
    startPan: { x: number; y: number };
    startFocal: { x: number; y: number };
  } | null>(null);

  const panResponder = useMemo(
    () => {
      // Per-axis pan bound at the live scale. `fit` maps the PADDED viewBox into
      // the viewport (that's the preserveAspectRatio="…meet" basis), but the sliver
      // guarantee is measured against REAL NODE content, not the symmetric padding:
      // the node bbox is centered in the padded viewBox, so its on-screen extent is
      // `fit * unpadded-node-span` (unpadded span = padded span − VIEWBOX_PAD*2).
      // Feeding maxPanOffset the node extent (not the padded span) stops a hard
      // fling from parking the viewport over pure padding. Reads viewport + viewBox
      // from refs so the memoized responder never closes over stale sizes.
      const axisBounds = () => {
        const { w: vw, h: vh } = viewportRef.current;
        const { w: vbW, h: vbH } = vbSizeRef.current;
        const fit = Math.min(vw / vbW, vh / vbH);
        const nodeW = vbW - VIEWBOX_PAD * 2;
        const nodeH = vbH - VIEWBOX_PAD * 2;
        return {
          x: maxPanOffset(liveScale.current, vw, fit * nodeW),
          y: maxPanOffset(liveScale.current, vh, fit * nodeH),
        };
      };
      // Flatten the offset and re-clamp the pan against the (possibly just-changed)
      // scale — a pinch-out shrinks the allowed range, so an out-of-bounds pan must
      // be pulled back in — then commit the exact final pinch scale. Also drops the
      // transient raster hint so the settled view re-renders as crisp vector SVG.
      const settle = () => {
        setInteracting(false);
        translateX.flattenOffset();
        translateY.flattenOffset();
        lastScale.current = liveScale.current;
        if (appliedScale.current !== liveScale.current) {
          appliedScale.current = liveScale.current;
          scale.setValue(liveScale.current);
        }
        const { x: maxX, y: maxY } = axisBounds();
        const clampedX = clampToRange(panOffset.current.x, -maxX, maxX);
        const clampedY = clampToRange(panOffset.current.y, -maxY, maxY);
        if (clampedX !== panOffset.current.x || clampedY !== panOffset.current.y) {
          panOffset.current = { x: clampedX, y: clampedY };
          // flattenOffset zeroed the offset, so setValue is the absolute position.
          translateX.setValue(clampedX);
          translateY.setValue(clampedY);
        }
        pinch.current = null;
      };
      return PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (event, gesture) =>
          event.nativeEvent.touches.length >= 2 ||
          Math.abs(gesture.dx) > 4 ||
          Math.abs(gesture.dy) > 4,
        onPanResponderGrant: () => {
          setInteracting(true);
          translateX.extractOffset();
          translateY.extractOffset();
          panStart.current = { x: panOffset.current.x, y: panOffset.current.y };
        },
        onPanResponderMove: (event, gesture) => {
          const touches = event.nativeEvent.touches;
          if (touches.length >= 2) {
            const dist = touchDistance(touches[0], touches[1]);
            if (!pinch.current) {
              pinch.current = pinchStartSnapshot({
                touches: [touches[0], touches[1]],
                lastScale: lastScale.current,
                panOffset: panOffset.current,
                containerOrigin: containerOriginRef.current,
              });
            }
            const next = clampToRange(
              (pinch.current.startScale * dist) / pinch.current.startDist,
              MIN_SCALE,
              MAX_SCALE,
            );
            liveScale.current = next;
            const anchoredPan = anchoredPanForScale({
              pan: pinch.current.startPan,
              focal: pinch.current.startFocal,
              viewport: viewportRef.current,
              startScale: pinch.current.startScale,
              nextScale: next,
            });
            const nextPan = panWithPinchFocalDelta({
              anchoredPan,
              startFocal: pinch.current.startFocal,
              currentFocal: touchCenterInViewport(touches[0], touches[1], containerOriginRef.current),
            });
            const { x: maxX, y: maxY } = axisBounds();
            const nextX = clampToRange(nextPan.x, -maxX, maxX);
            const nextY = clampToRange(nextPan.y, -maxY, maxY);
            translateX.setValue(nextX - panStart.current.x);
            translateY.setValue(nextY - panStart.current.y);
            panOffset.current = { x: nextX, y: nextY };
            // Throttle: skip most per-frame scale writes to cut SVG re-rasters.
            if (Math.abs(next - appliedScale.current) >= SCALE_APPLY_STEP) {
              appliedScale.current = next;
              scale.setValue(next);
            }
          } else if (!pinch.current) {
            // Clamp the absolute pan into ±maxPanOffset so the content can't drift
            // fully off the main area into empty space (a sliver always stays).
            const { x: maxX, y: maxY } = axisBounds();
            const nextX = clampToRange(panStart.current.x + gesture.dx, -maxX, maxX);
            const nextY = clampToRange(panStart.current.y + gesture.dy, -maxY, maxY);
            translateX.setValue(nextX - panStart.current.x);
            translateY.setValue(nextY - panStart.current.y);
            panOffset.current = { x: nextX, y: nextY };
          }
        },
        onPanResponderRelease: settle,
        onPanResponderTerminate: settle,
      });
    },
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
    appliedScale.current = 1;
    panOffset.current = { x: 0, y: 0 };
    panStart.current = { x: 0, y: 0 };
    pinch.current = null;
  };

  // useCallback so these stay referentially stable across the `interacting`
  // toggle — the memoized SVG node tree below depends on them, and rebuilding it
  // on every gesture start/end is exactly the repaint hitch the raster hint exists
  // to avoid.
  const openBookmark = useCallback(
    (bookmarkId: string) => {
      router.push({ pathname: '/bookmark/[id]', params: { id: bookmarkId } });
    },
    [router],
  );
  const applyTagFacet = useCallback(
    (tagId: string) => {
      // Exactly how /browse/tags hands a facet to the root Inbox: dismiss this
      // pushed route and re-apply the tag on the Inbox beneath, with a fresh nonce
      // so re-selecting the same tag still re-applies.
      router.dismissTo({ pathname: '/', params: { tag: tagId, t: nextFacetNonce() } });
    },
    [router],
  );

  // The edge + node + label SVG elements, memoized so a `setInteracting` toggle
  // (which flips the transient raster hint at gesture start/end) re-renders ONLY
  // the outer Animated.View/transform wrapper — NOT this whole vector tree. On a
  // hundreds-of-node stash reconciling every <Line>/<Circle> twice per gesture is
  // the very jank the raster hint is meant to hide. `interacting` is deliberately
  // NOT a dep. Keyed on everything the JSX reads.
  const svgChildren = useMemo(() => {
    if (!settled) {
      return null;
    }
    return (
      <>
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
              stroke={palette.textSecondary}
              strokeWidth={EDGE_WIDTH}
              strokeOpacity={EDGE_OPACITY}
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
          // Decluttered placement (may sit above/nudged instead of the fixed
          // below position); the baseline is already resolved for either side.
          const placement = labelById.get(node.id);
          if (!placement) {
            return null;
          }
          return (
            <SvgText
              key={`l${node.id}`}
              x={placement.x}
              y={placement.y}
              fill={palette.text}
              fontSize={LABEL_SIZE}
              fontWeight="700"
              textAnchor="middle"
            >
              {node.id === UNTAGGED_HUB_ID ? t('graph.untaggedLabel') : node.label}
            </SvgText>
          );
        })}
      </>
    );
  }, [settled, nodeById, labelById, palette, t, openBookmark, applyTagFacet]);

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

  // Bipartite: everything sits under the single untagged hub → surface the "add
  // tags" hint. Co-occurrence: NO tag-pair met the shared-bookmark threshold, so
  // the derived graph is empty → an intentional "no shared tags" hint, not a blank
  // canvas. Both keep the mode toggle reachable so the user can switch back.
  const hasTags = settled.nodes.some((node) => node.kind === 'tag');
  const isCoocEmpty = mode === 'cooccurrence' && settled.nodes.length === 0;

  const { w, h } = canvasSize;

  return (
    <View
      ref={containerRef}
      testID="graph-screen"
      style={[styles.container, { backgroundColor: palette.background }]}
      onLayout={onLayout}
    >
      <View testID="graph-canvas" style={StyleSheet.absoluteFill} {...panResponder.panHandlers}>
        <Animated.View
          // Promote this layer to its own GPU/composited texture ONLY while a gesture
          // is active, so a pan/zoom composites the cached layer instead of repainting
          // the vector SVG every frame (the web pinch stutter). The hint is dropped on
          // settle so the static view re-renders as crisp vector SVG at the new zoom
          // rather than scaling a stale cached bitmap (the zoom-in blur). Web uses
          // `will-change: transform`; native uses the platform rasterization hints.
          {...(interacting ? { renderToHardwareTextureAndroid: true, shouldRasterizeIOS: true } : null)}
          style={[
            StyleSheet.absoluteFill,
            interacting && Platform.OS === 'web' ? WEB_COMPOSITE_LAYER : null,
            { transform: [{ translateX }, { translateY }, { scale }] },
          ]}
        >
          <Svg width={w} height={h} viewBox={viewBox} preserveAspectRatio="xMidYMid meet">
            {svgChildren}
          </Svg>
        </Animated.View>
      </View>

      {/* Mode toggle — box-none so taps outside the pill still reach the canvas. */}
      <View pointerEvents="box-none" style={styles.modeToggleWrap}>
        <View
          style={[styles.modeToggle, { backgroundColor: palette.surface, borderColor: palette.border }]}
        >
          {GRAPH_MODES.map((m) => {
            const active = mode === m;
            return (
              <Pressable
                key={m}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={t(GRAPH_MODE_LABEL_KEY[m])}
                testID={`graph-mode-${m}`}
                onPress={() => selectMode(m)}
                style={[styles.modeToggleButton, active ? { backgroundColor: palette.accentSoft } : null]}
              >
                <Text
                  style={[
                    styles.modeToggleText,
                    { color: active ? palette.accentText : palette.textSecondary },
                  ]}
                >
                  {t(GRAPH_MODE_LABEL_KEY[m])}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {isCoocEmpty ? (
        <View pointerEvents="none" style={styles.coocEmpty}>
          <Text style={[styles.emptyTitle, { color: palette.text }]}>
            {t('graph.cooccurrenceEmpty')}
          </Text>
          <Text style={[styles.emptyHint, { color: palette.textSecondary }]}>
            {t('graph.cooccurrenceEmptyHint')}
          </Text>
        </View>
      ) : mode === 'bipartite' && !hasTags ? (
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
  // Full-width row that centers the segmented pill near the top of the canvas.
  // No background/elevation itself (box-none in JSX) — only the pill is a control.
  modeToggleWrap: {
    position: 'absolute',
    top: 16,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  modeToggle: {
    flexDirection: 'row',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    overflow: 'hidden',
    // elevation (no zIndex) keeps Android paint + touch in agreement so the
    // control stays tappable over the pan surface (same reasoning as recenter).
    elevation: 3,
  },
  modeToggleButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  modeToggleText: {
    fontSize: 13,
    fontWeight: '600',
  },
  // Centered hint when the co-occurrence view has no qualifying tag-pairs.
  coocEmpty: {
    position: 'absolute',
    left: 40,
    right: 40,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
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
