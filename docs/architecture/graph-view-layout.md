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

The scaled-down replacement had its own edge: at large enough hub counts
(~981+, given the tuned budget constant) the formula rounded all the way down
to a literal 0 passes — and 0 is not "less decluttering," it is a hard no-op
(`resolveNodeOverlap` returns hub positions completely unchanged), leaving
whatever the force settle produced. Measured on a 1,000-hub/5,000-node
fixture: 0 passes left 142,757 overlapping circle pairs.

A first fix attempt floored the budget at a flat 1, unconditionally. That
was itself incomplete: 1 pass is still one full O(n²) sweep through
`resolveNodeOverlap`, and review flagged that the SAME zero-floor bug also
existed in the pre-existing sibling `declutterPassBudget`
(`graph-declutter.ts`, used for the final whole-graph safety-net pass) —
which operates over ALL nodes (hubs + bookmarks), not just hub count, so it
reaches its own zero-floor at a much more easily-reached ~2,400 total
nodes. Timing a flat "always floor to 1" fix for `declutterPassBudget`
specifically (not just the hub-only case) found it was NOT safe at the
sizes review actually cares about: empirically, a single pass measures
~715ms at 5,000 nodes (fine) but ~1.85s at 8,000 and ~3.1s at 10,000 —
already over the 2s hang budget, at node counts a real (if large) library
could plausibly reach, unlike the hub-only case where reaching that many
DISTINCT surviving tags is far more extreme.

A second fix floored at 1 only up to a shared, empirically measured
`SINGLE_PASS_SAFE_NODE_COUNT` (6,000 — comfortably under the ~8,000 mark
where a single pass starts to bite, exported once from `graph-declutter.ts`
and reused by `hubFootprintPassBudget` since both budgets feed the same
`resolveNodeOverlap` primitive). This made `declutterPassBudget` (the
whole-graph safety net, which really can encounter thousands of nodes in a
large real library) safe at every scale it operates at. But review kept
pushing on the SAME underlying point, correctly: for `hubFootprintPassBudget`
specifically, "floor at 1" was never actually a fix, just a smaller version
of the same problem — no FIXED small pass count of an O(n²) relaxation sweep
*guarantees* full separation for an arbitrary configuration, it only makes
probabilistic progress toward it. On the reviewer's own 1,000-hub fixture, 1
pass still left 24,025 overlapping pairs.

That's the real insight the first three attempts missed by tuning the same
lever (how many passes): pass count was never going to be the fix, because
convergence isn't guaranteed at any bounded pass count for adversarial
input. The actual fix replaces the question entirely for the range where it
matters. `packHubsOnGrid` places hub centers on a uniform grid sized to
clear the single largest hub footprint present — an EXACT, structural
guarantee (any two hubs are at least one cell apart on some axis, which is
always ≥ the sum of their radii) instead of an iterative approximation, and
O(n log n) (sort for determinism, one assignment pass) instead of
O(passes·n²). `placeBookmarkSatellites` now uses ordinary iterative
declutter up to `HUB_FOOTPRINT_FULL_QUALITY_HUB_COUNT` (200 — provably
always the full 24 passes at that hub count, given the tuned budget
constant, and already verified to converge well for realistic distributions
via the production-shape fixture) and switches to the grid beyond it.
Verified directly against the reviewer's fixture: 0 overlapping pairs at
1,000 hubs (28ms) and still 0 at 5,000 hubs (78ms) — the guarantee holds
regardless of scale, unlike every pass-count-tuning attempt before it.

The trade-off, stated plainly: past 200 hubs the layout stops trying to
preserve the force-settled topological arrangement (hubs that share
bookmarks no longer cluster together) — a grid is topologically arbitrary.
That's an accepted, deliberate cost specific to a tier real libraries never
reach (observed ~60–110 hubs even for a 1,000+ bookmark library; 200+ needs
that many DISTINCT tags each carried by ≥4 bookmarks), not a regression
relative to the "hope enough passes happened" approach it replaces, which
never actually delivered a legible layout at that scale either.

### A rejected middle attempt: geometric label avoidance

Hub labels (`graph-labels.ts`'s `resolveHubLabels`) render AFTER node
circles, so a satellite placed directly under a hub's own text label was
painted over even though it registered zero circle-to-circle overlap — a
third PR #749 review finding, on a small hub with only a handful of
bookmarks (the label's near-hub footprint is proportionally larger relative
to a small ring).

The first fix attempt reserved a fixed ±65° angular sector around the
label's two possible positions (straight below/above — `resolveHubLabels`
never places one to the side), bounded to a radius near the hub so it
wouldn't inflate `ringOuterRadius`'s footprint estimate. Review caught two
more problems with this on the very next pass:

- A fixed angle can't model a rectangle: a wide label (long tag name) on a
  small hub needs a WIDER exclusion angle near its close top corner than a
  short label does, and a constant angular half-width is wrong in one
  direction or the other depending on hub size and label length. Concrete
  counter-example: a 3-bookmark hub labeled `abcdefghij` still placed a
  satellite whose circle clipped the label box, just outside the fixed
  65° cutoff.
- Worse: when label avoidance SKIPPED a spiral index, the accepted member
  index (`rawK`) ran ahead of the plain member count, but `ringOuterRadius`
  still sized the hub's footprint from `memberCount` alone — reintroducing
  the exact "footprint under-counts the true ring extent" bug that had just
  been fixed for the trailing-radius case, now via a different mechanism.
  Two adjacent hubs could again end up with overlapping satellites.

Rather than patch the angle heuristic a third time (chase the invariant one
counter-example at a time, the mistake `CLAUDE.md`'s Behavioral Invariants
section specifically warns against), the actual fix is architectural: SVG
paints later JSX children on top of earlier ones, so `app/graph.tsx` now
renders hub labels BEFORE node circles instead of after. Every circle —
bookmark or hub — is then guaranteed to paint on top of any label it
happens to sit near, by construction, with no geometry to get subtly wrong.
The trade-off is a small dot can locally cover a glyph or two of label text,
which is a strictly smaller defect than a fully hidden, untappable bookmark.
This also let the satellite-placement code drop the whole label-avoidance
mechanism (and its `ringOuterRadius`/footprint coupling risk) entirely,
returning `placeBookmarkSatellites` to the simpler, already-proven-correct
plain golden-angle spiral.

## Result

On the reproduced production shape: raw settle overlap (1,900+ pairs) → 0,
in ~150ms on top of the existing settle.
