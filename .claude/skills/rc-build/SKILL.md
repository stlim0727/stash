---
name: rc-build
description: >-
  Cut the next Android RC build for Stash and run the standard follow-ups in one
  go: (1) build the next `vX.Y.Z-rcN` APK via the CircleCI android_apk job, (2)
  note the (now mostly automatic) cleanup of stale Firebase App Distribution
  releases, and (3) print a QA checklist of everything fixed/changed in the last
  24h. Use whenever the user asks to "build the next rc", "cut an rc + clean up",
  "ship a new rc build", "new rc apk", or "rc checklist". Produces the same
  three-part outcome every time from the repo's real state.
---

# Build the next RC (build → clean up → checklist)

The operational sequence for cutting an Android release candidate and its
routine follow-ups. This is the *doer* companion to the `versioning` skill (which
decides *what* the next version is): run `versioning` if you need to reason about
MINOR/PATCH or a stable cut; run **this** to actually build the next RC and do
the housekeeping. Do the three steps in order and report all three at the end.

Repo: **`stlim0727/stash`**. Branch to build from: **`main`** (RCs always ship
from the trunk). **CI is CircleCI** (`.circleci/config.yml`) — the build is
triggered by the `android_apk` job, not a GitHub Actions `workflow_dispatch`.
The canonical trigger (below) is the `run_apk` pipeline parameter, which leaves
**no git tag** (RCs are tagless); the `dev` release self-records the label.

## How the build gets triggered (read this first)

Two ways to start the CircleCI `android_apk` build:

- **Canonical — CircleCI API `run_apk` (no tag, no Sentry release):**
  ```bash
  curl -X POST https://circleci.com/api/v2/project/gh/stlim0727/stash/pipeline \
    -H "Circle-Token: $CIRCLE_TOKEN" -H 'content-type: application/json' \
    -d '{"branch":"main","parameters":{"run_apk":true,"version":"vX.Y.Z-rcN"}}'
  ```
  Needs a CircleCI Personal API Token in `CIRCLE_TOKEN`. Runs only the
  `android_apk` job → refreshes the rolling `dev` prerelease. This is the
  tagless path that matches the old `workflow_dispatch` behaviour.

- **Alternative — push a tag (`vX.Y.Z-rcN`):** triggers the `release` workflow,
  which runs `android_apk` **and** `sentry_release`. Use when you also want the
  Sentry release marked, or when no `CIRCLE_TOKEN` is available. Leaves a tag.
  ```bash
  git fetch origin main && git tag vX.Y.Z-rcN origin/main && git push origin vX.Y.Z-rcN
  ```

**Environment caveat.** From a sandboxed remote session (e.g. Claude Code on the
web), outbound `api.circleci.com` is often egress-blocked **and** git push is
scoped to a single working branch — so the assistant can neither call the API nor
push a tag. In that case: do the version math + checklist here, then **hand the
user the exact `curl` (preferred) or tag command** and let them run it. When run
from a machine with network + `CIRCLE_TOKEN`, dispatch the `curl` directly.

## Step 1 — Build the next RC APK

1. **Find the next rc number.** Resolve the target `X.Y.Z` from `apps/mobile/app.json` `version` **first** — that is the cycle you're building. Then:
   - **Read the rolling `dev` release** — `mcp__github__get_release_by_tag(owner="stlim0727", repo="stash", tag="dev")`. Its `name` carries the label (`Development build — vX.Y.Z-rcN (latest)`, stamped by the CircleCI `android_apk` job). **Only trust its `rcN` when the label's `X.Y.Z` equals `app.json`'s `version`.**
     - **Match** → next is `rc(N+1)`.
     - **`app.json` is ahead of the `dev` label** (a fresh cycle bump with no RC built yet — e.g. `app.json` says `1.2.0` but `dev` still reads `v1.1.0-rcN`) → the label is **stale**; start the new cycle at **`rc1`** (`vX.Y.Z-rc1` from `app.json`). Do **not** carry the old cycle's number forward.
   - **Cross-check** the current cycle's table in `docs/development/build-history.md` (next = highest `-rcN` + 1). If that cycle has no table yet (a fresh version bump), it's `rc1` and you create the section.
   - Break ties **only within the same `X.Y.Z`**: if the `dev` label and the ledger disagree for the *same* version, prefer the `dev` release (it reflects the last *actual* build) and note the discrepancy. A cross-version disagreement is not a tie — `app.json` wins and the cycle restarts at `rc1`.
2. **Confirm there's new code to ship.** `git fetch origin main` then compare the `dev` release's `target_commitish` to `origin/main` HEAD (`git log <dev_sha>..origin/main --oneline`). If **nothing app-facing** changed (e.g. only `ci`/`docs` commits), do **not** cut a new rc for identical app code — say so (per the versioning golden rule: same code ⇒ keep the version, only the build number changes). Proceed only when there are real changes to ship. (Exception: a deliberate pipeline-validation build after a CI change — call it out explicitly.)
3. **Check for open PRs against `main`** — `mcp__github__list_pull_requests(state="open", base="main")`. If any open PR looks like it belongs in this RC, ask the user whether to wait for it before building; otherwise proceed. (Ignore infra/docs PRs that clearly don't belong.)
4. **Trigger the build** via the **canonical `run_apk` curl** in "How the build gets triggered" above, passing `"version":"vX.Y.Z-rcN"`. Always pass `version` — it stamps `APP_VERSION` into the APK and into the `dev` release name/body (the CircleCI port of #302), which is what makes the rc number self-recording (no ledger PR needed). If a `CIRCLE_TOKEN` / network isn't available in this session, hand the user the `curl` (or the tag command) to run.
5. **Logging is optional.** The `dev` release self-records the label, so a `build-history.md` row is narrative-only. Only add one (via a normal PR) if the user wants the per-rc "what's new" history preserved.

## Step 2 — Clean up stale artifacts

**Mostly automatic now.** Two of the old GitHub-Actions cleanups changed with the
CircleCI migration:

- **GitHub Actions artifact pruning is obsolete** — the migration removed GitHub
  Actions entirely, so there are no Actions artifacts to prune (CircleCI expires
  its own artifacts automatically). Do **not** try to run it.
- **Firebase App Distribution release cleanup runs nightly** — the CircleCI
  `nightly-ops` workflow runs `ops_firebase_cleanup` every day (`.circleci/config.yml`),
  so old tester releases self-prune without any per-RC action.

On-demand: trigger `run_ops` (`{"parameters":{"run_ops":true}}` via the same
`curl` shape as Step 1) to run a **dry-run listing** of what would be pruned.
Note: the manual `run_ops` path is list-only by design; retention (`KEEP` /
`MAX_AGE_DAYS`) is configured in the `ops_firebase_cleanup` job env, and the
nightly job is what actually deletes. To change retention or add an on-demand
*delete*, edit that job in `.circleci/config.yml`.

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
- **Built:** `vX.Y.Z-rcN` (CircleCI `android_apk` on `main` @ `<sha>`) → refreshes
  `dev`. If a sandboxed session couldn't dispatch, say so and show the exact
  command handed to the user.
- **Cleaned:** GitHub-artifact pruning is obsolete; Firebase cleanup runs nightly
  (note it, plus any on-demand `run_ops` dry-run you triggered).
- **Checklist:** the grouped 24h QA list.
- Offer to confirm the build's outcome once it finishes — poll
  `get_release_by_tag(dev)` for the name flipping to the new `vX.Y.Z-rcN` label
  (CircleCI sends no dispatch webhook, so a poll is how you confirm success).
