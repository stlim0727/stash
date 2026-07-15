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

# PASS: strip known-noisy-but-harmless blocks — everything else survives.
# The dominant one in practice is jest's "  ● Console" section per test file:
# every console.error/warn a test intentionally triggers (simulated storage
# errors, React dev warnings, etc.) prints its full message + stack trace
# there. On a passing run these are expected test artifacts, not signal, and
# in this repo's suite they account for >99% of the output (532KB -> 1.8KB
# measured on a real run). Stop skipping at the next PASS/FAIL line or the
# final summary block, whichever comes first, so real content always
# resumes correctly. Also strips the standalone worker-teardown warning +
# its react-reconciler stack trace, which isn't always inside a Console
# block.
filtered=$(printf '%s\n' "$output" | awk '
  /^  ● Console$/ { skip_console=1; next }
  skip_console && /^(PASS |FAIL |Test Suites:|Tests:|Snapshots:|Time:|Ran all test suites)/ { skip_console=0 }
  skip_console { next }
  /^A worker process has failed to exit gracefully/ { skipping=1; next }
  skipping && /^[[:space:]]*$/ { skipping=0; next }
  skipping && /^[[:space:]]+at /  { next }
  skipping { skipping=0 }
  { print }
')

# On a passing `node --test` run, the per-test TAP body ("# Subtest: ...",
# "ok N - ...") is legitimate but adds nothing once the run is known to have
# passed overall — collapse to just the final numeric summary block. Matches
# only the specific "# <keyword> <n>" summary lines, NOT "# Subtest: ..."
# (which also starts with "# " but is per-test chatter, not the summary).
if printf '%s\n' "$filtered" | grep -qE '^# tests [0-9]+$'; then
  filtered=$(printf '%s\n' "$filtered" | grep -E '^(> |# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) )')
fi

printf '%s\n' "$filtered"
exit "$exit_code"
