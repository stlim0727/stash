/**
 * Render-side hub-label declutter (pure, platform-free, deterministic).
 *
 * The settled graph layout (see `graph.ts`) places nodes as dimensionless
 * points, and the mass-weighting pulls the busiest tag hubs toward the centroid.
 * At larger stashes that means two popular hub LABELS can overlap near the
 * center. We fix this purely at label-placement time — the layout/mass math is
 * left completely untouched.
 *
 * Each hub label is modelled as an axis-aligned bounding box centered under (or
 * over) its hub. Hubs are processed in a stable priority order (descending
 * `degree`, then `id` ascending): the busiest hub keeps its default position
 * BELOW its circle, and each subsequent label that would collide with an
 * already-placed box is nudged — first FLIPPED above its own node, then, if that
 * still collides, pushed a small bounded step further away. The nudge is capped
 * so a label never drifts far from its hub; a capped label may keep a small
 * residual overlap (better than a detached label). No randomness, no clock — the
 * same input always yields identical output.
 */

/** A hub node to place a label for. */
export interface HubLabelInput {
  /** Stable graph-node id (priority tiebreak + render key). */
  id: string;
  /** Hub center (layout/viewBox units). */
  x: number;
  y: number;
  /** Hub circle radius. */
  r: number;
  /** Label text (already localized — e.g. the untagged hub's substitution). */
  text: string;
  /** Priority signal: bigger hubs keep their default position. */
  degree: number;
}

/** Axis-aligned label bounding box (layout/viewBox units, SVG y grows down). */
export interface LabelBox {
  min_x: number;
  min_y: number;
  max_x: number;
  max_y: number;
}

/** A resolved label placement for one hub. */
export interface HubLabelPlacement {
  id: string;
  /** Centered on the hub (== node.x); rendered with textAnchor="middle". */
  x: number;
  /** SVG text baseline y (sits at the bottom of the glyph box). */
  y: number;
  /** Which side of the hub the label landed on. */
  position: 'below' | 'above';
  /** The resolved bounding box (exposed for tests / debugging). */
  box: LabelBox;
}

/**
 * Estimated glyph width per character as a fraction of the font size. Exact glyph
 * metrics aren't available to SVG here, so we approximate with a monospace-ish
 * factor. The labels render BOLD (fontWeight 700), which runs wider than the
 * regular-weight average, so this deliberately over-estimates a touch: a slightly
 * wider box only makes the declutter MORE conservative (catches marginal
 * collisions a narrower box would miss), never less.
 */
const CHAR_WIDTH_FACTOR = 0.65;

/**
 * Bounded nudge offsets (in multiples of fontSize) tried in order for each side.
 * The largest, `2 * fontSize`, is the attachment cap: a label's nearest edge
 * never sits farther than this from its hub circle.
 */
function offsetSteps(fontSize: number): number[] {
  return [0, fontSize, 2 * fontSize];
}

/** The maximum distance a resolved label's nearest edge may sit from its hub. */
export function maxLabelOffset(fontSize: number): number {
  return 2 * fontSize;
}

function estimateWidth(text: string, fontSize: number): number {
  return text.length * fontSize * CHAR_WIDTH_FACTOR;
}

/** Area of the intersection of two boxes (0 when they merely touch or miss). */
function overlapArea(a: LabelBox, b: LabelBox): number {
  const w = Math.min(a.max_x, b.max_x) - Math.max(a.min_x, b.min_x);
  const h = Math.min(a.max_y, b.max_y) - Math.max(a.min_y, b.min_y);
  return w > 0 && h > 0 ? w * h : 0;
}

function totalOverlap(box: LabelBox, placed: LabelBox[]): number {
  let sum = 0;
  for (const other of placed) {
    sum += overlapArea(box, other);
  }
  return sum;
}

interface Candidate {
  position: 'below' | 'above';
  baseline: number;
  box: LabelBox;
}

/**
 * Candidate boxes for one hub, in the order they're tried: default BELOW, flip
 * ABOVE, then the same pair pushed one and two bounded steps further out. The
 * label box is `fontSize` tall and centered on the hub's x.
 */
function candidatesFor(hub: HubLabelInput, fontSize: number): Candidate[] {
  const half = estimateWidth(hub.text, fontSize) / 2;
  const height = fontSize;
  const minX = hub.x - half;
  const maxX = hub.x + half;
  // Box edge nearest the circle on each side, before any nudge offset.
  const belowTop = hub.y + hub.r;
  const aboveBottom = hub.y - hub.r;

  const candidates: Candidate[] = [];
  for (const off of offsetSteps(fontSize)) {
    const bTop = belowTop + off;
    candidates.push({
      position: 'below',
      baseline: bTop + height,
      box: { min_x: minX, max_x: maxX, min_y: bTop, max_y: bTop + height },
    });
    const aBottom = aboveBottom - off;
    candidates.push({
      position: 'above',
      baseline: aBottom,
      box: { min_x: minX, max_x: maxX, min_y: aBottom - height, max_y: aBottom },
    });
  }
  return candidates;
}

/**
 * Resolve non-overlapping (or minimally-overlapping) label placements for the
 * given hubs. Deterministic: same input ⇒ identical output.
 *
 * Hubs are processed by descending `degree` then ascending `id`; the first hub
 * keeps its default below position, and each later label takes the first
 * collision-free candidate (default-below → flip-above → bounded nudges). If no
 * candidate is collision-free, the least-overlapping one is used (still capped,
 * still attached).
 */
export function resolveHubLabels(
  hubs: HubLabelInput[],
  fontSize: number,
): HubLabelPlacement[] {
  const order = [...hubs].sort((a, b) => {
    if (b.degree !== a.degree) {
      return b.degree - a.degree;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const placed: LabelBox[] = [];
  const result: HubLabelPlacement[] = [];
  for (const hub of order) {
    const candidates = candidatesFor(hub, fontSize);
    let chosen = candidates[0];
    let chosenOverlap = Infinity;
    for (const candidate of candidates) {
      const overlap = totalOverlap(candidate.box, placed);
      if (overlap === 0) {
        chosen = candidate;
        chosenOverlap = 0;
        break;
      }
      if (overlap < chosenOverlap) {
        chosenOverlap = overlap;
        chosen = candidate;
      }
    }
    placed.push(chosen.box);
    result.push({
      id: hub.id,
      x: hub.x,
      y: chosen.baseline,
      position: chosen.position,
      box: chosen.box,
    });
  }
  return result;
}
