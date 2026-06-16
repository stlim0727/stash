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

adb install -r apps/mobile/android/app/build/outputs/apk/release/app-release.apk

overall=0
for scale in "${SCALES[@]}"; do
  echo "::group::Screenshots at font_scale=$scale"
  adb shell settings put system font_scale "$scale"
  # Don't abort the whole matrix if one flow fails — collect what we got and
  # remember to fail at the end, so partial screenshots still upload.
  # Retry the batch once: a freshly booted emulator can flake on the first
  # Maestro driver init and report every element as "not found". A second
  # attempt re-inits the driver and almost always succeeds.
  maestro test "$FLOWS_DIR" || maestro test "$FLOWS_DIR" || overall=1
  # Maestro writes <name>.png to the cwd (workspace root). Move + label per scale.
  for png in "$GITHUB_WORKSPACE"/*.png; do
    [ -e "$png" ] || continue
    mv "$png" "$OUT/font-${scale}-$(basename "$png")"
  done
  echo "::endgroup::"
done

adb shell settings put system font_scale 1.0
ls -la "$OUT"
exit "$overall"
