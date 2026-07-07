# Maintaining AGENTS.md

`AGENTS.md` is the declared source of truth for agents — CLAUDE.md says **"read
`AGENTS.md` first"**. Because it is loaded on demand at the start of a task, its
job is to let an agent **orient quickly and then drill in**, not to hold every
detail. This doc is the charter for editing it: the rules an agent (or a human)
must follow so the file stays useful instead of drifting or bloating.

It **supersedes** any older guidance — including earlier versions of the
`update-agents-md` skill — that told editors to "append dense bullets" and
"never rewrite". Restructuring toward the index model below is not just allowed;
it is the goal.

## The three tiers

Put each fact in the **lowest-cost tier** that still surfaces it. Duplicating a
fact across tiers is how they drift out of sync.

| Tier | Holds | Cost model |
| --- | --- | --- |
| `CLAUDE.md` | Rules that must be true on **every** turn — imperative, terse. | Always in context. Keep it lean. |
| `AGENTS.md` | Orientation: project snapshot, architecture map, invariants (as one-liners + links), commands, a traps index. | Read **once per task**. Keep it skimmable. |
| `docs/**` + PR history | The deep "why" — subsystem design, war stories, postmortems. | Loaded only when a task touches that area. |

`AGENTS.md` is an **index**, not a changelog or an encyclopedia.

## Rules for editing AGENTS.md

1. **Invariants travel as `assertion + one-line why + link`.** Never a bare rule
   (a future agent without the rationale "optimizes" it away), and never a full
   war story inline (it bloats the index and goes stale). Example:

   > An anonymous session **never** runs the remote-deletion diff — an anonymous
   > account is single-device by definition, so "deleted on another device" is
   > never a valid inference; this holds on **every** pass, not just the first
   > (see `docs/architecture/sync-account-switching.md` / #375).

2. **Relocate, don't delete, institutional memory.** Trim by *moving* the
   narrative to `docs/**` or citing the PR, and leave the one-liner + link
   behind. A saga that cost several review rounds is exactly what a future agent
   needs to not repeat it.

3. **Deleting an invariant requires proof it is dead** — the guard is gone from
   the code and its tests. "It's verbose" or "it's obvious" is not proof; the
   invariants that read as obvious are the ones that get regressed.

4. **Restructuring is allowed; contradiction is not.** You may reorder and
   rewrite freely, but re-derive facts from their source — commands from
   `package.json`, schema from the migrations — and if `AGENTS.md` and
   `CLAUDE.md` disagree, **fix both**. An agent trusting the wrong one is worse
   than one stale doc.

5. **Keep it skimmable.** Section headings, short blocks, orient-in-one-read. If
   a reader must ingest the whole file to answer one question, it is too big —
   move a section into `docs/**` and leave a pointer.

6. **Bump `Last updated` and lint.** Update the date line to today and run
   `pnpm lint` (`AGENTS.md` is subject to `format:check` — trailing whitespace /
   final newline).

## Relationship to the `update-agents-md` skill

The `update-agents-md` skill is the mechanism agents invoke to refresh
`AGENTS.md` after work merges. It implements this charter — its mechanical steps
(find the drift window, reconcile commands from `package.json`, bump the date,
lint) still apply, but its philosophy follows the rules above, not the older
append-only model. If the two ever diverge, this charter wins and the skill
should be reconciled to it.
