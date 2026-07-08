---
name: retro
description: >-
  Run a retrospective on a finished piece of work — a chat/session, a PR, or a
  debugging journey — and turn its trials and errors into reusable knowledge.
  Use whenever the user says "retro", "retrospective", "look back", "what did we
  learn", "capture the lessons", "save this for next time", "postmortem", or
  "extract what's reusable". Mines the dead-ends and course-corrections (not just
  the happy path), triages each lesson into a skill vs memory, and **upserts** it
  (create-or-update, never duplicate) into `~/.codex/skills/`, the repo's
  `.claude/skills/` when intentionally contributing back, `AGENTS.md`, or
  `CLAUDE.md` so the next chat starts ahead of where this one did.
---

# Retro — turn a session's trials & errors into reusable knowledge

The highest-value output of a working session is usually **not** the diff — it's
the *trials and errors*: the wrong assumption you corrected, the dead-end you
backed out of, the thing that took three tries, the review comment that caught a
real bug. Those are exactly what the **next** chat would repeat from scratch,
because the diff records the answer but not the reasoning that found it. This
skill mines that reasoning and writes it down where it will be reused.

Deterministic: same session in → same shape of output (kept lessons routed to
skill/memory, dropped lessons named). Grounded: every upsert traces to a real
moment in the work, and reconciles with what's already written. This is the
**failure-focused, session-wide** companion to `update-agents-md` (which only
refreshes feature notes from merged PRs) — retro captures *method and gotchas*,
including from work that never became a PR.

## Step 1 — Reconstruct the journey (failures first)

Walk the session/PR end to end and write the honest arc: **goal → what was
tried → what failed or was corrected → what finally worked, and why.**

- Prioritize the **course-corrections**: a wrong assumption that got fixed, an
  approach abandoned, a claim that turned out stale, a bug a reviewer caught. A
  clean success teaches little; a corrected mistake teaches a lot.
- Sources: the conversation itself; `git log` and PR threads for the work;
  review comments (human **and** bot) and how each was resolved; anything you had
  to verify empirically because a doc or your memory was wrong.

## Step 2 — Extract candidate lessons

For each notable moment, state the **transferable** lesson in one line — phrased
so it applies beyond this exact task. Three kinds are worth keeping:

- **Method / thinking process** — a repeatable way of reasoning. (e.g. "verify a
  doc claim empirically before 'correcting' it"; "grep the repo for the
  convention instead of assuming it".)
- **Workflow** — a repeatable multi-step procedure with a verification.
- **Fact / gotcha / convention** — a durable truth that changes future decisions
  (a config value, a trap, an ordering rule, a place two files must agree).

## Step 3 — Triage each lesson (the core rule)

Route every kept lesson to exactly one home:

- **→ New/updated skill** — it's a repeatable *procedure* you'd re-run (a doer or
  a checker), multi-step, with a success criterion. Personal Codex procedures
  live in `~/.codex/skills/`; repo-shared Claude procedures live in
  `.claude/skills/`.
- **→ Memory** — it's a durable *fact/convention/gotcha* that changes decisions
  but isn't itself a procedure:
  - project state / bug-class / gotcha → **`AGENTS.md`** (the right section:
    `Known minor gaps`, a labeled cycle, or a new area).
  - working convention / command / product principle → **`CLAUDE.md`**.
  - a general reasoning habit that isn't repo-specific → the **Working
    principles** in `CLAUDE.md` (or a skill if it has real steps).
- **→ Drop** — one-off, already captured, or too niche to reuse. **Name what you
  dropped and why** — a silent omission hides a judgment call the user may want
  to overturn.

When unsure skill-vs-memory: if a future agent would *do* it, it's a skill; if
they'd *know* it, it's memory.

## Step 4 — Upsert, don't duplicate

- **Look before you write.** Grep `~/.codex/skills/`, `.claude/skills/`, and
  `AGENTS.md`/`CLAUDE.md`
  for the topic first. **Extend or correct** an existing entry rather than adding
  a parallel one — a second doc that half-overlaps the first is worse than none.
- **New skill** → `~/.codex/skills/<name>/SKILL.md` for personal Codex reuse, or
  `.claude/skills/<name>/SKILL.md` when updating the Stash repo's shared Claude
  skills, in the house style: frontmatter
  `name` + `description` (the description must carry the trigger phrases a future
  agent would say); deterministic numbered steps grounded in real repo state;
  cross-reference the authoritative doc; end with a **Report** section. Match the
  shape of an existing skill (`versioning`, `web-deploy`) before inventing one.
- **Memory** → if a lesson touches something both `AGENTS.md` and `CLAUDE.md`
  describe, fix **both** so they never disagree (this project has been bitten by
  the two memory files drifting apart — don't recreate that).
- Stay **surgical**: only lessons that will actually be reused. No speculative
  abstractions, no skill for a thing done once.

## Step 5 — Verify & report

- Run `pnpm lint` (docs are subject to `format:check`).
- If the retro creates or updates repository files, commit on the designated
  branch and open a PR unless there is a clear reason not to. Do not stop at
  saying the files exist locally. Clear reasons include an explicit user request
  not to publish, missing credentials or PR tools, unrelated working-tree changes
  that cannot be isolated, personal `~/.codex` state, or secrets/private
  artifacts that must not be committed. When not opening a PR, state the concrete
  reason.
- **Report:** the journey's one-line headline; each lesson **kept** and where it
  landed (skill / `AGENTS.md` / `CLAUDE.md`); each lesson **dropped** and why; and
  any follow-up the retro surfaced but didn't act on.

## What a good retro lesson looks like

Prefer the lesson that would have *saved time* this session:

- ✅ "The web export is `web.output: single` (SPA), so no per-route HTML exists —
  don't treat `/add` as a file." → a **gotcha**, went to memory + a skill line.
- ✅ "`node --test "glob" file` runs the *union*, so passing a path doesn't narrow
  the lane." → a verified **fact**, went to `AGENTS.md` + `CLAUDE.md`.
- ✅ "Verify a doc claim by running it before you 'correct' it." → a **method**,
  belongs in Working principles.
- ❌ "Fixed a typo in the PR body." → one-off, **drop**.
