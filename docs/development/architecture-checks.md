# Dependency architecture checks

`pnpm lint:dependency-architecture` runs pinned dependency-cruiser and TypeScript
from the repository root. It is part of `pnpm lint` on both CI providers.
The policy lives in `scripts/dependency-cruiser.config.mjs`; the runner adds
platform selection, reporting, and the existing-violation baseline.

## What blocks CI

- Domain imports of routes, UI, features, store, sync, API, Supabase, or share.
  Storage dependencies are restricted to `storage/types.ts`.
- Feature imports of routes, except the exact existing desktop inline detail
  edge from `InboxItemRenderer.tsx` to `app/bookmark/[id].tsx`.
- Storage imports of store, features, routes, sync, or share.
- UI imports of features or routes.
- New runtime circular dependencies, including self-imports.
- Unresolved local alias or relative imports.

The analyzer parses TypeScript, re-exports, side-effect imports, static string
`import()` calls, and `require()` calls. Comments and string examples are not
imports. Computed import paths cannot be fully checked statically.

## Platforms and types

There are separate iOS, Android, and web graphs. Native resolution prefers the
platform extension, then `.native`, then the generic file. Web prefers `.web`
then generic. Directory index modules follow the same order. Other-platform
files, test suites, test helpers, mocks, and declaration files are excluded.
The app's aliases and compiler options come from `apps/mobile/tsconfig.json`,
including its asset alias; package internals are not
traversed. This is an internal architecture check, not a complete Metro bundler
simulation or dependency security scan.

Contract graphs include type-only imports so types cannot bypass layer rules.
Runtime graphs strip type imports before cycle detection: a cycle between type
contracts alone is not a runtime initialization cycle. Generic files are also
scanned as entry points, even when a platform variant shadows them.

## Existing violation and PR 926

This PR works independently of #926. Main currently has one runtime cycle on
both native platforms: `storage/sqlite-directory-expo.ts` imports the basename
`storage/sqlite-directory`, which resolves to `sqlite-directory.native.ts`,
which imports `sqlite-directory-expo.ts` again. #926 already renames the native
wrapper to fix this; this PR does not duplicate that application change.

`scripts/dependency-architecture-baseline.json` records that exact cycle using
dependency-cruiser's baseline format, including its rule, edge, and cycle path.
Known violations remain visible with `ignore` severity and a count in the CI
summary; new violations fail. Do not regenerate the baseline to make CI green.
After #926 merges, remove this entry once all three platform checks pass without
it. Fixture tests verify that a baseline cannot hide a different cycle.

The checks from #926 can coexist under their separate command names. After both
PRs merge, migrate any remaining desired architecture policies explicitly before
retiring its handwritten graph analyzer. Its task-map coverage and file-budget
checks remain separate.

## Reports and verification

`pnpm lint:dependency-architecture` writes six JSON graphs (contract/runtime for
each platform) and six Mermaid layer diagrams under `.artifacts/architecture/`.
Both CI providers upload these files; GitHub Actions also gets a summary table.
The JSON includes dependency-cruiser's folder coupling and instability metrics.
These are observational, include external package edges, and are not identical
to #926's internal-only layer metrics. No uncalibrated instability threshold is
introduced here.

Run `pnpm test:dependency-architecture` for adversarial fixtures covering import
syntax, false positives, type cycles, self cycles, platform and index resolution,
missing local imports, boundary exceptions, test exclusions, and exact baselines.
Run the four root checks from `AGENTS.md` before publishing.

File length and import fan-out are context-cost proxies, not evidence of AI
performance. Actual agent-efficiency evaluation needs comparable tasks and
recorded success, tokens, and completion time; this tool does not measure those.
