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
  },
  clearMocks: true,
};
