---
name: analyze-stash-issue
description: Analyze Stash app issues before fixing them, especially Sentry STASH-N reports, release-candidate regressions, sync/storage/auth/share bugs, and user feedback. Use when the user asks to analyze, triage, diagnose, classify, or decide what to do about a Stash issue before implementation.
---

# Analyze Stash Issue

Use this skill before writing a fix for a reported Stash issue. The output must make the uncertainty explicit and choose the next engineering action.

## Inputs To Gather

- Live issue data when available: Sentry short id, event time, release, user id, tags, screenshot, diagnostics/context/logs.
- Repo history: recent PRs, build-history row, release/RC commit SHA, and whether a candidate fix is already in the reported release.
- Code path: the likely modules touched by the report, plus nearby tests and known invariants in `AGENTS.md`.
- Scope signal: whether the same pattern exists in sibling paths such as native/web storage, auth/session, sync upload/pull, share capture, and feedback diagnostics.

## Required Classification

Classify the issue into exactly one evidence bucket:

- `clear`: The report directly identifies the failing code path and the cause is specific.
- `enough-logs`: The exact cause is not visually obvious, but logs/diagnostics are sufficient to isolate a small failing path.
- `limited-hypotheses`: Several causes are plausible, but they are bounded and can be checked with targeted code/history inspection.
- `clueless`: The report lacks enough evidence; any immediate fix would be guesswork.

Then classify the action into exactly one action bucket:

- `immediate-fix`: Make a small, well-scoped fix now with focused tests.
- `careful-fix`: The fix is clear but touches load-bearing behavior or multiple modules; proceed with a conservative plan and broader verification.
- `instrument-first`: Add diagnostics/logging/telemetry or a safer repro harness before changing behavior.

Finally answer: `similar-surface-check: yes/no`, and list the sibling surfaces to inspect or explicitly say why none apply.

## Decision Rules

- Do not jump from a user description directly to a fix when diagnostics are missing; choose `instrument-first`.
- Prefer `careful-fix` for auth/session transitions, sync deletion/deduplication, storage durability, Supabase migrations/functions, release workflows, and anything that can delete, duplicate, or hide user data.
- Prefer `immediate-fix` only when the blast radius is narrow and the failure mode is directly reproduced or logged.
- Treat screenshots as evidence of symptoms, not root cause, unless the UI state itself is the bug.
- Compare event release against PR/build history. If a suspected fix is not in the reported release, do not treat recurrence as proof the fix failed.
- If Sentry context/logs are available, inspect them before relying on title/message text.
- For a `logger: feedback-bridge` / `source: in-app-feedback` report (a user-typed "Report a problem" submission, not a captured exception), don't spend a round-trip on `get_sentry_resource(resourceType: breadcrumbs)` — these events carry none. The only evidence is the attached `context` (`logs`/`storage`/`shareAttempt`/etc.), and `logs`/`storage` are in-memory only: if the report was filed in a later app session than the failure (a real possibility — nothing forces immediate filing), those fields show only that later session's own startup noise, not the failure. Check the field's own timestamp/plausibility against the report time before treating it as evidence.
- If diagnostics are missing or too sparse, include a concrete instrumentation target: field name, phase label, log location, and where it should appear in future reports.
- A recurring symptom with several prior "fixes" (check `git log --grep`) and no stack trace each time is a strong `instrument-first` signal, not a cue to guess a variant of the same fix again — confirm first whether the diagnostics on the new report actually differ from the old ones.

## Output Shape

Keep the analysis concise but structured:

```text
Evidence bucket: <clear|enough-logs|limited-hypotheses|clueless>
Action bucket: <immediate-fix|careful-fix|instrument-first>
Similar-surface check: <yes/no> - <surfaces>

Why:
- <2-5 concrete facts from Sentry/history/code>

Next action:
- <the recommended implementation or instrumentation step>

Verification:
- <focused tests/checks to run>
```

If the user asked to proceed after analysis, implement the chosen action after giving this classification.
