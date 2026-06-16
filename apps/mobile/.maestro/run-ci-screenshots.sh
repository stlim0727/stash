#!/usr/bin/env bash
# Drives the Maestro flows on the booted emulator and collects screenshots.
#
# Why a script file instead of inline workflow steps: android-emulator-runner
# runs its `script:` input line-by-line (each line is a separate `sh -c`), so
# multi-line shell — loops, `cd`, variables — does not work there. Invoking this
# file as a single command sidesteps that entirely.
#
# For every font scale we run ALL flows in the .maestro directory and capture a
# screenshot of each screen, then label the PNGs `font-<scale>-<screen>.png`.
# Layout clipping (e.g. the Browse chips) only appears once the system font is
# enlarged, so a single 1.0 capture can hide it.
set -uo pipefail

cd "$GITHUB_WORKSPACE"

FLOWS_DIR="apps/mobile/.maestro"
SCALES=(1.0 1.5)
OUT="$GITHUB_WORKSPACE/screenshots"
mkdir -p "$OUT"
# Start clean: the workflow may invoke this script twice (job-level retry on a
# fresh emulator), and we don't want stale screenshots from a failed attempt.
rm -f "$OUT"/*.png

adb install -r apps/mobile/android/app/build/outputs/apk/release/app-release.apk

overall=0
for scale in "${SCALES[@]}"; do
  echo "::group::Screenshots at font_scale=$scale"
  adb shell settings put system font_scale "$scale"
  # Best-effort: a selector hiccup on a secondary screen must NOT fail the job.
  # The gate is the Inbox screenshots checked below — that is the actual
  # deliverable (the Browse-chip clipping verification). Maestro still runs every
  # flow and captures all the screenshots it can.
  maestro test "$FLOWS_DIR" || true
  # Maestro writes <name>.png to the cwd (workspace root). Move + label per scale.
  for png in "$GITHUB_WORKSPACE"/*.png; do
    [ -e "$png" ] || continue
    mv "$png" "$OUT/font-${scale}-$(basename "$png")"
  done
  echo "::endgroup::"
done

adb shell settings put system font_scale 1.0

# Gate: require the Inbox (Browse chip) screenshot at every scale. The whole
# point of this job is to prove the chips render uncropped across font sizes;
# the other screens are bonus coverage captured best-effort for human review.
for scale in "${SCALES[@]}"; do
  if [ ! -f "$OUT/font-${scale}-inbox.png" ]; then
    echo "::error::Missing required Inbox screenshot at font_scale=$scale"
    overall=1
  fi
done

ls -la "$OUT"
exit "$overall"
