// Guard against dynamic `process.env[...]` reads in the mobile app source.
//
// Expo only inlines STATIC `process.env.EXPO_PUBLIC_*` references into release
// bundles. A computed access like `process.env[key]` is left untouched and
// reads as empty in a production build — which silently broke Supabase config
// on device. Use `process.env.EXPO_PUBLIC_NAME` directly instead.
//
// Scans apps/mobile/src (excluding *.test.* and comment lines). Server-side
// Deno functions are not bundled by Expo, so they're out of scope.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'apps/mobile/src';
const PATTERN = /process\.env\s*(\?\.)?\s*\[/;
const offenders = [];

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
    readFileSync(path, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        const match = line.match(PATTERN);
        if (!match) {
          return;
        }
        const before = line.slice(0, match.index);
        if (before.includes('//') || /^\s*\*/.test(line)) {
          return; // inside a comment
        }
        offenders.push(`${path}:${index + 1}: ${line.trim()}`);
      });
  }
}

walk(ROOT);

if (offenders.length > 0) {
  console.error(
    'Dynamic process.env[...] access found. Expo only inlines STATIC\n' +
      'process.env.EXPO_PUBLIC_* references into release bundles; a computed\n' +
      'lookup reads empty in production. Use process.env.EXPO_PUBLIC_NAME directly.\n',
  );
  for (const offender of offenders) {
    console.error(`  ${offender}`);
  }
  process.exit(1);
}

console.log('Static env check passed: no dynamic process.env[...] reads in app source.');
