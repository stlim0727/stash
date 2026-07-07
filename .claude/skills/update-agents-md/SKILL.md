---
name: update-agents-md
description: >-
  Refresh AGENTS.md (the project source-of-truth handoff doc) from recently
  merged work so it stops drifting from the code. Use whenever the user asks to
  "update AGENTS.md", "refresh the handoff doc", "AGENTS.md is stale", "bring the
  agent notes up to date", or after a batch of PRs merges. Produces a faithful,
  deduplicated update — new-work bullets in the house style, reconciled
  conventions, a bumped date — without rewriting history that's already captured.
---

# Keep AGENTS.md current

`AGENTS.md` is the declared source of truth — CLAUDE.md says **"read `AGENTS.md`
first"**. It drifts because it's updated by hand and features ship faster than
anyone re-reads it (it once fell ~50 commits / an entire web-platform surface
behind). This skill closes the gap deterministically.

**Follow the charter in `docs/development/maintaining-agents-md.md`** — it is the
authoritative model for what belongs in `AGENTS.md`. In short: the file is an
**index**, not a changelog or an encyclopedia. Keep facts in the lowest tier
that surfaces them (CLAUDE.md = always-loaded rules, AGENTS.md = orientation
read once per task, `docs/**` + PRs = deep "why"). Invariants travel as
`assertion + one-line why + link`; relocate narrative to `docs/**` rather than
deleting it; restructuring is fine, contradiction with CLAUDE.md is not.

## Step 1 — Find the drift window

1. Read the `Last updated <date>` line near the top of `AGENTS.md`.
2. `git log --oneline --since=<that date>` on `main` (or diff against the last
   commit that touched `AGENTS.md`: `git log -1 --format=%cd -- AGENTS.md`).
3. Group the commits by area — app features/UX, sync/domain, backend/RLS, web,
   CI/infra, observability, docs. Ignore pure `chore`/`docs`/formatting commits
   that changed no behavior.

## Step 2 — Decide what's actually worth recording

AGENTS.md captures **why**, not a changelog. A commit earns a place when it
changes how the app behaves, how the system is built, or a convention an agent
must follow. Skip trivial fixes already implied by an existing entry.

- For anything non-obvious, open the PR (`mcp__github__pull_request_read`) for
  the "why" before writing — the one-line subject is rarely enough.
- **Check it isn't already there.** Grep AGENTS.md for the feature's keywords
  first; extend or correct the existing entry instead of adding a duplicate.
- Decide the **tier** (see the charter): a rule that must hold every turn belongs
  in CLAUDE.md; a deep war story belongs in `docs/**` with only a one-liner +
  link in AGENTS.md; only durable orientation stays inline.

## Step 3 — Write to the index model

Follow `docs/development/maintaining-agents-md.md`, and match the surrounding
prose:

- Prefer a **short entry that names the change + its load-bearing invariant + a
  link** (the PR `#NNN`, or the `docs/**` page that carries the detail) over a
  paragraph-long retelling. If the "why" is long, put it in a doc and cite it.
- New invariants travel as `assertion + one-line why + link` — never a bare rule
  (it gets regressed), never a full narrative inline (it bloats and staleness).
- Slot it under the right section, or add a `## <Area>` section for a whole new
  surface. Relocate — don't delete — any detail you're trimming.
- Keep the product invariants visible: **capture is sacred**, user-authored vs
  generated fields stay separate, RLS is owner-scoped.

## Step 4 — Reconcile the "Conventions and commands" section

This is where AGENTS.md most often goes *wrong* (not just stale) — it drifted
out of sync with CLAUDE.md and `package.json` on the test/lint lanes. Re-derive
from the source, don't trust the prose:

- `node -e "const p=require('./package.json'); console.log(p.scripts)"` (and the
  same for `apps/mobile/package.json`) — confirm what `pnpm lint` / `test` /
  `test:components` / `typecheck` actually run.
- If AGENTS.md and CLAUDE.md disagree on a command, **fix both** so the two
  memory files never contradict each other — an agent trusting the wrong one is
  worse than one stale doc.

## Step 5 — Bump the date and verify

- Update the `Last updated <date>` line to today (`currentDate` from context).
- Run `pnpm lint` (AGENTS.md is subject to `format:check` — trailing whitespace /
  final newline).
- Diff-review your own edits: every added line should trace to a real merged
  change; you added no duplicate of an existing bullet and rewrote nothing that
  was already correct.

## Report

Summarize: the drift window (from-date → N commits), the sections you added/
touched, any command/convention you reconciled between AGENTS.md and CLAUDE.md,
and the new `Last updated` date.
