#!/bin/bash
# Filters known-noisy-but-harmless output from Stash's verification commands
# (pnpm test / test:components / lint / typecheck) when they PASS, so a
# passing run doesn't burn context on things like the jest react-reconciler
# worker-teardown warning or per-test TAP body chatter. On ANY failure the
# FULL raw output is always printed untouched — this only trims noise on
# green runs, never hides a real problem.
#
# Usage: filter-verbose-test-output.sh <command> [args...]
set -o pipefail

output="$("$@" 2>&1)"
exit_code=$?

is_failure=0
[ "$exit_code" -ne 0 ] && is_failure=1
echo "$output" | grep -qE '^FAIL ' && is_failure=1
echo "$output" | grep -qE '^# fail [1-9][0-9]*$' && is_failure=1
echo "$output" | grep -qE 'Tests:.*[1-9][0-9]* failed' && is_failure=1

if [ "$is_failure" -eq 1 ]; then
  printf '%s\n' "$output"
  exit "$exit_code"
fi

# PASS: collapse known-noisy-but-harmless blocks — everything else survives.
# The dominant one in practice is jest's "  ● Console" section per test file:
# every console.error/warn a test intentionally triggers (simulated storage
# errors, React dev warnings, etc.) prints its full message + stack trace
# there, and in this repo's suite these account for >99% of the output
# (532KB -> 1.8KB measured on a real run). Rather than discarding the block
# outright — which would also hide a genuinely new/unexpected warning from a
# just-changed component on an otherwise-green run (caught in PR review) —
# keep the "  ● Console" header and replace only the body with a one-line
# count, so the signal that something was logged (and roughly how much)
# always survives; an unusual count is a cue to rerun without the hook to
# inspect the real content. Stop at the next PASS/FAIL line or the final
# summary block, whichever comes first, so real content always resumes
# correctly. Also strips the standalone worker-teardown warning + its
# react-reconciler stack trace, which isn't always inside a Console block.
filtered=$(printf '%s\n' "$output" | awk '
  /^  ● Console$/ { print; in_console=1; console_lines=0; next }
  in_console && /^(PASS |FAIL |Test Suites:|Tests:|Snapshots:|Time:|Ran all test suites)/ {
    if (console_lines > 0) {
      printf("    (%d line(s) of console output suppressed on this passing run)\n", console_lines)
    }
    in_console=0
  }
  in_console { console_lines++; next }
  /^A worker process has failed to exit gracefully/ { skipping=1; next }
  skipping && /^[[:space:]]*$/ { skipping=0; next }
  skipping && /^[[:space:]]+at /  { next }
  skipping { skipping=0 }
  { print }
  END {
    if (in_console && console_lines > 0) {
      printf("    (%d line(s) of console output suppressed on this passing run)\n", console_lines)
    }
  }
')

# On a passing `node --test` run, drop ONLY the per-test TAP chatter: the
# "# Subtest: <name>" description line, the "ok N - "/"not ok N - " result
# line, and the fixed 4-line YAML metadata block each result carries
# ("  ---" ... "  duration_ms: N" / "  type: 'test'" ... "  ..."). A
# deny-list, not an allow-list — an earlier version kept only recognized
# summary lines, which also silently swallowed anything unexpected on an
# otherwise-green run (a Node deprecation warning, a custom console.warn
# from a test helper) — exactly the signal that a passing run is newly
# noisy or relying on deprecated behavior (caught in PR review). Everything
# that isn't per-test chatter — including the final numeric summary block
# and any such warning — survives untouched.
if printf '%s\n' "$filtered" | grep -qE '^# tests [0-9]+$'; then
  filtered=$(printf '%s\n' "$filtered" | awk '
    /^# Subtest: / { next }
    /^(ok|not ok) [0-9]+ - / { next }
    /^  ---$/ { skip_yaml=1; next }
    skip_yaml && /^  \.\.\.$/ { skip_yaml=0; next }
    skip_yaml { next }
    { print }
  ')
fi

printf '%s\n' "$filtered"
exit "$exit_code"
