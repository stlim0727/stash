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
import { resolveHubLabels } from '@/domain/graph-labels';
import {
  hubFootprintPassBudget,
  placeBookmarkSatellites,
  ringOuterRadius,
} from '@/domain/graph-satellite-layout';
import type { Bookmark, BookmarkTag, Tag } from '@/domain/types';

const HUB_LABEL_SIZE = 24; // matches app/graph.tsx's LABEL_SIZE

const NOW = '2026-06-12T00:00:00.000Z';
const BOOKMARK_R = 9;
const HUB_MIN_R = 18;
const HUB_MAX_R = 54;

function hubRadius(degree: number): number {
  return Math.min(HUB_MAX_R, Math.max(HUB_MIN_R, HUB_MIN_R + 10 * Math.sqrt(degree)));
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
  // within a hub's own group is overlap impossible by construction) — a
  // small residual can remain here even with a correct footprint (the
  // label-avoidance skip nudges a few close-in members to a later index,
  // which is exactly the kind of small cross-hub interaction the final
  // whole-graph safety-net pass in app/graph.tsx's declutterSettledGraph
  // exists to mop up, so this assertion covers `placeBookmarkSatellites`
  // ALONE, not the full production pipeline. The footprint-radius formula
  // itself is covered precisely and separately by the `ringOuterRadius`
  // test below (checked to fail without that fix, pass with it) — this is
  // an integration-level sanity bound, not a substitute for that.
  assert.ok(after < 10, `expected the declutter+spiral pipeline to resolve nearly all overlap, got ${after} pairs (was ${before})`);

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

test('hubFootprintPassBudget tapers down for a pathologically tag-diverse library', () => {
  // minSharedDegree only bounds how many bookmarks a tag needs (>=4), not how
  // many DISTINCT tags can each clear that bar — a tag-diverse library could
  // produce thousands of hub nodes, and the budget must not stay flat there.
  const at1000 = hubFootprintPassBudget(1000);
  const at5000 = hubFootprintPassBudget(5000);
  assert.ok(at1000 < 24);
  assert.ok(at1000 >= 0);
  assert.ok(at5000 <= at1000);
  assert.equal(hubFootprintPassBudget(50000), 0);
});

test('reproduces the review report: an 8-bookmark "cooking" hub keeps every satellite out of its own label box', () => {
  // The exact scenario from the PR review: hub labels render AFTER node
  // circles (app/graph.tsx's svgChildren), so a satellite whose position
  // falls inside the hub's resolved label box is painted over even though
  // no circle-to-circle overlap is detected. Uses the REAL resolveHubLabels
  // (not a reimplementation) so this exercises the actual box the app
  // renders.
  const bookmarks = Array.from({ length: 8 }, (_, i) => makeBookmark(`bk${i}`));
  const tag = makeTag('cooking');
  const bookmarkTags = bookmarks.map((b) => link(b.id, tag.id));
  const settled = settle({ bookmarks, tags: [tag], bookmarkTags, minSharedDegree: 1 });
  const result = placeBookmarkSatellites(settled, {
    bookmarkRadius: BOOKMARK_R,
    hubRadius,
    hubLabelSize: HUB_LABEL_SIZE,
  });

  const hub = result.nodes.find((n) => n.kind === 'tag')!;
  const [placement] = resolveHubLabels(
    [{ id: hub.id, x: hub.x, y: hub.y, r: hubRadius(hub.degree), text: 'cooking', degree: hub.degree }],
    HUB_LABEL_SIZE,
  );

  for (const node of result.nodes.filter((n) => n.kind === 'bookmark')) {
    const circleIntersectsLabelBox =
      node.x + BOOKMARK_R > placement.box.min_x &&
      node.x - BOOKMARK_R < placement.box.max_x &&
      node.y + BOOKMARK_R > placement.box.min_y &&
      node.y - BOOKMARK_R < placement.box.max_y;
    assert.ok(
      !circleIntersectsLabelBox,
      `bookmark ${node.bookmark_id} at (${node.x}, ${node.y}) intersects the hub's label box`,
    );
  }
});
