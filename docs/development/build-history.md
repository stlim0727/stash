# Build history

A running log of the Android RC/test builds cut from CI (`android-apk.yml`), so
the next RC number isn't guesswork. **Stable releases** live in their own tags
(`vX.Y.Z`) and `docs/release-notes/<tag>.md`; this file tracks the **release
candidates** (`vX.Y.Z-rcN`) that lead up to each stable cut.

## How to read / extend this

- Each RC is built from `main` (the 0.2.x trunk) via the **Android APK** workflow.
- **Always pass the `version` input** (e.g. `v0.2.1-rc4`) so the build carries a
  real label in the Release/run instead of being an anonymous blank dispatch —
  that label is what makes this history trustworthy. A hyphenated `-rcN` tag
  refreshes the single rolling **`dev`** prerelease in place (it never clutters
  Releases); only a clean `vX.Y.Z` cuts a kept, versioned Release.
- After triggering, add a row below with the date, the `main` SHA it built from,
  and a one-line "what's new since the last RC."

## 0.2.2 cycle (current — unreleased trunk)

`apps/mobile/app.json` `version` = `0.2.2`; `min_app_version` soft gate stays at
`0.2.1` (a `0.2.2` client passes it; raising the gate would force `0.2.1` users
to update — a separate product call, not done here). This cycle carries the whole
0.2.x feature pile (Korean i18n / M11, image capture, icon redesign, tag cloud,
the app-UX-review epic, and the search chip shelf). The stable target is
**`v0.2.2`**.

| Build | Date (UTC) | `main` SHA | What's new since last RC |
| ----- | ---------- | ---------- | ------------------------ |
| `v0.2.2-rc3` | 2026-06-24 | `95c3ebf` | Search finishers (#207): punctuation/symbol-only query treated as not-a-search (no more "Matches (all)"); "Matches (N)" → "{count} results" / "검색 결과 {count}개"; zero-result label suppressed so it doesn't double-label the recovery card. |
| `v0.2.2-rc2` | 2026-06-24 | `321a8be` | Fix (#204): the search suggestion shelf no longer gets stranded on screen when the keyboard is dismissed via the Android Back button / list scroll (keyboardDidHide → drop focus, deferred so chip taps still land). |
| `v0.2.2-rc1` | 2026-06-24 | `7d330d3` | First build at version `0.2.2` — the `0.2.1` code (search chip shelf + UX epic) plus the version bump (#203). |

### 0.2.1 builds (superseded — never cut to a stable tag)

The 0.2.x work was version-stamped `0.2.1` while it accumulated, then renamed to
`0.2.2` for the stable cut. These RC builds were the `0.2.1`-labeled snapshots.

| Build | Date (UTC) | `main` SHA | Notes |
| ----- | ---------- | ---------- | ----- |
| `v0.2.1-rc4` | 2026-06-24 | `80833be` | Last `0.2.1`-labeled build. Search chip shelf Phase-2 + separator-vs-symbol fix (#198); app-UX-review epic (#201); tag-cloud back button (#192); `app_config` SELECT RLS scoping. |
| `v0.2.1-rc3` | 2026-06-23 | `14e13e2` | *(blank dispatch — reconstructed from CI run timestamps; not tagged)* |
| `v0.2.1-rc2` | 2026-06-23 | `8dd2e8c` | *(blank dispatch — reconstructed; not tagged)* |
| `v0.2.1-rc1` | 2026-06-23 | `0743602` | *(blank dispatch — reconstructed; first build after the `0.2.1` bump #175)* |

> rc1–rc3 were triggered as blank `workflow_dispatch` runs (no `version` input),
> so their rc numbers were tracked by hand and the SHAs above are reconstructed
> from the workflow run history. From `v0.2.1-rc4` on, every build passes the
> `version` input so the trail is exact.

## Released

| Version | Date | Notes |
| ------- | ---- | ----- |
| `v0.1.9` | 2026-06 | 0.1.x maintenance — durable share capture. See `docs/release-notes/v0.1.9.md`. |
| `v0.1.8` | 2026-06 | See `docs/release-notes/v0.1.8.md`. |
| `v0.1.7` | 2026-06 | See `docs/release-notes/v0.1.7.md`. |

> Note: `docs/release-notes/v0.2.0.md` exists as a running draft, but **`v0.2.0`
> was never tagged** — the trunk rolled forward through `0.2.1` to `0.2.2`.
> Retarget that draft to `v0.2.2.md` before the stable cut.
