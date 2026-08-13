import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  declutterPassBudget,
  resolveNodeOverlap,
  type OverlapNode,
} from '@/domain/graph-declutter';

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

test('non-overlapping circles are left untouched', () => {
  const nodes: OverlapNode[] = [
    { id: 'a', x: 0, y: 0, r: 10 },
    { id: 'b', x: 100, y: 0, r: 10 },
  ];
  const resolved = resolveNodeOverlap(nodes);
  assert.deepEqual(resolved.get('a'), { x: 0, y: 0 });
  assert.deepEqual(resolved.get('b'), { x: 100, y: 0 });
});

test('two overlapping circles are pushed apart until their circles clear', () => {
  const nodes: OverlapNode[] = [
    { id: 'a', x: 0, y: 0, r: 10 },
    { id: 'b', x: 5, y: 0, r: 10 },
  ];
  const resolved = resolveNodeOverlap(nodes);
  const a = resolved.get('a')!;
  const b = resolved.get('b')!;
  // Circles no longer overlap: center distance clears the sum of radii.
  assert.ok(distance(a, b) >= 20);
  // The correction is symmetric around the original midpoint (2.5, 0).
  assert.ok(Math.abs((a.x + b.x) / 2 - 2.5) < 1e-9);
});

test('exactly-coincident circles separate deterministically, not randomly', () => {
  const nodes: OverlapNode[] = [
    { id: 'a', x: 50, y: 50, r: 8 },
    { id: 'b', x: 50, y: 50, r: 8 },
  ];
  const first = resolveNodeOverlap(nodes);
  const second = resolveNodeOverlap(nodes);
  assert.deepEqual(first.get('a'), second.get('a'));
  assert.deepEqual(first.get('b'), second.get('b'));
  assert.ok(distance(first.get('a')!, first.get('b')!) >= 16);
});

test('a dense cluster converges to (near) zero pairwise overlap after passes', () => {
  // 30 small circles packed inside a radius far too small for them to fit
  // without overlapping at their original positions — reproduces the
  // "bookmark nodes clustered around a busy tag hub" hairball shape.
  const nodes: OverlapNode[] = Array.from({ length: 30 }, (_, i) => {
    const angle = (i / 30) * Math.PI * 2;
    const r = 10 * Math.sqrt(i / 30);
    return { id: `n${i}`, x: Math.cos(angle) * r, y: Math.sin(angle) * r, r: 9 };
  });

  const resolved = resolveNodeOverlap(nodes, 8);
  let overlapping = 0;
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = resolved.get(nodes[i].id)!;
      const b = resolved.get(nodes[j].id)!;
      if (distance(a, b) < nodes[i].r + nodes[j].r) {
        overlapping += 1;
      }
    }
  }
  // Started as a fully-collapsed cluster (every pair overlapping); after
  // relaxation only a small residual (if any) remains.
  assert.ok(overlapping < 5, `expected the cluster to mostly untangle, got ${overlapping} overlapping pairs`);
});

test('is deterministic: repeated calls on the same input yield identical output', () => {
  const nodes: OverlapNode[] = Array.from({ length: 12 }, (_, i) => ({
    id: `n${i}`,
    x: (i % 4) * 3,
    y: Math.floor(i / 4) * 3,
    r: 6,
  }));
  const first = resolveNodeOverlap(nodes);
  const second = resolveNodeOverlap(nodes);
  for (const node of nodes) {
    assert.deepEqual(first.get(node.id), second.get(node.id));
  }
});

test('zero or one node is a no-op', () => {
  assert.equal(resolveNodeOverlap([]).size, 0);
  const single = resolveNodeOverlap([{ id: 'only', x: 3, y: 4, r: 5 }]);
  assert.deepEqual(single.get('only'), { x: 3, y: 4 });
});

test('passes=0 returns original positions unchanged', () => {
  const nodes: OverlapNode[] = [
    { id: 'a', x: 0, y: 0, r: 10 },
    { id: 'b', x: 5, y: 0, r: 10 },
  ];
  const resolved = resolveNodeOverlap(nodes, 0);
  assert.deepEqual(resolved.get('a'), { x: 0, y: 0 });
  assert.deepEqual(resolved.get('b'), { x: 5, y: 0 });
});

test('declutterPassBudget gives full quality well under the production node-count ceiling', () => {
  assert.equal(declutterPassBudget(0), 4);
  assert.equal(declutterPassBudget(1), 4);
  // The largest real graph seen in production (~770 nodes) still gets full passes.
  assert.equal(declutterPassBudget(770), 4);
  assert.equal(declutterPassBudget(1200), 4);
});

test('declutterPassBudget tapers down, then skips, for very large graphs', () => {
  const at2000 = declutterPassBudget(2000);
  const at3000 = declutterPassBudget(3000);
  assert.ok(at2000 < 4);
  assert.ok(at2000 >= 0);
  assert.ok(at3000 <= at2000);
  assert.equal(declutterPassBudget(50000), 0);
});
