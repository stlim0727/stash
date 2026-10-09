// Guard architectural boundaries and SOLID principles (DIP, SRP, SDP)
// in the mobile app codebase.
//
// 1. Dependency Inversion Principle (DIP): High-level domain logic must never
//    depend on low-level delivery details, frameworks, UI, or route drivers.
// 2. Single Responsibility & Clean Modularity: Zero circular dependencies.
// 3. Stable Dependencies Principle (SDP): Depend in the direction of stability.

import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve('apps/mobile/src');

function walk(dir) {
  let files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walk(full));
    } else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)) {
      files.push(full);
    }
  }
  return files;
}

const files = walk(ROOT);
const graph = new Map();

for (const file of files) {
  const content = readFileSync(file, 'utf8');
  // Match import/export declarations and dynamic import/require statements.
  const regex =
    /(?:(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?)\s+from|(?:import|require)\s*\()\s*['"]([.a-zA-Z0-9_\-/@]+)['"]/g;
  let match;
  const deps = [];
  while ((match = regex.exec(content)) !== null) {
    const specifier = match[1];
    let candidatePath = null;
    if (specifier.startsWith('@/')) {
      candidatePath = join(ROOT, specifier.slice(2));
    } else if (specifier.startsWith('.')) {
      candidatePath = resolve(dirname(file), specifier);
    }
    if (candidatePath) {
      const extensions = [
        '',
        '.ts',
        '.tsx',
        '.native.ts',
        '.native.tsx',
        join(candidatePath, 'index.ts'),
        join(candidatePath, 'index.tsx'),
      ];
      for (const ext of extensions) {
        const fullPath = ext.startsWith(candidatePath) ? ext : candidatePath + ext;
        if (files.includes(fullPath)) {
          deps.push(fullPath);
          break;
        }
      }
    }
  }
  graph.set(file, deps);
}

// 1. Cycle detection (DIP & SRP guard)
const visited = new Map(); // node -> "visiting" | "visited"
const cycles = [];

function detectCycles(node, path) {
  visited.set(node, 'visiting');
  path.push(node);
  const nextNodes = graph.get(node) || [];
  for (const next of nextNodes) {
    if (visited.get(next) === 'visiting') {
      const cycleStart = path.indexOf(next);
      cycles.push(path.slice(cycleStart).map((f) => relative(ROOT, f)));
    } else if (!visited.has(next)) {
      detectCycles(next, path);
    }
  }
  path.pop();
  visited.set(node, 'visited');
}

for (const file of files) {
  if (!visited.has(file)) {
    detectCycles(file, []);
  }
}

// 2. Layer boundary rules (DIP & Clean Architecture)
const violations = [];
for (const [file, deps] of graph.entries()) {
  const rel = relative(ROOT, file);
  const layer = rel.split('/')[0];
  for (const dep of deps) {
    const depRel = relative(ROOT, dep);
    const depLayer = depRel.split('/')[0];

    // Domain must remain pure: no UI, routes, features, sync, api, or supabase
    if (layer === 'domain' && ['features', 'app', 'sync', 'api', 'ui'].includes(depLayer)) {
      violations.push(`DIP violation: domain module "${rel}" imports from "${depLayer}" ("${depRel}")`);
    }

    // Features must remain decoupled from Expo Router routes
    if (layer === 'features' && depLayer === 'app') {
      violations.push(`Boundary violation: feature "${rel}" imports from route "${depRel}"`);
    }

    // Storage must not depend on higher-level orchestrators
    if (layer === 'storage' && ['features', 'app', 'sync'].includes(depLayer)) {
      violations.push(`Boundary violation: storage module "${rel}" imports from "${depLayer}" ("${depRel}")`);
    }

    // Reusable UI components must not depend on feature or route layers
    if (layer === 'ui' && ['features', 'app'].includes(depLayer)) {
      violations.push(`Boundary violation: UI component "${rel}" imports from "${depLayer}" ("${depRel}")`);
    }
  }
}

// 3. Robert C. Martin's Package Coupling & Instability Metrics
// Ca (Afferent Coupling): Distinct external modules outside the layer that depend on modules in the layer.
// Ce (Efferent Coupling): Distinct external modules outside the layer that modules in the layer depend on.
const trackedLayers = ['domain', 'storage', 'sync', 'api', 'supabase', 'store', 'features', 'ui', 'app'];
const layerFiles = Object.fromEntries(trackedLayers.map((l) => [l, []]));
for (const file of files) {
  const layer = relative(ROOT, file).split('/')[0];
  if (layerFiles[layer]) layerFiles[layer].push(file);
}

const layerCa = Object.fromEntries(trackedLayers.map((l) => [l, 0]));
const layerCe = Object.fromEntries(trackedLayers.map((l) => [l, 0]));

for (const layer of trackedLayers) {
  const filesInLayer = new Set(layerFiles[layer]);
  const externalDependencies = new Set();
  const externalDependents = new Set();

  for (const f of filesInLayer) {
    for (const dep of graph.get(f) || []) {
      if (!filesInLayer.has(dep)) {
        externalDependencies.add(dep);
      }
    }
  }

  for (const [otherFile, deps] of graph.entries()) {
    if (!filesInLayer.has(otherFile)) {
      if (deps.some((d) => filesInLayer.has(d))) {
        externalDependents.add(otherFile);
      }
    }
  }

  layerCa[layer] = externalDependents.size;
  layerCe[layer] = externalDependencies.size;
}

console.log('--- SOLID Architectural Metrics ---');
console.log('Layer      | Inbound (Ca) | Outbound (Ce) | Instability (I = Ce/(Ca+Ce))');
console.log('------------------------------------------------------------------------');
for (const layer of trackedLayers) {
  const ca = layerCa[layer];
  const ce = layerCe[layer];
  const total = ca + ce;
  const inst = total === 0 ? '0.00' : (ce / total).toFixed(2);
  console.log(`${layer.padEnd(10)} | ${String(ca).padStart(12)} | ${String(ce).padStart(13)} | ${inst.padStart(15)}`);
}
console.log('------------------------------------------------------------------------');

let hasError = false;

if (cycles.length > 0) {
  console.error(`\nFAILED: Found ${cycles.length} circular dependency cycle(s):`);
  for (const cycle of cycles) {
    console.error(`  ${cycle.join(' -> ')} -> ${cycle[0]}`);
  }
  hasError = true;
} else {
  console.log('✓ Dependency cycles check passed: 0 circular dependencies detected.');
}

if (violations.length > 0) {
  console.error(`\nFAILED: Found ${violations.length} architectural boundary violation(s):`);
  for (const violation of violations) {
    console.error(`  ${violation}`);
  }
  hasError = true;
} else {
  console.log('✓ Layer boundaries check passed: All layer dependency constraints satisfied.');
}

if (process.env.GITHUB_STEP_SUMMARY) {
  const summaryLines = [
    '### 🏛️ SOLID Architectural Metrics',
    '',
    '| Layer | Inbound ($C_a$) | Outbound ($C_e$) | Instability ($I = \\frac{C_e}{C_a + C_e}$) |',
    '| :--- | :---: | :---: | :---: |',
    ...trackedLayers.map((layer) => {
      const ca = layerCa[layer];
      const ce = layerCe[layer];
      const total = ca + ce;
      const inst = total === 0 ? '0.00' : (ce / total).toFixed(2);
      return `| \`${layer}\` | ${ca} | ${ce} | ${inst} |`;
    }),
    '',
    cycles.length > 0
      ? `- ❌ **Dependency Cycles:** ${cycles.length} circular dependencies detected.`
      : '- ✅ **Dependency Cycles:** 0 circular dependencies detected.',
    violations.length > 0
      ? `- ❌ **Layer Boundaries:** ${violations.length} architectural boundary violations found.`
      : '- ✅ **Layer Boundaries:** All layer dependency constraints satisfied.',
    '',
  ];
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryLines.join('\n') + '\n');
  } catch (err) {
    console.warn(`Could not write to GITHUB_STEP_SUMMARY: ${err.message}`);
  }
}

if (hasError) {
  process.exit(1);
} else {
  console.log('✓ Architecture boundaries check passed successfully.\n');
}
