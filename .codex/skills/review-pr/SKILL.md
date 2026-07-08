---
name: review-pr
description: >-
  Triage and review a GitHub pull request for Stash. Use whenever the user says
  "review PR N", "check PR N", "is PR N worth merging", "should we merge N", or
  "handle / close PR N". First checks whether the PR's changes are already in
  the base branch (superseded) before doing a full review, so obsolete PRs get
  closed with an explanation instead of needlessly merged. Produces a clear
  merge / close / changes-needed verdict grounded in the repo's real state.
---

# Review a Stash PR

The single source of truth for "is this PR worth merging, and what do we do with
it?" Follow the steps in order. The cardinal rule: **check whether the work is
already in the base branch before reviewing the diff** — a superseded PR is the
most common and most easily-missed disposition, and reviewing its diff in detail
before that check wastes effort.

Owner/repo is `stlim0727/stash` and the base is almost always `main`. Use the
GitHub app tools exposed in Codex (`mcp__codex_apps__github._fetch_pr`,
`_fetch_pr_patch`, `_get_pr_info`, `_search_prs`, `_add_review_to_pr`, etc.);
use `tool_search` first if a needed GitHub action is not currently callable.
Fall back to `git` over the fetched refs when connector coverage is incomplete.

## Step 1 — Pull the PR's real state

Read these together in one batch:

- PR metadata (`_fetch_pr` or `_get_pr_info`) — title, body, `state`, `draft`, `merged`,
  **`mergeable_state`** (`dirty` ⇒ conflicts with base), head/base refs,
  additions/deletions/changed_files.
- PR patch/diff (`_fetch_pr_patch` or `_get_pr_diff`) — the actual diff. **Compare it against the title/body.**
  A mismatch (e.g. a branch named `*-mixed-*`, or a body describing one change
  while the diff does another) is itself a finding — flag it.
- Commit status and workflow/job tools where exposed — CI status (`success` /
  `failure` / `skipped`).
- Reviews/comments where exposed — existing human/bot feedback; don't repeat
  what's already been said.

## Step 2 — Is it already superseded? (do this BEFORE the deep review)

The trap: a branch's commits can already be in `main` — merged via another
(often squashed) PR, or independently reimplemented — so `git cherry` still
flags them by patch-id while the **file content is identical**. Patch-id checks
lie here; verify by content.

1. Fetch the refs: `git fetch origin <base> <head-ref>`.
2. Find the merge base and list the PR's own commits:
   `git log --oneline $(git merge-base origin/<base> origin/<head>)..origin/<head>`.
3. **Try the rebase as the test** — `git checkout -B <head> origin/<head>` then
   `git rebase origin/<base>`. If every commit conflicts with "base already has
   this," or the rebase resolves to empty/near-empty, the PR is **superseded**.
   `git rebase --abort` and return to a clean branch afterward — do not push.
4. Confirm by content, not patch-id: `git show origin/<base>:<path>` for the key
   files and check the actual strings/logic the PR adds are already present.
   Watch for the doc/guidance case where base has a **newer, better** version of
   the same change — force-resolving would *regress* base.

If superseded → go to Step 4 (close). Otherwise → Step 3.

## Step 3 — Review the live diff

Only reached when the work is genuinely not in base. Assess, in order:

- **Conflicts**: `mergeable_state: dirty` is a blocker — it must be rebased
  before merge. Offer to rebase.
- **CI**: failing checks are a blocker; read the failing job logs before
  judging whether it's the PR's fault.
- **Correctness & scope**: does the diff do what the body claims, and only that?
  Honor the repo's core principles — *Capture is sacred*, user-authored fields
  never overwritten by generated/AI metadata, owner-scoped RLS, local-first
  optimism (see `CLAUDE.md` / `AGENTS.md`).
- **Tests**: is the behavior covered? Note missing coverage.
- **Product/UX judgment calls**: flag decisions a human should sign off on
  rather than rubber-stamping.

Give a plain verdict: **merge** / **rebase first** / **changes needed** /
**close**. Don't hedge — state blockers explicitly with evidence.

## Step 4 — Take the disposition (only what the user asked for)

- **Close as superseded/obsolete**: ALWAYS post an explanatory comment first if
  a GitHub comment tool is exposed — say *why* (superseded by base, obsolete,
  duplicate), name the commits/PR that replaced it, then close with an exposed
  PR update tool. If Codex does not expose comment/close tools, report the exact
  comment and close action for the user. Never close silently.
- **Rebase**: rebase onto base, resolve conflicts, push, report.
- **Merge / changes-needed**: report the verdict and let the user decide; only
  merge when explicitly told to.

Never push or change PR state beyond what the user requested. When the right
action is ambiguous (a reviewer comment reads two ways, or the change is
architecturally significant), ask before acting.
