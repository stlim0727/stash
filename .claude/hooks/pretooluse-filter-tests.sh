#!/bin/bash
# PreToolUse hook (Bash matcher): when the command is one of Stash's four
# bare verification lanes (optionally with a trailing `2>&1`, the common way
# they're actually invoked), rewrite it to run through
# filter-verbose-test-output.sh, which trims known-noisy-but-harmless output
# on a PASSING run and passes everything through untouched on any failure.
# Deliberately scoped to an EXACT match on the bare command only — a
# narrowed invocation (e.g. `pnpm test:components -- some-file.test.tsx`)
# is left alone so single-test debugging output is never filtered.
set -euo pipefail

input="$(cat)"
# Parse JSON with node rather than jq: node is a hard project prerequisite
# (Node 22, see CLAUDE.md) while jq is not declared anywhere in this repo —
# on a checkout without jq this hook fires for every Bash call and, under
# `set -e`, would error out before it could even decide not to match,
# breaking ALL Bash tool calls rather than just the four targeted lanes.
command="$(printf '%s' "$input" | node -e '
  let d = "";
  process.stdin.on("data", (c) => { d += c; });
  process.stdin.on("end", () => {
    const obj = JSON.parse(d);
    process.stdout.write((obj.tool_input && obj.tool_input.command) || "");
  });
')"
trimmed="$(printf '%s' "$command" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
# Match against the command with any trailing `2>&1` stripped, but keep
# $trimmed (with the redirect, if present) for the rewritten command — a
# trailing `2>&1` is a shell redirect on the whole invocation, not an
# argument, so passing it through to the filter script wrapper is harmless.
normalized="$(printf '%s' "$trimmed" | sed -E 's/[[:space:]]*2>&1[[:space:]]*$//')"

case "$normalized" in
  "pnpm test"|"pnpm test:components"|"pnpm lint"|"pnpm typecheck")
    filter_script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/filter-verbose-test-output.sh"
    # updatedInput REPLACES the whole Bash tool_input, not just `command` — a
    # caller-set `timeout` (these lanes can run long enough to need one above
    # Claude Code's 2-minute default), `description`, or `run_in_background`
    # would silently vanish otherwise, risking a spurious timeout kill on the
    # rewritten command that the original call would not have hit (caught in
    # PR review). Preserve every original field; only override `command`.
    export FILTER_CMD="$filter_script $trimmed"
    printf '%s' "$input" | node -e '
      let d = "";
      process.stdin.on("data", (c) => { d += c; });
      process.stdin.on("end", () => {
        const obj = JSON.parse(d);
        const updatedInput = Object.assign({}, obj.tool_input, { command: process.env.FILTER_CMD });
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            updatedInput,
          },
        }));
      });
    '
    ;;
  *)
    ;;
esac
