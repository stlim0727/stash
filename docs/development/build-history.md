# Build history

A running log of the Android RC/test builds cut from CI (`android-apk.yml`), so
the next RC number isn't guesswork. **Stable releases** live in their own tags
(`vX.Y.Z`) and `docs/release-notes/<tag>.md`; this file tracks the **release
candidates** (`vX.Y.Z-rcN`) that lead up to each stable cut.

## How to read / extend this

- Each RC is built from `main` (the trunk) via the **Android APK** workflow.
- **The next RC number comes from THIS FILE, not from git tags.** An RC build is
  a `workflow_dispatch` run that only refreshes the rolling **`dev`** prerelease
  — it creates **no git tag and no versioned Release**, and the `dev` release
  body shows only the built commit, never the `-rcN` label. So `list_tags` /
  releases are blind to RC history; the **current cycle's table below is the
  single source of truth**. Next rc = (highest `-rcN` in the current cycle's
  table) **+ 1**. If the cycle has no table yet (a fresh `app.json` version
  bump), start at `rc1` and create the section.
- **Always pass the `version` input** (e.g. `v1.0.0-rc5`) so the build carries a
  real label in the run instead of being an anonymous blank dispatch — that
  label plus the row you add here is what makes this history trustworthy. A
  hyphenated `-rcN` tag refreshes the single rolling **`dev`** prerelease in
  place (it never clutters Releases); only a clean `vX.Y.Z` cuts a kept,
  versioned Release.
- **After triggering, immediately add a row** to the current cycle's table with
  the date, the `main` SHA it built from (the run's `head_sha`), and a one-line
  "what's new since the last RC." Skipping this is exactly how `v1.0.0-rc4` went
  unlogged and the next build's number became a guess.

## 1.0.0 cycle (current trunk)

`apps/mobile/app.json` `version` = `1.0.0` (bumped `0.2.2 → 1.0.0` in #223,
commit `d48c01f`, ahead of the first 1.0 release candidate). Stash is
feature-complete for 1.0; these are the release candidates leading to the first
`v1.0.0` stable cut. The stable target is **`v1.0.0`**.

| Build | Date (UTC) | `main` SHA | What's new since last RC |
| ----- | ---------- | ---------- | ------------------------ |
| `v1.0.0-rc8` | 2026-06-27 | `6501bb6` | Large-library tag cloud: cap the browse-by-tag cloud to the 80 busiest tags so opening/drilling no longer freezes the JS/UI thread for seconds (the true tag count is still shown; rarer tags reachable via search) (#249). AI folder recommendation no longer re-surfaces after you undo the move or refile elsewhere — accept now records the suggestion as reviewed, symmetric with dismiss (#247). Observability: a degraded AI enrichment (provider rate-limit/timeout → heuristics) is no longer reported as a Sentry error — it's a low-severity breadcrumb, the in-app "basic suggestions" note already surfaces it (#248); plus reporting-only SQLite freeze observability (stall watchdog + reopen-churn alert to Sentry, never aborts work) (#250). Build = `android-apk.yml` run #118. (Note: run #117 was an rc7 mis-dispatch of this newer code, cancelled — this is the correctly-labelled rc8.) |
| `v1.0.0-rc7` | 2026-06-27 | `bd5d4d6` | Sync: bookmarks could get stuck on "동기화 실패 / sync failed" forever — an orphaned local-id `update` (whose `create` was overwritten in the one-entry-per-bookmark queue) re-failed every pass and never reached the server. The orphaned-update branch now promotes the entry to a `create` so it uploads (idempotent on URL) and re-keys onto its remote id; already-stuck bookmarks self-heal on the next sync, no migration (#245). Also includes the Android tag-cloud touch fix (overlay containers set `pointerEvents="box-none"` so cloud taps/back control land after drill-in, #244). Build = `android-apk.yml` run #116. |
| `v1.0.0-rc6` | 2026-06-27 | `0a3dd63` | Settings reorganized into labelled sections (Account / Library / Preferences / Your data / Advanced); AI-suggestion review moved out of Settings onto a persistent Inbox banner that stands while anything is left to review and escalates to a "new" alert for unseen arrivals (#239). Build = `android-apk.yml` run #110. |
| `v1.0.0-rc5` | 2026-06-26 | `8e68980` | Search now narrows the Browse-by-tag cloud to the tags on matching results (was showing the whole library under a "Results for …" banner) (#234). Build = `android-apk.yml` run #109. |
| `v1.0.0-rc4` | 2026-06-26 | `45b13b6` | *(not logged at build time — reconstructed: this was the `dev` prerelease's target commit immediately before rc5, and `dev` always holds the latest RC. Code: unify the no-collection label as "Inbox" + folder/Inbox chip counts (#232).)* |
| `v1.0.0-rc1`–`rc3` | 2026-06 | *(not recorded)* | *(1.0.0 dispatches built before this cycle's table existed; their `-rcN` numbers were tracked only on the Play internal-test track. SHAs were not captured at the time — this is the tracking gap that adding the rows above closes. rc1 was the first build after the `1.0.0` bump #223.)* |

> **Why `rc4` was missed.** RC builds leave no git tag and the `dev` release body
> omits the `-rcN` label, so the only durable ledger is this file — and it was
> never extended past the 0.2.2 cycle when `app.json` jumped to `1.0.0`. Anyone
> deriving "the next RC" from `list_tags` (or from the partial Play-Console
> notes in #233, which only saw rc1/rc3) would skip straight past rc4. The fix
> is procedural: maintain this 1.0.0 table on every dispatch (see "How to read").

## 0.2.2 cycle (released — `v0.2.2`)

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
