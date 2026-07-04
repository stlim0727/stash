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

function boxWidth(box: LabelBox): number {
  return box.max_x - box.min_x;
}

test('a 2-char Korean tag is measured ~2 ems wide, not ~1.3 ems', () => {
  // "여행" (travel) is two full-width Hangul syllables → ~2 ems. The old flat
  // Latin factor (2 * 0.65 = 1.3 ems) badly under-measures it.
  const [placement] = resolveHubLabels(
    [{ id: 't:travel', x: 0, y: 0, r: 20, text: '여행', degree: 5 }],
    FONT,
  );
  const width = boxWidth(placement.box);
  // Wide glyphs counted wide: ~2 ems, and well clear of the old 1.3-em estimate.
  assert.equal(width, 2 * FONT);
  assert.ok(width > 1.5 * FONT, `Korean label width ${width} was measured too narrow`);
});

test('nearby Korean hub labels the old flat factor missed now declutter', () => {
  // Centers 35 units apart. Under the OLD flat 0.65-em model each 2-char Korean
  // box is only 2*24*0.65 = 31.2 wide (half 15.6): box A x[-15.6,15.6],
  // box B x[19.4,50.6] → NO x-overlap, so the old code leaves BOTH below and the
  // real (full-width) glyphs visibly collide. Under the per-glyph model each box
  // is 2*24 = 48 wide (half 24): A x[-24,24], B x[11,59] → they overlap, so the
  // declutter must move one off the default below row.
  const hubs: HubLabelInput[] = [
    { id: 't:여행', x: 0, y: 0, r: 20, text: '여행', degree: 5 },
    { id: 't:투자', x: 35, y: 0, r: 20, text: '투자', degree: 3 },
  ];
  const placements = resolveHubLabels(hubs, FONT);
  const byId = new Map(placements.map((p) => [p.id, p]));

  // The regression the old flat factor produced: BOTH labels below. The fix must
  // move the lower-priority one (this assertion fails against the old code).
  const positions = placements.map((p) => p.position);
  assert.ok(
    positions.some((pos) => pos !== 'below'),
    'both Korean labels stayed below — overlap not resolved (old flat-factor regression)',
  );
  // Busiest hub keeps below; the other flips above.
  assert.equal(byId.get('t:여행')!.position, 'below');
  assert.equal(byId.get('t:투자')!.position, 'above');
  // Resolved boxes no longer overlap.
  assert.equal(boxesOverlap(byId.get('t:여행')!.box, byId.get('t:투자')!.box), false);
});

test('Latin-only labels keep the narrow factor (unchanged width)', () => {
  const [placement] = resolveHubLabels(
    [{ id: 't:cooking', x: 0, y: 0, r: 20, text: 'cooking', degree: 5 }],
    FONT,
  );
  // 7 narrow glyphs at 0.65 em each.
  assert.equal(boxWidth(placement.box), 7 * 0.65 * FONT);
});
