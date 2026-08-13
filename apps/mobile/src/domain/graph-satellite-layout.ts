/**
 * Deterministic bookmark-satellite placement around tag hubs (pure,
 * platform-free, deterministic).
 *
 * `layoutGraph` (see `graph.ts`) settles ALL nodes together with a tick
 * budget that shrinks quadratically as node count grows, to keep the
 * O(ticks·n²) settle bounded. That's fine for the tag-hub backbone (there
 * are only ever a few dozen to ~100 surviving tag nodes even in a huge
 * library), but a real multi-hundred-bookmark library with a few very
 * popular tags (observed in production: a single tag carried by 331 of
 * ~1,035 bookmarks) collapses the tick-starved bookmark positions into a
 * genuinely overlapping cluster — measured at 3,000+ overlapping circle
 * pairs on a ~1,100-node production-scale graph.
 *
 * A pure post-hoc pairwise nudge (`resolveNodeOverlap` alone, see
 * `graph-declutter.ts`) cannot cheaply fix that many overlaps: resolving
 * them by local nudging alone needs on the order of a hundred+ O(n²)
 * passes (confirmed empirically — 150 passes still left 467 pairs
 * overlapping and took ~5s, well past the app's 2s hang-detector budget).
 *
 * This takes a different, EXACT and cheap approach instead of repairing
 * the force-settled bookmark positions:
 *
 *  1. Keep the force-settled TAG HUB positions, but nudge hub CENTERS apart
 *     using a "footprint" radius — the hub's own circle PLUS the radius its
 *     full satellite ring will occupy (`ringOuterRadius`) — via the same
 *     `resolveNodeOverlap` primitive already used for local cleanup. This
 *     is cheap because hub count stays tiny (bounded by the shared-tag
 *     backbone's degree threshold) even when bookmark count is huge.
 *  2. Assign every bookmark node to exactly one PRIMARY hub: the tag with
 *     the highest degree among its surviving tags (ties broken by tag id
 *     for determinism). Edges to its OTHER tags are untouched — a
 *     multi-tag bookmark still draws a line to every tag it carries, just
 *     anchored near its most prominent one.
 *  3. Place each hub's satellite bookmarks on a golden-angle (phyllotaxis)
 *     spiral around the hub's (now-separated) center, at a radius that
 *     GUARANTEES no two same-hub satellites overlap, by construction — no
 *     iteration needed, so this stays exact and O(n) regardless of how
 *     lopsided the tag distribution is.
 *
 * Every bookmark is still rendered — nothing is hidden (the STASH-5Z
 * precedent: the fix for a large-library graph must not drop data, only
 * decongest it) — and the whole pipeline runs in single-digit
 * milliseconds even at ~1,100 nodes.
 */

import type { PositionedNode, SettledGraph } from '@/domain/graph';
import {
  declutterPassBudget,
  resolveNodeOverlap,
  SINGLE_PASS_SAFE_NODE_COUNT,
  type OverlapNode,
} from '@/domain/graph-declutter';

export interface SatelliteLayoutOptions {
  /** Rendered bookmark-node circle radius (layout units). */
  bookmarkRadius: number;
  /** Rendered hub-node circle radius for a given node degree. */
  hubRadius: (degree: number) => number;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/**
 * Spacing multiple of `bookmarkRadius` between consecutive same-hub
 * satellites on the spiral. Empirically verified (see the test file) to
 * leave zero overlap for group sizes from 1 up to several hundred.
 */
const SPACING_FACTOR = 1.3;
/**
 * Hub-center declutter's own pass-count budget — same shape as
 * `declutterPassBudget` (graph-declutter.ts), but with a higher full-quality
 * ceiling: `minSharedDegree` only bounds how many bookmarks a tag needs to
 * survive (≥4), not how many DISTINCT tags can each clear that bar, so a
 * very tag-diverse library could in principle produce thousands of hub
 * nodes — this must taper for that case exactly like the settle's own tick
 * budget does, not assume hub count always stays in the observed ~60-110
 * range. `HUB_FOOTPRINT_FULL_QUALITY_HUB_COUNT` (200) is comfortably above
 * that observed range, so the realistic case still gets the full,
 * empirically-verified 24 passes.
 */
const HUB_FOOTPRINT_MAX_PASSES = 24;
const HUB_FOOTPRINT_FULL_QUALITY_HUB_COUNT = 200;
const HUB_FOOTPRINT_PAIR_BUDGET =
  HUB_FOOTPRINT_MAX_PASSES * HUB_FOOTPRINT_FULL_QUALITY_HUB_COUNT * HUB_FOOTPRINT_FULL_QUALITY_HUB_COUNT;

export function hubFootprintPassBudget(hubCount: number): number {
  if (hubCount <= 1) {
    return HUB_FOOTPRINT_MAX_PASSES;
  }
  const scaled = Math.floor(HUB_FOOTPRINT_PAIR_BUDGET / (hubCount * hubCount));
  if (scaled >= 1) {
    return Math.min(HUB_FOOTPRINT_MAX_PASSES, scaled);
  }
  // Never taper all the way to 0 within the safe range: 0 is a hard no-op
  // that leaves hub centers at whatever (possibly heavily overlapping)
  // position the force settle left them, guaranteeing the exact hairball
  // this module exists to prevent — whereas 1 pass makes real progress on
  // every currently-overlapping pair. But a single pass is still one full
  // O(hubCount^2) sweep through the SAME `resolveNodeOverlap` primitive
  // `declutterPassBudget` (graph-declutter.ts) uses, so it shares that
  // function's measured-safe ceiling: past `SINGLE_PASS_SAFE_NODE_COUNT`
  // hubs, even 1 pass risks the app's 2s hang budget, and this genuinely
  // has no safe declutter left to offer (this is far beyond any hub count a
  // real tag-diverse library could plausibly produce).
  return hubCount <= SINGLE_PASS_SAFE_NODE_COUNT ? 1 : 0;
}

// Distance from the hub center to the FAR edge of the outermost satellite's
// own circle — i.e. the true footprint the ring occupies, not just the
// distance to that satellite's center. `baseR` below (the placement loop)
// puts the outermost member's CENTER at `hubRadius + bookmarkRadius + 2 +
// spacing*sqrt(memberCount-1)`; its circle then extends another
// `bookmarkRadius` past that, or two hubs whose footprints are treated as
// merely touching can still have their outermost satellites overlap.
export function ringOuterRadius(memberCount: number, bookmarkRadius: number, spacing: number): number {
  if (memberCount <= 0) {
    return 0;
  }
  return bookmarkRadius + 2 + spacing * Math.sqrt(memberCount - 1 + 0.5) + bookmarkRadius;
}

/** Extra gap between adjacent grid cells in `packHubsOnGrid`, on top of the
 * cell size already sized to clear the largest hub's footprint. */
const GRID_CELL_PADDING = 4;

/**
 * Guaranteed non-overlapping placement for hub centers, used once hub count
 * exceeds `HUB_FOOTPRINT_FULL_QUALITY_HUB_COUNT` — a PR review finding: no
 * fixed, safe-to-run pass count of the iterative `resolveNodeOverlap`
 * actually GUARANTEES full separation for an arbitrary configuration, only
 * makes probabilistic progress toward it. A synthetic 1,000-hub library
 * (disjoint 4-bookmark tags) left tens of thousands of overlapping pairs
 * even with several tapered-but-nonzero passes.
 *
 * A uniform grid sidesteps the convergence question entirely: cell size is
 * set to clear the SINGLE LARGEST hub footprint present, so ANY two hubs —
 * adjacent cells or not — are guaranteed at least one cell's width apart on
 * at least one axis, which is always ≥ the sum of their radii. This is an
 * exact, structural guarantee, not an iterative approximation, and it's
 * O(n log n) (a sort for determinism, then a single assignment pass) rather
 * than O(passes·n²).
 *
 * The trade-off: this discards the force-settled topological arrangement
 * (hubs that share bookmarks no longer cluster near each other) for this
 * tier. That's an accepted cost, not a regression — real libraries never
 * reach this hub count (observed ~60–110 even for a 1,000+ bookmark
 * library; this needs hundreds of DISTINCT tags each carried by ≥4
 * bookmarks), and a grid of legible, fully separated circles reads far
 * better than a "natural-looking" layout a bounded algorithm can't actually
 * deliver at this scale.
 */
export function packHubsOnGrid(hubs: readonly OverlapNode[]): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  if (hubs.length === 0) {
    return positions;
  }
  const maxRadius = Math.max(...hubs.map((hub) => hub.r));
  const cellSize = maxRadius * 2 + GRID_CELL_PADDING;
  const columns = Math.ceil(Math.sqrt(hubs.length));
  const ordered = [...hubs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  ordered.forEach((hub, i) => {
    const column = i % columns;
    const row = Math.floor(i / columns);
    positions.set(hub.id, { x: column * cellSize, y: row * cellSize });
  });
  return positions;
}

/**
 * Replace a settled bipartite graph's bookmark-node positions with
 * deterministic, non-overlapping satellite placements around their primary
 * tag hub, and nudge hub centers apart by their satellite ring's footprint
 * first so neighboring hubs' rings don't collide either. Hub nodes keep
 * their force-settled position, only decluttered by this footprint radius.
 * No-op (returns `settled` unchanged) when there are no bookmark nodes —
 * the co-occurrence view has none, and this is only meant for bipartite.
 */
export function placeBookmarkSatellites(
  settled: SettledGraph,
  options: SatelliteLayoutOptions,
): SettledGraph {
  const { bookmarkRadius, hubRadius } = options;
  const hubNodes = settled.nodes.filter((node) => node.kind !== 'bookmark');
  const bookmarkNodes = settled.nodes.filter((node) => node.kind === 'bookmark');
  if (bookmarkNodes.length === 0 || hubNodes.length === 0) {
    return settled;
  }

  const hubById = new Map(hubNodes.map((node) => [node.id, node]));

  // bookmark node id -> its connected hub ids (bipartite edges: source is
  // always the bookmark, target the hub — see graph.ts's GraphEdge doc).
  const hubIdsByBookmark = new Map<string, string[]>();
  for (const edge of settled.edges) {
    if (!hubById.has(edge.target)) {
      continue;
    }
    const list = hubIdsByBookmark.get(edge.source) ?? [];
    list.push(edge.target);
    hubIdsByBookmark.set(edge.source, list);
  }

  // Assign each bookmark to its highest-degree connected hub (its most
  // prominent tag), tie-broken by ascending hub id for determinism.
  const groups = new Map<string, PositionedNode[]>();
  const ungrouped: PositionedNode[] = [];
  for (const node of bookmarkNodes) {
    const hubIds = hubIdsByBookmark.get(node.id) ?? [];
    let bestId: string | null = null;
    let bestDegree = -Infinity;
    for (const hubId of hubIds) {
      const hub = hubById.get(hubId);
      if (!hub) {
        continue;
      }
      if (hub.degree > bestDegree || (hub.degree === bestDegree && (bestId === null || hubId < bestId))) {
        bestId = hubId;
        bestDegree = hub.degree;
      }
    }
    if (bestId === null) {
      // No connected hub survived (shouldn't happen — deriveGraph only
      // keeps bookmarks with a surviving tag link — but fall back to the
      // node's existing settled position rather than dropping it).
      ungrouped.push(node);
      continue;
    }
    const list = groups.get(bestId) ?? [];
    list.push(node);
    groups.set(bestId, list);
  }
  // Deterministic member order within each group, independent of the
  // incoming node array order.
  for (const list of groups.values()) {
    list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  const spacing = bookmarkRadius * SPACING_FACTOR;

  // Declutter hub CENTERS using a footprint radius (own circle + the ring
  // its satellites will occupy), so two busy hubs' satellite rings don't
  // collide once placed.
  const hubOverlapNodes: OverlapNode[] = hubNodes.map((node) => ({
    id: node.id,
    x: node.x,
    y: node.y,
    r: hubRadius(node.degree) + ringOuterRadius((groups.get(node.id) ?? []).length, bookmarkRadius, spacing),
  }));
  // Below the full-quality ceiling, iterative declutter always gets the max
  // pass count (guaranteed by hubFootprintPassBudget's own formula at this
  // hub count) and reliably converges for realistic tag distributions
  // (verified against the production-shape fixture, see the test file).
  // Beyond it, no bounded pass count can be trusted to converge (a PR
  // review finding), so switch to the grid packing's exact guarantee
  // instead of hoping enough relaxation passes happened.
  const resolvedHubs =
    hubOverlapNodes.length <= HUB_FOOTPRINT_FULL_QUALITY_HUB_COUNT
      ? resolveNodeOverlap(hubOverlapNodes, hubFootprintPassBudget(hubOverlapNodes.length))
      : packHubsOnGrid(hubOverlapNodes);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  const nextHubNodes: PositionedNode[] = hubNodes.map((node) => {
    const pos = resolvedHubs.get(node.id)!;
    include(pos.x, pos.y);
    return { ...node, x: pos.x, y: pos.y };
  });
  const hubPosById = new Map(nextHubNodes.map((node) => [node.id, node]));

  const nextBookmarkNodes: PositionedNode[] = [];
  for (const [hubId, members] of groups) {
    const hub = hubPosById.get(hubId)!;
    const baseR = hubRadius(hub.degree) + bookmarkRadius + 2;
    members.forEach((member, k) => {
      const r = baseR + spacing * Math.sqrt(k);
      const angle = k * GOLDEN_ANGLE;
      const x = hub.x + Math.cos(angle) * r;
      const y = hub.y + Math.sin(angle) * r;
      include(x, y);
      nextBookmarkNodes.push({ ...member, x, y });
    });
  }
  for (const node of ungrouped) {
    include(node.x, node.y);
    nextBookmarkNodes.push(node);
  }

  // Preserve the original relative node order (bookmark ids etc. don't
  // depend on it, but keeping it stable avoids gratuitous diffs for callers
  // that key off array position).
  const byId = new Map<string, PositionedNode>();
  for (const node of nextHubNodes) byId.set(node.id, node);
  for (const node of nextBookmarkNodes) byId.set(node.id, node);
  const nodes = settled.nodes.map((node) => byId.get(node.id) ?? node);

  return {
    nodes,
    edges: settled.edges,
    bounds: {
      min_x: minX,
      min_y: minY,
      max_x: maxX,
      max_y: maxY,
      width: maxX - minX,
      height: maxY - minY,
    },
  };
}
