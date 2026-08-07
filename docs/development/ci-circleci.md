# CI on CircleCI (+ GitHub Actions, dual)

Stash's primary CI gate is **CircleCI** (`.circleci/config.yml`). It was
migrated off GitHub Actions when the Actions quota was exhausted; the old
workflows are preserved in git history under `.github/workflows/` before that
change.

**The gate can also run on GitHub Actions** (`.github/workflows/ci.yml`),
restored from that same git history — added when the CircleCI plan ran out
of credits, so PRs can still get a real lint/typecheck/test signal when
CircleCI can't run. Both workflows run the same steps (lint, typecheck,
`pnpm test`, `pnpm test:components`, web export); keep them in sync if the
gate's steps change.

Only one provider is meant to actually run the gate at a time — running both
on every push burns CircleCI credits and Actions minutes simultaneously for
no benefit. The GitHub Actions `checks` job is gated by a repo variable:

| `CI_PROVIDER` repo variable | GitHub Actions `ci.yml` | CircleCI `ci` workflow |
| --- | --- | --- |
| `github` | runs the gate | still triggers (CircleCI has no matching gate — pause the project in the CircleCI dashboard, e.g. Project Settings, if you want to stop it from queuing/spending credits) |
| unset / anything else (default) | skipped — no runner allocated, no minutes billed | runs the gate |

Set it at *GitHub repo → Settings → Secrets and variables → Actions →
Variables → `CI_PROVIDER`*. Flip it back to unset (or delete it) once
CircleCI has credits again.

When `CI_PROVIDER` is set to `github`:
- The automated nightly Firebase App Distribution release cleanup runs on GitHub Actions (via `.github/workflows/firebase-cleanup.yml` scheduled at `17 4 * * *` UTC) instead of CircleCI. The CircleCI `ops_firebase_cleanup` job will automatically check the variable via the GitHub API (using `GH_TOKEN` or `GITHUB_TOKEN`) or the `CI_PROVIDER` environment variable and halt itself.
- The Android APK build and other manual/opt-in jobs remain provider-specific as documented.

## One-time setup

1. **Connect the repo** at <https://app.circleci.com> → *Projects* → *Set Up
   Project* → use the existing `.circleci/config.yml`.
2. **Add environment variables** (*Project Settings → Environment Variables*, or
   a shared *Context*). These replace the GitHub repository *secrets*/*variables*
   of the same name — the jobs read them straight from the shell:

   | Variable | Used by | Notes |
   | --- | --- | --- |
   | `EXPO_PUBLIC_SUPABASE_URL` | apk, secrets-check | inlined into the APK bundle |
   | `EXPO_PUBLIC_SUPABASE_ANON_KEY` | apk | |
   | `EXPO_PUBLIC_SENTRY_DSN` | apk, secrets-check | |
   | `FIREBASE_APP_ID` | apk, app-testing, ops | optional — steps skip if unset |
   | `FIREBASE_SERVICE_ACCOUNT` | apk, app-testing, ops | raw or base64 service-account JSON |
   | `FIREBASE_TESTER_GROUPS` | apk | defaults to `testers` |
   | `FIREBASE_TEST_DEVICES` / `FIREBASE_TEST_NAME_PATTERN` | app-testing | optional |
   | `FIREBASE_TEST_CASES` / `FIREBASE_TEST_DEVICES` | apk (post-distribution App Testing) | both required to run the agent after a release build; `FIREBASE_TEST_NON_BLOCKING` / `FIREBASE_TEST_USERNAME` / `FIREBASE_TEST_PASSWORD` / `*_RESOURCE` optional |
   | `SENTRY_AUTH_TOKEN` / `SENTRY_ORG` / `SENTRY_PROJECT` | sentry release | release skips if token unset |
   | `GH_TOKEN` (or `GITHUB_TOKEN`) | apk | PAT with `contents:write`, used to publish the GitHub Release; the build still runs (APK in CircleCI artifacts) without it |
   | `SUPABASE_ACCESS_TOKEN` | GitHub Actions `supabase-live-check.yml` (`migration-drift` job) only | a Supabase *account* personal access token (Dashboard → Account → Access Tokens, not the project anon/service key); used read-only via the Management API to list applied migrations. Job skips itself with a clear log message if unset. |

## What runs when

| Workflow | Trigger | Ported from |
| --- | --- | --- |
| `ci` (lint + typecheck + tests) | every push / PR | `ci.yml` |
| `release` (Sentry release) | a `v*` git tag | `sentry-release.yml` |
| `nightly-ops` (Firebase release cleanup) | pipeline param `run_nightly_ops=true` — **manual only, CircleCI web UI "Trigger Pipeline" on `main`**. There is no working scheduler, and the REST API can't trigger it either (`POST /project/.../pipeline` 400s for this standalone project): the old inline `triggers: - schedule:` never fired, and CircleCI Scheduled Pipelines (the supported replacement) return "not supported for standalone projects" for this project | `ops.yml` (Firebase task only) |
| `manual-screenshots` | pipeline param `run_screenshots=true` | `android-screenshots.yml` |
| `manual-app-testing` | pipeline param `run_app_testing=true` | `app-testing.yml` |
| `manual-secrets-check` | pipeline param `run_secrets_check=true` | `secrets-check.yml` |
| `manual-ops` | pipeline param `run_ops=true` (dry-run cleanup) | `ops.yml` |

> **The Android APK build runs on GitHub Actions, not CircleCI**
> (`.github/workflows/android-apk.yml`). The app's React Native native compile
> needs more memory than this project's CircleCI plan allows — CircleCI Docker
> caps at the 8 GB `large` class (and `xlarge` is not in-plan), which OOM-kills
> the build; the GitHub-hosted runners (16 GB + swap) build it fine. It's the
> one heavy, infrequent job (release `v*` tags + manual dispatch), so it stays
> on Actions while the every-push CI gate stays on CircleCI. Trigger it by
> pushing a `v*` tag or via the workflow's `workflow_dispatch` (`version` input).

> **Live production checks run on GitHub Actions only, on a schedule**
> (`.github/workflows/supabase-live-check.yml`), independent of `CI_PROVIDER`
> (this isn't ported to CircleCI — its scheduler doesn't work for this
> standalone project, same limitation as `nightly-ops` above). It runs nightly,
> on manual dispatch, and right after any push to `main` touching
> `supabase/migrations/**`. Two jobs: `migration-drift` diffs local migration
> files against what's actually applied on the live project (needs the
> `SUPABASE_ACCESS_TOKEN` secret, see the table above), and `verify-supabase`
> runs `pnpm verify:supabase` against production. This exists because a
> migration (`20260712000000_realtime_broadcast_policies.sql`) was merged to
> main but never applied live for weeks, silently breaking Realtime for every
> user — nothing caught it until users hit the failure (STASH-5V/5T/5W).

Trigger a manual CircleCI workflow from the CircleCI UI (*Trigger Pipeline* → add
the parameter) or the API, e.g.:

```sh
curl -X POST https://circleci.com/api/v2/project/gh/<org>/<repo>/pipeline \
  -H "Circle-Token: $CIRCLE_TOKEN" -H 'content-type: application/json' \
  -d '{"branch":"main","parameters":{"run_screenshots":true}}'
```

## GitHub Actions → CircleCI mapping

| Actions concept | CircleCI equivalent |
| --- | --- |
| `${{ github.sha }}` | `$CIRCLE_SHA1` |
| `${{ github.ref_name }}` | `$CIRCLE_TAG` (tags) / `$CIRCLE_BRANCH` |
| `${{ github.run_number }}` | `$CIRCLE_BUILD_NUM` |
| `${{ github.repository }}` | `$CIRCLE_PROJECT_USERNAME/$CIRCLE_PROJECT_REPONAME` |
| repository `secrets.X` | project/context env var `X` |
| `actions/upload-artifact` | `store_artifacts` |
| `actions/cache` | `restore_cache` / `save_cache` |
| `softprops/action-gh-release` | `gh release create/edit/upload` (needs `GH_TOKEN`) |
| `reactivecircus/android-emulator-runner` | `circleci/android` orb emulator |
| `getsentry/action-release` | `@sentry/cli` |

The repo helper scripts (`scripts/firebase-*.mjs`,
`apps/mobile/.maestro/run-ci-screenshots.sh`) are reused unchanged; the jobs
export the `GITHUB_WORKSPACE` / `GITHUB_OUTPUT` shims those scripts expect.

## Intentionally not ported

- **`ops.yml`'s GitHub-Actions-artifact pruning** and its `gh` *run-command*
  escape hatch — both are Actions-specific (CircleCI expires its own artifacts
  automatically). Only the portable Firebase-release cleanup carries over.
- **The android-screenshots "detect changed screen code" auto-trigger** — it
  used the GitHub PR-files API. On CircleCI screenshots are opt-in via
  `run_screenshots`; wiring auto-detection back up would need the
  `path-filtering` orb + dynamic config.
- **The 3× fresh-emulator retry** in screenshots is reduced to the orb's single
  managed emulator (the no-screenshots guard and visual-diff gate are kept).
