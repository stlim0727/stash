// Guard against the Android "visible but dead" overlay trap.
//
// On iOS `zIndex` orders both paint and touch. On Android `zIndex` is
// paint-only — touch dispatch follows native draw order (elevation, then
// sibling order). So an absolutely-positioned overlay that sets `zIndex` but no
// `elevation` paints on top yet lets a later-mounted scroll sibling steal the
// touches over it, leaving its controls visible but unresponsive. That was
// STASH-7 (the inbox header went dead while the tag cloud was open).
//
// Rule: any style object with `position: 'absolute'` and a `zIndex` MUST also
// set `elevation` (matching it keeps paint and touch in agreement). The
// `overlayLayer(z)` helper in src/ui/layering.ts sets both at once and is the
// preferred fix. We only flag zIndex-without-elevation, never the reverse:
// elements that intentionally carry a shadow (e.g. the FAB) set `elevation`
// alone and rely on sibling order, which is fine.
//
// Scans apps/mobile/src (excluding *.test.*). Block boundaries are found by
// brace matching so nested objects (shadowOffset, etc.) don't confuse it.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'apps/mobile/src';
const ABSOLUTE = /position\s*:\s*['"]absolute['"]/g;
const offenders = [];

/** Index of the `{` that opens the object literal enclosing `pos`. */
function enclosingOpenBrace(text, pos) {
  let depth = 0;
  for (let i = pos; i >= 0; i -= 1) {
    const ch = text[i];
    if (ch === '}') depth += 1;
    else if (ch === '{') {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

/** Index just past the `}` that closes the block opened at `open`. */
function matchingCloseBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      walk(path);
      continue;
    }
    if (!/\.tsx?$/.test(path) || /\.test\.tsx?$/.test(path)) {
      continue;
    }
    const text = readFileSync(path, 'utf8');
    for (const match of text.matchAll(ABSOLUTE)) {
      const open = enclosingOpenBrace(text, match.index);
      if (open < 0) continue;
      const block = text.slice(open, matchingCloseBrace(text, open));
      // `overlayLayer(...)` sets zIndex+elevation together, so a block using it
      // satisfies the rule even though neither literal appears here.
      if (block.includes('overlayLayer(')) continue;
      const hasZ = /\bzIndex\s*:/.test(block);
      const hasElevation = /\belevation\s*:/.test(block);
      if (hasZ && !hasElevation) {
        const line = text.slice(0, match.index).split('\n').length;
        offenders.push(`${path}:${line}: absolute overlay sets zIndex but no elevation`);
      }
    }
  }
}

walk(ROOT);

if (offenders.length > 0) {
  console.error(
    'Absolute overlay with zIndex but no elevation found. On Android zIndex is\n' +
      'paint-only, so the overlay will be visible but unhittable (STASH-7). Set\n' +
      'elevation to match, or use overlayLayer(z) from @/ui/layering.\n',
  );
  for (const offender of offenders) {
    console.error(`  ${offender}`);
  }
  process.exit(1);
}

console.log('Overlay elevation check passed: no zIndex-without-elevation overlays.');
