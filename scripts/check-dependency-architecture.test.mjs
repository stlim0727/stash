import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { analyzeArchitecture } from './check-dependency-architecture.mjs';

async function fixture(files, run) {
  mkdirSync('.artifacts', { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), '.artifacts/architecture-test-'));
  const sourceRoot = relative(process.cwd(), dir);
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  try {
    await run((platform = 'web', runtimeOnly = false, knownViolations = [], extra = {}) =>
      analyzeArchitecture(platform, { sourceRoot, runtimeOnly, knownViolations, ...extra }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const rules = (result) => result.summary.violations.map((violation) => violation.rule.name);

test('parses multiline type imports and re-exports, but ignores comments and strings', async () => {
  await fixture({
    'domain/type.ts': "import type {\n Value\n} from '@/ui/value'; export type Alias = Value;",
    'domain/export.ts': "export { value } from '../ui/value';",
    'domain/comment.ts': "// import { value } from '@/ui/value';\nexport const example = \"import { value } from '@/ui/value'\";",
    'ui/value.ts': 'export type Value = string; export const value = 1;',
  }, async (scan) => {
    const result = await scan();
    assert.equal(rules(result).filter((rule) => rule === 'domain-is-independent').length, 2);
    assert.ok(result.summary.violations.every((violation) => !violation.from.endsWith('comment.ts')));
  });
});

test('detects dynamic import, CommonJS require and side-effect dependencies', async () => {
  await fixture({
    'domain/dynamic.ts': "export const load = () => import('@/ui/value');",
    'domain/require.ts': "export const load = () => require('@/ui/value');",
    'domain/side-effect.ts': "import '@/ui/value';",
    'ui/value.ts': 'export const value = 1;',
  }, async (scan) => assert.equal(rules(await scan()).filter((rule) => rule === 'domain-is-independent').length, 3));
});

test('runtime cycles fail; type-only cycles do not', async () => {
  await fixture({
    'domain/a.ts': "import { b } from './b'; export const a = () => b();",
    'domain/b.ts': "import { a } from './a'; export const b = () => a();",
    'domain/x.ts': "import type { Y } from './y'; export interface X { y: Y }",
    'domain/y.ts': "import type { X } from './x'; export interface Y { x: X }",
  }, async (scan) => {
    const result = await scan('web', true);
    assert.ok(rules(result).includes('no-runtime-cycles'));
    assert.ok(result.summary.violations.every((violation) => !/[xy]\.ts$/.test(violation.from)));
  });
});

test('runtime self-import is rejected', async () => {
  await fixture({ 'domain/self.ts': "import { value } from './self'; export const value = () => value();" }, async (scan) => {
    assert.ok(rules(await scan('web', true)).includes('no-runtime-cycles'));
  });
});

test('resolves platform precedence separately and excludes other-platform entry points', async () => {
  await fixture({
    'domain/entry.ts': "export { value } from './adapter';",
    'domain/adapter.ts': 'export const value = 0;',
    'domain/adapter.native.ts': 'export const value = 1;',
    'domain/adapter.ios.ts': 'export const value = 2;',
    'domain/adapter.web.ts': 'export const value = 3;',
    'domain/adapter.android.ts': 'export const value = 4;',
  }, async (scan) => {
    for (const [platform, suffix] of [['ios', '.ios.ts'], ['android', '.android.ts'], ['web', '.web.ts']]) {
      const result = await scan(platform);
      const entry = result.modules.find((module) => module.source.endsWith('/entry.ts'));
      assert.ok(entry.dependencies[0].resolved.endsWith(`/adapter${suffix}`));
      assert.equal(result.summary.error, 0);
      assert.ok(!result.modules.some((module) => module.source.endsWith(platform === 'web' ? '.native.ts' : '.web.ts')));
    }
  });
});

test('native fallback and index modules use platform extensions', async () => {
  await fixture({
    'domain/entry.ts': "export { value } from './adapter'; export { indexValue } from './folder';",
    'domain/adapter.ts': 'export const value = 0;',
    'domain/adapter.native.ts': 'export const value = 1;',
    'domain/folder/index.ts': 'export const indexValue = 0;',
    'domain/folder/index.native.ts': 'export const indexValue = 1;',
  }, async (scan) => {
    for (const platform of ['ios', 'android']) {
      const result = await scan(platform);
      const deps = result.modules.find((module) => module.source.endsWith('/entry.ts')).dependencies;
      assert.ok(deps.every((dep) => dep.resolved.endsWith('.native.ts')));
    }
  });
});

test('missing local imports fail instead of silently dropping an edge', async () => {
  await fixture({ 'domain/a.ts': "export { value } from '@/domain/missing'; export { other } from './missing';" }, async (scan) => {
    assert.equal(rules(await scan()).filter((rule) => rule === 'local-imports-must-resolve').length, 2);
  });
});

test('allows storage type contract, rejects runtime storage and layer inversions', async () => {
  await fixture({
    'domain/a.ts': "export type { Value } from '@/storage/types'; export { value } from '@/storage/repository';",
    'storage/types.ts': 'export interface Value { id: string }',
    'storage/repository.ts': 'export const value = 1;',
    'storage/bad.ts': "export { value } from '@/sync/run';",
    'sync/run.ts': 'export const value = 1;',
    'ui/bad.ts': "export { value } from '@/features/sample/value';",
    'features/sample/value.ts': 'export const value = 1;',
  }, async (scan) => {
    const result = await scan();
    assert.deepEqual(rules(result).sort(), ['domain-storage-contract-only', 'storage-does-not-import-orchestration', 'ui-does-not-import-features-or-routes'].sort());
  });
});

test('inline detail exception does not permit another route or another feature', async () => {
  await fixture({
    'features/inbox/InboxItemRenderer.tsx': "export { value } from '@/app/bookmark/[id]'; export { other } from '@/app/other';",
    'features/inbox/other.ts': "export { value } from '@/app/bookmark/[id]';",
    'app/bookmark/[id].tsx': 'export const value = 1;',
    'app/other.ts': 'export const other = 2;',
  }, async (scan) => {
    assert.deepEqual(rules(await scan()).sort(), ['features-do-not-import-routes', 'inline-detail-route-only'].sort());
  });
});

test('ignores test fixtures and mocks as production entry points', async () => {
  await fixture({
    'domain/good.ts': 'export const value = 1;',
    'domain/bad.test.ts': "export { value } from '@/ui/value';",
    '__tests__/helper.ts': "export { value } from '@/ui/value';",
    '__mocks__/mock.ts': "export { value } from '@/ui/value';",
    'ui/value.ts': 'export const value = 1;',
  }, async (scan) => {
    const result = await scan();
    assert.equal(result.summary.error, 0);
    assert.equal(result.modules.length, 2);
  });
});

test('exact cycle baseline does not hide a different cycle', async () => {
  await fixture({
    'domain/a.ts': "import { b } from './b'; export const a = () => b();",
    'domain/b.ts': "import { a } from './a'; export const b = () => a();",
    'domain/c.ts': "import { d } from './d'; export const c = () => d();",
    'domain/d.ts': "import { c } from './c'; export const d = () => c();",
  }, async (scan) => {
    const initial = await scan('web', true);
    const baseline = initial.summary.violations.filter((violation) => violation.from.endsWith('/a.ts') || violation.from.endsWith('/b.ts'));
    const result = await scan('web', true, baseline);
    assert.ok(result.summary.ignore > 0);
    assert.ok(result.summary.error > 0);
    assert.ok(result.summary.violations.filter((violation) => violation.rule.severity === 'error').every((violation) => /[cd]\.ts$/.test(violation.from)));
  });
});

test('uses project aliases, preferring specific mappings over the general alias', async () => {
  await fixture({
    'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'], '@/contracts/*': ['./storage/*'] } } }),
    'domain/a.ts': "export type { Value } from '@/contracts/types';",
    'storage/types.ts': 'export interface Value { id: string }',
  }, async (scan) => {
    // Obtain the fixture project path from the graph instead of using app paths.
    const first = await scan();
    const entry = first.modules.find((module) => module.source.endsWith('/domain/a.ts'));
    const project = entry.source.replace(/domain\/a\.ts$/, 'tsconfig.json');
    const result = await scan('web', false, [], { tsConfigPath: project });
    assert.equal(result.summary.error, 0);
    const dep = result.modules.find((module) => module.source.endsWith('/domain/a.ts')).dependencies[0];
    assert.ok(dep.resolved.endsWith('/storage/types.ts'));
  });
});
