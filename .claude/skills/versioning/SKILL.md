---
name: versioning
description: >-
  Determine the correct next version for Stash and (optionally) cut it. Use
  whenever the user asks to "find the next version", "bump the version", "what
  version is next", "cut a release / RC", "tag a build", or "ship X". Produces a
  deterministic answer — version string, target branch, tag, and build command —
  from the repo's real state (git tags + app.json) and the rules in
  docs/development/releasing.md and branching.md. Removes the guesswork so the
  same request always yields the same answer.
---

# Versioning Stash

The single source of truth for "what version comes next" and how to cut it.
Follow the steps in order; do not improvise. When in doubt, prefer the more
conservative bump (PATCH over MINOR) and **ask** only the one decision the rules
genuinely leave open (see Step 3).

The authoritative docs are `docs/development/releasing.md` (PATCH vs MINOR vs
MAJOR, marketing version vs build number) and `docs/development/branching.md`
(which line a change ships on). This skill operationalizes them — if they ever
disagree with this file, the docs win; fix this file.

## Versioning model (memorize)

- Format is `MAJOR.MINOR.PATCH` (e.g. `0.1.10`). Pre-1.0 conventions:
  - **MINOR** (`x.Y.0`) — a **feature** release. Ships from `main`.
  - **PATCH** (`x.y.Z`) — a **bug-fix / hotfix** release. Ships from the
    affected `release/X.Y.x` maintenance line, then the fix is **cherry-picked
    forward into `main`**.
  - **MAJOR** (`X.0.0`) — reserved for the first public/stable milestone.
- **Two independent identifiers — never conflate them:**
  - *Version name* (`apps/mobile/app.json` → `version`) is the human SemVer
    string, stamped into the build via `APP_VERSION` (see `app.config.js`).
  - *Build number* (`versionCode`) is `github.run_number`, a monotonic integer.
    Use a build-number-only bump **only for genuinely identical code** (CI
    re-run, re-sign, refreshed QR). Never use it to paper over a code change.
- **Release candidates** are hyphenated tags: `vX.Y.Z-rcN` — **no dot** before
  the number (`v0.1.7-rc8`, `v1.0.0-rc2`), N increments from 1 per target
  version. Under the current `android-apk.yml`, any hyphenated tag/version
  routes to the rolling **`dev`** prerelease (the APK is still stamped with the
  full `1.0.0-rc2` version name); only a clean `vX.Y.Z` gets its own versioned,
  marked-"latest" release.
- **Golden rule:** any code users receive that changed → bump the version. Same
  code rebuilt → keep the version, let the build number distinguish it. Never
  ship different code under the same version name.

## Step 1 — Read the real current state (never guess)

Gather, in this order:

1. **Latest tags** (source of truth for what's shipped). Local clone is often
   shallow with no tags, so prefer the GitHub MCP:
   `mcp__github__list_tags(owner, repo)` → take the highest `vX.Y.Z` and the
   highest `vX.Y.Z-rcN` per version. Fall back to `git tag --sort=-v:refname`.
2. **Marketing version**: `apps/mobile/app.json` → `expo.version`.
3. **Branches that exist**: is there a `release/X.Y.x` for the line in question?
   `mcp__github__list_branches` or `git branch -r`.
4. **What the change is** (feature vs bug fix) and **which shipped line it
   affects** — from the user and the diff/PRs since the last tag.

Report what you found before proposing a version, e.g. "latest stable
`v0.1.10`, app.json `1.0.0`, `release/0.1.x` exists, change is a feature."

## Step 2 — Classify the change

| The change is…                                  | Bump      | Example                |
| ----------------------------------------------- | --------- | ---------------------- |
| New feature / anything for the next release     | **MINOR** | `0.1.10 → 0.2.0`       |
| Bug fix / hotfix to an already-shipped line     | **PATCH** | `0.1.10 → 0.1.11`      |
| First public/stable milestone (explicit)        | **MAJOR** | `→ 1.0.0`              |
| Identical code, rebuild only                    | none      | keep name, build++     |

A release candidate does not change this — it's just a `-rcN` suffix on the
target version you computed above.

## Step 3 — Compute the next version

1. Start from the **highest existing tag for the target line** (not app.json —
   app.json can be ahead of or behind the tags; tags are what shipped).
2. Apply the bump from Step 2.
3. If cutting a release candidate for that target:
   - Find the highest existing `vTARGET-rcN`. Next is `rc(N+1)`.
   - If none exists, start at `rc1`. (Flag to the user when there's a gap, e.g.
     they ask for `rc2` but no `rc1` exists — name it as requested but say so.)
4. **The one question worth asking** (only if genuinely ambiguous from the
   request + diff): is this a feature (MINOR) or a fix (PATCH)? Everything else
   is determined. Don't ask about anything the rules already decide.

Resolve `app.json`: if you're cutting a clean `vX.Y.Z`, `app.json.version`
should equal `X.Y.Z` at the tagged commit — bump it in a PR first if it lags.
RC builds stamp from the tag, so `app.json` need not carry the `-rcN`.

## Step 4 — Pick the branch and tag location (branching.md)

- **MINOR / next release** (`v0.2.0`, `v1.0.0`, and their RCs) → tag on
  **`main`**.
- **PATCH for a shipped series** (`v0.1.11`) → tag on **`release/0.1.x`**, then
  **cherry-pick the fix forward into `main`** (oldest → newest; never merge
  `main` into a release branch). If the fix is genuinely that-line-only, say so.
- Stable releases want human notes at `docs/release-notes/<tag>.md`; RC / `dev`
  builds don't.

## Step 5 — Cut it (only when asked to build/release, not just "what's next")

**Before tagging or building, check for open PRs.** List open PRs against the
target branch (`mcp__github__list_pull_requests` with `state="open"`, base =
`main` or the relevant `release/X.Y.x`). If any are open, **ask the user whether
to wait for them to merge and publish afterward**, instead of cutting from the
current commit — the open work may belong in this release. List the open PRs in
the question so they can decide, and only proceed once they have. (If there are
no open PRs against the target, skip the question and continue.)

Releases are tag-driven; pushing a `v*` tag (or dispatching the workflow)
triggers `android-apk.yml`.

- **Clean `vX.Y.Z`** → versioned prerelease, marked "latest", kept forever.
- **`vX.Y.Z-rcN`** (hyphenated) → refreshes the rolling **`dev`** prerelease.

**Preferred:** push the tag.
```bash
git fetch origin <branch>
git tag vX.Y.Z[-rcN] <commit-on-that-branch>
git push origin vX.Y.Z[-rcN]
```

**Remote-environment caveat (important):** Claude Code web/remote sessions push
through a git relay that only permits the session's designated dev branch — **tag
pushes are blocked (HTTP 403)** and no GitHub MCP tool creates a tag/release. In
that case cut the build via workflow dispatch instead:

```
mcp__github__actions_run_trigger(
  method="run_workflow", workflow_id="android-apk.yml",
  ref="<branch>", inputs={ "version": "vX.Y.Z[-rcN]" })
```

It builds from the **same commit**, so the shipped app code / JS bundle is the
same — but do **not** call it identical to a later tag-triggered build. The two
differ in build metadata: `ANDROID_VERSION_CODE` is `github.run_number` (changes
every run) and `EXPO_PUBLIC_GIT_REF` is `github.ref_name` (a dispatch on `main`
records `main`; a tag build records `vX.Y.Z-rcN`), both baked into the APK and
shown in Settings. And for an RC, pushing the tag later just refreshes the same
rolling `dev` release again — it is not a new, distinct release. So describe the
dispatch build as "same code, different build number/provenance," and hand the
user the exact `git tag … && git push …` one-liner to create the durable tag
from an unconstrained machine. Always tell them which path you used and what is
missing or will differ.

If the target depends on an unmerged PR (e.g. "include fix #N in the RC"),
**merge that PR first** so the tag/commit you build actually contains it.

## Step 6 — Report

Always end with a compact, copy-pasteable summary:

- **Next version:** `vX.Y.Z[-rcN]`
- **Why:** <feature→MINOR / fix→PATCH / RC of …>, from latest tag `<…>`
- **Branch / tag at:** `<branch>` @ `<commit>`
- **Build:** clean release ⇒ versioned/latest; rc ⇒ rolling `dev` (stamped
  `X.Y.Z-rcN`)
- **Command run / for you to run:** the tag push or dispatch
- **Follow-ups:** app.json bump? cherry-pick to `main`? release notes file?

## Quick examples

- "next version?" after feature work on `main`, latest `v0.1.10` → **`v0.2.0`**
  (MINOR, tag on `main`).
- "hotfix the 0.1 line", latest `v0.1.10` → **`v0.1.11`** (PATCH on
  `release/0.1.x`, cherry-pick into `main`).
- "cut 1.0 rc2", latest stable `v0.1.10`, app.json `1.0.0`, no `v1.0.0-rc1` →
  **`v1.0.0-rc2`** (MAJOR RC on `main`; note the missing rc1; hyphenated ⇒ `dev`
  build).
- "rebuild v0.1.10, nothing changed" → **keep `0.1.10`**, new build number only.
