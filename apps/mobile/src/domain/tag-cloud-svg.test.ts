import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildTagCloud, type TagCount } from './tag-cloud.ts';
import { renderTagCloudSvg } from './tag-cloud-svg.ts';

// A richer-than-seed sample so the emitted example looks like a real cloud
// (the first-run mock data only carries a few tags).
const SAMPLE: TagCount[] = [
  { id: '1', name: 'design', count: 18 },
  { id: '2', name: 'react', count: 15 },
  { id: '3', name: 'typescript', count: 13 },
  { id: '4', name: 'reading', count: 12 },
  { id: '5', name: 'local-first', count: 11 },
  { id: '6', name: 'productivity', count: 9 },
  { id: '7', name: 'ai', count: 8 },
  { id: '8', name: 'css', count: 7 },
  { id: '9', name: 'tools', count: 6 },
  { id: '10', name: 'mobile', count: 6 },
  { id: '11', name: 'database', count: 5 },
  { id: '12', name: 'recipes', count: 4 },
  { id: '13', name: 'travel', count: 4 },
  { id: '14', name: 'finance', count: 3 },
  { id: '15', name: 'music', count: 3 },
  { id: '16', name: 'security', count: 2 },
  { id: '17', name: 'docs', count: 2 },
  { id: '18', name: 'inspiration', count: 2 },
  { id: '19', name: 'shopping', count: 1 },
  { id: '20', name: 'misc', count: 1 },
];

test('renderTagCloudSvg emits a well-formed svg containing every tag', () => {
  const cloud = buildTagCloud(SAMPLE);
  const svg = renderTagCloudSvg(cloud);

  assert.match(svg, /^<svg /);
  assert.match(svg, /<\/svg>$/);
  // One <text> element per tag, each carrying its "#name".
  assert.equal(svg.match(/<text /g)?.length, cloud.length);
  for (const entry of cloud) {
    assert.ok(svg.includes(`#${entry.name}`), `svg should include #${entry.name}`);
  }
});

test('renderTagCloudSvg is deterministic for the same input', () => {
  assert.equal(renderTagCloudSvg(buildTagCloud(SAMPLE)), renderTagCloudSvg(buildTagCloud(SAMPLE)));
});

test('renderTagCloudSvg escapes XML-special characters in tag names', () => {
  const svg = renderTagCloudSvg(buildTagCloud([{ id: 'x', name: 'a & b', count: 2 }]));
  assert.ok(svg.includes('#a &amp; b'));
  assert.ok(!svg.includes('#a & b'));
});

test('renderTagCloudSvg handles an empty cloud without crashing', () => {
  const svg = renderTagCloudSvg(buildTagCloud([]));
  assert.match(svg, /^<svg /);
  assert.equal(svg.match(/<text /g), null);
});

// Side-effect "test": emit the example SVG so a CI run can upload it as an
// artifact (and so it can be eyeballed locally). Wrapped so a read-only FS can
// never fail the suite.
test('writes the example tag-cloud svg artifact', () => {
  const svg = renderTagCloudSvg(buildTagCloud(SAMPLE));
  try {
    const dir = join(process.cwd(), '.artifacts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tag-cloud-example.svg'), svg);
  } catch {
    // best-effort artifact emission; assertions above already cover correctness
  }
  assert.ok(svg.length > 0);
});
