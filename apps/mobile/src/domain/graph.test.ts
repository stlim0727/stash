import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  UNTAGGED_HUB_ID,
  buildSettledGraph,
  deriveGraph,
  layoutGraph,
  layoutTickBudget,
  type DeriveGraphInput,
  type GraphNode,
  type PositionedNode,
} from '@/domain/graph';
import type { Bookmark, BookmarkTag, Tag } from '@/domain/types';

const NOW = '2026-07-04T00:00:00.000Z';

function makeBookmark(id: string, overrides: Partial<Bookmark> = {}): Bookmark {
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
    ...overrides,
  };
}

function makeTag(id: string, slug = id): Tag {
  return {
    id,
    user_id: 'u1',
    name: slug,
    slug,
    source: 'user',
    created_at: NOW,
  };
}

function link(bookmark_id: string, tag_id: string): BookmarkTag {
  return { bookmark_id, tag_id, source: 'user', confidence: null, created_at: NOW };
}

/** A ~12-item fixture: bookmarks, some shared tags, one untagged. */
function smallFixture(): DeriveGraphInput {
  const bookmarks = Array.from({ length: 12 }, (_, i) => makeBookmark(`bk${i}`));
  const tags = [makeTag('design'), makeTag('read'), makeTag('code')];
  const bookmarkTags: BookmarkTag[] = [
    link('bk0', 'design'),
    link('bk1', 'design'),
    link('bk2', 'design'),
    link('bk3', 'read'),
    link('bk4', 'read'),
    link('bk5', 'code'),
    link('bk6', 'code'),
    link('bk7', 'code'),
    link('bk8', 'design'),
    link('bk8', 'read'), // multi-tag bookmark
    link('bk9', 'read'),
    link('bk10', 'code'),
    // bk11 has no tags -> untagged hub
  ];
  return { bookmarks, tags, bookmarkTags };
}

function tagTargetKinds(input: DeriveGraphInput): Map<string, GraphNode['kind']> {
  const graph = deriveGraph(input);
  return new Map(graph.nodes.map((node) => [node.id, node.kind]));
}

test('bipartite: every edge is bookmark -> tag/hub, never bookmark-bookmark or tag-tag', () => {
  const graph = deriveGraph(smallFixture());
  const kindById = new Map(graph.nodes.map((n) => [n.id, n.kind]));
  for (const edge of graph.edges) {
    assert.equal(kindById.get(edge.source), 'bookmark', `source ${edge.source} must be a bookmark`);
    const targetKind = kindById.get(edge.target);
    assert.ok(
      targetKind === 'tag' || targetKind === 'untagged-hub',
      `target ${edge.target} must be a tag/hub, got ${targetKind}`,
    );
  }
});

test('edge count is O(links): one edge per active tag-link + one per untagged bookmark', () => {
  const input = smallFixture();
  const graph = deriveGraph(input);
  // 12 real links above + 1 untagged bookmark = 13 edges.
  assert.equal(graph.edges.length, 13);
});

test('untagged bookmarks connect to a single synthetic hub node', () => {
  const graph = deriveGraph(smallFixture());
  const hubs = graph.nodes.filter((n) => n.kind === 'untagged-hub');
  assert.equal(hubs.length, 1);
  assert.equal(hubs[0].id, UNTAGGED_HUB_ID);
  assert.equal(hubs[0].degree, 1); // only bk11
  const hubEdges = graph.edges.filter((e) => e.target === UNTAGGED_HUB_ID);
  assert.equal(hubEdges.length, 1);
  assert.equal(hubEdges[0].source, 'b:bk11');
});

test('tag hub degree equals its active bookmark count', () => {
  const graph = deriveGraph(smallFixture());
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const design = byId.get('t:design');
  assert.ok(design && design.kind === 'tag');
  assert.equal(design.degree, 4); // bk0, bk1, bk2, bk8
  assert.equal((byId.get('t:read') as GraphNode).degree, 4); // bk3, bk4, bk8, bk9
  assert.equal((byId.get('t:code') as GraphNode).degree, 4); // bk5, bk6, bk7, bk10
});

test('tag node exposes slug + tag_id, bookmark node exposes bookmark_id', () => {
  const graph = deriveGraph(smallFixture());
  const tag = graph.nodes.find((n) => n.id === 't:design');
  assert.ok(tag && tag.kind === 'tag');
  assert.equal(tag.slug, 'design');
  assert.equal(tag.tag_id, 'design');
  const bk = graph.nodes.find((n) => n.id === 'b:bk0');
  assert.ok(bk && bk.kind === 'bookmark');
  assert.equal(bk.bookmark_id, 'bk0');
});

test('trashed and archived bookmarks are excluded (Inbox filter)', () => {
  const input: DeriveGraphInput = {
    bookmarks: [
      makeBookmark('active'),
      makeBookmark('trashed', { deleted_at: NOW }),
      makeBookmark('archived', { is_archived: true }),
    ],
    tags: [makeTag('t')],
    bookmarkTags: [link('active', 't'), link('trashed', 't'), link('archived', 't')],
  };
  const graph = deriveGraph(input);
  const bookmarkNodes = graph.nodes.filter((n) => n.kind === 'bookmark');
  assert.equal(bookmarkNodes.length, 1);
  assert.equal((bookmarkNodes[0] as GraphNode & { bookmark_id: string }).bookmark_id, 'active');
  // The tag keeps only the active link.
  const tag = graph.nodes.find((n) => n.id === 't:t');
  assert.equal((tag as GraphNode).degree, 1);
});

test('isolated tags (no active links) do not become floating nodes', () => {
  const input: DeriveGraphInput = {
    bookmarks: [makeBookmark('bk0')],
    tags: [makeTag('used'), makeTag('orphan')],
    bookmarkTags: [link('bk0', 'used')],
  };
  const graph = deriveGraph(input);
  assert.ok(graph.nodes.some((n) => n.id === 't:used'));
  assert.ok(!graph.nodes.some((n) => n.id === 't:orphan'));
});

test('links to non-existent tags are ignored', () => {
  const input: DeriveGraphInput = {
    bookmarks: [makeBookmark('bk0')],
    tags: [],
    bookmarkTags: [link('bk0', 'ghost')],
  };
  const graph = deriveGraph(input);
  // No real tag -> bookmark counts as untagged.
  assert.ok(graph.nodes.some((n) => n.id === UNTAGGED_HUB_ID));
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].target, UNTAGGED_HUB_ID);
});

test('duplicate links collapse to one edge', () => {
  const input: DeriveGraphInput = {
    bookmarks: [makeBookmark('bk0')],
    tags: [makeTag('t')],
    bookmarkTags: [link('bk0', 't'), link('bk0', 't')],
  };
  const graph = deriveGraph(input);
  assert.equal(graph.edges.length, 1);
  assert.equal((graph.nodes.find((n) => n.id === 't:t') as GraphNode).degree, 1);
});

test('empty input does not throw and returns an empty settled graph', () => {
  const empty: DeriveGraphInput = { bookmarks: [], tags: [], bookmarkTags: [] };
  const graph = deriveGraph(empty);
  assert.equal(graph.nodes.length, 0);
  assert.equal(graph.edges.length, 0);
  const settled = layoutGraph(graph);
  assert.equal(settled.nodes.length, 0);
  assert.deepEqual(settled.bounds, {
    min_x: 0,
    min_y: 0,
    max_x: 0,
    max_y: 0,
    width: 0,
    height: 0,
  });
});

test('zero-tags case: all bookmarks land under the untagged hub', () => {
  const input: DeriveGraphInput = {
    bookmarks: [makeBookmark('a'), makeBookmark('b')],
    tags: [],
    bookmarkTags: [],
  };
  const graph = deriveGraph(input);
  assert.equal(graph.edges.length, 2);
  assert.ok(graph.edges.every((e) => e.target === UNTAGGED_HUB_ID));
  const settled = layoutGraph(graph);
  assert.ok(settled.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)));
});

test('layout produces finite, bounded positions for the small fixture', () => {
  const settled = buildSettledGraph(smallFixture());
  for (const node of settled.nodes) {
    assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y));
    assert.ok(node.x >= settled.bounds.min_x && node.x <= settled.bounds.max_x);
    assert.ok(node.y >= settled.bounds.min_y && node.y <= settled.bounds.max_y);
  }
  assert.ok(settled.bounds.width >= 0 && settled.bounds.height >= 0);
});

test('layout is deterministic: same input -> identical positions', () => {
  const input = smallFixture();
  const a = buildSettledGraph(input);
  const b = buildSettledGraph(input);
  const pos = (g: typeof a) => g.nodes.map((n: PositionedNode) => [n.id, n.x, n.y]);
  assert.deepEqual(pos(a), pos(b));
  assert.deepEqual(a.bounds, b.bounds);
});

test('mass-weighting (ablation) pulls the high-degree tag closer to the centroid', () => {
  // Real ablation: settle the SAME graph twice — once with production
  // mass-weighting (default massK) and once with it OFF (massK: 0) — everything
  // else (seed, ticks, input) identical, so the mass term is the only variable.
  //
  // Balanced fixture: one popular tag (8 bookmarks) and two symmetric minor
  // tags (6 each). Symmetry keeps the unweighted centroid from being pinned on
  // the popular cluster by topology alone, so any centering must come from mass.
  const bookmarks: Bookmark[] = [];
  const bookmarkTags: BookmarkTag[] = [];
  const tags = [makeTag('popular'), makeTag('minor0'), makeTag('minor1')];
  let idc = 0;
  const addCluster = (tagId: string, count: number) => {
    for (let i = 0; i < count; i += 1) {
      const id = `bk${idc++}`;
      bookmarks.push(makeBookmark(id));
      bookmarkTags.push(link(id, tagId));
    }
  };
  addCluster('popular', 8);
  addCluster('minor0', 6);
  addCluster('minor1', 6);
  const input: DeriveGraphInput = { bookmarks, tags, bookmarkTags };

  const distToPopular = (settled: ReturnType<typeof buildSettledGraph>) => {
    const cx = settled.nodes.reduce((s, n) => s + n.x, 0) / settled.nodes.length;
    const cy = settled.nodes.reduce((s, n) => s + n.y, 0) / settled.nodes.length;
    const node = settled.nodes.find((n) => n.id === 't:popular')!;
    return Math.hypot(node.x - cx, node.y - cy);
  };

  const massOn = distToPopular(buildSettledGraph(input));
  const massOff = distToPopular(buildSettledGraph(input, { massK: 0 }));
  assert.ok(
    massOn < massOff,
    `mass-weighting must move the popular tag closer to the centroid: on=${massOn} off=${massOff}`,
  );
});

test('different seeds produce different layouts', () => {
  const graph = deriveGraph(smallFixture());
  const a = layoutGraph(graph, { seed: 1 });
  const b = layoutGraph(graph, { seed: 2 });
  const differs = a.nodes.some((n, i) => n.x !== b.nodes[i].x || n.y !== b.nodes[i].y);
  assert.ok(differs);
});

test('synthetic ~400-bookmark graph settles to finite, bounded positions', () => {
  const bookmarks: Bookmark[] = [];
  const bookmarkTags: BookmarkTag[] = [];
  const tags = Array.from({ length: 20 }, (_, i) => makeTag(`tag${i}`));
  for (let i = 0; i < 400; i += 1) {
    const id = `bk${i}`;
    bookmarks.push(makeBookmark(id));
    if (i % 10 !== 0) {
      // ~90% tagged; spread across tags, some multi-tag.
      bookmarkTags.push(link(id, `tag${i % 20}`));
      if (i % 3 === 0) {
        bookmarkTags.push(link(id, `tag${(i + 7) % 20}`));
      }
    }
  }
  const input: DeriveGraphInput = { bookmarks, tags, bookmarkTags };
  const graph = deriveGraph(input);
  // 400 bookmarks + 20 tags + 1 untagged hub = 421 nodes.
  assert.equal(graph.nodes.length, 421);
  // Use the exact shipped budget the /graph screen runs (test == prod).
  const ticks = layoutTickBudget(graph.nodes.length);
  assert.ok(ticks < 300, 'a 421-node graph must be scaled below the full budget');
  const settled = layoutGraph(graph, { ticks });
  assert.equal(settled.nodes.length, 421);
  for (const node of settled.nodes) {
    assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y));
  }
  assert.ok(Number.isFinite(settled.bounds.width) && settled.bounds.width > 0);
});

test('layoutTickBudget: full budget for small graphs, scaled down for large ones', () => {
  // Tiny graphs get the full-quality settle.
  assert.equal(layoutTickBudget(12), 300);
  assert.equal(layoutTickBudget(50), 300);
  // Large graphs strictly fewer, never below the floor.
  const large = layoutTickBudget(400);
  assert.ok(large < 300, 'a 400-node graph must run fewer ticks');
  assert.ok(large >= 60, 'never below the min floor');
  assert.equal(layoutTickBudget(1000), 60);
  // Monotonic: more nodes never means more ticks.
  assert.ok(layoutTickBudget(1000) <= layoutTickBudget(400));
  // Deterministic: same input -> same number.
  assert.equal(layoutTickBudget(400), layoutTickBudget(400));
  // Safe at degenerate node counts (no divide-by-zero).
  assert.equal(layoutTickBudget(0), 300);
  assert.equal(layoutTickBudget(1), 300);
});
