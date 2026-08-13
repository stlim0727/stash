import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  deriveGraph,
  layoutGraph,
  layoutTickBudget,
  type DeriveGraphInput,
  type PositionedNode,
  type SettledGraph,
} from '@/domain/graph';
import { SINGLE_PASS_SAFE_NODE_COUNT } from '@/domain/graph-declutter';
import {
  hubFootprintPassBudget,
  packHubsOnGrid,
  placeBookmarkSatellites,
  ringOuterRadius,
} from '@/domain/graph-satellite-layout';
import type { Bookmark, BookmarkTag, Tag } from '@/domain/types';

const NOW = '2026-06-12T00:00:00.000Z';
const BOOKMARK_R = 9;
// Matches app/graph.tsx's HUB_MIN_R/HUB_MAX_R/hubRadius.
const HUB_MIN_R = 11;
const HUB_MAX_R = 33;

function hubRadius(degree: number): number {
  return Math.min(HUB_MAX_R, Math.max(HUB_MIN_R, HUB_MIN_R + 6 * Math.sqrt(degree)));
}

function makeBookmark(id: string): Bookmark {
  return {
    id,
    user_id: 'u1',
    url: `https://example.com/${id}`,
    canonical_url: null,
    url_hash: id,
    title: `Title ${id}`,
    description: null,
    notes: null,
    source_app: null,
    content_type: 'url',
    preview_image_url: null,
    favicon_url: null,
    site_name: null,
    collection_id: null,
    is_archived: false,
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
    last_saved_at: NOW,
    metadata_status: 'complete',
    sync_status: 'synced',
  };
}

function makeTag(id: string): Tag {
  return { id, user_id: 'u1', name: id, slug: id, source: 'user', created_at: NOW };
}

function link(bookmark_id: string, tag_id: string): BookmarkTag {
  return { bookmark_id, tag_id, source: 'user', confidence: null, created_at: NOW };
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function countOverlaps(nodes: { x: number; y: number; r: number }[]): number {
  let overlaps = 0;
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      if (distance(nodes[i], nodes[j]) < nodes[i].r + nodes[j].r) {
        overlaps += 1;
      }
    }
  }
  return overlaps;
}

function radiusOf(node: PositionedNode): number {
  return node.kind === 'bookmark' ? BOOKMARK_R : hubRadius(node.degree);
}

function settle(input: DeriveGraphInput): SettledGraph {
  const graph = deriveGraph(input);
  return layoutGraph(graph, { ticks: layoutTickBudget(graph.nodes.length) });
}

/**
 * Directly reproduces the reported production shape: a ~1,035-bookmark
 * library whose top three tags carry 331 / 263 / 223 bookmarks (the exact
 * degrees observed on the live report), plus a long tail of smaller tags —
 * instead of random generation, so the fixture is auditable and the test is
 * fully deterministic without depending on a PRNG seed.
 */
function hairballFixture(): DeriveGraphInput {
  const N = 1035;
  const bookmarks = Array.from({ length: N }, (_, i) => makeBookmark(`bk${i}`));
  const tags: Tag[] = [];
  const bookmarkTags: BookmarkTag[] = [];

  // The top tags' degrees, exactly matching the live report. Members are
  // OVERLAPPING windows into the shared `bookmarks` pool (each window starts
  // half-way into the previous one), not disjoint slices — a real library's
  // top tags routinely share bookmarks (the live account averages 2.71
  // tags/bookmark; three tags at once is common), and the primary-hub
  // tie-break logic under test needs bookmarks that are genuinely reachable
  // from more than one of these big hubs to be exercised at all. Still fully
  // deterministic (modulo arithmetic, no PRNG) so the fixture is auditable.
  const topDegrees = [331, 263, 223, 83, 73, 68, 42, 35, 34, 32, 21, 21, 21, 21, 20];
  let offset = 0;
  topDegrees.forEach((degree, tagIndex) => {
    const tag = makeTag(`tag${tagIndex}`);
    tags.push(tag);
    for (let i = 0; i < degree; i += 1) {
      const bookmark = bookmarks[(offset + i) % N];
      bookmarkTags.push(link(bookmark.id, tag.id));
    }
    offset = (offset + Math.floor(degree / 2)) % N;
  });

  // Long tail of small tags (2-3 members each), spread across the whole pool
  // with a stride coprime-ish to N so they land on different bookmarks than
  // the top-tag windows above, until the total link count matches the live
  // account's total_bookmark_tag_links (2,338) — pushing the average
  // tags/bookmark up toward the real ~2.71, not just the top tags' own
  // overlap.
  const TARGET_LINKS = 2338;
  let tailOffset = 17;
  let tailTagIndex = topDegrees.length;
  while (bookmarkTags.length < TARGET_LINKS) {
    const tag = makeTag(`tag${tailTagIndex}`);
    tags.push(tag);
    const groupSize = 2 + (tailTagIndex % 2);
    for (let i = 0; i < groupSize && bookmarkTags.length < TARGET_LINKS; i += 1) {
      const bookmark = bookmarks[(tailOffset + i * 37) % N];
      bookmarkTags.push(link(bookmark.id, tag.id));
    }
    tailOffset = (tailOffset + 53) % N;
    tailTagIndex += 1;
  }

  return { bookmarks, tags, bookmarkTags, minSharedDegree: 4 };
}

test('no-op when the graph has no bookmark nodes (co-occurrence view)', () => {
  const settled: SettledGraph = {
    nodes: [{ id: 't:a', kind: 'tag', tag_id: 'a', slug: 'a', label: 'a', degree: 3, x: 10, y: 20 }],
    edges: [],
    bounds: { min_x: 10, min_y: 20, max_x: 10, max_y: 20, width: 0, height: 0 },
  };
  const result = placeBookmarkSatellites(settled, { bookmarkRadius: BOOKMARK_R, hubRadius });
  assert.equal(result, settled);
});

test('a small single-hub group places every bookmark distinctly around the hub, no overlap', () => {
  const bookmarks = Array.from({ length: 8 }, (_, i) => makeBookmark(`bk${i}`));
  const tag = makeTag('cooking');
  const bookmarkTags = bookmarks.map((b) => link(b.id, tag.id));
  const settled = settle({ bookmarks, tags: [tag], bookmarkTags, minSharedDegree: 1 });

  const result = placeBookmarkSatellites(settled, { bookmarkRadius: BOOKMARK_R, hubRadius });

  const circles = result.nodes.map((node) => ({ x: node.x, y: node.y, r: radiusOf(node) }));
  assert.equal(countOverlaps(circles), 0);
  // Every bookmark id from the input is still present — nothing dropped.
  for (const b of bookmarks) {
    assert.ok(result.nodes.some((n) => n.kind === 'bookmark' && n.bookmark_id === b.id));
  }
});

test('the reported production shape (1,035 bookmarks, a 331-bookmark mega-tag) settles with (near) zero overlap', () => {
  const settled = settle(hairballFixture());
  // Sanity: this reproduces the real reported scale (the live account has
  // 710 bookmarks with a tag surviving the same >=4 threshold, per the
  // production query this fixture is modeled on).
  assert.ok(settled.nodes.length > 600, `expected a large graph, got ${settled.nodes.length} nodes`);

  const beforeCircles = settled.nodes.map((node) => ({ x: node.x, y: node.y, r: radiusOf(node) }));
  const before = countOverlaps(beforeCircles);
  // The raw force settle at this scale is genuinely a hairball (this is the
  // bug being fixed, asserted here so a future change can't silently regress
  // the fixture into a case that was never actually reproducing the report).
  assert.ok(before > 500, `expected the raw settle to reproduce heavy overlap, got ${before} pairs`);

  const result = placeBookmarkSatellites(settled, { bookmarkRadius: BOOKMARK_R, hubRadius });
  const afterCircles = result.nodes.map((node) => ({ x: node.x, y: node.y, r: radiusOf(node) }));
  const after = countOverlaps(afterCircles);
  // Not a full mathematical guarantee across DIFFERENT hubs' rings (only
  // within a hub's own group is overlap impossible by construction), but on
  // this fixture the footprint declutter + spiral placement resolves every
  // overlap — asserted as an exact 0, not just "small", so a regression in
  // either the footprint radius or the pass budget shows up here instead of
  // hiding under a loose threshold.
  assert.equal(after, 0, `expected the declutter+spiral pipeline to resolve all overlap, got ${after} pairs (was ${before})`);

  // Every bookmark node is still present — the fix must not hide data.
  const bookmarkCountBefore = settled.nodes.filter((n) => n.kind === 'bookmark').length;
  const bookmarkCountAfter = result.nodes.filter((n) => n.kind === 'bookmark').length;
  assert.equal(bookmarkCountAfter, bookmarkCountBefore);
});

test('is deterministic: repeated calls on the same settled graph yield identical positions', () => {
  const settled = settle(hairballFixture());
  const first = placeBookmarkSatellites(settled, { bookmarkRadius: BOOKMARK_R, hubRadius });
  const second = placeBookmarkSatellites(settled, { bookmarkRadius: BOOKMARK_R, hubRadius });
  for (let i = 0; i < first.nodes.length; i += 1) {
    assert.equal(first.nodes[i].x, second.nodes[i].x);
    assert.equal(first.nodes[i].y, second.nodes[i].y);
  }
});

test('edges are passed through unchanged', () => {
  const settled = settle(hairballFixture());
  const result = placeBookmarkSatellites(settled, { bookmarkRadius: BOOKMARK_R, hubRadius });
  assert.equal(result.edges, settled.edges);
});

test('bounds cover every adjusted node position', () => {
  const settled = settle(hairballFixture());
  const result = placeBookmarkSatellites(settled, { bookmarkRadius: BOOKMARK_R, hubRadius });
  for (const node of result.nodes) {
    assert.ok(node.x >= result.bounds.min_x && node.x <= result.bounds.max_x);
    assert.ok(node.y >= result.bounds.min_y && node.y <= result.bounds.max_y);
  }
  assert.equal(result.bounds.width, result.bounds.max_x - result.bounds.min_x);
  assert.equal(result.bounds.height, result.bounds.max_y - result.bounds.min_y);
});

test('a multi-tag bookmark is still placed near its highest-degree tag, deterministically', () => {
  const bookmarks = [makeBookmark('multi'), ...Array.from({ length: 5 }, (_, i) => makeBookmark(`solo${i}`))];
  const popular = makeTag('popular'); // degree 6 (all bookmarks)
  const niche = makeTag('niche'); // degree 1 (only "multi")
  const bookmarkTags: BookmarkTag[] = [
    link('multi', popular.id),
    link('multi', niche.id),
    ...bookmarks.slice(1).map((b) => link(b.id, popular.id)),
  ];
  const settled = settle({ bookmarks, tags: [popular, niche], bookmarkTags, minSharedDegree: 1 });
  const result = placeBookmarkSatellites(settled, { bookmarkRadius: BOOKMARK_R, hubRadius });

  const popularHub = result.nodes.find((n) => n.kind === 'tag' && n.tag_id === popular.id)!;
  const nicheHub = result.nodes.find((n) => n.kind === 'tag' && n.tag_id === niche.id)!;
  const multiNode = result.nodes.find((n) => n.kind === 'bookmark' && n.bookmark_id === 'multi')!;

  // Anchored near the higher-degree tag ("popular"), not the niche one.
  assert.ok(distance(multiNode, popularHub) < distance(multiNode, nicheHub));
});

test('ringOuterRadius reaches the outermost satellite\'s far EDGE, not just its center', () => {
  // Direct regression for the footprint bug: the placement loop puts the
  // outermost member's (index `memberCount - 1`) CENTER at
  // `bookmarkRadius + 2 + spacing*sqrt(memberCount-1)` from the hub's own
  // circle edge — that satellite's OWN circle then extends a further
  // `bookmarkRadius` past its center. A footprint that only reaches the
  // center (the pre-fix formula) lets a neighboring hub's declutter treat
  // that gap as safe when it isn't. Checked at both the live report's
  // biggest tag (331) and a couple of smaller sizes.
  const spacing = BOOKMARK_R * 1.3;
  for (const memberCount of [1, 2, 10, 331]) {
    const lastSatelliteCenterDistance = BOOKMARK_R + 2 + spacing * Math.sqrt(memberCount - 1);
    const footprint = ringOuterRadius(memberCount, BOOKMARK_R, spacing);
    assert.ok(
      footprint >= lastSatelliteCenterDistance + BOOKMARK_R,
      `memberCount=${memberCount}: footprint ${footprint} must reach at least ${lastSatelliteCenterDistance + BOOKMARK_R}`,
    );
  }
});

test('hubFootprintPassBudget gives full quality at the observed production hub-count range', () => {
  assert.equal(hubFootprintPassBudget(0), 24);
  assert.equal(hubFootprintPassBudget(1), 24);
  assert.equal(hubFootprintPassBudget(110), 24);
  assert.equal(hubFootprintPassBudget(200), 24);
});

test('hubFootprintPassBudget tapers down for a pathologically tag-diverse library, floored at 1 within the safe range', () => {
  // minSharedDegree only bounds how many bookmarks a tag needs (>=4), not how
  // many DISTINCT tags can each clear that bar — a tag-diverse library could
  // produce thousands of hub nodes, and the budget must not stay flat there.
  const at1000 = hubFootprintPassBudget(1000);
  assert.ok(at1000 < 24);
  assert.ok(at1000 >= 1);
  // A literal 0 is a hard no-op (resolveNodeOverlap returns positions
  // unchanged) that leaves hub centers wherever the force settle left them —
  // a PR review finding on a 1,000-hub/5,000-node scenario, where that
  // produced 230,000+ residual overlaps. A floor of 1 still makes real
  // progress on every currently-overlapping pair (verified: 142,757 -> 24,025
  // overlaps at hubCount=1,000 on the equivalent fixture), and both the
  // reviewer's own reported scale and the "no PRNG, deterministic" fixture
  // scale below sit well inside SINGLE_PASS_SAFE_NODE_COUNT.
  assert.equal(hubFootprintPassBudget(5000), 1);
  assert.equal(hubFootprintPassBudget(SINGLE_PASS_SAFE_NODE_COUNT), 1);
});

test('hubFootprintPassBudget gives up (0 passes) only once even a single pass would risk the hang budget', () => {
  // A single pass is still one full O(hubCount^2) sweep through the same
  // resolveNodeOverlap primitive declutterPassBudget (graph-declutter.ts)
  // uses, empirically measured (see that module's test file) to approach
  // the app's 2s hang budget around 8,000 nodes — so past
  // SINGLE_PASS_SAFE_NODE_COUNT this genuinely has no safe declutter left to
  // offer, same as the pre-existing behavior for an extreme node count.
  assert.equal(hubFootprintPassBudget(SINGLE_PASS_SAFE_NODE_COUNT + 1), 0);
  assert.equal(hubFootprintPassBudget(50000), 0);
});

test('packHubsOnGrid guarantees zero overlap for any hub count, unlike a bounded relaxation sweep', () => {
  // A PR review finding: no fixed pass count of the ITERATIVE declutter
  // actually GUARANTEES full separation — it only makes probabilistic
  // progress. A grid sidesteps convergence entirely: cell size clears the
  // single largest radius present, so any two hubs (adjacent cells or not)
  // are provably at least one cell apart on some axis. Checked with widely
  // varying radii (not just the uniform case) since the guarantee has to
  // hold for the largest hub in the set, not the average.
  const hubs = Array.from({ length: 50 }, (_, i) => ({
    id: `h${i}`,
    x: Math.random() * 1000,
    y: Math.random() * 1000,
    r: 10 + (i % 7) * 15, // 10..100, deliberately non-uniform
  }));
  const positions = packHubsOnGrid(hubs);
  assert.equal(positions.size, hubs.length);
  for (let i = 0; i < hubs.length; i += 1) {
    for (let j = i + 1; j < hubs.length; j += 1) {
      const a = positions.get(hubs[i].id)!;
      const b = positions.get(hubs[j].id)!;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      assert.ok(
        dist >= hubs[i].r + hubs[j].r,
        `hubs ${hubs[i].id} and ${hubs[j].id} overlap: dist=${dist}, radii sum=${hubs[i].r + hubs[j].r}`,
      );
    }
  }
});

test('packHubsOnGrid is deterministic regardless of input order', () => {
  const hubs = Array.from({ length: 10 }, (_, i) => ({ id: `h${i}`, x: i, y: i, r: 10 + i }));
  const shuffled = [...hubs].reverse();
  const a = packHubsOnGrid(hubs);
  const b = packHubsOnGrid(shuffled);
  for (const hub of hubs) {
    assert.deepEqual(a.get(hub.id), b.get(hub.id));
  }
});

test('placeBookmarkSatellites reproduces the review report\'s exact scenario with genuinely zero overlap', () => {
  // The reviewer's own fixture: 1,000 disjoint 4-bookmark hubs (5,000 total
  // nodes), which satisfies minSharedDegree=4. At 0 passes this left
  // 230,000+ overlaps; even a nonzero-but-bounded pass count left tens of
  // thousands. Above HUB_FOOTPRINT_FULL_QUALITY_HUB_COUNT this now uses the
  // grid's exact guarantee instead, so this must be genuinely 0, not just
  // "small".
  const HUB_COUNT = 300; // safely above the 200 full-quality ceiling, kept
  // modest so this test stays fast; the grid guarantee is independent of
  // hub count (see packHubsOnGrid's own test above for the harder-evidence
  // case with deliberately non-uniform radii).
  const bookmarks: Bookmark[] = [];
  const tags: Tag[] = [];
  const bookmarkTags: BookmarkTag[] = [];
  let counter = 0;
  for (let t = 0; t < HUB_COUNT; t += 1) {
    const tag = makeTag(`tag${t}`);
    tags.push(tag);
    for (let i = 0; i < 4; i += 1) {
      const bookmark = makeBookmark(`bk${counter}`);
      counter += 1;
      bookmarks.push(bookmark);
      bookmarkTags.push(link(bookmark.id, tag.id));
    }
  }
  const settled = settle({ bookmarks, tags, bookmarkTags, minSharedDegree: 4 });
  const result = placeBookmarkSatellites(settled, { bookmarkRadius: BOOKMARK_R, hubRadius });
  const overlaps = countOverlaps(result.nodes.map((node) => ({ x: node.x, y: node.y, r: radiusOf(node) })));
  assert.equal(overlaps, 0, `expected the grid-packed hub tier to leave zero overlap, got ${overlaps} pairs`);
});

test('packHubsOnGrid stays compact for a heterogeneous hub set, not inflated by the single largest one', () => {
  // A PR review finding: a uniform grid (one earlier version of this fix)
  // sized EVERY cell from the single largest hub present, so one popular
  // tag inflated the spacing of every small hub too. Reproduced with the
  // exact reported shape: one 331-bookmark hub + 200 four-bookmark hubs
  // (201 total). The uniform-grid version measured ~7,800-unit-wide bounds
  // for this; shelf packing should stay a small fraction of that, since
  // only the (single) row containing the big hub needs to be that wide.
  const bigFootprint = 265; // hubRadius(331) + ringOuterRadius(331, ...), see verify script
  const smallFootprint = 65; // hubRadius(4) + ringOuterRadius(4, ...)
  const hubs = [
    { id: 'big', x: 0, y: 0, r: bigFootprint },
    ...Array.from({ length: 200 }, (_, i) => ({ id: `small${i}`, x: 0, y: 0, r: smallFootprint })),
  ];
  const positions = packHubsOnGrid(hubs);

  let minX = Infinity;
  let maxX = -Infinity;
  for (const hub of hubs) {
    const pos = positions.get(hub.id)!;
    minX = Math.min(minX, pos.x - hub.r);
    maxX = Math.max(maxX, pos.x + hub.r);
  }
  const width = maxX - minX;
  // A uniform grid sized to the big hub would need columns=ceil(sqrt(201))=15
  // cells of ~(2*265+pad) each, ~7,950 units wide. Shelf packing should stay
  // well under half that.
  assert.ok(width < 4000, `expected shelf packing to stay compact, got width=${width}`);

  // Still fully non-overlapping despite the size disparity.
  for (let i = 0; i < hubs.length; i += 1) {
    for (let j = i + 1; j < hubs.length; j += 1) {
      const a = positions.get(hubs[i].id)!;
      const b = positions.get(hubs[j].id)!;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      assert.ok(dist >= hubs[i].r + hubs[j].r, `hubs ${hubs[i].id} and ${hubs[j].id} overlap`);
    }
  }
});

test('placeBookmarkSatellites falls back to the grid when hub count alone would look safe but footprints are too large to converge', () => {
  // A PR review finding: hub COUNT alone isn't a reliable predictor of
  // iterative convergence — the reviewer's own reported repro (200 hubs at
  // 20 bookmarks each) didn't reproduce residual overlap against the
  // CURRENT (smaller, since-retuned) hub-radius constants, so this uses a
  // more direct worst case instead: many VARIED-size hubs all starting at
  // the exact same coincident point (uniform-size coincident circles
  // converge cleanly via the tie-break logic; heterogeneous sizes don't —
  // verified directly against resolveNodeOverlap: 200 coincident circles
  // with degrees cycling 4..80 left 159 overlapping pairs after the full 24
  // passes, vs. 0 for 200 uniform-size ones). At exactly
  // HUB_FOOTPRINT_FULL_QUALITY_HUB_COUNT (200) this stays on the "should
  // get full quality" iterative path by count alone, so this exercises the
  // verify-then-fallback logic specifically, not the hub-count threshold.
  const HUB_COUNT = 200;
  const hubs = Array.from({ length: HUB_COUNT }, (_, i) => {
    const degree = 4 + (i % 20) * 4; // 4, 8, 12, ..., 80 -- varied footprints
    return {
      id: `t:tag${i}`,
      kind: 'tag' as const,
      tag_id: `tag${i}`,
      slug: `tag${i}`,
      label: `tag${i}`,
      degree,
      x: 0,
      y: 0, // all coincident — the hard case for pairwise relaxation
    };
  });
  const bookmarks: PositionedNode[] = [];
  const edges: SettledGraph['edges'] = [];
  hubs.forEach((hub, hubIndex) => {
    for (let i = 0; i < hub.degree; i += 1) {
      const id = `b:bk${hubIndex}_${i}`;
      bookmarks.push({ id, kind: 'bookmark', bookmark_id: `bk${hubIndex}_${i}`, label: id, degree: 1, x: 0, y: 0 });
      edges.push({ source: id, target: hub.id });
    }
  });
  const settled: SettledGraph = {
    nodes: [...hubs, ...bookmarks],
    edges,
    bounds: { min_x: 0, min_y: 0, max_x: 0, max_y: 0, width: 0, height: 0 },
  };
  const result = placeBookmarkSatellites(settled, { bookmarkRadius: BOOKMARK_R, hubRadius });
  const overlaps = countOverlaps(result.nodes.map((node) => ({ x: node.x, y: node.y, r: radiusOf(node) })));
  assert.equal(overlaps, 0, `expected the verify-then-fallback path to leave zero overlap, got ${overlaps} pairs`);
});
