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
import { placeBookmarkSatellites } from '@/domain/graph-satellite-layout';
import type { Bookmark, BookmarkTag, Tag } from '@/domain/types';

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
  const bookmarks: Bookmark[] = [];
  const bookmarkTags: BookmarkTag[] = [];
  const tagDegrees = [331, 263, 223, 83, 73, 68, 42, 35, 34, 32, 21, 21, 21, 21, 20];
  let counter = 0;
  const nextBookmark = () => {
    const id = `bk${counter}`;
    counter += 1;
    const bookmark = makeBookmark(id);
    bookmarks.push(bookmark);
    return bookmark;
  };
  const tags: Tag[] = [];
  tagDegrees.forEach((degree, tagIndex) => {
    const tag = makeTag(`tag${tagIndex}`);
    tags.push(tag);
    for (let i = 0; i < degree; i += 1) {
      const bookmark = nextBookmark();
      bookmarkTags.push(link(bookmark.id, tag.id));
    }
  });
  // A long tail of small tags (2-3 each) padding the library out to ~1,035
  // bookmarks total, mirroring the real library's overall size.
  let tailTagIndex = tagDegrees.length;
  while (counter < 1035) {
    const tag = makeTag(`tag${tailTagIndex}`);
    tags.push(tag);
    tailTagIndex += 1;
    const groupSize = Math.min(2, 1035 - counter);
    for (let i = 0; i < groupSize; i += 1) {
      const bookmark = nextBookmark();
      bookmarkTags.push(link(bookmark.id, tag.id));
    }
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
  // Sanity: this reproduces the real reported scale.
  assert.ok(settled.nodes.length > 700, `expected a large graph, got ${settled.nodes.length} nodes`);

  const beforeCircles = settled.nodes.map((node) => ({ x: node.x, y: node.y, r: radiusOf(node) }));
  const before = countOverlaps(beforeCircles);
  // The raw force settle at this scale is genuinely a hairball (this is the
  // bug being fixed, asserted here so a future change can't silently regress
  // the fixture into a case that was never actually reproducing the report).
  assert.ok(before > 500, `expected the raw settle to reproduce heavy overlap, got ${before} pairs`);

  const result = placeBookmarkSatellites(settled, { bookmarkRadius: BOOKMARK_R, hubRadius });
  const afterCircles = result.nodes.map((node) => ({ x: node.x, y: node.y, r: radiusOf(node) }));
  const after = countOverlaps(afterCircles);
  // Not a full guarantee across DIFFERENT hubs' rings (only within a hub's
  // own group is overlap mathematically impossible), but the footprint
  // declutter step should leave only a small residual, not thousands.
  assert.ok(after < 50, `expected the declutter+spiral pipeline to resolve nearly all overlap, got ${after} pairs (was ${before})`);

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
