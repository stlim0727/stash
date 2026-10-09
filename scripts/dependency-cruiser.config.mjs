// Policy is shared by the CI runner and adversarial fixture tests.
export const PLATFORMS = ['ios', 'android', 'web'];

export function architectureConfig(platform, { sourceRoot = 'apps/mobile/src', runtimeOnly = false } = {}) {
  if (!PLATFORMS.includes(platform)) throw new Error(`Unknown platform: ${platform}`);
  const root = sourceRoot.replace(/\\/g, '/');
  const escapedRoot = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const layer = (name) => `^${escapedRoot}/${name}/`;
  const unsupported = platform === 'web' ? 'native|ios|android' : platform === 'ios' ? 'web|android' : 'web|ios';
  const extensions = platform === 'web'
    ? ['.web.ts', '.web.tsx', '.ts', '.tsx', '.web.js', '.js', '.json']
    : [`.${platform}.ts`, `.${platform}.tsx`, '.native.ts', '.native.tsx', '.ts', '.tsx', `.${platform}.js`, '.native.js', '.js', '.json'];
  const boundary = (name, from, to, extra = {}) => ({
    name, severity: 'error', from: { path: layer(from) }, to: { path: layer(to), ...extra },
  });
  const forbidden = runtimeOnly ? [{
    name: 'no-runtime-cycles', severity: 'error', from: { path: `^${escapedRoot}/` }, to: { circular: true },
  }] : [
    boundary('domain-is-independent', 'domain', '(store|features|app|sync|api|ui|supabase|share)'),
    boundary('domain-storage-contract-only', 'domain', 'storage', { pathNot: `^${escapedRoot}/storage/types\\.ts$` }),
    {
      name: 'features-do-not-import-routes', severity: 'error',
      from: { path: layer('features'), pathNot: `^${escapedRoot}/features/inbox/InboxItemRenderer\\.tsx$` },
      to: { path: layer('app') },
    },
    {
      // The desktop inline-detail exception is limited to this one edge.
      name: 'inline-detail-route-only', severity: 'error',
      from: { path: `^${escapedRoot}/features/inbox/InboxItemRenderer\\.tsx$` },
      to: { path: layer('app'), pathNot: `^${escapedRoot}/app/bookmark/\\[id\\]\\.tsx$` },
    },
    boundary('storage-does-not-import-orchestration', 'storage', '(store|features|app|sync|share)'),
    boundary('ui-does-not-import-features-or-routes', 'ui', '(features|app)'),
  ];
  forbidden.push({
    name: 'local-imports-must-resolve', severity: 'error', from: { path: `^${escapedRoot}/` },
    to: { path: `^(@/|\\.|${escapedRoot}/)`, couldNotResolve: true },
  });
  return {
    forbidden,
    options: {
      doNotFollow: { path: 'node_modules' },
      exclude: { path: [`(^|/)(__tests__|__mocks__)/`, '\\.(test|spec)\\.[cm]?[jt]sx?$', `\\.(${unsupported})\\.[jt]sx?$`, '\\.d\\.ts$'] },
      tsPreCompilationDeps: runtimeOnly ? false : 'specify',
      enhancedResolveOptions: {
        extensions,
        conditionNames: platform === 'web' ? ['browser', 'import', 'default'] : ['react-native', 'import', 'default'],
        mainFields: platform === 'web' ? ['browser', 'module', 'main'] : ['react-native', 'browser', 'main'],
      },
      metrics: !runtimeOnly,
    },
  };
}
