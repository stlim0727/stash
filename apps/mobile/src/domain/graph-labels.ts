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
 * Estimated glyph width per code point, as a fraction of the font size. Exact
 * glyph metrics aren't available to SVG here, so we approximate per-glyph and sum.
 *
 * Latin/narrow glyphs get `NARROW_EM`. The labels render BOLD (fontWeight 700),
 * which runs wider than the regular-weight average, so this narrow factor
 * deliberately over-estimates a touch — a slightly wider box only makes the
 * declutter MORE conservative, never less.
 *
 * CJK/full-width glyphs (Korean/Chinese/Japanese/full-width forms) render ~1 em
 * square — roughly 1.5× the narrow estimate — so a flat narrow factor badly
 * under-estimates a Korean tag like "여행" and would leave two nearby Korean hub
 * labels judged non-overlapping when they visually collide. `WIDE_EM` counts
 * those glyphs at ~1 em so the box tracks their real width.
 */
const NARROW_EM = 0.65;
const WIDE_EM = 1.0;

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

/**
 * Whether a code point renders as a wide/full-width glyph (~1 em square). A
 * pragmatic range check that errs WIDE/conservative rather than reproducing the
 * full Unicode East-Asian-Width table:
 *  - Hangul Jamo (1100–11FF) + Hangul Compatibility Jamo (3130–318F)
 *  - CJK Symbols & Punctuation (3000–303F)
 *  - Hiragana + Katakana (3040–30FF)
 *  - CJK Unified Ideographs Ext-A (3400–4DBF) + base (4E00–9FFF)
 *  - Hangul Syllables (AC00–D7A3)
 *  - Fullwidth Forms (FF00–FF60) + Fullwidth signs (FFE0–FFE6)
 *  - CJK Unified Ideographs Ext-B and beyond (>= 20000, matched by code point so
 *    surrogate pairs count as one wide glyph)
 */
function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0x3130 && cp <= 0x318f) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    cp >= 0x20000
  );
}

/**
 * Estimated label width: sum of per-code-point glyph widths. Iterating by code
 * point (spread, not `.length`) means a CJK Ext-B surrogate pair counts as one
 * wide glyph, and mixed Latin/CJK tags are measured segment-by-segment.
 */
function estimateWidth(text: string, fontSize: number): number {
  let ems = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    ems += isWideCodePoint(cp) ? WIDE_EM : NARROW_EM;
  }
  return ems * fontSize;
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
