---
name: rc-build
description: >-
  Cut the next Android RC build for Stash and run the standard follow-ups in one
  go: (1) build the next `vX.Y.Z-rcN` APK via the Android APK workflow, (2) confirm
  the Firebase App Distribution cleanup (now a nightly CircleCI job, no longer an
  agent-dispatched step), and (3) print a QA checklist of everything fixed/changed
  in the last 24h. Use whenever the user asks to "build the next rc", "cut an rc + clean
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
from the trunk). Only **Step 1** is an agent action — a GitHub Actions
`workflow_dispatch` on `android-apk.yml` via `mcp__github__actions_run_trigger`
(no git tag, no PR required; the `dev` release self-records the label, see Step 1).
**Step 2 (cleanup) is no longer an agent step** — it runs automatically on
CircleCI (see Step 2). Step 3 is a local `git log` + classification.

## Step 1 — Build the next RC APK

1. **Find the next rc number.** Resolve the target `X.Y.Z` from `apps/mobile/app.json` `version` **first** — that is the cycle you're building. Then:
   - **Read the rolling `dev` release** — `mcp__github__get_release_by_tag(owner="stlim0727", repo="stash", tag="dev")`. Its `name` now carries the label (`Development build — vX.Y.Z-rcN (latest)`, stamped by `android-apk.yml` since #302). **Only trust its `rcN` when the label's `X.Y.Z` equals `app.json`'s `version`.**
     - **Match** → next is `rc(N+1)`.
     - **`app.json` is ahead of the `dev` label** (a fresh cycle bump with no RC built yet — e.g. `app.json` says `1.2.0` but `dev` still reads `v1.1.0-rcN`) → the label is **stale**; start the new cycle at **`rc1`** (`vX.Y.Z-rc1` from `app.json`). Do **not** carry the old cycle's number forward.
   - **Cross-check** the current cycle's table in `docs/development/build-history.md` (next = highest `-rcN` + 1). If that cycle has no table yet (a fresh version bump), it's `rc1` and you create the section.
   - Break ties **only within the same `X.Y.Z`**: if the `dev` label and the ledger disagree for the *same* version, prefer the `dev` release (it reflects the last *actual* build) and note the discrepancy. A cross-version disagreement is not a tie — `app.json` wins and the cycle restarts at `rc1`.
2. **Confirm there's new code to ship.** `git fetch origin main` then compare the `dev` release's `target_commitish` to `origin/main` HEAD (`git log <dev_sha>..origin/main --oneline`). If **nothing** changed, do **not** cut a new rc for identical code — say so (per the versioning golden rule: same code ⇒ keep the version, only the build number changes). Proceed only when there are new commits.
   - **If this RC exists to ship a specific fix, confirm that fix is actually on `main` HEAD (merged) before dispatching.** RCs build from `main`, so cutting one while the fix is still on an open PR just reships the bug (this happened: rc13 was dispatched before the anonymous-fallback fix #375 merged, so rc14 had to follow once it landed). Verify the fix commit/PR is in `git log <dev_sha>..origin/main` — don't build on the *intent* to merge.
3. **Check for open PRs against `main`** — `mcp__github__list_pull_requests(state="open", base="main")`. If any open PR looks like it belongs in this RC, ask the user whether to wait for it before building; otherwise proceed. (Ignore infra/docs PRs that clearly don't belong.)
4. **Dispatch the build:**
   ```
   mcp__github__actions_run_trigger(
     method="run_workflow", owner="stlim0727", repo="stash",
     workflow_id="android-apk.yml", ref="main",
     inputs={ "version": "vX.Y.Z-rcN" })   # e.g. v1.1.0-rc4
   ```
   Always pass the `version` input — it stamps `APP_VERSION` into the APK and, since #302, into the `dev` release name/body, which is what makes the rc number self-recording (no ledger PR needed). A hyphenated `-rcN` refreshes the rolling **`dev`** prerelease in place.
5. **Logging & Release Notes:** Logging in `build-history.md` is optional. However, to attach a release note / QA checklist to the GitHub `dev` release, write the compiled notes to `docs/release-notes/vX.Y.Z-rcN.md` (e.g. `docs/release-notes/v1.2.0-rc19.md`), commit, and push it to `main` before triggering the build dispatch.

## Step 2 — Cleanup runs automatically on CircleCI (nothing to dispatch)

The GitHub Actions `ops.yml` this step used to fire **was removed** in the
CircleCI migration (#288). Do **not** try to `workflow_dispatch` it — that 422s
("Workflow does not have 'workflow_dispatch' trigger"). Cleanup is now split:

- **Firebase App Distribution releases** → ported to the CircleCI job
  `ops_firebase_cleanup` (`.circleci/config.yml`). It runs **nightly** as a real
  delete that keeps the newest `KEEP=20` and prunes releases older than
  `MAX_AGE_DAYS=7`. Those bounds are **baked into the job as env**, not per-run
  inputs, so there is nothing to pass and nothing for the agent to fire during
  an RC build. The `nightly-ops` workflow itself is gated on the
  `run_nightly_ops` pipeline parameter, fired daily at `17 4 * * *` UTC by a
  **CircleCI Scheduled Pipeline** (project settings → Triggers, not YAML) —
  this project is on the GitHub App integration, and the old inline
  `triggers: - schedule:` key silently never fires for GitHub-App-connected
  projects. (It shipped that way and went stale for ~a week before anyone
  noticed the backlog; if the nightly job ever seems to have stopped running
  again, check the Scheduled Pipeline still exists via
  `GET /project/{slug}/schedule` before assuming the cleanup logic itself broke.)
- **GitHub Actions artifact prune** → **retired** (intentionally not ported in
  #288). Only `android-apk.yml` still produces Actions artifacts now; if that
  quota ever needs pruning it's a separate, manual concern.

So for an RC build there is **no cleanup to dispatch** — just note that tonight's
nightly CircleCI job handles Firebase. The agent **cannot** trigger it: CircleCI
is not reachable through the GitHub MCP tools (`mcp__github__actions_*` only see
GitHub Actions). If a manual run is genuinely needed:
- **Preview** — the `run_ops` CircleCI pipeline runs `ops_firebase_cleanup` with
  `dry_run: true` (lists what would go, deletes nothing).
- **Force a real prune** — trigger `ops_firebase_cleanup` from the CircleCI UI/API
  (or just wait for `nightly-ops`). Changing `KEEP`/`MAX_AGE_DAYS` means editing
  the job in `.circleci/config.yml`, not passing an input.

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
5. **Attach to Release Notes:** Write this markdown checklist to `docs/release-notes/vX.Y.Z-rcN.md` (e.g. `docs/release-notes/v1.2.0-rc19.md`). Commit and push this file to the remote `main` branch **before** dispatching the build. This ensures that the GitHub Actions run picks up the file and prepends it to the release notes on BOTH GitHub and Firebase App Distribution.

## Report

End with a compact summary of all three:
- **Built:** `vX.Y.Z-rcN` (android-apk.yml on `main` @ `<sha>`) → refreshes `dev`.
- **Cleaned:** nothing to dispatch — Firebase cleanup runs nightly on CircleCI
  (`ops_firebase_cleanup`, `17 4 * * *` UTC); the GitHub-artifact prune is retired.
- **Checklist:** the grouped 24h QA list (also committed to `docs/release-notes/vX.Y.Z-rcN.md` and attached to the GitHub and Firebase releases).
- Offer to confirm the **build** outcome once `android-apk.yml` finishes.
