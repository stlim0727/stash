# Reviewing sync changes across channels

PR [#873](https://github.com/stlim0727/stash/pull/873) required repeated review
rounds because local fixes did not initially establish one consistent contract
across retry scheduling, execution, credential recovery, and presentation.
Examples included overdue timers that first postponed recovery and then spun
empty passes, credential recovery lost during coalescing or early exits, and
recoverable HTTP errors presented as attention in another view. Some existing
behaviors became defects in scope when the new UI promised automatic recovery
or completion. Comment totals include replies and resolution activity and are
not a count of distinct defects.

Use this guide for changes spanning those boundaries. A copy-only status edit
does not need a full state-machine audit. The current product contract lives
in [library-sync-status.md](library-sync-status.md); this guide describes how to
check changes without repeating patch-by-patch discovery.

## Establish the contract before patching

Trace the affected channels: bookmark create/update/delete, tags, imported
folder assignments, enrichment restores, and pulls. Metadata fetching and AI
generation can block or produce cloud work but have independent completion.
For each relevant channel, identify these facts in the implementation:

| Boundary | Question to settle |
| --- | --- |
| Eligibility | Can this work run now, later automatically, or only after recovery? Does the driver enforce the same rule as the scheduler? |
| Deadline | Is the due time absolute and stable across unrelated renders? What changes when a pass skips this work? |
| Provenance | Do HTTP status, transport failure, and request timeout survive every adapter, including native uploads and persisted legacy rows? |
| Recovery ownership | Who retains credential-recovery proof? When is it consumed? Can early exit, coalescing, or an account switch lose or misapply it? |
| Completion | Does success require a confirming pull? What schedules it locally, and what durable state retires the work? |
| Presentation | Do item detail, aggregate status, processing counts, and Settings agree about retry versus attention? Can the offered action actually run? |

Write down any changed invariant in the product contract. Use a shared policy
where appropriate; if channels differ intentionally, document why. Do not
infer execution eligibility from an aggregate UI phase: an auth phase can
take priority over offline while the action still requires connectivity.

## Test transitions, not just classifications

Choose relevant combinations rather than mechanically testing the full cross
product. These are the dimensions that exposed gaps in #873:

- Cause: transport/timeout, HTTP 408/429/5xx, auth, permission, ordinary failure,
  and permanently unsyncable work.
- State: metadata pending, owner never synced, mixed retry deadlines, empty
  outboxes with a failed pull, and legacy missing timestamps.
- Lifecycle: cold restoration versus server refresh, same-account new bearer,
  account change, offline/reconnect, pause/resume, and reset success/failure.
- Overlap: unrelated bookmark updates near a deadline, direct tag upload during
  recovery, early storage/reconciliation failure, and removal awaiting pull.

Use the real store with controlled API promises and time for lifecycle cases.
Assert request count and timing, bearer/account, durable queue or tombstone
state, and available UI action where relevant. In particular:

- Updating local bookmarks must not postpone an existing due retry.
- Work a driver cannot execute must not cause repeated empty pulls.
- A fresh 401 under recovered credentials must block again; recovering auth
  must not bypass permission or exhausted ordinary failures.
- A direct removal must reach acknowledgment without an unrelated user action.
- A legacy row must retain its deadline across renders.

Helper tests establish classification; store sequences establish that the
classification actually controls execution. A large passing test count does
not substitute for these transitions. Run focused regressions first, then
the checks warranted by the affected boundaries and repository requirements.

## When review repeats the same mechanism

Before the next patch, group the new findings with previous ones and identify
the missed boundary. Check sibling drivers and interruption paths against that
invariant. Prefer correcting the policy or its consumption over accumulating
special cases. This is a focused investigation, not authorization to rewrite
the sync system or change unrelated product behavior.

Reply with the fixing commit and the transition verified, resolve the thread,
and follow AGENTS.md for CI and review monitoring. Report findings separately
from replies, fixes, and test totals so progress is not measured by comment
volume. Keep the final contract consistent: replace superseded rules instead
of appending contradictory notes after each round.
