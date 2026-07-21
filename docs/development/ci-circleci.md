# CI on CircleCI (+ GitHub Actions, dual)

Stash's primary CI gate is **CircleCI** (`.circleci/config.yml`). It was
migrated off GitHub Actions when the Actions quota was exhausted; the old
workflows are preserved in git history under `.github/workflows/` before that
change.

**The gate now also runs on GitHub Actions** (`.github/workflows/ci.yml`),
restored from that same git history, in parallel — added when the CircleCI
plan ran out of credits, so PRs still get a real lint/typecheck/test signal
even when CircleCI can't run. Both workflows run the same steps (lint,
typecheck, `pnpm test`, `pnpm test:components`, web export) on every
push/PR; keep them in sync if the gate's steps change. The Android APK build
and the rest of the manual/opt-in jobs below stay CircleCI/Actions-specific
as documented.

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
