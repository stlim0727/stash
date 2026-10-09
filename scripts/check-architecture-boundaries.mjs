// Guard architectural boundaries and SOLID principles (DIP, SRP, SDP)
// in the mobile app codebase.
//
// 1. Dependency Inversion Principle (DIP): High-level domain logic must never
//    depend on low-level delivery details, frameworks, UI, or route drivers.
// 2. Single Responsibility & Clean Modularity: Zero circular dependencies
//    across both native and web platform module resolutions.
// 3. Stable Dependencies Principle (SDP): Depend in the direction of stability.

import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve('apps/mobile/src');

function normalizePath(p) {
  return p.replace(/\\/g, '/');
}

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

function extractImports(content) {
  const specifiers = new Set();
  const fromRegex = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?)\s+from\s*['"]([.a-zA-Z0-9_\-/@]+)['"]/g;
  const bareRegex = /import\s+['"]([.a-zA-Z0-9_\-/@]+)['"]/g;
  const callRegex = /(?:import|require)\s*\(\s*['"]([.a-zA-Z0-9_\-/@]+)['"]\s*\)/g;

  let match;
  while ((match = fromRegex.exec(content)) !== null) specifiers.add(match[1]);
  while ((match = bareRegex.exec(content)) !== null) specifiers.add(match[1]);
  while ((match = callRegex.exec(content)) !== null) specifiers.add(match[1]);
  return [...specifiers];
}

function resolveModule(importer, specifier, platform) {
  let candidatePath = null;
  if (specifier.startsWith('@/')) {
    candidatePath = join(ROOT, specifier.slice(2));
  } else if (specifier.startsWith('.')) {
    candidatePath = resolve(dirname(importer), specifier);
  } else {
    return null;
  }

  // Exact file match
  if (files.includes(candidatePath) && candidatePath !== importer) {
    return candidatePath;
  }

  const candidateExtensions = [
    `.${platform}.ts`,
    `.${platform}.tsx`,
    '.ts',
    '.tsx',
    `/index.${platform}.ts`,
    `/index.${platform}.tsx`,
    '/index.ts',
    '/index.tsx',
  ];

  for (const ext of candidateExtensions) {
    const full = candidatePath + ext;
    if (full !== importer && files.includes(full)) {
      return full;
    }
  }
  return null;
}

// 1. Cycle detection (DIP & SRP guard) across both native and web targets
const allCycles = [];
for (const platform of ['native', 'web']) {
  const platformGraph = new Map();
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const specifiers = extractImports(content);
    const deps = [];
    for (const spec of specifiers) {
      const resolved = resolveModule(file, spec, platform);
      if (resolved && !deps.includes(resolved)) deps.push(resolved);
    }
    platformGraph.set(file, deps);
  }

  const visited = new Map(); // node -> "visiting" | "visited"
  function detectCycles(node, path) {
    visited.set(node, 'visiting');
    path.push(node);
    for (const next of platformGraph.get(node) || []) {
      if (visited.get(next) === 'visiting') {
        const cycleStart = path.indexOf(next);
        allCycles.push({
          platform,
          cycle: path.slice(cycleStart).map((f) => normalizePath(relative(ROOT, f))),
        });
      } else if (!visited.has(next)) {
        detectCycles(next, path);
      }
    }
    path.pop();
    visited.set(node, 'visited');
  }

  for (const file of files) {
    if (!visited.has(file)) detectCycles(file, []);
  }
}

// 2. Layer boundary rules (DIP & Clean Architecture)
const unifiedGraph = new Map();
for (const file of files) {
  const content = readFileSync(file, 'utf8');
  const specifiers = extractImports(content);
  const deps = new Set();
  for (const platform of ['native', 'web']) {
    for (const spec of specifiers) {
      const resolved = resolveModule(file, spec, platform);
      if (resolved) deps.add(resolved);
    }
  }
  unifiedGraph.set(file, [...deps]);
}

const violations = [];
for (const [file, deps] of unifiedGraph.entries()) {
  const rel = normalizePath(relative(ROOT, file));
  const layer = rel.split('/')[0];
  for (const dep of deps) {
    const depRel = normalizePath(relative(ROOT, dep));
    const depLayer = depRel.split('/')[0];

    // Domain must remain pure: no UI, routes, features, sync, api, supabase, or runtime storage
    if (layer === 'domain') {
      if (['features', 'app', 'sync', 'api', 'ui', 'supabase'].includes(depLayer)) {
        violations.push(`DIP violation: domain module "${rel}" imports from "${depLayer}" ("${depRel}")`);
      } else if (depLayer === 'storage' && !depRel.startsWith('storage/types')) {
        violations.push(`DIP violation: domain module "${rel}" imports runtime storage module ("${depRel}")`);
      }
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
  const layer = normalizePath(relative(ROOT, file)).split('/')[0];
  if (layerFiles[layer]) layerFiles[layer].push(file);
}

const layerCa = Object.fromEntries(trackedLayers.map((l) => [l, 0]));
const layerCe = Object.fromEntries(trackedLayers.map((l) => [l, 0]));

for (const layer of trackedLayers) {
  const filesInLayer = new Set(layerFiles[layer]);
  const externalDependencies = new Set();
  const externalDependents = new Set();

  for (const f of filesInLayer) {
    for (const dep of unifiedGraph.get(f) || []) {
      if (!filesInLayer.has(dep)) {
        externalDependencies.add(dep);
      }
    }
  }

  for (const [otherFile, deps] of unifiedGraph.entries()) {
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

if (allCycles.length > 0) {
  console.error(`\nFAILED: Found ${allCycles.length} circular dependency cycle(s):`);
  for (const { platform, cycle } of allCycles) {
    console.error(`  [${platform}] ${cycle.join(' -> ')} -> ${cycle[0]}`);
  }
  hasError = true;
} else {
  console.log('✓ Dependency cycles check passed: 0 circular dependencies detected across native and web.');
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
    allCycles.length > 0
      ? `- ❌ **Dependency Cycles:** ${allCycles.length} circular dependencies detected.`
      : '- ✅ **Dependency Cycles:** 0 circular dependencies detected across native and web.',
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
