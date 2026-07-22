import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
// Bookmark-node labels: much smaller than hub labels (BOOKMARK_R dwarfs the hub
// radius range) and length-capped so a long title can't sprawl across
// neighboring nodes — truncateGraphLabel below adds the ellipsis.
// Sized up from 11 and given a heavier weight (STASH-2N): pinch-zoom is a
// transform-scale over a fixed-resolution SVG (see the `interacting` comment
// below), so at high zoom the rendered glyphs get magnified rather than
// re-rasterized — thin small text shows that as blur first. A larger,
// semibold glyph stays legible through that softening; it doesn't make the
// text pixel-crisp, since the underlying scale-transform rendering is
// unchanged.
const BOOKMARK_LABEL_SIZE = 13;
const BOOKMARK_LABEL_WEIGHT = '600';
const BOOKMARK_LABEL_MAX_CHARS = 18;
// Keep gesture-time SVG text work bounded independently of library size. The
// stable bucket preserves labels for the most connected bookmarks; a small
// gesture-local bucket adds context around the user's initial touch focal point.
const INTERACTION_PRIORITY_LABEL_LIMIT = 16;
const INTERACTION_NEARBY_LABEL_LIMIT = 8;
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
// Wheel/trackpad zoom: exponential so repeated small trackpad deltas compound
// smoothly, and a single physical mouse-wheel notch (deltaY ~100) reads as a
// ~15% zoom step — close enough to the pinch gesture's feel to not need its own
// tuning UI.
const WHEEL_ZOOM_SENSITIVITY = 0.0015;
// A single trackpad/smooth-wheel gesture fires many `wheel` events in quick
// succession — baking (a viewBox state update, forcing the whole SVG to
// re-render) on every one of them would replace the cheap Animated-transform
// interaction path with exactly the expensive work it exists to avoid,
// stuttering on a large stash (review finding on #527). So each tick only
// updates the cheap live transform; the bake is debounced until wheel input
// goes idle for this long — comparable to common trackpad
// gesture-end-detection debounces (~100-200ms).
const WHEEL_SETTLE_DELAY_MS = 150;
// Web-only: promote the transformed layer to its own compositor layer so a
// translate/scale composites cheaply instead of repainting the whole vector SVG
// each frame. `willChange` isn't in RN's ViewStyle, so it lives behind this cast
// and is only ever applied under Platform.OS === 'web'.
const WEB_COMPOSITE_LAYER = { willChange: 'transform' } as unknown as ViewStyle;
// Web-only: the SVG <text> labels (tag hubs + bookmark titles) are natively
// selectable by the browser. react-native-web's PanResponder implementation
// (ResponderSystem.js) treats a native `selectionchange` with a non-collapsed
// selection as a TERMINATE signal for whatever gesture it's tracking — so if a
// drag starts on/over a label and the browser starts selecting text, our pan
// gets forcibly cut. A fast drag makes this worse (more screen distance covered
// before our own move-threshold claims the gesture, giving the browser's native
// selection more of a head start) and so does dragging near the settled
// content's edge (that's where labels cluster most densely — hub labels can
// nudge right up to the padding boundary). Disabling selection removes the only
// way a selection can START inside the canvas, so this must be applied to the
// whole draggable canvas unconditionally — not gated on `interacting`, since
// selection can anchor on the very first mousedown, before any gesture is even
// recognized. `userSelect` is a TextStyle field in RN's types, not ViewStyle,
// hence the cast (same pattern as WEB_COMPOSITE_LAYER above).
const WEB_NO_TEXT_SELECT = { userSelect: 'none' } as unknown as ViewStyle;

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

export function wheelZoomScale(startScale: number, deltaY: number): number {
  return clampToRange(startScale * Math.exp(-deltaY * WHEEL_ZOOM_SENSITIVITY), MIN_SCALE, MAX_SCALE);
}

// Caps a bookmark node's label so a long title can't sprawl across the
// canvas; appends an ellipsis when it clips. Pure + exported for testing.
export function truncateGraphLabel(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function selectPriorityBookmarkLabelIds(
  nodes: readonly PositionedNode[],
  limit = INTERACTION_PRIORITY_LABEL_LIMIT,
): Set<string> {
  return new Set(
    nodes
      .filter((node) => node.kind === 'bookmark')
      .sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id))
      .slice(0, Math.max(0, limit))
      .map((node) => node.id),
  );
}

export function selectNearbyBookmarkLabelIds(input: {
  nodes: readonly PositionedNode[];
  excludedIds: ReadonlySet<string>;
  focal: { x: number; y: number };
  viewport: { w: number; h: number };
  viewBox: { minX: number; minY: number; w: number; h: number };
  scale: number;
  pan: { x: number; y: number };
  limit?: number;
}): Set<string> {
  const { nodes, excludedIds, focal, viewport, viewBox, scale, pan } = input;
  const limit = Math.max(0, input.limit ?? INTERACTION_NEARBY_LABEL_LIMIT);
  if (limit === 0 || viewport.w <= 0 || viewport.h <= 0 || viewBox.w <= 0 || viewBox.h <= 0) {
    return new Set();
  }
  const fit = Math.min(viewport.w / viewBox.w, viewport.h / viewBox.h);
  const letterboxX = (viewport.w - viewBox.w * fit) / 2;
  const letterboxY = (viewport.h - viewBox.h * fit) / 2;
  const centerX = viewport.w / 2;
  const centerY = viewport.h / 2;

  return new Set(
    nodes
      .filter((node) => node.kind === 'bookmark' && !excludedIds.has(node.id))
      .map((node) => {
        const fittedX = letterboxX + (node.x - viewBox.minX) * fit;
        const fittedY = letterboxY + (node.y - viewBox.minY) * fit;
        const screenX = centerX + (fittedX - centerX) * scale + pan.x;
        const screenY = centerY + (fittedY - centerY) * scale + pan.y;
        return {
          id: node.id,
          distanceSquared: (screenX - focal.x) ** 2 + (screenY - focal.y) ** 2,
        };
      })
      .sort((a, b) => a.distanceSquared - b.distanceSquared || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map(({ id }) => id),
  );
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

type ViewBoxRect = { minX: number; minY: number; w: number; h: number };

// Re-renders the SVG at native resolution for a just-committed pan/zoom
// instead of only ever stretching a fixed-resolution picture via the
// Animated transform (STASH-2N/STASH-2R: bookmark-node label text read as
// visibly blurred at high pinch-zoom). Once a gesture settles, its
// transform is "baked" into a new `viewBox` covering exactly the same
// on-screen content, and the Animated transform resets to identity against
// that new baseline — so the next paint draws crisp vector content
// (including SvgText glyphs) at the committed zoom. `pan`/`scale` are
// relative to `base` (scale 1, pan {0,0} is a no-op returning `base`
// unchanged). The result keeps `base`'s aspect ratio — and therefore its
// preserveAspectRatio="meet" letterbox proportions — so the fit scale factor
// changes by exactly `scale`. Pure + exported for testing: the production
// call sites can't be exercised without a real gesture stream, but the
// screen-mapping this produces can be checked directly (see the graph test
// file's "bake viewBox" describe block, which verifies the OLD system's
// base+pan+scale screen mapping and the NEW system's baked+identity mapping
// agree for sample points).
export function bakeViewBox(input: {
  base: ViewBoxRect;
  viewport: { w: number; h: number };
  pan: { x: number; y: number };
  scale: number;
}): ViewBoxRect {
  const { base, viewport, pan, scale } = input;
  const fit = Math.min(viewport.w / base.w, viewport.h / base.h);
  const offsetX = (viewport.w - base.w * fit) / 2;
  const offsetY = (viewport.h - base.h * fit) / 2;
  const halfVisibleX = viewport.w / 2 - offsetX;
  const halfVisibleY = viewport.h / 2 - offsetY;
  return {
    minX: base.minX + ((scale - 1) * halfVisibleX - pan.x) / (scale * fit),
    minY: base.minY + ((scale - 1) * halfVisibleY - pan.y) / (scale * fit),
    w: base.w / scale,
    h: base.h / scale,
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

  const bookmarkNodes = useMemo(
    () => (settled?.nodes ?? []).filter((node) => node.kind === 'bookmark'),
    [settled],
  );
  const priorityBookmarkLabelIds = useMemo(
    () => selectPriorityBookmarkLabelIds(bookmarkNodes),
    [bookmarkNodes],
  );
  const priorityBookmarkNodes = useMemo(
    () => bookmarkNodes.filter((node) => priorityBookmarkLabelIds.has(node.id)),
    [bookmarkNodes, priorityBookmarkLabelIds],
  );
  const bulkBookmarkNodes = useMemo(
    () => bookmarkNodes.filter((node) => !priorityBookmarkLabelIds.has(node.id)),
    [bookmarkNodes, priorityBookmarkLabelIds],
  );

  // Live "bookmark id → current title" lookup for the visible bookmark label.
  // `settled.nodes[i].label` is a snapshot from the last TOPOLOGY settle (see
  // `signature` above) — a title edit or enrichment result doesn't change tag
  // links, so it wouldn't trigger a resettle and the label would render stale
  // until an unrelated tag change or remount. Keyed on a title/url signature
  // (not the churning `inbox` reference) for the same reason `input` is keyed
  // on `signature`: a background sync/enrich that changed no title text must
  // not rebuild the whole (hundreds-of-node) SVG tree.
  const titleSignature = useMemo(() => {
    const parts: string[] = [];
    for (const bookmark of inbox) {
      parts.push(`${bookmark.id}:${bookmark.title ?? ''}|${bookmark.url ?? ''}`);
    }
    parts.sort();
    return parts.join('\n');
  }, [inbox]);
  const bookmarkTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const bookmark of inbox) {
      map.set(bookmark.id, bookmark.title ?? bookmark.url ?? 'Untitled');
    }
    return map;
    // Intentionally keyed on `titleSignature`, not the churning `inbox` reference.
  }, [titleSignature]);

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

  // Fit-to-bounds: a padded viewBox over the settled bounds, centered by the
  // Svg's preserveAspectRatio="xMidYMid meet". This is the ORIGINAL baseline
  // the view resets to on a resettle or a recenter tap. Guard zero-span
  // (all-collapsed).
  const fitViewBoxRect = useMemo<ViewBoxRect>(() => {
    const b = settled?.bounds;
    if (!b) {
      return { minX: 0, minY: 0, w: 1, h: 1 };
    }
    const spanX = b.width || 1;
    const spanY = b.height || 1;
    return {
      minX: b.min_x - VIEWBOX_PAD,
      minY: b.min_y - VIEWBOX_PAD,
      w: spanX + VIEWBOX_PAD * 2,
      h: spanY + VIEWBOX_PAD * 2,
    };
  }, [settled]);

  // The actual (unpadded) node bbox span — constant per settle, independent
  // of zoom/pan. The pan clamp needs THIS, not a span derived from the
  // current viewBox (which shrinks every time a gesture bakes a deeper
  // zoom, see `bakeViewBox` above) — otherwise a deep zoom would lose track
  // of where the real node content is.
  const nodeExtentRef = useRef({ w: 1, h: 1 });
  useEffect(() => {
    const b = settled?.bounds;
    nodeExtentRef.current = { w: b?.width || 1, h: b?.height || 1 };
  }, [settled]);

  // The CURRENTLY RENDERED viewBox. Starts as `fitViewBoxRect` and gets
  // replaced ("baked") once a pan/pinch/wheel gesture settles, so the SVG
  // re-renders its vector content at native resolution for the committed
  // zoom instead of only ever being magnified via the Animated transform
  // (see `bakeViewBox` above). The live gesture itself still uses the cheap
  // transform for smooth interaction — only the settled/resting view gets
  // re-rendered. Mirrored into a ref for the memoized panResponder/wheel
  // handler closures below, which can't see a fresh state value.
  const [viewBoxRect, setViewBoxRect] = useState<ViewBoxRect>(fitViewBoxRect);
  const viewBox = `${viewBoxRect.minX} ${viewBoxRect.minY} ${viewBoxRect.w} ${viewBoxRect.h}`;
  // Bumped alongside every `setViewBoxRect` call below, and the only dep of
  // the transform-reset effect (see `transformResetToken` useLayoutEffect
  // further down) — NOT `viewBoxRect` itself. A `setViewBoxRect(fitViewBoxRect)`
  // call (recenter/topology-resettle) can pass a value that's already
  // reference-equal to the current `viewBoxRect` (e.g. recentering before an
  // in-flight debounced wheel-zoom bake has ever replaced it), which makes
  // React bail out of that state update — no re-render, so an effect keyed on
  // `viewBoxRect` would never re-fire and the Animated transform would stay
  // stuck at its live (non-identity) value while the refs reset underneath it
  // (review finding on #561). This token always changes, so the effect always
  // re-fires exactly once per bake.
  const [transformResetToken, setTransformResetToken] = useState(0);
  const bumpTransformResetToken = () => setTransformResetToken((v) => v + 1);
  // `bakeViewBox`'s `base` is ALWAYS `fitViewBoxRect` — never the previous
  // bake's output — mirrored into a ref for the memoized panResponder/wheel
  // handler closures below, which can't see a fresh memo value. Baking from
  // a FIXED base using the full CUMULATIVE pan/scale (panOffset/lastScale
  // below, which mirror the pre-baking code's semantics exactly) means every
  // bake is independent and exact, with no compounding drift from repeatedly
  // re-basing on the previous bake's own output (review finding on #527:
  // re-basing incrementally lost track of how far the node content had
  // already drifted off-center, so a repeated max-pan in the same direction
  // could keep pushing it further each gesture instead of clamping in place).
  const fitViewBoxRectRef = useRef<ViewBoxRect>(fitViewBoxRect);
  useEffect(() => {
    fitViewBoxRectRef.current = fitViewBoxRect;
  }, [fitViewBoxRect]);

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
  // The memoized panResponder also needs the FIXED baseline's size to derive
  // the fitted content extent for the clamp (the clamp is always evaluated
  // against `fitViewBoxRect`, never the current baked `viewBoxRect` — see
  // `fitViewBoxRectRef` above); mirror it into a ref for the same
  // stable-closure reason.
  const vbSizeRef = useRef({ w: 1, h: 1 });
  useEffect(() => {
    vbSizeRef.current = { w: fitViewBoxRect.w, h: fitViewBoxRect.h };
  }, [fitViewBoxRect]);

  // Whether a pan/pinch gesture is currently active. Drives a TRANSIENT
  // raster/composite hint: promoting the layer to a cached texture keeps the
  // gesture smooth, but leaving it promoted scales that cached bitmap and blurs
  // on zoom-in. So it's on only while interacting and off at rest, letting the
  // static view re-render as crisp vector SVG at the settled zoom.
  const [interacting, setInteracting] = useState(false);
  const [nearbyBookmarkLabelIds, setNearbyBookmarkLabelIds] = useState<Set<string>>(
    () => new Set(),
  );

  // Pan/zoom over the static canvas — zero new deps: PanResponder drives an
  // Animated transform on the outer view. Taps fall through to the SVG nodes
  // (onStartShouldSet = false); only a drag or a two-finger pinch claims the
  // responder.
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(1)).current;
  // Absolute, cumulative scale relative to the ORIGINAL fit-to-bounds view
  // (`fitViewBoxRect`) — the SAME baseline `bakeViewBox` always bakes
  // against (never the previous bake's output; see `fitViewBoxRectRef`
  // above). Baking resets the Animated `scale`/pan transform back to
  // identity every time, but this deliberately does NOT reset — together
  // with `panOffset` below, it's the TRUE cumulative state the pan/zoom
  // clamp is evaluated against, which is what enforces [MIN_SCALE,
  // MAX_SCALE] AND the pan-clamp sliver guarantee across any number of
  // successive gestures/wheel ticks (a review finding on #527: resetting
  // this after each bake and clamping against a "relative to the last bake"
  // quantity instead let repeated max-pan gestures in the same direction
  // each individually pass the clamp while drifting the real node content
  // further off-screen every time).
  const lastScale = useRef(1);
  const liveScale = useRef(1);
  // Last scale actually pushed to the Animated value — the pinch throttle applies
  // a new scale only when it drifts SCALE_APPLY_STEP from this.
  const appliedScale = useRef(1);
  // The absolute cumulative scale (see `lastScale` above) AT THE START of
  // the current TOUCH gesture — i.e. what's already baked into the picture
  // the live Animated transform renders on top of. Only the LIVE Animated
  // `scale`/translate transform during a touch gesture works relative to
  // this baseline (see the pinch move handler below); `bakeViewBox` itself
  // always uses the absolute cumulative `lastScale`/`panOffset` directly
  // against the fixed `fitViewBoxRect`, never this.
  const gestureStartScaleRef = useRef(1);
  // Cumulative pan (screen px) relative to the FIXED `fitViewBoxRect`
  // baseline — the SAME baseline `lastScale` above is relative to, and
  // deliberately does NOT reset after a bake, for the same reason.
  // extractOffset/flattenOffset move the accumulated pan between the
  // Animated value's offset and value, neither cheaply readable, so we
  // track it ourselves to clamp the ABSOLUTE resulting position rather than
  // just the frame delta.
  const panOffset = useRef({ x: 0, y: 0 });
  const panStart = useRef({ x: 0, y: 0 });
  const pinch = useRef<{
    startDist: number;
    startScale: number;
    startPan: { x: number; y: number };
    startFocal: { x: number; y: number };
  } | null>(null);
  // True for the duration of a touch pan/pinch (grant → release/terminate). The
  // wheel handler checks this so a trackpad's momentum wheel events can't fight
  // an in-progress touch gesture over the same Animated offset.
  const gestureActiveRef = useRef(false);
  // Pending "bake once wheel input goes idle" timer (see WHEEL_SETTLE_DELAY_MS
  // above), and the cumulative pan/scale the CURRENT wheel burst started
  // from — null when no burst is in progress. Mirrors gestureStartScaleRef's
  // role but for the wheel path, which has no discrete grant/release events
  // to hang that bookkeeping off of.
  const wheelIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wheelBurstStartRef = useRef<{ pan: { x: number; y: number }; scale: number } | null>(null);
  useEffect(
    () => () => {
      if (wheelIdleTimerRef.current) {
        clearTimeout(wheelIdleTimerRef.current);
      }
    },
    [],
  );

  // A resettle (topology change) gets the ORIGINAL fit-to-bounds view,
  // discarding any baked zoom/pan from the previous layout — node positions
  // aren't stable across different topologies (a fresh force-layout run), so
  // preserving a baked window over them wouldn't mean anything anyway. Also
  // covers the initial settle (this just reconfirms the already-correct
  // default, a no-op state update).
  useEffect(() => {
    // A pending debounced wheel bake (see WHEEL_SETTLE_DELAY_MS above) would
    // otherwise fire later against the NEW fitViewBoxRect using pan/scale
    // state left over from the OLD topology.
    if (wheelIdleTimerRef.current) {
      clearTimeout(wheelIdleTimerRef.current);
      wheelIdleTimerRef.current = null;
    }
    wheelBurstStartRef.current = null;
    setViewBoxRect(fitViewBoxRect);
    bumpTransformResetToken();
    lastScale.current = 1;
    liveScale.current = 1;
    appliedScale.current = 1;
    gestureStartScaleRef.current = 1;
    panOffset.current = { x: 0, y: 0 };
    panStart.current = { x: 0, y: 0 };
    pinch.current = null;
  }, [fitViewBoxRect]);

  // The Animated transform must reset to identity in the SAME committed
  // frame as a new baked `viewBoxRect`, not right after the `setViewBoxRect`
  // call that schedules it: that call is an async React state update, while
  // `Animated.Value#setValue` applies immediately, so resetting inline (the
  // old code, here and in settle()/recenter()/the wheel-bake timeout below)
  // raced the two — for one frame the transform read as identity against
  // the STILL-OLD viewBox, a visible snap back to the pre-gesture view
  // before the re-render landed and snapped forward to the real one
  // (reported as a stutter on Android on release). `useLayoutEffect` fires
  // after the commit carrying the new `viewBoxRect`, so pairing the reset
  // here keeps both changes in the same displayed frame. Keyed on
  // `transformResetToken`, not `viewBoxRect` — see that token's comment above.
  useLayoutEffect(() => {
    translateX.setOffset(0);
    translateX.setValue(0);
    translateY.setOffset(0);
    translateY.setValue(0);
    scale.setValue(1);
  }, [transformResetToken, translateX, translateY, scale]);

  // Per-axis pan bound at a given scale, relative to the FIXED
  // `fitViewBoxRect` baseline (never the current baked `viewBoxRect` — see
  // `fitViewBoxRectRef` above). `fit` maps that fixed viewBox into the
  // viewport (the preserveAspectRatio="…meet" basis), and the sliver
  // guarantee is measured against the REAL NODE bbox — constant across any
  // zoom (`nodeExtentRef` above). Reads viewport + viewBox + node extent from
  // refs so this stays stable across renders yet never closes over stale
  // sizes. Shared by the pinch responder and the wheel-zoom handler below.
  // Always called with the TRUE cumulative scale (`liveScale.current`), not
  // a "relative to the last bake" value — the clamp bounds the pan against
  // the ORIGINAL centered baseline, so evaluating it against anything else
  // loses track of how far a chain of gestures has already drifted.
  const axisBoundsAt = useCallback((liveScaleValue: number) => {
    const { w: vw, h: vh } = viewportRef.current;
    const { w: vbW, h: vbH } = vbSizeRef.current;
    const fit = Math.min(vw / vbW, vh / vbH);
    const { w: nodeW, h: nodeH } = nodeExtentRef.current;
    return {
      x: maxPanOffset(liveScaleValue, vw, fit * nodeW),
      y: maxPanOffset(liveScaleValue, vh, fit * nodeH),
    };
  }, []);

  const panResponder = useMemo(
    () => {
      // Always evaluated against the TRUE cumulative scale relative to the
      // fixed `fitViewBoxRect` baseline (see the `panOffset`/`lastScale`
      // comments above) — matches the pre-baking code's clamp exactly.
      const axisBounds = () => axisBoundsAt(liveScale.current);
      // Bake the just-settled transform into a new viewBox (`bakeViewBox`
      // above), ALWAYS from the fixed `fitViewBoxRect` using the full
      // cumulative pan/scale, so the resting view re-renders as crisp
      // vector SVG — including SvgText glyphs — at the committed zoom,
      // instead of a magnified fixed-resolution picture
      // (STASH-2N/STASH-2R). Also drops the transient raster hint now that
      // the gesture is over.
      const settle = () => {
        gestureActiveRef.current = false;
        setInteracting(false);
        setNearbyBookmarkLabelIds(new Set());
        translateX.flattenOffset();
        translateY.flattenOffset();
        lastScale.current = liveScale.current;
        const { x: maxX, y: maxY } = axisBounds();
        panOffset.current = {
          x: clampToRange(panOffset.current.x, -maxX, maxX),
          y: clampToRange(panOffset.current.y, -maxY, maxY),
        };
        setViewBoxRect(
          bakeViewBox({
            base: fitViewBoxRectRef.current,
            viewport: viewportRef.current,
            pan: panOffset.current,
            scale: liveScale.current,
          }),
        );
        bumpTransformResetToken();
        appliedScale.current = liveScale.current;
        gestureStartScaleRef.current = liveScale.current;
        panStart.current = { x: 0, y: 0 };
        pinch.current = null;
      };
      return PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (event, gesture) =>
          event.nativeEvent.touches.length >= 2 ||
          Math.abs(gesture.dx) > 4 ||
          Math.abs(gesture.dy) > 4,
        onPanResponderGrant: (event) => {
          // A touch gesture starting mid-wheel-burst takes over the shared
          // Animated offset — cancel the pending debounced wheel bake so it
          // can't fire mid-touch-gesture and stomp state settle() is about
          // to own; this gesture's own settle() will bake when IT ends.
          if (wheelIdleTimerRef.current) {
            clearTimeout(wheelIdleTimerRef.current);
            wheelIdleTimerRef.current = null;
          }
          wheelBurstStartRef.current = null;
          gestureActiveRef.current = true;
          setInteracting(true);
          gestureStartScaleRef.current = lastScale.current;
          const touches = event.nativeEvent.touches;
          const origin = containerOriginRef.current;
          const focal =
            touches.length >= 2
              ? touchCenterInViewport(touches[0], touches[1], origin)
              : touches[0]
                ? { x: touches[0].pageX - origin.x, y: touches[0].pageY - origin.y }
                : { x: viewportRef.current.w / 2, y: viewportRef.current.h / 2 };
          setNearbyBookmarkLabelIds(
            selectNearbyBookmarkLabelIds({
              nodes: bulkBookmarkNodes,
              excludedIds: priorityBookmarkLabelIds,
              focal,
              viewport: viewportRef.current,
              viewBox: fitViewBoxRectRef.current,
              scale: liveScale.current,
              pan: panOffset.current,
            }),
          );
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
            // The Animated transform renders on TOP of the already-baked
            // picture (which itself encodes panStart/gestureStartScaleRef),
            // so the LIVE delta can't just subtract panStart — a scale
            // change re-reads that baked pan too. Derived the same way
            // anchoredPanForScale keeps a focal point fixed across a scale
            // change: translate2 = pan_live − (scale_live⁄scaleAtStart) ×
            // panStart (see the "bake viewBox" tests for the algebra).
            const liveRelativeScale = next / gestureStartScaleRef.current;
            translateX.setValue(nextX - liveRelativeScale * panStart.current.x);
            translateY.setValue(nextY - liveRelativeScale * panStart.current.y);
            panOffset.current = { x: nextX, y: nextY };
            // Throttle: skip most per-frame scale writes to cut SVG re-rasters.
            if (Math.abs(next - appliedScale.current) >= SCALE_APPLY_STEP) {
              appliedScale.current = next;
              scale.setValue(liveRelativeScale);
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
    [
      translateX,
      translateY,
      scale,
      axisBoundsAt,
      bulkBookmarkNodes,
      priorityBookmarkLabelIds,
    ],
  );

  // Wheel/trackpad zoom (web only): mirrors the pinch-zoom math above but keyed
  // off a single `deltaY` instead of two touch points, anchored on the cursor so
  // the point under it stays put. Skips while a touch pan/pinch is mid-gesture
  // (gestureActiveRef) since that path is managing the Animated offset itself.
  // A single trackpad gesture fires many wheel events, so — unlike the touch
  // path, which has explicit grant/release events — this treats the whole
  // BURST of ticks as one logical gesture: each tick updates only the cheap
  // Animated transform (relative to whatever the burst started from), and
  // the expensive bake into a fresh viewBox (STASH-2N/STASH-2R) is debounced
  // until wheel input goes idle (WHEEL_SETTLE_DELAY_MS above), matching how
  // the touch path only bakes on settle() rather than every frame (a review
  // finding on #527: baking every tick forced a full SVG re-render on every
  // wheel event, stuttering trackpad zoom on a large stash).
  const applyWheelZoom = useCallback(
    (deltaY: number, focal: { x: number; y: number }) => {
      if (gestureActiveRef.current) {
        return;
      }
      const startScale = lastScale.current;
      const nextScale = wheelZoomScale(startScale, deltaY);
      if (nextScale === startScale) {
        return;
      }
      // First tick of a new burst: capture the cumulative pan/scale it
      // started from (whatever's currently baked) and raise the same
      // transient raster hint the touch path uses for the duration.
      if (!wheelBurstStartRef.current) {
        wheelBurstStartRef.current = { pan: { ...panOffset.current }, scale: lastScale.current };
        setInteracting(true);
      }
      const burstStart = wheelBurstStartRef.current;
      // Cumulative pan/scale relative to the FIXED fitViewBoxRect (the same
      // baseline the pan clamp and settle()'s bake use) — anchors the point
      // under the cursor exactly as the pre-baking code did.
      const anchoredPan = anchoredPanForScale({
        pan: panOffset.current,
        focal,
        viewport: viewportRef.current,
        startScale,
        nextScale,
      });
      const { x: maxX, y: maxY } = axisBoundsAt(nextScale);
      const nextX = clampToRange(anchoredPan.x, -maxX, maxX);
      const nextY = clampToRange(anchoredPan.y, -maxY, maxY);
      panOffset.current = { x: nextX, y: nextY };
      lastScale.current = nextScale;
      liveScale.current = nextScale;
      appliedScale.current = nextScale;

      // Cheap live transform on top of whatever's currently baked — same
      // translate2/scale2 math as the pinch move handler above.
      const liveRelativeScale = nextScale / burstStart.scale;
      translateX.setValue(nextX - liveRelativeScale * burstStart.pan.x);
      translateY.setValue(nextY - liveRelativeScale * burstStart.pan.y);
      scale.setValue(liveRelativeScale);

      // Debounce the expensive bake until wheel input goes idle.
      if (wheelIdleTimerRef.current) {
        clearTimeout(wheelIdleTimerRef.current);
      }
      wheelIdleTimerRef.current = setTimeout(() => {
        wheelIdleTimerRef.current = null;
        wheelBurstStartRef.current = null;
        // A touch gesture may have taken over since this timer was
        // scheduled (its onPanResponderGrant would have cleared the timer —
        // this is a defensive belt-and-suspenders check, not the primary
        // guard).
        if (gestureActiveRef.current) {
          return;
        }
        setInteracting(false);
        setViewBoxRect(
          bakeViewBox({
            base: fitViewBoxRectRef.current,
            viewport: viewportRef.current,
            pan: panOffset.current,
            scale: liveScale.current,
          }),
        );
        bumpTransformResetToken();
      }, WHEEL_SETTLE_DELAY_MS);
    },
    [axisBoundsAt, translateX, translateY, scale],
  );

  useEffect(() => {
    if (Platform.OS !== 'web') {
      return;
    }
    // A plain `View`'s ref forwards to its underlying DOM node on web (unlike
    // ScrollView, which needs getScrollableNode()) — same cast pattern as the
    // other web-only DOM listeners in this codebase (see ShelfEdges). The ref
    // only attaches once the settled (non-loading, non-empty) canvas JSX
    // mounts, so this must re-run once `settled` flips from null so the retry
    // finds a real node instead of permanently bailing on the mount-time null.
    const node = containerRef.current as unknown as HTMLElement | null;
    if (!node) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      // Always consumed: besides driving our own zoom, this stops Ctrl+wheel
      // from triggering the browser's native page-zoom over the canvas.
      event.preventDefault();
      applyWheelZoom(event.deltaY, {
        x: event.clientX - containerOriginRef.current.x,
        y: event.clientY - containerOriginRef.current.y,
      });
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [applyWheelZoom, settled]);

  // Reset the pan/zoom transform to identity AND the baked viewBoxRect back
  // to `fitViewBoxRect`, which restores the initial fit-to-bounds view. Lets a
  // user who flung the graph off-screen (or zoomed deep) get back without a
  // way-out dead end.
  const recenter = () => {
    // A pending debounced wheel bake (see WHEEL_SETTLE_DELAY_MS above) would
    // otherwise fire later and overwrite this reset with stale burst state.
    if (wheelIdleTimerRef.current) {
      clearTimeout(wheelIdleTimerRef.current);
      wheelIdleTimerRef.current = null;
    }
    wheelBurstStartRef.current = null;
    setViewBoxRect(fitViewBoxRect);
    bumpTransformResetToken();
    setInteracting(false);
    setNearbyBookmarkLabelIds(new Set());
    lastScale.current = 1;
    liveScale.current = 1;
    appliedScale.current = 1;
    gestureStartScaleRef.current = 1;
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

  const renderBookmarkLabel = useCallback(
    (node: (typeof bookmarkNodes)[number]) => (
      <SvgText
        key={`l${node.id}`}
        x={node.x}
        y={node.y + BOOKMARK_R + BOOKMARK_LABEL_SIZE}
        fill={palette.textSecondary}
        fontSize={BOOKMARK_LABEL_SIZE}
        fontWeight={BOOKMARK_LABEL_WEIGHT}
        textAnchor="middle"
        pointerEvents="none"
      >
        {truncateGraphLabel(
          bookmarkTitleById.get(node.bookmark_id) ?? node.label,
          BOOKMARK_LABEL_MAX_CHARS,
        )}
      </SvgText>
    ),
    [bookmarkTitleById, palette.textSecondary],
  );
  const priorityBookmarkLabels = useMemo(
    () => priorityBookmarkNodes.map(renderBookmarkLabel),
    [priorityBookmarkNodes, renderBookmarkLabel],
  );
  const bulkBookmarkLabels = useMemo(
    () => bulkBookmarkNodes.map(renderBookmarkLabel),
    [bulkBookmarkNodes, renderBookmarkLabel],
  );
  const nearbyBookmarkLabels = useMemo(
    () =>
      bulkBookmarkNodes
        .filter((node) => nearbyBookmarkLabelIds.has(node.id))
        .map(renderBookmarkLabel),
    [bulkBookmarkNodes, nearbyBookmarkLabelIds, renderBookmarkLabel],
  );

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
      <View
        testID="graph-canvas"
        style={[StyleSheet.absoluteFill, Platform.OS === 'web' ? WEB_NO_TEXT_SELECT : null]}
        {...panResponder.panHandlers}
      >
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
            {priorityBookmarkLabels}
          </Svg>
          <View
            pointerEvents="none"
            testID="graph-bookmark-labels-bulk"
            style={[StyleSheet.absoluteFill, interacting ? styles.hiddenLabelLayer : null]}
          >
            <Svg width={w} height={h} viewBox={viewBox} preserveAspectRatio="xMidYMid meet">
              {bulkBookmarkLabels}
            </Svg>
          </View>
          <View
            pointerEvents="none"
            testID="graph-bookmark-labels-nearby"
            style={[StyleSheet.absoluteFill, interacting ? null : styles.hiddenLabelLayer]}
          >
            <Svg width={w} height={h} viewBox={viewBox} preserveAspectRatio="xMidYMid meet">
              {nearbyBookmarkLabels}
            </Svg>
          </View>
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
  hiddenLabelLayer: {
    display: 'none',
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
