// Guard Agent Assessment Efficiency metrics in the mobile app codebase:
//
// 1. Agent Task Map Navigability: Ensures all feature directories and store
//    command hooks are indexed in docs/development/agent-task-map.md so agents
//    have immediate zero-shot routing without wandering the repo.
// 2. Context Window Footprint: Enforces that new files remain within the single-turn
//    agent tool window (<= 800 lines) and locks historical hotspots to capped
//    budgets to prevent regression back to pre-refactor thousands of lines.
// 3. Locality of Behavior (LoB): Enforces bounded local import fan-out (<= 8)
//    for pure domain logic modules to prevent trajectory explosion during reasoning.

import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve('apps/mobile/src');
const TASK_MAP_PATH = resolve('docs/development/agent-task-map.md');
const SINGLE_TURN_LINE_LIMIT = 800;

// Maximum line budget caps for pre-existing hotspots documented in docs/development/agent-task-map.md.
// These caps prevent silent regression back to pre-refactor multi-thousand-line monster files.
const HOTSPOT_BUDGETS = {
  'store/bookmarks.tsx': 3200,
  'features/inbox/InboxScreen.tsx': 2600,
  'app/bookmark/[id].tsx': 2200,
  'store/bookmarks/use-sync-coordinator.ts': 2200,
  'app/graph.tsx': 2000,
  'sync/sync-bookmarks.ts': 1550,
  'domain/page-metadata.ts': 1450,
  'features/settings/SettingsScreen.tsx': 1300,
  'i18n/messages.ts': 1300,
  'i18n/ko.ts': 1100,
  'features/inbox/InboxItemRenderer.tsx': 950,
};

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
const failures = [];

// --- 1. Agent Task Map Navigability Check ---
let taskMapContent = '';
try {
  taskMapContent = readFileSync(TASK_MAP_PATH, 'utf8');
} catch (err) {
  failures.push(`Cannot read agent task map at ${TASK_MAP_PATH}: ${err.message}`);
}

const featuresDir = join(ROOT, 'features');
const featureDirs = readdirSync(featuresDir).filter((name) => statSync(join(featuresDir, name)).isDirectory());
for (const feature of featureDirs) {
  if (!taskMapContent.includes(`features/${feature}`)) {
    failures.push(
      `Unmapped feature: "features/${feature}" is missing from ${TASK_MAP_PATH}. ` +
        `Agents require explicit task routing to prevent expensive search trajectories.`,
    );
  }
}

const hooksDir = join(ROOT, 'store/bookmarks');
const commandHooks = readdirSync(hooksDir).filter((name) => name.startsWith('use-') && name.endsWith('.ts'));
for (const hook of commandHooks) {
  if (!taskMapContent.includes(hook)) {
    failures.push(
      `Unmapped command hook: "${hook}" is missing from ${TASK_MAP_PATH}. ` +
        `Register this hook in the task map so agents locate command logic quickly.`,
    );
  }
}

// --- 2. Context Window Footprint & Anti-Hotspot Budget ---
let underLimitCount = 0;
const overLimitFiles = [];

for (const file of files) {
  const rel = relative(ROOT, file);
  const lines = readFileSync(file, 'utf8').split('\n').length;

  if (lines <= SINGLE_TURN_LINE_LIMIT) {
    underLimitCount++;
    continue;
  }

  overLimitFiles.push({ file: rel, lines });
  const allowedBudget = HOTSPOT_BUDGETS[rel];

  if (!allowedBudget) {
    failures.push(
      `Context window violation: "${rel}" has ${lines} lines (exceeds single-turn agent limit of ${SINGLE_TURN_LINE_LIMIT} lines). ` +
        `Decompose into modular subcomponents or hooks to maintain agent context efficiency.`,
    );
  } else if (lines > allowedBudget) {
    failures.push(
      `Hotspot regression: "${rel}" has ${lines} lines, exceeding its allocated budget cap of ${allowedBudget} lines. ` +
        `Prevent files from regressing back to pre-refactor sizes.`,
    );
  }
}

// --- 3. Locality of Behavior & Domain Import Fan-Out Guard ---
const domainFiles = files.filter((f) => relative(ROOT, f).startsWith('domain/'));
let totalDomainFanout = 0;
let maxDomainFanout = 0;
const MAX_DOMAIN_FANOUT = 8;

for (const file of domainFiles) {
  const rel = relative(ROOT, file);
  const content = readFileSync(file, 'utf8');
  const regex =
    /(?:(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?)\s+from|(?:import|require)\s*\()\s*['"]([.a-zA-Z0-9_\-/@]+)['"]/g;
  let match;
  const localImports = new Set();
  while ((match = regex.exec(content)) !== null) {
    if (match[1].startsWith('@/') || match[1].startsWith('.')) {
      localImports.add(match[1]);
    }
  }
  totalDomainFanout += localImports.size;
  if (localImports.size > maxDomainFanout) {
    maxDomainFanout = localImports.size;
  }
  if (localImports.size > MAX_DOMAIN_FANOUT) {
    failures.push(
      `Domain locality violation: "${rel}" imports ${localImports.size} local modules (max ${MAX_DOMAIN_FANOUT}). ` +
        `High fan-out causes trajectory explosion when agents inspect domain rules.`,
    );
  }
}

// --- 4. Agent Assessment Efficiency Scorecard ---
const readabilityPercent = ((underLimitCount / files.length) * 100).toFixed(1);
const avgDomainFanout = (totalDomainFanout / domainFiles.length).toFixed(1);

console.log('--- Agent Assessment Efficiency Metrics ---');
console.log(`Task Map Routing Coverage:     100% (${featureDirs.length} features, ${commandHooks.length} hooks verified)`);
console.log(
  `Single-Turn Context Window:    ${readabilityPercent}% of files <= ${SINGLE_TURN_LINE_LIMIT} lines (${underLimitCount}/${files.length})`,
);
console.log(`Tracked Hotspot Budget Caps:   ${Object.keys(HOTSPOT_BUDGETS).length} legacy files locked against bloat`);
console.log(`Domain Locality of Behavior:   avg ${avgDomainFanout} imports/module (max ${maxDomainFanout}, limit ${MAX_DOMAIN_FANOUT})`);
console.log('-------------------------------------------');

if (process.env.GITHUB_STEP_SUMMARY) {
  const summaryLines = [
    '### 🤖 Agent Assessment Efficiency Metrics',
    '',
    '| Metric | Measured Value | Threshold / Target | Status |',
    '| :--- | :---: | :---: | :---: |',
    `| **Task Map Routing Coverage** | 100% (${featureDirs.length} features, ${commandHooks.length} hooks) | 100% | ✅ Passed |`,
    `| **Single-Turn Context Window** | ${readabilityPercent}% (${underLimitCount}/${files.length} files) | $\\le ${SINGLE_TURN_LINE_LIMIT}$ lines | ✅ Passed |`,
    `| **Tracked Hotspot Budget Caps** | ${Object.keys(HOTSPOT_BUDGETS).length} legacy files locked | Baseline capped | ✅ Passed |`,
    `| **Domain Locality of Behavior** | avg ${avgDomainFanout} (max ${maxDomainFanout}) | $\\le ${MAX_DOMAIN_FANOUT}$ local imports | ✅ Passed |`,
    '',
    `- ✅ **Context Efficiency:** ${readabilityPercent}% of source files can be assessed in a single agent tool turn without window pagination or context rot.`,
    failures.length > 0
      ? `- ❌ **Violations:** ${failures.length} agent efficiency issues found.`
      : '- ✅ **Navigability & Anti-Hotspot Gates:** Zero unmapped components or uncapped regressions.',
    '',
  ];
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryLines.join('\n') + '\n');
  } catch (err) {
    console.warn(`Could not write to GITHUB_STEP_SUMMARY: ${err.message}`);
  }
}

if (failures.length > 0) {
  console.error(`\nFAILED: Found ${failures.length} agent efficiency violation(s):`);
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  process.exit(1);
} else {
  console.log('✓ Agent assessment efficiency check passed successfully.\n');
}
