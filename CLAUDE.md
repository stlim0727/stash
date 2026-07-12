# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working principles

Behavioral guidelines to reduce common LLM coding mistakes (adapted from [andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills)). These bias toward caution over speed — for trivial tasks, use judgment. The Stash-specific instructions in the rest of this file take precedence where they conflict.

### 1. Think before coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently. (A "wrap up the project" / "you're leaving" request is ambiguous in a way that changes the *entire* deliverable, so confirm the **direction of the handoff** before planning: is the *human* stepping away — wanting a project-for-a-stranger doc with ops/credentials/external-accounts/strategy — or is the *agent* being swapped while the human continues with a new one? The latter wants tacit agent-context flushed into repo-resident memory (`AGENTS.md`/`CLAUDE.md`/`.claude/skills`), because **none of the outgoing agent's conversational context survives** — only committed files cross the boundary; device/Supabase verification and credential ownership drop in priority since the successor agent or the human can do/hold those.)
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity first

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical changes

**Touch only what you must. Clean up only your own mess.**

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.
- Remove imports/variables/functions that YOUR changes made unused; leave pre-existing dead code unless asked.

The test: every changed line should trace directly to the request.

### 4. Goal-driven execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"
- "Fix a mysterious failure" → "Confirm the actual cause with a minimal isolating probe *before* applying a fix" — a plausible theory can be wrong and cost a full cycle (e.g. renaming `node_modules` on the theory that Netlify skips it, when a marker-file probe showed the real cause was dot-directories like `.pnpm`).
- "A test went red after my change" → **don't attribute it from `git diff --stat`.** A test whose file your diff never touched can still fail because your change altered runtime behaviour it only *exercises* — so "my branch doesn't touch that file" does **not** prove "pre-existing." Confirm by reverting *your* files to the base and re-running that one test; if it then passes, you introduced it. And a newly-red test may be the fix working correctly — the old assertion encoded the bug you just fixed (e.g. a test expecting `requestEnrichment(id, undefined)` only passed because an anonymous pull deleted the seeded row; once the data-loss fix preserved the row, the real metadata got sent). Update the assertion to the corrected behaviour; do not revert the fix to make the test green.
- "Build an eval or a pass/fail gate" → **adversarially enumerate how a *bad* output still passes, and make each one a failure.** A PASS that a no-op (empty output), a duplicate, a hallucinated value, or a too-small sample also earns is not a gate. `scripts/tag-merge-eval` needed three review rounds to close its holes — overlapping groups hiding a bad pair, hard negatives that only matched literal names (not class-equivalents), a no-op passing on vacuous precision, out-of-vocab/hallucinated tags, filler tags, a `--runs 1` lucky sample — each "technically PASS, obviously wrong". And keep the graded artifact and the gate in sync (the prompt's filler list must match the scorer's, else you measure instruction-mismatch, not model quality).

For multi-step tasks, state a brief plan with a verification check per step. Strong success criteria let you loop independently; weak criteria ("make it work") require constant clarification.

## What this is

Stash is a mobile bookmark app (React Native + Expo, Supabase backend) inspired by Raindrop.io, with an inbox-first UI and a capture-from-any-app share flow. See `README.md` for product direction and `AGENTS.md` for the detailed, continuously-updated project state and per-milestone implementation notes — **read `AGENTS.md` first** when picking up work; it is the source of truth for what is done and why.

## Commands

pnpm workspace, **Node 22, pnpm 10**. Run everything from the repo root:

- `pnpm dev` (and `dev:android` / `dev:ios` / `dev:web`) — Expo dev server for `apps/mobile`.
- `pnpm lint` — runs three checks (there is no ESLint config): `format:check` (whitespace/final-newline only), `lint:env` (`scripts/check-static-env.mjs`, which enforces how `EXPO_PUBLIC_*` env vars may be referenced), and `lint:overlay` (`scripts/check-overlay-elevation.mjs`, no zIndex-without-elevation overlays). `pnpm format` auto-fixes formatting. **Run it from the repo root — that is the CI lint.** Running `pnpm lint` *inside* `apps/mobile` invokes `expo lint` (ESLint) instead: a separate, already-red baseline **not** wired into CI that also auto-installs `eslint`/`eslint-config-expo` and writes `apps/mobile/eslint.config.js` + mutates `package.json`/`pnpm-lock.yaml` — never commit that churn.
- `pnpm typecheck` — `tsc --noEmit` in `apps/mobile`.
- `pnpm test` — two lanes: the mobile **Node-runner** logic tests **plus** `test:functions` (Supabase edge-function tests under `supabase/functions/**/*.test.ts`).
- `pnpm test:components` — jest-expo + React Native Testing Library for hooks/components.
- `pnpm verify:supabase` — 16-check end-to-end script against a live Supabase project; needs `EXPO_PUBLIC_SUPABASE_URL` + `EXPO_PUBLIC_SUPABASE_ANON_KEY` and anonymous sign-ins enabled.

Test lanes are split by extension. The jest lane (`test:components`) accepts a single file path; the Node lanes hard-code a glob, so appending a path to `pnpm test` unions with it (runs the whole lane) rather than narrowing — to run one `.test.ts` file, invoke node directly: `cd apps/mobile && node --experimental-transform-types --import ../../scripts/register-alias.mjs --test src/domain/<file>.test.ts`.

- **`src/**/*.test.ts`** — pure logic, via Node's built-in runner (`--experimental-transform-types`, `@/` alias resolved by `scripts/register-alias.mjs`). Use fakes, no React.
- **`src/**/*.test.tsx`** — jest, for hooks/components. Lives under `src/__tests__/` so expo-router never treats tests as routes. RNTL v14: `render`/`renderHook`/`fireEvent` are async — `await` them and wrap state changes in `await act(async () => …)`.

Headless build check (no emulator): `cd apps/mobile && CI=1 pnpm exec expo export --platform web` (use `--platform ios` to exercise the native/Hermes + expo-sqlite path); delete the gitignored `dist/` afterward.

## Architecture

Monorepo (`apps/*`, `packages/*`) — currently one app, `apps/mobile` (Expo SDK 56, RN 0.85, expo-router, TypeScript). Routes live in `apps/mobile/src/app`. Key layers under `apps/mobile/src`:

- **`domain/`** — pure, platform-free logic and types. `types.ts` mirrors the snake_case Postgres schema (`docs/architecture/data-model.md`) 1:1 on purpose, for direct row mapping. URL handling (`urls.ts`), metadata enrichment (`enrichment.ts`, `page-metadata.ts`), search, and pending-mutation engines live here and are heavily unit-tested.
- **`storage/`** — durable persistence behind the `BookmarkRepository` interface. Platform is chosen by **Metro platform extensions**: `repository.native.ts` (expo-sqlite) on iOS/Android, `repository.ts` (localStorage / in-memory during SSR) on web. New/changed bookmarks enqueue entries in a local pending queue carrying a sync `operation` (create/update/delete), one entry per bookmark (newer mutations supersede older).
- **`store/bookmarks.tsx`** — React context that orchestrates the **local-first** model: saves/edits are optimistic and persisted immediately, then queued; nothing blocks on the network. Capture must never be broken by enrichment or sync.
- **`api/bookmarks.ts`** — the documented bookmark API surface (`docs/api/bookmarks.md`) implemented against **Supabase REST directly (no `supabase-js`)**, scoped to the authenticated user.
- **`supabase/`** — hand-rolled auth client (anonymous-first sessions, single-flighted creation, refresh/restore) and **browser PKCE OAuth** (Apple/Google) in `oauth.ts` (pure) + `run-oauth.ts` (the one auth file allowed to import native modules).
- **`sync/`** — uploads the queue (server-side idempotent so retries can't duplicate), then incremental pull by `updated_at` watermark; last-write-wins except rows with queued local work. `account-transition.ts` plans anonymous→real (carry over) vs real A→real B (replace) to prevent data loss on account switch (see `docs/architecture/sync-account-switching.md`).
- **`share/`** — `expo-share-intent` capture: extract a URL from the shared payload, save via the normal store path, toast, route to Inbox — no editor. No-op on web.

Backend: `supabase/migrations` (owner-scoped RLS) and `supabase/functions` edge functions (`ai-enrich`, `feedback-bridge`).

## Core conventions

- **Keep user-authored fields separate from generated/AI metadata.** This is the central product principle (`docs/api/bookmarks.md`): enrichment and sync only fill generated fields that are still null and must never overwrite user-typed values. A title has **three** provenances, not two — user-typed, a real *fetched* title, and a URL-derived *fallback* — and `metadata_status: 'complete'` does **not** distinguish the last two; the local-only `Bookmark.title_is_derived` bit records it (set by `enrichBookmark`), so a repair or the UI can trust a recorded fact instead of string-matching the title.
- **A local-only cosmetic repair must never bump `updated_at` or enqueue a sync mutation.** It runs before the startup pull, so a bumped/uploaded *generated* value out-ranks a better cloud row under last-write-wins (`pullRemoteChanges` accepts remote only when `remote.updated_at > local.updated_at`) and strands it. Repair the local view only and let each device self-heal (this is how the title backfill works).
- **Capture is sacred** — saves are local-first and optimistic; enrichment and sync are fire-and-forget and record a failed/skipped status instead of throwing.
- Duplicate saves are idempotent (reuse the existing bookmark); deletes archive by default.
- Domain types stay snake_case to mirror the DB; only reference `EXPO_PUBLIC_*` env vars in the ways `lint:env` permits.

## Branch / release notes

- **Branch strategy: trunk-based + release branches** (`docs/development/branching.md`). `main` is the trunk (next release); each `release/*` branch is the maintenance line for an already-shipped version. Base each change on the line it ships in — features → `main`; bug fixes for a shipped version → its `release/*` branch, then **cherry-pick the fix forward into `main`**. Never merge `main` into a release branch.
- **A large multi-PR feature whose intermediate steps aren't independently shippable** (e.g. the bottom-`(tabs)` nav migration) develops on **one integration branch** and merges to `main` as a **single reviewed unit** — do not land it in `main` step-by-step (a half-migrated trunk is the failure mode: the tab-shell step was merged to `main` and then had to be reverted). Small, self-contained changes still go straight to `main` per trunk-based above.
  - _Corollary — using a `main`-only skill from such a branch:_ a skill added on `main` after your integration branch forked isn't in your checkout. Borrow it **without committing it** to your feature PR: `git checkout origin/main -- .claude/skills/<name>` (then `git restore --staged` it), run it, and restore with `git checkout HEAD -- .claude/skills/<name>` + delete any untracked files it added.
  - _Corollary — follow-up work after a **squash** merge:_ PRs here merge as a **squash**, so your branch's old commits are **not** ancestors of the new `main` (`git merge-base --is-ancestor <oldtip> origin/main` → false). For a follow-up on the same branch you must `git checkout -B <branch> origin/main` and re-commit on top; a normal push then fails (non-fast-forward) and `--force-with-lease` — though correct here, since the branch holds only already-merged history — is **blocked by the auto-mode git classifier and needs explicit user approval**. To avoid that friction, prefer a **fresh branch** for post-merge follow-ups, or ask the user to approve the force-push. **Special case that removes the friction — the remote branch was auto-deleted on merge** (squash + delete-branch-on-merge, the default here): there's no remote branch to force over, so after `checkout -B <branch> origin/main` + re-commit, `--force-with-lease` fails with **`stale info`** (your local `origin/<branch>` ref still points at the deleted branch). Run `git remote prune origin`, then a **plain** `git push -u origin <branch>` recreates it (no force, no classifier prompt); open a **new** PR. (And when `origin/main` has moved, the cherry-pick/re-commit can conflict against files rewritten upstream — resolve against the *current* file, don't push a half-applied state.) (Also: the `stop-hook-git-check.sh` wants the committer to be `noreply@anthropic.com` — `git config user.email noreply@anthropic.com && git config user.name Claude`, then `git commit --amend --no-edit --reset-author` on your commit before pushing.)
- **Pull requests: open as regular (non-draft) PRs, not drafts.**
- **Merging a `STASH-N` PR does NOT auto-close its Sentry issue.** In-app feedback (the `feedback-bridge` → Sentry flow) lands as Sentry issues with short-IDs `STASH-N` in org `self-463` / project `stash`; PRs that fix them are titled `STASH-N: …`. Sentry's GitHub integration only auto-resolves an issue when a **merged commit message contains `Fixes STASH-N`** — and since PRs here **squash-merge with the title as the commit message**, a `STASH-N:` *prefix* (not the `Fixes` keyword) never triggers it. So after merging, the issue stays `unresolved`: either put `Fixes STASH-N` in the PR title/squash body, or resolve it by hand in Sentry. The Sentry MCP in these sessions is **read-only** (no resolve/update-issue tool). The `sentry__search_issues` tool is currently unavailable due to a temporary Sentry MCP server configuration issue. Check https://self-463.sentry.io/issues/?project=stash for real-time status. Do NOT rely on local docs (like AGENTS.md or build-history.md) to look up open/active Sentry issues as they only record historically resolved issues. Active feedback issues must be checked on Sentry directly or provided by the user.
- CI runs on **CircleCI** (`.circleci/config.yml`): the `ci` workflow runs, in order, `pnpm lint`, `pnpm typecheck`, `pnpm test`, **and `pnpm test:components`** on every PR — so the jest component lane is a real gate. A green `pnpm test` locally is **not** sufficient before pushing; run `pnpm test:components` too (it caught a data-loss-fix regression that the node lanes couldn't). Migrated off GitHub Actions (quota exhausted); see `docs/development/ci-circleci.md`. **Exception: the Android APK build stays on GitHub Actions** (see next bullet).
- Installable Android APK without an EAS account: the GitHub Actions `android-apk.yml` workflow (`expo prebuild` → Gradle `assembleRelease`, debug-signed standalone, arm64-v8a only). It lives on GitHub Actions rather than CircleCI because the RN native compile needs more RAM than this project's CircleCI Docker plan allows (8 GB `large`, no swap → OOM); it's an infrequent job (release tags / manual dispatch), so only it moved back. Trigger/output mapping is documented in `AGENTS.md`. EAS profiles for store builds live in `apps/mobile/eas.json`; release flow in `docs/development/releasing.md`.
