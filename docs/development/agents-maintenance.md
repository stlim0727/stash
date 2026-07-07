# Maintaining AGENTS.md

`AGENTS.md` is an agent efficiency file, not a project encyclopedia. Its job is
to help a fresh coding agent reach the right first actions quickly, with enough
context to avoid dangerous mistakes.

## Target Shape

Keep `AGENTS.md` short enough to scan before touching code. A good target is
roughly 120-180 lines. Going longer is fine only when every added line prevents
a likely bad edit, bad deploy, or data-loss path.

Prefer this structure:

- Project snapshot: what the repo is and what is currently shipped.
- Architecture map: where major code lives.
- Behavioral invariants: rules agents must not break.
- Common commands: the local checks and their gotchas.
- PR/release workflow: what to do after changes are ready.
- Known traps: high-risk operational lessons.
- Links to deeper docs.

## What Belongs Inline

Keep details in `AGENTS.md` when they are:

- Needed before the first code search.
- High-risk if forgotten, such as data deletion, auth/session, sync, migration,
  release, or production deploy rules.
- Short and stable enough to stay true across many PRs.
- Commands that an agent is expected to run often.

Examples that should stay inline:

- Anonymous sessions must never run the remote-deletion diff.
- Local-only fields must not enqueue sync or bump `updated_at`.
- Metadata backfill must not re-fetch or mutate cloud-visible timestamps.
- Destructive scripts such as `pnpm dedupe:supabase --apply` require explicit
  confirmation.
- PRs that touch migrations, functions, auth/session deletion behavior, deploy
  config, or release workflows should not be auto-merged.

## What Should Move Out

Move details to linked docs when they are:

- Historical narratives or long postmortems.
- Milestone-by-milestone implementation history.
- Deep subsystem design that only matters after an agent decides to work there.
- Release build ledgers, incident timelines, or repeated examples.
- Anything that makes `AGENTS.md` harder to scan without changing the next safe
  action.

Good destinations:

- `docs/architecture/` for durable design and invariants.
- `docs/development/` for workflows, release procedures, and tool setup.
- `docs/reviews/` for audits and project-wide review notes.
- PR descriptions for context tied to a single change.

## How To Edit

When adding context:

1. Ask whether the fact changes an agent's first 5 minutes in the repo.
2. If yes, keep the shortest safe version inline.
3. If no, move it to a deeper doc and link to it.
4. If the fact is both long and dangerous, write a one-line invariant inline and
   put the full explanation in a linked doc.
5. Remove stale status while adding new status; do not let `AGENTS.md` become an
   append-only changelog.

When pruning context:

- Preserve sharp invariants before preserving history.
- Prefer links over deletion when the detail is still useful.
- Check that commands and paths still resolve.
- Keep `Last updated` current only when the file meaningfully changes.

## Review Checklist

Before committing an `AGENTS.md` edit, verify:

- A new agent can identify the app, code entry points, and check commands fast.
- The file does not duplicate long explanations already present in docs.
- High-risk sync/auth/storage/deploy rules remain visible.
- Current claims are not pretending that historical verification is fresh proof.
- `git diff --check -- AGENTS.md docs/development/agents-maintenance.md` passes.
