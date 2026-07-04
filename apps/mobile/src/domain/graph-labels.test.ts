import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  maxLabelOffset,
  resolveHubLabels,
  type HubLabelInput,
  type LabelBox,
} from '@/domain/graph-labels';

const FONT = 24;

function boxesOverlap(a: LabelBox, b: LabelBox): boolean {
  return (
    a.min_x < b.max_x && a.max_x > b.min_x && a.min_y < b.max_y && a.max_y > b.min_y
  );
}

/** Distance from the resolved label's nearest edge to the hub's circle edge. */
function attachmentOffset(hub: HubLabelInput, placement: { position: string; box: LabelBox }): number {
  return placement.position === 'below'
    ? placement.box.min_y - (hub.y + hub.r)
    : hub.y - hub.r - placement.box.max_y;
}

test('a single hub keeps its default below position', () => {
  const hubs: HubLabelInput[] = [{ id: 't:a', x: 100, y: 50, r: 20, text: 'cooking', degree: 5 }];
  const [placement] = resolveHubLabels(hubs, FONT);

  assert.equal(placement.position, 'below');
  assert.equal(placement.x, 100);
  // Baseline == node.y + r + fontSize (unchanged from the fixed default).
  assert.equal(placement.y, 50 + 20 + FONT);
});

test('non-overlapping hubs all stay below at their defaults', () => {
  const hubs: HubLabelInput[] = [
    { id: 't:a', x: 0, y: 0, r: 18, text: 'a', degree: 3 },
    { id: 't:b', x: 500, y: 0, r: 18, text: 'b', degree: 2 },
  ];
  const placements = resolveHubLabels(hubs, FONT);

  for (const p of placements) {
    assert.equal(p.position, 'below');
    const hub = hubs.find((h) => h.id === p.id)!;
    assert.equal(p.y, hub.y + hub.r + FONT);
  }
});

test('overlapping default labels are decluttered to zero overlap', () => {
  // Three hubs clustered near the center: their default (all-below) label boxes
  // all overlap, so the declutter must flip/nudge them apart.
  const hubs: HubLabelInput[] = [
    { id: 't:cooking', x: 0, y: 0, r: 20, text: 'cooking', degree: 5 },
    { id: 't:reading', x: 30, y: 0, r: 20, text: 'reading', degree: 3 },
    { id: 't:travel', x: 60, y: 0, r: 20, text: 'travel', degree: 1 },
  ];
  const placements = resolveHubLabels(hubs, FONT);

  // No two resolved boxes overlap.
  for (let i = 0; i < placements.length; i += 1) {
    for (let j = i + 1; j < placements.length; j += 1) {
      assert.equal(
        boxesOverlap(placements[i].box, placements[j].box),
        false,
        `resolved labels ${placements[i].id} and ${placements[j].id} still overlap`,
      );
    }
  }

  // The highest-degree hub keeps its default below position.
  const cooking = placements.find((p) => p.id === 't:cooking')!;
  assert.equal(cooking.position, 'below');
  assert.equal(cooking.y, 0 + 20 + FONT);
});

test('every resolved label stays attached (within the bounded max offset)', () => {
  const hubs: HubLabelInput[] = [
    { id: 't:cooking', x: 0, y: 0, r: 20, text: 'cooking', degree: 5 },
    { id: 't:reading', x: 30, y: 0, r: 20, text: 'reading', degree: 3 },
    { id: 't:travel', x: 60, y: 0, r: 20, text: 'travel', degree: 1 },
  ];
  const placements = resolveHubLabels(hubs, FONT);

  for (const p of placements) {
    const hub = hubs.find((h) => h.id === p.id)!;
    const offset = attachmentOffset(hub, p);
    assert.ok(offset >= 0, `label ${p.id} overlaps its own hub`);
    assert.ok(
      offset <= maxLabelOffset(FONT) + 1e-9,
      `label ${p.id} drifted ${offset} beyond the ${maxLabelOffset(FONT)} cap`,
    );
  }
});

test('deterministic: identical input yields identical output', () => {
  const hubs: HubLabelInput[] = [
    { id: 't:cooking', x: 0, y: 0, r: 20, text: 'cooking', degree: 5 },
    { id: 't:reading', x: 30, y: 0, r: 20, text: 'reading', degree: 3 },
    { id: 't:travel', x: 60, y: 0, r: 20, text: 'travel', degree: 1 },
  ];
  const a = resolveHubLabels(hubs, FONT);
  const b = resolveHubLabels(hubs, FONT);
  assert.deepEqual(a, b);
});

test('input order does not matter: reversed input yields identical output', () => {
  const hubs: HubLabelInput[] = [
    { id: 't:cooking', x: 0, y: 0, r: 20, text: 'cooking', degree: 5 },
    { id: 't:reading', x: 30, y: 0, r: 20, text: 'reading', degree: 3 },
    { id: 't:travel', x: 60, y: 0, r: 20, text: 'travel', degree: 1 },
  ];
  // The stable priority sort (descending degree, then id) makes the result
  // independent of the order the hubs arrive in.
  const normal = resolveHubLabels(hubs, FONT);
  const reversed = resolveHubLabels([...hubs].reverse(), FONT);
  assert.deepEqual(reversed, normal);
});
