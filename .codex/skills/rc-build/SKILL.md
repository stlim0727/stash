---
name: rc-build
description: >-
  Cut the next Android RC build for Stash and run the standard follow-ups in one
  go: (1) build the next `vX.Y.Z-rcN` APK via the Android APK workflow, (2) remind
  the user to run the Firebase App Distribution cleanup manually (there is no
  working scheduler — see Step 2), and (3) print a QA checklist of everything
  fixed/changed in the last 24h. Use whenever the user asks to "build the next rc",
  "cut an rc + clean up", "ship a new rc build", "new rc apk", or "rc checklist".
  Produces the same three-part outcome every time from the repo's real state.
---

# Build the next RC (build → clean up → checklist)

The operational sequence for cutting an Android release candidate and its
routine follow-ups. This is the *doer* companion to the `versioning` skill (which
decides *what* the next version is): run `versioning` if you need to reason about
MINOR/PATCH or a stable cut; run **this** to actually build the next RC and do
the housekeeping. Do the three steps in order and report all three at the end.

Repo: **`stlim0727/stash`**. Branch to build from: **`main`** (RCs always ship
from the trunk). Only **Step 1** is an agent action: trigger GitHub Actions
`workflow_dispatch` on `android-apk.yml` with the `version` input. In Codex,
first use `tool_search` for a GitHub workflow-dispatch tool. If no dispatch tool
is exposed, do not push an RC git tag as a substitute; report the exact
`workflow_dispatch` payload for the user to run and complete the local
classification/checklist steps.
**Step 2 (cleanup) has no working automatic trigger** — see Step 2 for why, and
remind the user to fire it manually. Step 3 is a local `git log` + classification.

## Step 1 — Build the next RC APK

`android-apk.yml` now computes the next `vX.Y.Z-rcN` itself when `version` is
left blank (from `apps/mobile/app.json` and the `dev` release's tracked rc
state), so a blank dispatch is a safe fallback. Still resolve the number
yourself first — it's what you log in `build-history.md`, and it's the
cross-check that catches a stale/mistracked marker before it reaches CI.

1. **Find the next rc number.** Resolve the target `X.Y.Z` from `apps/mobile/app.json` `version` **first** — that is the cycle you're building. Then:
   - **Read the rolling `dev` release** using the GitHub app if a release-by-tag
     tool is exposed; otherwise use local `refs/tags/dev` plus
     `docs/development/build-history.md` as the fallback. Its `name` carries the
     label (`Development build — vX.Y.Z-rcN (latest)`, stamped by
     `android-apk.yml` since #302), **but check the `body` first for a hidden
     `<!-- rc-state: vX.Y.Z-rcN -->` marker** — the workflow's blank-dispatch
     allocator writes the real rc there and it survives a non-rc test build
     (e.g. `v1.2.3-test1`) overwriting the name; the name alone can be stale in
     that case. If neither is legible or you're unsure which is current, leave
     `version` blank on dispatch — the workflow resolves it the same way.
     **Only trust the resolved `rcN` when its `X.Y.Z` equals `app.json`'s
     `version`.**
     - **Match** → next is `rc(N+1)`.
     - **`app.json` is ahead of the `dev` label** (a fresh cycle bump with no RC built yet — e.g. `app.json` says `1.2.0` but `dev` still reads `v1.1.0-rcN`) → the label is **stale**; start the new cycle at **`rc1`** (`vX.Y.Z-rc1` from `app.json`). Do **not** carry the old cycle's number forward.
   - **Cross-check** the current cycle's table in `docs/development/build-history.md` (next = highest `-rcN` + 1). If that cycle has no table yet (a fresh version bump), it's `rc1` and you create the section.
   - Break ties **only within the same `X.Y.Z`**: if the `dev` label and the ledger disagree for the *same* version, prefer the `dev` release (it reflects the last *actual* build) and note the discrepancy. A cross-version disagreement is not a tie — `app.json` wins and the cycle restarts at `rc1`.
2. **Confirm there's new code to ship.** `git fetch origin main tag dev --force`,
   then resolve the shipped base from the rolling `dev` tag commit:
   `git rev-parse refs/tags/dev`. Do not trust the GitHub Release object's
   `target_commitish` after the rolling release exists; the workflow force-moves
   the `dev` tag while release metadata can remain stale or branch-shaped.
   Compare that tag commit to `origin/main` HEAD
   (`git log refs/tags/dev..origin/main --oneline`). If **nothing** changed, do
   **not** cut a new rc for identical code — say so (per the versioning golden
   rule: same code ⇒ keep the version, only the build number changes). Proceed
   only when there are new commits.
   - **If this RC exists to ship a specific fix, confirm that fix is actually on
     `main` HEAD (merged) before dispatching.** RCs build from `main`, so cutting
     one while the fix is still on an open PR just reships the bug (this
     happened: rc13 was dispatched before the anonymous-fallback fix #375 merged,
     so rc14 had to follow once it landed). Verify the fix commit/PR is in
     `git log refs/tags/dev..origin/main` — don't build on the *intent* to merge.
3. **Check for open PRs against `main`** — use
   `mcp__codex_apps__github._search_prs` with `repository_full_name:
   "stlim0727/stash"`, `state: "open"`, and query `base:main`. If any open PR
   looks like it belongs in this RC, ask the user whether to wait for it before
   building; otherwise proceed. (Ignore infra/docs PRs that clearly don't
   belong.)
4. **Dispatch the build:**
   ```
   # Use the GitHub workflow-dispatch tool if exposed by tool_search.
   owner/repo: stlim0727/stash
   workflow_id: android-apk.yml
   ref: main
   inputs: { "version": "vX.Y.Z-rcN" }   # e.g. v1.1.0-rc4
   ```
   Always pass the `version` input — it stamps `APP_VERSION` into the APK and, since #302, into the `dev` release name/body, which is what makes the rc number self-recording (no ledger PR needed). A hyphenated `-rcN` refreshes the rolling **`dev`** prerelease in place.
5. **Logging & Release Notes:** Logging in `build-history.md` is optional. However, to attach a release note / QA checklist to the GitHub `dev` release, write the compiled notes to `docs/release-notes/vX.Y.Z-rcN.md` (e.g. `docs/release-notes/v1.2.0-rc19.md`), commit, and push it to `main` before triggering the build dispatch.

## Step 2 — Cleanup has no working scheduler; nudge the user to run it manually

The GitHub Actions `ops.yml` this step used to fire **was removed** in the
CircleCI migration (#288). Do **not** try to `workflow_dispatch` it — that 422s
("Workflow does not have 'workflow_dispatch' trigger"). Cleanup is now split:

- **Firebase App Distribution releases** → ported to the CircleCI job
  `ops_firebase_cleanup` (`.circleci/config.yml`), which keeps the newest
  `KEEP=20` and prunes releases older than `MAX_AGE_DAYS=7` (baked into the job
  as env, not per-run inputs). The `nightly-ops` workflow that runs it is gated
  on the `run_nightly_ops` pipeline parameter — **there is currently no
  scheduler that sets it**. The original inline `triggers: - schedule:` key
  silently never fired (confirmed via the CircleCI API — this project has zero
  schedule-triggered pipelines, ever), and its intended replacement, CircleCI
  **Scheduled Pipelines** (project settings → Triggers), returns "Scheduled
  pipelines is not supported for standalone projects" for this project — it's
  connected via the GitHub App but was never claimed into a real CircleCI
  Organization/plan. **Until someone claims the project into an org (the clean
  fix) or wires up another scheduler, this cleanup only ever runs when a human
  fires it from the CircleCI UI.** Don't describe it as automatic/nightly —
  that's what let 22+ stale releases pile up silently (fixed in PR #545).
- **GitHub Actions artifact prune** → **retired** (intentionally not ported in
  #288). Only `android-apk.yml` still produces Actions artifacts now; if that
  quota ever needs pruning it's a separate, manual concern.

So for an RC build: **remind the user to trigger the cleanup manually** — the
agent can't do it for them. It's not reachable through the GitHub app tools
(they only see GitHub Actions), and the CircleCI REST API also rejects
programmatic pipeline triggers for this standalone project
(`POST /project/.../pipeline` 400s: "This API is not yet supported for this
GitHub App or GitLab project"), so even a personal API token can't fire it from
here — only the CircleCI web UI's "Trigger Pipeline" button can:
- **Preview** — the `run_ops` pipeline parameter runs `ops_firebase_cleanup`
  with `dry_run: true` (lists what would go, deletes nothing).
- **Real prune** — set `run_nightly_ops=true` (real delete path, restricted to
  `main` by a job filter). Changing `KEEP`/`MAX_AGE_DAYS` means editing the job
  in `.circleci/config.yml`, not passing an input.

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
   (GitHub app PR metadata/diff tools, or local `git show`) for the "why"
   before writing the line.
4. Emit the checklist as GitHub-flavored markdown, headed by the build under test
   (`vX.Y.Z-rcN @ <sha>`), grouped by the categories above.
5. **Attach to Release Notes:** Write this markdown checklist to `docs/release-notes/vX.Y.Z-rcN.md` (e.g. `docs/release-notes/v1.2.0-rc19.md`). Commit and push this file to the remote `main` branch **before** dispatching the build. This ensures that the GitHub Actions run picks up the file and prepends it to the release notes on BOTH GitHub and Firebase App Distribution.

## Report

End with a compact summary of all three:
- **Built:** `vX.Y.Z-rcN` (android-apk.yml on `main` @ `<sha>`) → refreshes `dev`.
- **Cleaned:** remind the user to trigger `ops_firebase_cleanup` manually from
  the CircleCI UI (`run_nightly_ops=true`) — no scheduler is wired up yet; the
  GitHub-artifact prune is retired.
- **Checklist:** the grouped 24h QA list (also committed to `docs/release-notes/vX.Y.Z-rcN.md` and attached to the GitHub and Firebase releases).
- Offer to confirm the **build** outcome once `android-apk.yml` finishes.
