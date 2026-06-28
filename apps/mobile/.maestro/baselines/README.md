# Screenshot baselines (visual-regression gate)

Committed reference PNGs for the `android-screenshots` workflow's visual-diff
gate (`scripts/screenshot-diff.mjs`, issue #269). One file per
`font-<scale>-<screen>.png` that the Maestro flows capture (e.g.
`font-1.0-inbox.png`, `font-1.5-inbox.png`).

On every run the workflow pixel-diffs the freshly captured screenshots against
these and **fails the job** when a screen's layout changed — including a resized
element (a dimension change is always a regression), which `assertVisible`
cannot catch. This is the gate that would have caught the rc11/rc12 oversized
wordmark.

## Updating baselines (blessing an intentional change)

When a UI change is intentional, the gate will fail until the baselines are
re-blessed:

1. Open the failing `android-screenshots` run → download the `android-screenshots`
   artifact. It contains the new `font-*.png` captures (and `diff/` images
   showing what changed).
2. Replace the corresponding files in this directory with the new captures.
3. Commit them in the same PR as the UI change, so the diff is reviewable.

Adding a **new** screen capture is not a hard failure — it's reported as
"new (un-blessed)" until its baseline is committed here.

## Tuning

`scripts/screenshot-diff.mjs` honours `PIXEL_THRESHOLD` (per-pixel colour
tolerance) and `MAX_DIFF_RATIO` (fraction of differing pixels allowed) via env,
defaulting to `0.1` and `0.002`. Raise `MAX_DIFF_RATIO` if antialiasing noise
causes flapping; keep it low enough that a real layout shift still trips it.
