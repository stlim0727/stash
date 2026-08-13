# Graph View Layout: The Large-Library "Hairball" Fix

Context for `apps/mobile/src/domain/graph.ts`, `graph-declutter.ts`, and
`graph-satellite-layout.ts` — why the bipartite (bookmark↔tag) graph needed a
second, non-physics placement pass on top of the force settle, and why the
first, cheaper fix attempt didn't work.

## The report

A user's graph render looked "inadequate" — a screenshot showed the
bipartite view as a large, illegible gray mass of overlapping bookmark-node
dots around the busiest tag hubs. Verified against the live production
database (`mcp__Supabase__execute_sql`, not a guess): the account has 1,035
active bookmarks, and its single most popular tag alone carries 331 of them
(second and third: 263 and 223).

## Root cause

`layoutTickBudget` (`graph.ts`) deliberately shrinks the force settle's tick
count as node count grows, to keep the O(ticks·n²) settle bounded and avoid
tripping Stash's 2s hang detector. At this scale that's as few as ~10-20
ticks — nowhere near enough for all-pairs repulsion to separate hundreds of
bookmark-node circles clustered around a busy hub. Reproducing the shape
(see `graph-satellite-layout.test.ts`'s `hairballFixture`), the raw settle
measured 1,900-3,400 circle pairs that **genuinely overlap in raw layout
coordinates**, not just read as visually dense. This matters because SVG
viewBox zoom scales node position and radius together, so the overlap
persists at any zoom level — it is not a "just zoom in" situation.

## Rejected fix: post-hoc pairwise nudge alone

The obvious cheap fix — after the settle, find overlapping circles and nudge
them apart (`graph-declutter.ts`'s `resolveNodeOverlap`) — does not converge
cheaply at this scale. Empirically: 150 relaxation passes over the full
~1,100-node graph still left 467 pairs overlapping and took ~5s, well past
the 2s hang budget. The failure mode: pairwise correction only reshuffles
local overlap: with hundreds of circles genuinely too dense for the space
the force settle gave them, resolving it needs a large NET outward
migration, not local jitter, and that needs either many more O(n²)
iterations or a smarter algorithm.

## The fix: deterministic satellite placement

`graph-satellite-layout.ts`'s `placeBookmarkSatellites` replaces the
tick-starved bookmark positions instead of repairing them:

1. Assign each bookmark to its highest-degree connected tag (its most
   prominent one; edges to its other tags are untouched — still drawn, just
   anchored near the primary one).
2. Declutter tag-hub **centers** apart using a *footprint* radius — the
   hub's own circle plus the radius its full satellite ring will occupy
   (`ringOuterRadius`) — via `resolveNodeOverlap`. This step is cheap
   because hub count stays small (tens, bounded by the shared-tag backbone's
   degree threshold) even when bookmark count is huge — but is NOT assumed
   to stay small: `hubFootprintPassBudget` tapers the same way
   `layoutTickBudget` does, because `minSharedDegree` only bounds how many
   bookmarks a tag needs (≥4), not how many distinct tags can each clear
   that bar.
3. Place each hub's bookmarks on a golden-angle (phyllotaxis) spiral around
   its (now-separated) center — mathematically guaranteed no same-hub
   overlap, O(n), no iteration.
4. A final whole-graph safety-net pass (`declutterSettledGraph` in
   `app/graph.tsx`) mops up any small residual overlap between neighboring
   hubs' rings.

Every bookmark is still rendered — nothing is hidden, consistent with the
STASH-5Z precedent (#735) that a large-library graph fix must decongest, not
drop, data.

`ringOuterRadius` must reach the outermost satellite's far EDGE, not just
its center — the placement loop puts that satellite's center at
`hubRadius + bookmarkRadius + 2 + spacing*sqrt(memberCount-1)`, and its own
circle then extends a further `bookmarkRadius` past that. An early version
of the fix missed this (PR #749 review), which under-counted the footprint
by exactly one `bookmarkRadius` and could leave two neighboring hubs' rings
touching.

`hubFootprintPassBudget` exists for the same reason `layoutTickBudget` does:
`minSharedDegree` bounds how many bookmarks a tag needs to survive (≥4), not
how many distinct tags can each clear that bar, so a tag-diverse library
could in principle produce thousands of hub nodes. An early version used a
fixed 24-pass constant for the hub-footprint declutter (safe at the observed
~60-110 hub range, but O(24·h²) unbounded past it) — also caught in PR #749
review.

Hub labels (`graph-labels.ts`'s `resolveHubLabels`) render AFTER node
circles (`app/graph.tsx`'s `svgChildren`), so a satellite placed directly
under a hub's own text label is painted over even though it registers zero
circle-to-circle overlap — a third PR #749 review finding, on a small hub
with only a handful of bookmarks (the label's near-hub footprint is
proportionally larger relative to a small ring). The fix reserves angular
sectors centered on the label's two possible positions (straight below or
straight above — `resolveHubLabels` never places one to the side), but only
within a bounded radius of the hub (a label can never reach further than
`maxLabelOffset` + the label's own height), so it doesn't meaningfully
inflate `ringOuterRadius`'s footprint estimate for a large hub.

## Result

On the reproduced production shape: raw settle overlap (1,900+ pairs) → 0,
in ~150ms on top of the existing settle.
