import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  TAG_CLOUD_MAX_FONT,
  TAG_CLOUD_MIN_FONT,
  buildTagCloud,
  tagCloudFontSize,
} from './tag-cloud.ts';

test('buildTagCloud ranks by frequency (desc) then name (asc)', () => {
  const cloud = buildTagCloud([
    { id: 'a', name: 'react', count: 1 },
    { id: 'b', name: 'design', count: 3 },
    { id: 'c', name: 'apis', count: 3 },
  ]);
  assert.deepEqual(
    cloud.map((entry) => entry.name),
    ['apis', 'design', 'react'],
  );
});

test('buildTagCloud normalizes counts into a 0..1 weight', () => {
  const cloud = buildTagCloud([
    { id: 'a', name: 'low', count: 1 },
    { id: 'b', name: 'mid', count: 3 },
    { id: 'c', name: 'high', count: 5 },
  ]);
  const byId = new Map(cloud.map((entry) => [entry.id, entry.weight]));
  assert.equal(byId.get('a'), 0);
  assert.equal(byId.get('b'), 0.5);
  assert.equal(byId.get('c'), 1);
});

test('buildTagCloud weights singletons/ties at 1 (largest)', () => {
  const cloud = buildTagCloud([
    { id: 'a', name: 'one', count: 2 },
    { id: 'b', name: 'two', count: 2 },
  ]);
  assert.ok(cloud.every((entry) => entry.weight === 1));
});

test('buildTagCloud drops blank names and non-positive counts, trimming the rest', () => {
  const cloud = buildTagCloud([
    { id: 'a', name: '   ', count: 4 },
    { id: 'b', name: '', count: 2 },
    { id: 'c', name: 'kept', count: 0 },
    { id: 'd', name: '  cooking ', count: 1 },
  ]);
  assert.deepEqual(
    cloud.map((entry) => entry.name),
    ['cooking'],
  );
});

test('buildTagCloud returns an empty cloud when there are no usable tags', () => {
  assert.deepEqual(buildTagCloud([]), []);
  assert.deepEqual(buildTagCloud([{ id: 'a', name: ' ', count: 3 }]), []);
});

test('tagCloudFontSize maps weight into the font bounds and clamps', () => {
  assert.equal(tagCloudFontSize(0), TAG_CLOUD_MIN_FONT);
  assert.equal(tagCloudFontSize(1), TAG_CLOUD_MAX_FONT);
  assert.equal(tagCloudFontSize(-1), TAG_CLOUD_MIN_FONT);
  assert.equal(tagCloudFontSize(2), TAG_CLOUD_MAX_FONT);
  const mid = tagCloudFontSize(0.5);
  assert.ok(mid > TAG_CLOUD_MIN_FONT && mid < TAG_CLOUD_MAX_FONT);
});
