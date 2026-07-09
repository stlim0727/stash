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
 * Untagged bookmarks are omitted. This is a tag relationship map, so showing
 * untagged items as a synthetic cluster adds visual noise without a meaningful
 * tag connection.
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

/** Legacy id for older graph data/tests; current graph derivation omits untagged bookmarks. */
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
 * A graph edge.
 *
 * For {@link deriveGraph} this is BIPARTITE: `source` is always a bookmark node
 * id and `target` is always a tag or untagged-hub node id — never
 * bookmark↔bookmark or tag↔tag. That invariant is specific to `deriveGraph`.
 *
 * {@link deriveCoOccurrenceGraph} produces a DIFFERENT shape on the same type:
 * there `source`/`target` are both tag node ids (an undirected tag–tag edge in
 * canonical id order) and `weight` carries the shared-bookmark count.
 *
 * `weight` is optional and additive: bipartite edges omit it (unchanged
 * behavior); co-occurrence edges set it.
 */
export interface GraphEdge {
  source: string;
  target: string;
  /** Co-occurrence edges: number of active bookmarks carrying BOTH tags. */
  weight?: number;
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
  /**
   * Minimum active-bookmark degree a tag must reach to become a tag node
   * (shared-tag backbone). Tags below the threshold are dropped entirely (no
   * node, no edges), and bookmarks with no surviving tag are omitted. Defaults
   * to 1 (every used tag survives).
   */
  minSharedDegree?: number;
  /**
   * Co-occurrence view only ({@link deriveCoOccurrenceGraph}): the minimum
   * number of active bookmarks that must carry BOTH tags for a tag–tag edge to
   * exist. Distinct from `minSharedDegree` (which is the bipartite per-tag
   * inclusion threshold). Defaults to 2 — a pair shared by a single bookmark is
   * usually noise; 2 surfaces genuinely related tags.
   */
  minSharedBookmarks?: number;
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
   * quality for speed. Pass 0 to skip the force simulation and use the cheap
   * deterministic fallback placement for graphs too large for even one all-pairs
   * tick.
   */
  ticks?: number;
  /** Layout canvas size; also seeds the ideal edge length. */
  width?: number;
  height?: number;
  /** PRNG seed. Same seed + same graph ⇒ identical positions. */
  seed?: number;
  /**
   * Mass coefficient for the degree-weighted central gravity (see {@link
   * MASS_K}). Defaults to the production constant; a test can pass `0` to settle
   * the identical graph with mass-weighting disabled (ablation baseline).
   * Production callers leave this unset.
   */
  massK?: number;
}

const DEFAULT_TICKS = 300;
const DEFAULT_SIZE = 1000;
const DEFAULT_SEED = 0x9e3779b9;

/**
 * Mass coefficient: a tag/hub node's mass is `1 + MASS_K * sqrt(degree)`, which
 * scales its pull toward the layout center so popular tags anchor centrally.
 */
const MASS_K = 0.5;

/**
 * Work ceiling for the settle, expressed as ticks·n² repulsion pairs. Keep
 * full-quality layout through a few hundred nodes, then spend a fixed work
 * budget instead of carrying a tick floor that turns 1k+ libraries into long
 * synchronous stalls.
 */
const FULL_QUALITY_NODE_COUNT = 200;
const LAYOUT_PAIR_BUDGET = DEFAULT_TICKS * FULL_QUALITY_NODE_COUNT * FULL_QUALITY_NODE_COUNT; // 12_000_000

/**
 * Tick budget for {@link layoutGraph}, scaled DOWN as the node count grows so
 * the O(ticks·n²) settle cannot explode on a large stash.
 *
 * Small graphs (n ≤ 200) get the full-quality DEFAULT_TICKS. Past that we spend
 * a fixed pair-work budget: at 400 nodes this still allows 75 ticks, at 1k nodes
 * 12 ticks, and at 2k nodes 3 ticks. Once even one O(n²) tick would exceed the
 * cap, return 0 so callers skip the force simulation instead of blocking the JS
 * thread anyway.
 *
 * This is the SINGLE SOURCE OF TRUTH for the budget: the /graph screen derives
 * the visible graph, then calls `layoutGraph(graph, { ticks:
 * layoutTickBudget(graph.nodes.length) })`, so tests and prod settle with the
 * same tick count. Safe (no divide-by-zero) at n = 0/1.
 */
export function layoutTickBudget(nodeCount: number): number {
  if (nodeCount <= 1) return DEFAULT_TICKS;
  const scaled = Math.floor(LAYOUT_PAIR_BUDGET / (nodeCount * nodeCount));
  return Math.min(DEFAULT_TICKS, Math.max(0, scaled));
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
 * - Tag nodes are created only for tags that link to at least
 *   `minSharedDegree` (default 1) active bookmarks, so isolated tags don't
 *   float as disconnected noise and single-use tags can be filtered out to
 *   surface the shared-tag backbone.
 * - Bookmarks with no surviving tag link are omitted.
 */
export function deriveGraph(input: DeriveGraphInput): Graph {
  const minSharedDegree = input.minSharedDegree ?? 1;
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

  // Raw active-bookmark degree per tag, then keep only those meeting the
  // threshold. A surviving tag's node degree equals this raw count (every
  // active bookmark carrying it still links to it).
  const rawTagDegree = new Map<string, number>();
  for (const tagIds of linksByBookmark.values()) {
    for (const tagId of tagIds) {
      rawTagDegree.set(tagId, (rawTagDegree.get(tagId) ?? 0) + 1);
    }
  }
  const survives = (tagId: string): boolean =>
    (rawTagDegree.get(tagId) ?? 0) >= minSharedDegree;

  const edges: GraphEdge[] = [];
  const tagDegree = new Map<string, number>();

  const bookmarkNodes: GraphNode[] = activeBookmarks.flatMap((bookmark) => {
    const tagIds = (linksByBookmark.get(bookmark.id) ?? []).filter(survives);
    if (tagIds.length === 0) {
      return [];
    }
    for (const tagId of tagIds) {
      edges.push({ source: bookmarkNodeId(bookmark.id), target: tagNodeId(tagId) });
      tagDegree.set(tagId, (tagDegree.get(tagId) ?? 0) + 1);
    }
    return [{
      kind: 'bookmark',
      id: bookmarkNodeId(bookmark.id),
      bookmark_id: bookmark.id,
      label: bookmark.title ?? bookmark.url ?? 'Untitled',
      degree: tagIds.length,
    } satisfies BookmarkGraphNode];
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

  return { nodes: [...tagNodes, ...bookmarkNodes], edges };
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

function fallbackPosition(index: number, total: number, width: number, height: number): {
  x: number;
  y: number;
} {
  if (total === 1) {
    return { x: 0, y: 0 };
  }
  // Phyllotaxis spiral: deterministic, O(n), and less overlapped than placing
  // every node on one ring when huge graphs skip the force simulation.
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const radius = (Math.sqrt((index + 0.5) / total) * Math.min(width, height)) / 2;
  const angle = index * goldenAngle;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

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
    if (ticks <= 0) {
      const fallback = fallbackPosition(i, n, width, height);
      xs[i] = fallback.x;
      ys[i] = fallback.y;
    } else {
      // Seeded initial placement inside the frame (centered on origin).
      xs[i] = (rand() - 0.5) * width;
      ys[i] = (rand() - 0.5) * height;
    }
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
  // nodes get `1 + massK * sqrt(degree)`. The sqrt keeps mass bounded so one
  // mega-tag can't dominate, and degree ≥ 1 on hubs means no divide-by-zero
  // (sqrt(0) would still yield mass 1). Mass biases central gravity below: a
  // heavier node is pulled toward the origin (≈ layout centroid) more strongly,
  // so popular tags settle in the middle while light nodes orbit the rim.
  const massK = options.massK ?? MASS_K;
  const mass = new Float64Array(n);
  graph.nodes.forEach((node, i) => {
    mass[i] = node.kind === 'bookmark' ? 1 : 1 + massK * Math.sqrt(node.degree);
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

/**
 * Derive the TAG CO-OCCURRENCE graph: nodes are tags only (no bookmark nodes,
 * no untagged hub), and an undirected weighted edge connects two tags with
 * `weight` = the number of active (not trashed, not archived) bookmarks that
 * carry BOTH tags. An edge is emitted only when `weight >= minSharedBookmarks`
 * (default 2). A tag node is included only if it participates in at least one
 * qualifying edge — isolated tags are dropped, not floated.
 *
 * Unlike {@link deriveGraph}, edges here are tag–tag (see {@link GraphEdge}):
 * `source`/`target` are both tag node ids, emitted once per unordered pair in
 * canonical (sorted) id order so there are no reciprocal duplicates.
 *
 * Node `degree` is CONNECTIVITY — the count of qualifying co-occurrence edges
 * the tag has (its number of co-occurring neighbors), not its bookmark count.
 * This mode is about tag relationships, so a tag that co-occurs with many
 * others reads as more central; `layoutGraph`'s mass-weighting keys off
 * `degree`, so well-connected tags anchor the middle.
 *
 * Construction is per-bookmark, not all-pairs-over-tags: for each active
 * bookmark we increment a pair-count map over every co-tag pair within it, so
 * cost is Σ (tags_per_bookmark choose 2) — tiny for real data (a handful of
 * tags per bookmark) rather than O(T²) over the whole tag set. Deterministic:
 * stable ordering, no clock/random.
 */
export function deriveCoOccurrenceGraph(input: DeriveGraphInput): Graph {
  const minSharedBookmarks = input.minSharedBookmarks ?? 2;
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

  // Per-bookmark pair counting. Nested map keyed on the two tag ids in
  // canonical order (a < b) — delimiter-safe, so a space in an id can't
  // collide with a pair separator the way a single composite string key could.
  const pairCount = new Map<string, Map<string, number>>();
  for (const tagIds of linksByBookmark.values()) {
    const sorted = [...tagIds].sort();
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const a = sorted[i];
        const b = sorted[j];
        let inner = pairCount.get(a);
        if (!inner) {
          inner = new Map<string, number>();
          pairCount.set(a, inner);
        }
        inner.set(b, (inner.get(b) ?? 0) + 1);
      }
    }
  }

  // Emit qualifying edges and tally each tag's connectivity (neighbor/edge
  // count) — its node degree. Sort qualifying pairs by (a, then b) tuple order
  // for determinism. Ids are space/NUL-free and the old delimiter sorted before
  // every id character, so this yields the same order the former composite-
  // string sort produced: layout is unchanged.
  const qualifying: Array<{ a: string; b: string; weight: number }> = [];
  for (const [a, inner] of pairCount) {
    for (const [b, weight] of inner) {
      if (weight >= minSharedBookmarks) {
        qualifying.push({ a, b, weight });
      }
    }
  }
  qualifying.sort((x, y) =>
    x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0,
  );

  const edges: GraphEdge[] = [];
  const tagDegree = new Map<string, number>();
  for (const { a: tagA, b: tagB, weight } of qualifying) {
    edges.push({ source: tagNodeId(tagA), target: tagNodeId(tagB), weight });
    tagDegree.set(tagA, (tagDegree.get(tagA) ?? 0) + 1);
    tagDegree.set(tagB, (tagDegree.get(tagB) ?? 0) + 1);
  }

  // Only tags that participate in a qualifying edge become nodes (no isolates).
  const nodes: GraphNode[] = [];
  for (const [tagId, degree] of tagDegree) {
    const tag = tagById.get(tagId)!;
    nodes.push({
      kind: 'tag',
      id: tagNodeId(tagId),
      tag_id: tagId,
      slug: tag.slug,
      label: tag.name,
      degree,
    } satisfies TagGraphNode);
  }

  return { nodes, edges };
}

/** Convenience: derive the co-occurrence graph and settle it in one call. */
export function buildSettledCoOccurrenceGraph(
  input: DeriveGraphInput,
  options?: LayoutOptions,
): SettledGraph {
  return layoutGraph(deriveCoOccurrenceGraph(input), options);
}
