#!/bin/bash
# Run one Maestro flow ($1) on the assigned real device. takeScreenshot inside
# the flow writes <name>.png to the cwd; uploadArtefacts (hyperexecute.yaml)
# collects them. Single font scale (system default) for this first cut — the
# emulator path did 1.0 + 1.5; add scales later once the pipeline is proven.
set -uo pipefail
adb devices
export PATH="$PATH:$HOME/.maestro/bin"
maestro -v
maestro test "$1" --debug-output ./MaestroLogs --format junit
