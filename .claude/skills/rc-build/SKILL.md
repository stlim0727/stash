---
name: rc-build
description: >-
  Cut the next Android RC build for Stash and run the standard follow-ups in one
  go: (1) build the next `vX.Y.Z-rcN` APK via the Android APK workflow, (2) clean
  up stale CI artifacts on GitHub + old Firebase App Distribution releases via the
  Ops workflow, and (3) print a QA checklist of everything fixed/changed in the
  last 24h. Use whenever the user asks to "build the next rc", "cut an rc + clean
  up", "ship a new rc build", "new rc apk", or "rc checklist". Produces the same
  three-part outcome every time from the repo's real state.
---

# Build the next RC (build → clean up → checklist)

The operational sequence for cutting an Android release candidate and its
routine follow-ups. This is the *doer* companion to the `versioning` skill (which
decides *what* the next version is): run `versioning` if you need to reason about
MINOR/PATCH or a stable cut; run **this** to actually build the next RC and do
the housekeeping. Do the three steps in order and report all three at the end.

Repo: **`stlim0727/stash`**. Branch to build from: **`main`** (RCs always ship
from the trunk). All three steps are GitHub Actions `workflow_dispatch` calls via
`mcp__github__actions_run_trigger` — no git tag, no PR required (RCs leave no tag;
the `dev` release self-records the label, see Step 1).

## Step 1 — Build the next RC APK

1. **Find the next rc number.** In order of authority:
   - **Read the rolling `dev` release** — `mcp__github__get_release_by_tag(owner="stlim0727", repo="stash", tag="dev")`. Its `name` now carries the label (`Development build — v1.1.0-rcN (latest)`, stamped by `android-apk.yml` since #302). Parse `vX.Y.Z-rcN` → next is `rc(N+1)`.
   - **Fallback / cross-check:** the current cycle's table in `docs/development/build-history.md` (next = highest `-rcN` + 1) and `apps/mobile/app.json` `version` (the `X.Y.Z`). If `app.json`'s version has no matching build-history cycle yet (a fresh version bump), the cycle is new → next is `rc1`.
   - If the `dev` label and the ledger disagree, prefer the `dev` release (it reflects the last *actual* build) and note the discrepancy.
2. **Confirm there's new code to ship.** `git fetch origin main` then compare the `dev` release's `target_commitish` to `origin/main` HEAD (`git log <dev_sha>..origin/main --oneline`). If **nothing** changed, do **not** cut a new rc for identical code — say so (per the versioning golden rule: same code ⇒ keep the version, only the build number changes). Proceed only when there are new commits.
3. **Check for open PRs against `main`** — `mcp__github__list_pull_requests(state="open", base="main")`. If any open PR looks like it belongs in this RC, ask the user whether to wait for it before building; otherwise proceed. (Ignore infra/docs PRs that clearly don't belong.)
4. **Dispatch the build:**
   ```
   mcp__github__actions_run_trigger(
     method="run_workflow", owner="stlim0727", repo="stash",
     workflow_id="android-apk.yml", ref="main",
     inputs={ "version": "vX.Y.Z-rcN" })   # e.g. v1.1.0-rc4
   ```
   Always pass the `version` input — it stamps `APP_VERSION` into the APK and, since #302, into the `dev` release name/body, which is what makes the rc number self-recording (no ledger PR needed). A hyphenated `-rcN` refreshes the rolling **`dev`** prerelease in place.
5. **Logging is now optional.** The `dev` release self-records the label, so a `build-history.md` row is narrative-only, not required. Only add one (via a normal PR) if the user wants the per-rc "what's new" history preserved.

## Step 2 — Clean up stale artifacts (> 24h)

Both use the **Ops** workflow (`ops.yml`), which is day-granular — 24h = `days=1`,
which fits its built-in tasks exactly (no `run-command` needed). Fire both:

- **GitHub Actions artifacts** (the ~80 MB APK per build eats the account's
  artifact quota):
  ```
  mcp__github__actions_run_trigger(
    method="run_workflow", owner="stlim0727", repo="stash",
    workflow_id="ops.yml", ref="main",
    inputs={ "task": "delete-artifacts-older-than-days", "days": "1" })
  ```
- **Firebase App Distribution releases** (keeps the newest 20 regardless of age):
  ```
  mcp__github__actions_run_trigger(
    method="run_workflow", owner="stlim0727", repo="stash",
    workflow_id="ops.yml", ref="main",
    inputs={ "task": "firebase-delete-old-releases", "days": "1", "keep": "20" })
  ```

Notes:
- **Sub-day thresholds aren't supported.** `date -d "0.5 days ago"` is rejected and
  the Firebase cleanup script's `intInput` requires a whole non-negative integer.
  If the user asks for e.g. "12 hours", either round to `days=1` (confirm) or use
  the `run-command` task with a custom `date -d '12 hours ago'` cutoff for the
  GitHub side (Firebase has no hours path without a workflow change).
- **Want a preview first?** Run `firebase-list-releases` (dry run, same `days`/`keep`)
  before the delete to show exactly what would go.

## Step 3 — Checklist of what changed in the last 24h

1. Gather the window: `git log origin/main --since='24 hours ago' --format='%h %ci %s'`.
2. Classify each commit by its conventional-commit prefix / subject:
   - `fix(...)` / `Fix:` → **🐛 Fixes**
   - `feat(...)` → **✨ Features / UX** — but route `feat(observability)` /
     Sentry / watchdog / ANR work to **📊 Observability (verify no regressions)**.
   - `ci` / `build` / `docs` / `test` / `chore` → **🔧 Non-app (no QA needed)** —
     list them but don't add checkboxes.
3. For each app-facing item write **one checkbox** with (a) the change and (b) a
   concrete *what-to-verify* step a tester can follow. If the one-line subject
   isn't enough to write a meaningful verification, open the PR
   (`mcp__github__pull_request_read`) for the "why" before writing the line.
4. Emit the checklist as GitHub-flavored markdown, headed by the build under test
   (`vX.Y.Z-rcN @ <sha>`), grouped by the categories above.

## Report

End with a compact summary of all three:
- **Built:** `vX.Y.Z-rcN` (android-apk.yml on `main` @ `<sha>`) → refreshes `dev`.
- **Cleaned:** GitHub artifacts + Firebase releases > 24h (which runs, dispatched).
- **Checklist:** the grouped 24h QA list.
- Offer to confirm each run's outcome once the dispatched workflows finish.
