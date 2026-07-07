---
name: update-agents-md
description: >-
  Refresh AGENTS.md (the project source-of-truth handoff doc) from recently
  merged work so it stops drifting from the code. Use whenever the user asks to
  "update AGENTS.md", "refresh the handoff doc", "AGENTS.md is stale", "bring the
  agent notes up to date", or after a batch of PRs merges. Produces a faithful,
  deduplicated update: durable orientation in AGENTS.md, deep context linked out
  to docs, reconciled conventions, and a bumped date.
---

# Keep AGENTS.md Current

`AGENTS.md` is the declared source of truth for agent handoff. It drifts because
it is updated by hand and features ship faster than anyone re-reads it. This
skill closes the gap deterministically.

Follow the charter in `docs/development/maintaining-agents-md.md`. It is the
authoritative model for what belongs in `AGENTS.md`: the file is an index, not a
changelog or encyclopedia. Keep facts in the lowest tier that surfaces them:
`CLAUDE.md` for always-loaded rules, `AGENTS.md` for orientation read once per
task, and `docs/**` plus PRs for the deep why. Invariants travel as assertion,
one-line why, and link; relocate narrative to `docs/**` instead of deleting it.

## Step 1 - Find The Drift Window

1. Read the `Last updated <date>` line near the top of `AGENTS.md`.
2. `git log --oneline --since=<that date>` on `main` or diff against the last
   commit that touched `AGENTS.md`: `git log -1 --format=%cd -- AGENTS.md`.
3. Group commits by area: app features/UX, sync/domain, backend/RLS, web,
   CI/infra, observability, docs. Ignore pure `chore`, `docs`, or formatting
   commits that changed no behavior.

## Step 2 - Decide What's Worth Recording

`AGENTS.md` captures durable orientation, not a changelog. A commit earns a
place when it changes how the app behaves, how the system is built, or a
convention an agent must follow. Skip trivial fixes already implied by an
existing entry.

- For anything non-obvious, open the PR for the why before writing; the one-line
  subject is rarely enough.
- Check it is not already there. Grep `AGENTS.md` for the feature's keywords
  first; extend or correct the existing entry instead of adding a duplicate.
- Decide the tier from `docs/development/maintaining-agents-md.md`: a rule that
  must hold every turn belongs in `CLAUDE.md`; a deep war story belongs in
  `docs/**` with only a one-liner and link in `AGENTS.md`; durable orientation
  stays inline.

## Step 3 - Write To The Index Model

Follow `docs/development/maintaining-agents-md.md`, and match the surrounding
prose:

- Prefer a short entry that names the change, its load-bearing invariant, and a
  link over a paragraph-long retelling. If the why is long, put it in a doc and
  cite it.
- New invariants travel as assertion, one-line why, and link: never a bare rule,
  never a full narrative inline.
- Slot it under the right section, or add a new section for a whole new surface.
  Relocate, do not delete, any detail you trim.
- Keep product invariants visible: capture is sacred, user-authored vs.
  generated fields stay separate, RLS is owner-scoped.

## Step 4 - Reconcile The Commands Section

This is where `AGENTS.md` most often goes wrong, not just stale. Re-derive from
the source, do not trust the prose:

- `node -e "const p=require('./package.json'); console.log(p.scripts)"` and the
  same for `apps/mobile/package.json` to confirm what `pnpm lint`, `test`,
  `test:components`, and `typecheck` actually run.
- If `AGENTS.md` and `CLAUDE.md` disagree on a command, fix both so the two
  memory files never contradict each other. An agent trusting the wrong one is
  worse than one stale doc.

## Step 5 - Bump The Date And Verify

- Update the `Last updated <date>` line to today (`currentDate` from context).
- Run `pnpm lint`; `AGENTS.md` is subject to `format:check` for trailing
  whitespace and final newline.
- Diff-review your own edits: every added line should trace to a real merged
  change, there should be no duplicate of an existing entry, and deep context
  should be linked rather than inlined.

## Report

Summarize the drift window, the sections you touched, any command/convention you
reconciled between `AGENTS.md` and `CLAUDE.md`, and the new `Last updated` date.
