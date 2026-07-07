# Maintaining AGENTS.md

`AGENTS.md` is the declared source of truth for agents. Because it is loaded on
demand at the start of a task, its job is to let an agent orient quickly and
then drill in, not to hold every detail. This doc is the charter for editing it:
the rules an agent or human should follow so the file stays useful instead of
drifting or bloating.

It supersedes older guidance, including earlier versions of the
`update-agents-md` skill, that told editors to append dense bullets and never
rewrite. Restructuring toward the index model below is allowed and encouraged.

## The Three Tiers

Put each fact in the lowest-cost tier that still surfaces it. Duplicating a fact
across tiers is how docs drift out of sync.

| Tier | Holds | Cost model |
| --- | --- | --- |
| `CLAUDE.md` | Rules that must be true on every turn: imperative, terse. | Always in context. Keep it lean. |
| `AGENTS.md` | Orientation: project snapshot, architecture map, invariants, commands, traps index. | Read once per task. Keep it skimmable. |
| `docs/**` and PR history | The deep why: subsystem design, postmortems, implementation history. | Loaded only when a task touches that area. |

`AGENTS.md` is an index, not a changelog or an encyclopedia.

## Editing Rules

1. **Invariants travel as assertion, one-line why, and link.** Never a bare rule
   that lacks rationale, and never a full war story inline. Example:

   > Anonymous sessions never run the remote-deletion diff. Anonymous data is
   > single-device, so "deleted on another device" is never a valid inference;
   > this holds on every pass, not just the first. See
   > `docs/architecture/sync-account-switching.md`.

2. **Relocate, do not delete, institutional memory.** Trim by moving narrative
   to `docs/**` or citing the PR, then leave a one-line invariant plus link.

3. **Deleting an invariant requires proof it is dead.** The guard must be gone
   from the code and its tests. "Verbose" or "obvious" is not enough.

4. **Restructuring is allowed; contradiction is not.** Re-derive facts from
   their source: commands from `package.json`, schema from migrations, deploy
   behavior from current workflow config. If `AGENTS.md` and `CLAUDE.md`
   disagree, fix both.

5. **Keep it skimmable.** Section headings, short blocks, orient-in-one-read. If
   a reader must ingest the whole file to answer one question, move that section
   into `docs/**` and leave a pointer.

6. **Bump `Last updated` and lint.** Update the date line to today and run
   `pnpm lint` or, for a narrow docs-only edit,
   `git diff --check -- AGENTS.md docs/development/maintaining-agents-md.md`.

## Relationship To The Update Skill

The `update-agents-md` skill is the mechanism agents invoke to refresh
`AGENTS.md` after work merges. Its mechanical steps still apply: find the drift
window, reconcile commands from `package.json`, bump the date, and lint. Its
philosophy follows this charter, not the older append-only model. If the two
ever diverge, this charter wins and the skill should be reconciled to it.
