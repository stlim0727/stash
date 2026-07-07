// Self-test for the scorer. Run: node --test scripts/tag-merge-eval/score.test.mjs
// Validates the metrics against the real fixtures without any model call.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { score, passesGate } from './score.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const gt = JSON.parse(readFileSync(join(here, 'fixtures/totohero-ground-truth.json'), 'utf8'));
const vocabNames = JSON.parse(readFileSync(join(here, 'fixtures/totohero-vocab.json'), 'utf8')).tags.map((t) => t.name);

// The ground truth expressed as a model would return it: each group's tags.
const perfect = gt.groups.map((g) => [g.canonical, ...g.members]);

test('perfect grouping = precision 1, recall 1, 0 forbidden, passes gate, full restraint', () => {
  const s = score(perfect, gt, vocabNames);
  assert.equal(s.mergePrecision, 1);
  assert.equal(s.mergeRecall, 1);
  assert.equal(s.forbiddenCount, 0);
  assert.equal(s.restraint.overMergedTags, 0);
  assert.ok(passesGate(s));
});

test('a forbidden merge (접영 + backstroke) is caught and fails the gate', () => {
  const bad = perfect.map((g) => (g[0] === '접영' ? [...g, 'backstroke'] : g));
  const s = score(bad, gt, vocabNames);
  assert.ok(s.forbiddenCount >= 1);
  assert.ok(s.forbiddenViolations.some(([a, b]) => (a === '접영' && b === 'backstroke') || (a === 'backstroke' && b === '접영')));
  assert.ok(s.mergePrecision < 1); // backstroke paired with 접영/접영 킥/… are wrong pairs
  assert.equal(passesGate(s), false);
});

test('merging two distinct singletons (busan + okinawa) drops precision and trips the hard negative', () => {
  const s = score([...perfect, ['busan', 'okinawa']], gt, vocabNames);
  assert.ok(s.forbiddenCount >= 1);
  assert.equal(passesGate(s), false);
});

test('under-merging (dropping some 수영 members) lowers recall but keeps precision 1', () => {
  const partial = perfect.map((g) => (g[0] === '수영' ? g.slice(0, 3) : g));
  const s = score(partial, gt, vocabNames);
  assert.equal(s.mergePrecision, 1);
  assert.ok(s.mergeRecall < 1);
  assert.ok(passesGate(s)); // precision-first: leaving merges on the table still passes
});

test('empty output = no merges = vacuous precision 1 but recall 0', () => {
  const s = score([], gt, vocabNames);
  assert.equal(s.mergePrecision, 1);
  assert.equal(s.mergeRecall, 0);
  assert.equal(s.forbiddenCount, 0);
});
