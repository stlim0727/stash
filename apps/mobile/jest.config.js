/**
 * Jest runs ONLY component/hook tests (*.test.tsx) via the jest-expo preset.
 * Pure logic tests (*.test.ts) stay on Node's built-in runner — see the
 * `test` script; `test:components` runs this config.
 */
module.exports = {
  preset: 'jest-expo',
  testMatch: ['**/src/**/*.test.tsx'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^react-native-enriched-markdown$': 'react-native-enriched-markdown/jest',
  },
  clearMocks: true,
  // CI hardening: CircleCI's memory-constrained container (8GB, no swap) gets
  // over-subscribed by jest-expo's default numCPUs-1 heavy workers, which
  // starves/swaps and makes a slow async store init (ensureRepositoryReady/sync)
  // trip the 5s default timeout — flaky, not a real hang (the failing run took
  // 26.8s for a test that's 315ms locally). Run serially in CI (CI=true on
  // CircleCI; maxWorkers:1 = runInBand-equivalent, the only reliable fit on the
  // 8GB/no-swap box) and keep local fast at 50%; raise the per-test timeout so a
  // slow-but-fine init doesn't fail (a genuine hang still fails, just later).
  maxWorkers: process.env.CI ? 1 : '50%',
  testTimeout: 15000,
};
