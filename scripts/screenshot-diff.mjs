// Visual-regression gate for the Android screenshots (issue #269, item 2).
//
// Compares the PNGs Maestro just captured against committed baselines and FAILS
// when a screen's layout changed — including the case that slipped through
// rc11/rc12: an element rendered at the wrong size. A pure "assertVisible" check
// can't see that; a pixel diff can.
//
// Policy per screen (a baseline `*.png`):
//   - no matching new capture            → FAIL (screen missing from this run)
//   - dimensions differ                  → FAIL (a resize is always a regression)
//   - >MAX_DIFF_RATIO of pixels differ   → FAIL, write a diff image
//   - otherwise                          → PASS
// New captures with no baseline are reported as "needs bless", not failures, so
// adding a screen doesn't hard-fail before its baseline is committed.
//
// Env:
//   BASELINE_DIR     dir of committed baseline PNGs (default screenshots/baselines)
//   NEW_DIR          dir of freshly captured PNGs   (default screenshots)
//   OUT_DIR          where diff images are written  (default screenshots/diff)
//   PIXEL_THRESHOLD  pixelmatch per-pixel colour threshold 0..1 (default 0.1)
//   MAX_DIFF_RATIO   max fraction of differing pixels tolerated (default 0.002)
//
// Exit non-zero if any screen FAILS, so CI blocks the merge.
import { readdirSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const BASELINE_DIR = process.env.BASELINE_DIR || 'screenshots/baselines';
const NEW_DIR = process.env.NEW_DIR || 'screenshots';
const OUT_DIR = process.env.OUT_DIR || 'screenshots/diff';
const PIXEL_THRESHOLD = Number(process.env.PIXEL_THRESHOLD ?? '0.1');
const MAX_DIFF_RATIO = Number(process.env.MAX_DIFF_RATIO ?? '0.002');

const pngs = (dir) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.png')) : [];

const baselines = pngs(BASELINE_DIR);
if (baselines.length === 0) {
  // First run / nothing blessed yet: don't fail, just point at how to seed.
  console.log(
    `No baselines in ${BASELINE_DIR}. Skipping visual diff — bless the current ` +
      `run's screenshots into that directory to start gating.`,
  );
  process.exit(0);
}

const newSet = new Set(pngs(NEW_DIR));
mkdirSync(OUT_DIR, { recursive: true });

const rows = [];
let failed = 0;

for (const name of baselines.sort()) {
  if (!newSet.has(name)) {
    rows.push({ name, status: 'FAIL', detail: 'no matching capture in this run' });
    console.log(`::error::screenshot-diff: ${name} — not captured this run`);
    failed += 1;
    continue;
  }
  const base = PNG.sync.read(readFileSync(join(BASELINE_DIR, name)));
  const cur = PNG.sync.read(readFileSync(join(NEW_DIR, name)));

  if (base.width !== cur.width || base.height !== cur.height) {
    rows.push({
      name,
      status: 'FAIL',
      detail: `size ${base.width}x${base.height} → ${cur.width}x${cur.height}`,
    });
    console.log(
      `::error::screenshot-diff: ${name} — dimensions changed ` +
        `(${base.width}x${base.height} → ${cur.width}x${cur.height})`,
    );
    failed += 1;
    continue;
  }

  const { width, height } = base;
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(base.data, cur.data, diff.data, width, height, {
    threshold: PIXEL_THRESHOLD,
  });
  const ratio = diffPixels / (width * height);
  if (ratio > MAX_DIFF_RATIO) {
    writeFileSync(join(OUT_DIR, name), PNG.sync.write(diff));
    rows.push({ name, status: 'FAIL', detail: `${(ratio * 100).toFixed(3)}% pixels differ` });
    console.log(
      `::error::screenshot-diff: ${name} — ${(ratio * 100).toFixed(3)}% of pixels ` +
        `differ (> ${(MAX_DIFF_RATIO * 100).toFixed(3)}%); see diff image in ${OUT_DIR}`,
    );
    failed += 1;
  } else {
    rows.push({ name, status: 'pass', detail: `${(ratio * 100).toFixed(3)}% pixels differ` });
  }
}

const orphans = [...newSet].filter((n) => !baselines.includes(n)).sort();
for (const name of orphans) {
  rows.push({ name, status: 'new', detail: 'no baseline — bless to start gating' });
}

console.log('\nVisual diff vs baselines:');
for (const r of rows) {
  console.log(`  [${r.status.padEnd(4)}] ${basename(r.name).padEnd(28)} ${r.detail}`);
}
console.log(
  `\n${rows.filter((r) => r.status === 'pass').length} passed, ${failed} failed, ` +
    `${orphans.length} new (un-blessed).`,
);

if (failed > 0) {
  console.log(
    `\nIf a change is intentional, re-bless the baselines (re-run the screenshots ` +
      `workflow with the bless input/label) and commit the updated PNGs.`,
  );
  process.exit(1);
}
