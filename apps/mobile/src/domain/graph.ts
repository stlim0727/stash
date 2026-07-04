/**
 * Bipartite tag-graph derivation + settled layout (pure, platform-free).
 *
 * READ-SIDE ONLY. This module derives a graph view from the user's local
 * bookmarks + tag links and computes a static layout. It never writes, never
 * touches the pending queue, and never affects capture/sync.
 *
 * The graph is deliberately BIPARTITE: there are bookmark nodes and tag nodes,
 * and edges exist ONLY between a bookmark and a tag it carries. There are no
 * bookmark↔bookmark and no tag↔tag edges. This keeps the edge count at
 * O(total tag-links) ≈ O(n) instead of the O(n²) shared-tag hairball a
 * co-occurrence graph would produce. Tag nodes become hubs; bookmark nodes
 * orbit the tags they belong to.
 *
 * Untagged bookmarks are parked under a single synthetic "untagged" hub node
 * (see UNTAGGED_HUB_ID) rather than omitted. Omitting them would silently hide
 * real user content from a view that is meant to be a map of everything saved;
 * leaving them as disconnected nodes would create floating noise. A single
 * labelled hub keeps them present, grouped, and stylable by the UI while still
 * reading as "these have no tags yet".
 *
 * Layout: a deterministic, seeded Fruchterman-Reingold force simulation run to
 * completion synchronously for a fixed tick budget, returning static x/y. We do
 * NOT use a live physics engine — the UI renders a static SVG and only
 * pans/zooms, so a running sim on the JS thread (and Stash's 2s hang detector)
 * is never involved. We hand-roll rather than pull in d3-force: it is a
 * read-only view and d3-force isn't already a dependency, so a small seeded
 * layout avoids adding a package to the native build while staying fully
 * Node-testable and deterministic (seeded PRNG → same input yields same
 * positions across renders and test runs).
 */

import type { Bookmark, BookmarkTag, Tag } from '@/domain/types';

/** Well-known id of the synthetic hub that untagged bookmarks connect to. */
export const UNTAGGED_HUB_ID = 'untagged-hub';

export type GraphNodeKind = 'bookmark' | 'tag' | 'untagged-hub';

interface GraphNodeBase {
  /** Stable graph-node id (unique across all kinds). */
  id: string;
  kind: GraphNodeKind;
  /** Display label. */
  label: string;
  /**
   * Edge count for this node — the UI sizing signal. On a tag/untagged-hub node
   * this is the number of bookmarks carrying it; on a bookmark node it is the
   * number of tags it has (>= 1, since untagged bookmarks link to the hub).
   */
  degree: number;
}

export interface BookmarkGraphNode extends GraphNodeBase {
  kind: 'bookmark';
  /** Source bookmark id → the `/bookmark/[id]` detail route. */
  bookmark_id: string;
}

export interface TagGraphNode extends GraphNodeBase {
  kind: 'tag';
  /** Source tag id (stable key). */
  tag_id: string;
  /** Tag slug → the tag facet. */
  slug: string;
}

export interface UntaggedHubGraphNode extends GraphNodeBase {
  kind: 'untagged-hub';
}

export type GraphNode = BookmarkGraphNode | TagGraphNode | UntaggedHubGraphNode;

/**
 * A bipartite edge. `source` is always a bookmark node id; `target` is always a
 * tag or untagged-hub node id. There are never bookmark↔bookmark or tag↔tag
 * edges.
 */
export interface GraphEdge {
  source: string;
  target: string;
}

/** The derived (unpositioned) bipartite graph. */
export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Local data the graph is derived from (mirrors storage `TagData` + bookmarks). */
export interface DeriveGraphInput {
  bookmarks: Bookmark[];
  tags: Tag[];
  bookmarkTags: BookmarkTag[];
}

/** A node with its settled position. */
export type PositionedNode = GraphNode & { x: number; y: number };

/** Axis-aligned bounding box of all settled node positions. */
export interface GraphBounds {
  min_x: number;
  min_y: number;
  max_x: number;
  max_y: number;
  width: number;
  height: number;
}

/** The settled graph the UI renders: positioned nodes, edges, and bounds. */
export interface SettledGraph {
  nodes: PositionedNode[];
  edges: GraphEdge[];
  bounds: GraphBounds;
}

export interface LayoutOptions {
  /**
   * Force-simulation tick budget. Bounds cost: the layout is O(ticks * n²)
   * (naive all-pairs repulsion), so for n ≈ 450 nodes at the default 300 ticks
   * this is a one-time ~tens-of-ms synchronous settle. Lower it to trade
   * quality for speed.
   */
  ticks?: number;
  /** Layout canvas size; also seeds the ideal edge length. */
  width?: number;
  height?: number;
  /** PRNG seed. Same seed + same graph ⇒ identical positions. */
  seed?: number;
}

const DEFAULT_TICKS = 300;
const DEFAULT_SIZE = 1000;
const DEFAULT_SEED = 0x9e3779b9;

/** Lower bound on ticks: even huge graphs get a minimum-quality settle. */
const MIN_TICKS = 60;
/**
 * Work ceiling for the settle, expressed as ticks·n² pairs. Set to
 * DEFAULT_TICKS·50² so a small graph (n ≤ 50) still runs the full 300 ticks;
 * see {@link layoutTickBudget}.
 */
const LAYOUT_TICK_BUDGET = DEFAULT_TICKS * 50 * 50; // 750_000

/**
 * Tick budget for {@link layoutGraph}, scaled DOWN as the node count grows so
 * the O(ticks·n²) settle can never cost DEFAULT_TICKS·n² on a large stash.
 *
 * Small graphs (n ≤ 50) get the full-quality DEFAULT_TICKS. Past that we spend
 * a fixed work budget: ticks·n² is capped at LAYOUT_TICK_BUDGET (~750k) until
 * the MIN_TICKS floor takes over (around n > 112), beyond which every graph
 * settles at 60 ticks — 60·n², still 5× cheaper than a naive 300·n² run.
 *
 * This is the SINGLE SOURCE OF TRUTH for the budget: the /graph screen calls
 * `buildSettledGraph(input, { ticks: layoutTickBudget(n) })`, so tests and prod
 * settle with the same tick count. Safe (no divide-by-zero) at n = 0/1.
 */
export function layoutTickBudget(nodeCount: number): number {
  if (nodeCount <= 1) return DEFAULT_TICKS;
  const scaled = Math.floor(LAYOUT_TICK_BUDGET / (nodeCount * nodeCount));
  return Math.min(DEFAULT_TICKS, Math.max(MIN_TICKS, scaled));
}

function bookmarkNodeId(id: string): string {
  return `b:${id}`;
}

function tagNodeId(id: string): string {
  return `t:${id}`;
}

/** Active exactly as the Inbox defines it: not trashed and not archived. */
function isActive(bookmark: Bookmark): boolean {
  return !bookmark.deleted_at && !bookmark.is_archived;
}

/**
 * Derive the bipartite graph from local bookmarks + tag links.
 *
 * - Only active (not trashed, not archived) bookmarks become nodes.
 * - Tag nodes are created only for tags that link to at least one active
 *   bookmark, so isolated tags don't float as disconnected noise.
 * - Bookmarks with no such tag link connect to the single UNTAGGED_HUB_ID node,
 *   which is only created when at least one untagged bookmark exists.
 */
export function deriveGraph(input: DeriveGraphInput): Graph {
  const activeBookmarks = input.bookmarks.filter(isActive);
  const activeIds = new Set(activeBookmarks.map((b) => b.id));
  const tagById = new Map(input.tags.map((tag) => [tag.id, tag]));

  // bookmark_id -> ordered, de-duped list of existing tag ids on active rows.
  const linksByBookmark = new Map<string, string[]>();
  for (const link of input.bookmarkTags) {
    if (!activeIds.has(link.bookmark_id) || !tagById.has(link.tag_id)) {
      continue;
    }
    const list = linksByBookmark.get(link.bookmark_id) ?? [];
    if (!list.includes(link.tag_id)) {
      list.push(link.tag_id);
    }
    linksByBookmark.set(link.bookmark_id, list);
  }

  const edges: GraphEdge[] = [];
  const tagDegree = new Map<string, number>();
  let untaggedCount = 0;

  const bookmarkNodes: GraphNode[] = activeBookmarks.map((bookmark) => {
    const tagIds = linksByBookmark.get(bookmark.id) ?? [];
    if (tagIds.length === 0) {
      edges.push({ source: bookmarkNodeId(bookmark.id), target: UNTAGGED_HUB_ID });
      untaggedCount += 1;
    } else {
      for (const tagId of tagIds) {
        edges.push({ source: bookmarkNodeId(bookmark.id), target: tagNodeId(tagId) });
        tagDegree.set(tagId, (tagDegree.get(tagId) ?? 0) + 1);
      }
    }
    return {
      kind: 'bookmark',
      id: bookmarkNodeId(bookmark.id),
      bookmark_id: bookmark.id,
      label: bookmark.title ?? bookmark.url ?? 'Untitled',
      degree: Math.max(tagIds.length, 1),
    } satisfies BookmarkGraphNode;
  });

  const tagNodes: GraphNode[] = [];
  for (const [tagId, degree] of tagDegree) {
    const tag = tagById.get(tagId)!;
    tagNodes.push({
      kind: 'tag',
      id: tagNodeId(tagId),
      tag_id: tagId,
      slug: tag.slug,
      label: tag.name,
      degree,
    } satisfies TagGraphNode);
  }

  const hubNodes: GraphNode[] = [];
  if (untaggedCount > 0) {
    hubNodes.push({
      kind: 'untagged-hub',
      id: UNTAGGED_HUB_ID,
      label: 'Untagged',
      degree: untaggedCount,
    } satisfies UntaggedHubGraphNode);
  }

  return { nodes: [...tagNodes, ...hubNodes, ...bookmarkNodes], edges };
}

/** Deterministic PRNG (mulberry32) — keeps the layout reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EMPTY_BOUNDS: GraphBounds = {
  min_x: 0,
  min_y: 0,
  max_x: 0,
  max_y: 0,
  width: 0,
  height: 0,
};

/**
 * Run a seeded Fruchterman-Reingold simulation to completion and return static
 * positions. Deterministic: same graph + options ⇒ identical output.
 */
export function layoutGraph(graph: Graph, options: LayoutOptions = {}): SettledGraph {
  const ticks = options.ticks ?? DEFAULT_TICKS;
  const width = options.width ?? DEFAULT_SIZE;
  const height = options.height ?? DEFAULT_SIZE;
  const rand = mulberry32(options.seed ?? DEFAULT_SEED);

  const n = graph.nodes.length;
  if (n === 0) {
    return { nodes: [], edges: graph.edges, bounds: EMPTY_BOUNDS };
  }

  // Ideal edge length (FR's `k`): denser graphs pack tighter.
  const k = Math.sqrt((width * height) / n);
  const index = new Map<string, number>();
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);

  graph.nodes.forEach((node, i) => {
    index.set(node.id, i);
    // Seeded initial placement inside the frame (centered on origin).
    xs[i] = (rand() - 0.5) * width;
    ys[i] = (rand() - 0.5) * height;
  });

  // Resolve edges to index pairs once (skip any dangling endpoints).
  const edgePairs: Array<[number, number]> = [];
  for (const edge of graph.edges) {
    const a = index.get(edge.source);
    const b = index.get(edge.target);
    if (a !== undefined && b !== undefined) {
      edgePairs.push([a, b]);
    }
  }

  // Mass per node, proportional to degree, so heavily-referenced tags act as
  // stable central anchors. Bookmark nodes stay light (unit mass); tag/hub
  // nodes get `1 + MASS_K * sqrt(degree)`. The sqrt keeps mass bounded so one
  // mega-tag can't dominate, and degree ≥ 1 on hubs means no divide-by-zero
  // (sqrt(0) would still yield mass 1). Mass biases central gravity below: a
  // heavier node is pulled toward the origin (≈ layout centroid) more strongly,
  // so popular tags settle in the middle while light nodes orbit the rim.
  const MASS_K = 0.5;
  const mass = new Float64Array(n);
  graph.nodes.forEach((node, i) => {
    mass[i] = node.kind === 'bookmark' ? 1 : 1 + MASS_K * Math.sqrt(node.degree);
  });

  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  const eps = 1e-4;
  let temp = Math.max(width, height) / 10;
  const cooling = 0.95;
  const gravity = 0.01;

  for (let tick = 0; tick < ticks; tick += 1) {
    dx.fill(0);
    dy.fill(0);

    // Repulsion: every pair pushes apart (O(n²)).
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        let deltaX = xs[i] - xs[j];
        let deltaY = ys[i] - ys[j];
        let dist = Math.hypot(deltaX, deltaY);
        if (dist < eps) {
          // Deterministic tiny jitter so coincident nodes separate.
          deltaX = (rand() - 0.5) * eps;
          deltaY = (rand() - 0.5) * eps;
          dist = eps;
        }
        const force = (k * k) / dist;
        const fx = (deltaX / dist) * force;
        const fy = (deltaY / dist) * force;
        dx[i] += fx;
        dy[i] += fy;
        dx[j] -= fx;
        dy[j] -= fy;
      }
    }

    // Attraction along edges (springs).
    for (const [a, b] of edgePairs) {
      const deltaX = xs[a] - xs[b];
      const deltaY = ys[a] - ys[b];
      const dist = Math.max(Math.hypot(deltaX, deltaY), eps);
      const force = (dist * dist) / k;
      const fx = (deltaX / dist) * force;
      const fy = (deltaY / dist) * force;
      dx[a] -= fx;
      dy[a] -= fy;
      dx[b] += fx;
      dy[b] += fy;
    }

    // Gravity toward origin keeps disconnected components bounded, and is
    // mass-weighted so heavy (high-degree) tags are drawn to the center.
    for (let i = 0; i < n; i += 1) {
      dx[i] -= xs[i] * gravity * k * mass[i];
      dy[i] -= ys[i] * gravity * k * mass[i];
    }

    // Move each node by its displacement, capped by the cooling temperature.
    for (let i = 0; i < n; i += 1) {
      const disp = Math.max(Math.hypot(dx[i], dy[i]), eps);
      const step = Math.min(disp, temp);
      xs[i] += (dx[i] / disp) * step;
      ys[i] += (dy[i] / disp) * step;
    }

    temp *= cooling;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const nodes: PositionedNode[] = graph.nodes.map((node, i) => {
    const x = xs[i];
    const y = ys[i];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    return { ...node, x, y };
  });

  const bounds: GraphBounds = {
    min_x: minX,
    min_y: minY,
    max_x: maxX,
    max_y: maxY,
    width: maxX - minX,
    height: maxY - minY,
  };

  return { nodes, edges: graph.edges, bounds };
}

/** Convenience: derive the bipartite graph and settle it in one call. */
export function buildSettledGraph(
  input: DeriveGraphInput,
  options?: LayoutOptions,
): SettledGraph {
  return layoutGraph(deriveGraph(input), options);
}
