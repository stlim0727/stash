/**
 * Search match highlighting — splits a display string into highlighted vs.
 * plain segments for the active search query, so the Inbox can show *where* a
 * result matched.
 *
 * This is a presentation aid, deliberately decoupled from the authoritative
 * matcher in `@/domain/search`: `filterBookmarks` decides WHICH bookmarks show
 * (with its punctuation-stripping + whitespace-collapse tolerance), and this
 * decides where to draw the highlight on the text the user actually sees. The
 * two share the same case/width tolerance (NFKC + lowercase) but this one is
 * intentionally a *literal* per-token match against the original text:
 *
 *  - It finds each whitespace-separated query token (NFKC + lowercased, keeping
 *    internal symbols so "c++" / "watch-later" highlight literally) wherever it
 *    appears in the display text, case/width-insensitively.
 *  - It does NOT reproduce the collapse fallback ("watchlater" → "Watch Later"):
 *    a query that only matched a row via separator-collapsing simply gets no
 *    highlight on that field. The row still shows (search already decided that);
 *    highlighting is best-effort, never a second filter, and never highlights a
 *    span the user didn't type.
 *
 * Pure (no React / native), so it lives under the Node test lane.
 */

const ALNUM = /[\p{L}\p{N}]/u;

export interface HighlightSegment {
  text: string;
  /** True when this run is a query match to be visually emphasized. */
  match: boolean;
}

/**
 * The needles to look for: each whitespace-separated query token, NFKC-folded
 * and lowercased, keeping internal symbols. Tokens carrying no letter/digit
 * ("...", "-", "!!!") are dropped — they aren't real search tokens (mirroring
 * `queryHasSearchTokens`), so they never drive a highlight.
 */
function queryNeedles(query: string): string[][] {
  const seen = new Set<string>();
  const needles: string[][] = [];
  for (const token of query.split(/\s+/)) {
    if (!token) {
      continue;
    }
    const folded = token.normalize('NFKC').toLowerCase();
    if (!ALNUM.test(folded) || seen.has(folded)) {
      continue;
    }
    seen.add(folded);
    needles.push([...folded]);
  }
  return needles;
}

/**
 * Fold the display text per code point (NFKC + lowercase), keeping a parallel
 * map from each folded code point back to the [start, end) code-unit slice of
 * the ORIGINAL string it came from. Folding can change length (e.g. fullwidth
 * forms, the Turkish dotted capital I), so we track the mapping rather than
 * assuming 1:1, and matches are reported in original-string indices.
 */
function foldWithMap(text: string): { folded: string[]; map: Array<[number, number]> } {
  const folded: string[] = [];
  const map: Array<[number, number]> = [];
  let index = 0;
  for (const cp of text) {
    const start = index;
    const end = index + cp.length;
    index = end;
    for (const fch of cp.normalize('NFKC').toLowerCase()) {
      folded.push(fch);
      map.push([start, end]);
    }
  }
  return { folded, map };
}

/** All start indices in `folded` where `needle` occurs (overlapping allowed). */
function occurrences(folded: string[], needle: string[]): number[] {
  const hits: number[] = [];
  if (needle.length === 0 || folded.length < needle.length) {
    return hits;
  }
  outer: for (let i = 0; i + needle.length <= folded.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (folded[i + j] !== needle[j]) {
        continue outer;
      }
    }
    hits.push(i);
  }
  return hits;
}

/**
 * Split `text` into ordered highlighted/plain segments for `query`. With no
 * real query tokens or no matches, returns a single non-match segment carrying
 * the whole string, so callers can render uniformly.
 */
export function highlightSegments(text: string, query: string): HighlightSegment[] {
  const whole: HighlightSegment[] = [{ text, match: false }];
  if (!text || !query.trim()) {
    return whole;
  }
  const needles = queryNeedles(query);
  if (needles.length === 0) {
    return whole;
  }

  const { folded, map } = foldWithMap(text);
  // Collect matched ranges in ORIGINAL code-unit indices.
  const ranges: Array<[number, number]> = [];
  for (const needle of needles) {
    for (const start of occurrences(folded, needle)) {
      ranges.push([map[start]![0], map[start + needle.length - 1]![1]]);
    }
  }
  if (ranges.length === 0) {
    return whole;
  }

  // Merge overlapping/adjacent ranges so neighbouring matches render as one run.
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }

  // Walk the merged ranges, emitting the plain gaps between them.
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) {
      segments.push({ text: text.slice(cursor, start), match: false });
    }
    segments.push({ text: text.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), match: false });
  }
  return segments;
}
