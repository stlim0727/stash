/**
 * Post-settle node declutter (pure, platform-free, deterministic).
 *
 * `layoutGraph` (see `graph.ts`) settles node positions with a tick budget
 * that shrinks quadratically as node count grows (`layoutTickBudget`), to
 * keep the O(ticks·n²) force settle bounded on a large stash. A real
 * multi-hundred-bookmark library can land as few as a couple dozen ticks —
 * enough for the overall shape (hubs pulled central, bookmarks strung out
 * along their tag edges) but not enough for all-pairs point-mass repulsion
 * to fully separate every circle. The visible result: a cluster of
 * bookmark-node circles overlapping near a busy tag hub reads as an
 * indistinguishable gray blob rather than individual nodes.
 *
 * This is a separate, cheap fixup pass run AFTER the force settle. Unlike
 * the force sim (which treats every node as a dimensionless point), this
 * pass is RADIUS-AWARE: it only nudges apart node pairs whose rendered
 * circles actually overlap on screen, by the minimum distance needed to
 * clear them. It never touches the force-layout math, mass weighting, or
 * tick budget — those settle exactly as before; this only cleans up
 * leftover local overlap so every circle stays visually distinct.
 */

export interface OverlapNode {
  /** Stable graph-node id (matches the settled node's id). */
  id: string;
  x: number;
  y: number;
  /** Rendered circle radius, in the same layout units as x/y. */
  r: number;
}

const DEFAULT_PASSES = 4;
/** Small gap left beyond bare non-overlap so circles read as visually distinct, not just touching. */
const SEPARATION_PADDING = 1.5;

/**
 * Resolve overlapping circles apart, returning each node's adjusted
 * position keyed by id. Runs `passes` full relaxation sweeps: each sweep
 * finds every currently-overlapping pair and splits the correction evenly
 * between them, so a chain of touching circles untangles over a few passes
 * rather than needing one pass to get it perfect. Deterministic — pairs are
 * visited in a stable id order and exactly-coincident circles fall back to a
 * fixed (not random) push direction.
 */
export function resolveNodeOverlap(
  nodes: readonly OverlapNode[],
  passes = DEFAULT_PASSES,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  for (const node of nodes) {
    positions.set(node.id, { x: node.x, y: node.y });
  }
  if (nodes.length < 2 || passes <= 0) {
    return positions;
  }

  const ordered = [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (let pass = 0; pass < passes; pass += 1) {
    const displacement = new Map<string, { x: number; y: number }>();
    for (let i = 0; i < ordered.length; i += 1) {
      const a = ordered[i];
      const posA = positions.get(a.id)!;
      for (let j = i + 1; j < ordered.length; j += 1) {
        const b = ordered[j];
        const posB = positions.get(b.id)!;
        let dx = posA.x - posB.x;
        let dy = posA.y - posB.y;
        let dist = Math.hypot(dx, dy);
        const minDist = a.r + b.r + SEPARATION_PADDING;
        if (dist >= minDist) {
          continue;
        }
        if (dist < 1e-6) {
          // Deterministic tie-break for exactly-coincident circles: push
          // along a fixed axis derived from stable id order, never randomness.
          dx = 1;
          dy = 0;
          dist = 1;
        }
        const push = (minDist - dist) / 2;
        const ux = (dx / dist) * push;
        const uy = (dy / dist) * push;
        accumulate(displacement, a.id, ux, uy);
        accumulate(displacement, b.id, -ux, -uy);
      }
    }
    if (displacement.size === 0) {
      break;
    }
    for (const [id, delta] of displacement) {
      const pos = positions.get(id)!;
      positions.set(id, { x: pos.x + delta.x, y: pos.y + delta.y });
    }
  }

  return positions;
}

function accumulate(
  map: Map<string, { x: number; y: number }>,
  id: string,
  dx: number,
  dy: number,
): void {
  const current = map.get(id);
  if (current) {
    current.x += dx;
    current.y += dy;
  } else {
    map.set(id, { x: dx, y: dy });
  }
}

/**
 * Work ceiling for the declutter, mirroring `layoutTickBudget`'s shape
 * (`graph.ts`): a fixed pair-work budget spent as fewer passes once node
 * count grows, so this stays a small, bounded addition on top of the
 * settle's own cost instead of an unbounded second O(passes·n²) pass.
 * Returns 0 (skip entirely) once even one pass would exceed the budget.
 *
 * `DECLUTTER_FULL_QUALITY_NODE_COUNT` (1200) is chosen well above the
 * largest real graph observed in production (~770 nodes for a ~1,000-
 * bookmark library after tag-degree filtering) so the reported hairball
 * gets the full 4 passes; past that the pass count tapers the same way the
 * settle's own tick budget does.
 */
const DECLUTTER_FULL_QUALITY_NODE_COUNT = 1200;
const DECLUTTER_PAIR_BUDGET =
  DEFAULT_PASSES * DECLUTTER_FULL_QUALITY_NODE_COUNT * DECLUTTER_FULL_QUALITY_NODE_COUNT;

export function declutterPassBudget(nodeCount: number): number {
  if (nodeCount <= 1) {
    return DEFAULT_PASSES;
  }
  const scaled = Math.floor(DECLUTTER_PAIR_BUDGET / (nodeCount * nodeCount));
  return Math.min(DEFAULT_PASSES, Math.max(0, scaled));
}
