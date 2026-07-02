# Build history

A running log of the Android RC/test builds cut from CI (`android-apk.yml`), so
the next RC number isn't guesswork. **Stable releases** live in their own tags
(`vX.Y.Z`) and `docs/release-notes/<tag>.md`; this file tracks the **release
candidates** (`vX.Y.Z-rcN`) that lead up to each stable cut.

## How to read / extend this

- Each RC is built from `main` (the trunk) via the **Android APK** workflow.
- **The `dev` release now self-records its `-rcN`, so per-build logging here is
  optional (history/narrative only), not required to derive the next number.**
  As of the `android-apk.yml` change that stamps the dispatch's `version` input
  into the rolling **`dev`** prerelease, that release's **name** (`Development
  build — v1.1.0-rcN (latest)`) and body carry the label. So the next rc is now
  answerable straight from the live `dev` release — read it, add 1 — with **no
  ledger PR**. This table remains the durable *narrative* (what changed per RC)
  and the record for builds that predate the self-recording change; keep
  extending it when you want that history, but you no longer *have* to open a PR
  just to make the next number derivable.
- **Historically the next RC number came from THIS FILE, not from git tags.** An
  RC build is a `workflow_dispatch` run that only refreshes the rolling **`dev`**
  prerelease — it creates **no git tag and no versioned Release**, and (before
  the self-recording change) the `dev` release body showed only the built commit,
  never the `-rcN` label. So `list_tags` / releases were blind to RC history and
  the **current cycle's table below was the single source of truth**. Next rc =
  (highest `-rcN` in the current cycle's table) **+ 1**. If the cycle has no
  table yet (a fresh `app.json` version bump), start at `rc1` and create the
  section.
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

## 1.1.0 cycle (current trunk)

`apps/mobile/app.json` `version` = `1.1.0` (bumped `1.0.0 → 1.1.0` to open the
1.1 line, ahead of the first 1.1 release candidate; the `version` input passed to
the **Android APK** workflow stamps the full `1.1.0-rcN` onto the build via
`APP_VERSION`). These are the release candidates leading to the first `v1.1.0`
stable cut. The stable target is **`v1.1.0`**. Note: the 1.0.0 cycle below shipped
18 RCs but was never cut to a stable `v1.0.0` tag — the 1.1 line supersedes it.

| Build | Date (UTC) | `main` SHA | What's new since last RC |
| ----- | ---------- | ---------- | ------------------------ |
| `v1.1.0-rc1` | 2026-07-01 | _(pending — filled on dispatch)_ | First build at version `1.1.0`: opens the 1.1 cycle (`app.json` bump `1.0.0 → 1.1.0`). Carries all 1.0.0-cycle code through rc18 plus the merged fix for the "bookmark could not be found" flash after sharing (Detail resolving a bookmark by its pre-sync local id across the sync id-swap, #289). Build = `android-apk.yml` run #_(TBD)_. |

## 1.0.0 cycle (superseded — 18 RCs, no stable `v1.0.0` cut)

`apps/mobile/app.json` `version` = `1.0.0` (bumped `0.2.2 → 1.0.0` in #223,
commit `d48c01f`, ahead of the first 1.0 release candidate). Stash is
feature-complete for 1.0; these were the release candidates leading toward a
`v1.0.0` stable cut that never happened — the 1.1 line above supersedes this one.

| Build | Date (UTC) | `main` SHA | What's new since last RC |
| ----- | ---------- | ---------- | ------------------------ |
| `v1.0.0-rc18` | 2026-07-01 | `de26484` | Four app-code changes shipped since rc17 (`0916bae`): (1) Inbox keeps the Sort pill, Tags pill, and view-mode segment on one row — dropped the `flexWrap: 'wrap'` on the controls row so the flexible Sort pill truncates its label ("Recently opened" → "Recently op…", its leading icon still naming the field) instead of wrapping the right-aligned view segment onto a wasteful second line (#283); (2) Inbox UX slice — tighter Add-flow copy, per-row accessibility labels, and the browse control de-pilled to an icon-only Tags pill (#281); (3) the tag field and other text inputs now stay above the software keyboard instead of being covered by it (#279); (4) first run now starts empty — the bundled first-run sample/seed bookmarks were removed (#278). CI/infra only (no app-code change): the TestMu/HyperExecute real-device screenshot path was added then reverted in favour of the Firebase App Distribution App Testing Agent integration (#282/#284/#280). Build = `android-apk.yml` run #130. (rc18 was first dispatched on 2026-06-30 as run #129 but hit a runner **startup failure** — the account's June Actions minutes were exhausted; the 2026-07-01 monthly reset cleared it and run #130 built the same commit.) |
| `v1.0.0-rc17` | 2026-06-29 | `0916bae` | Makes the rc15 per-user app-version tracking (#274) actually work — it was a silent no-op on rc15/rc16. Two fixes (#275): (1) the GoTrue `user_metadata` write used `PATCH /auth/v1/user`, which GoTrue doesn't route (PATCH is CORS-only), so every stamp was rejected and — because the tracker swallows failures — `app_version` was never written for anyone; switched to `PUT` (the verb supabase-js's `updateUser` uses). (2) After a successful stamp only React state was updated, not secure storage, so a cold restart before the next token refresh re-stamped every launch; the merged session is now persisted so the change-only guard holds across restarts. First build where `auth.users.raw_user_meta_data->>'app_version'` is populated. Build = `android-apk.yml` run #128. |
| `v1.0.0-rc16` | 2026-06-29 | `01b454d` | Fixes the tag-cloud narrowing bug (Sentry **STASH-D**): re-selecting the same tag from `/browse/tags` (or a bookmark's tag drill-in) did nothing and showed no filter ribbon. The drill-in nonce that lets the root Inbox tell a fresh selection from an unrelated re-focus was a per-screen `useRef`, but `dismissTo` tears the screen down, so every visit re-emitted the same nonce ("1") and the Inbox skipped it as already-consumed. Moved to a shared module-level counter (`domain/facet-nonce.ts`) that stays monotonic across mounts; both the cloud and bookmark-detail drill-ins use it (#276). Build = `android-apk.yml` run #127. |
| `v1.0.0-rc15` | 2026-06-29 | `9820799` | Per-user app-version tracking: the current app version is now stamped into Supabase `user_metadata` on auth so each user's build is visible server-side (#274). Otherwise CI-only since rc14: further screenshots-gate hardening (emulator boot no longer blocks UI PRs) (#273) — no app-code change. Build = `android-apk.yml` run #126. (Logged here to complete the ledger; also tracked in the separate PR #275.) |
| `v1.0.0-rc14` | 2026-06-28 | `e056664` | Android hardware **Back** on the Inbox now peels the active narrowing layer instead of quitting the app: a live search clears first, otherwise a non-`all` tag/collection facet resets to All, and only an already-un-narrowed Inbox lets the OS exit — mirroring the on-screen scope-bar **X**, so landing on the root Inbox already filtered (e.g. after picking a tag in `/browse/tags`, which dismisses itself and applies the facet) no longer drops you straight to the home screen. Android-only (no-op on iOS; skips react-native-web's `BackHandler` stub so it can't spam Sentry) (#271). Otherwise CI-only since rc13: the screenshots emulator gate now auto-runs on UI PRs with a visual-regression diff gate + 45m timeout (#268, #270) — no app-code change. Build = `android-apk.yml` run #125. |
| `v1.0.0-rc13` | 2026-06-28 | `09045c4` | Fixes the oversized hero wordmark on native — a regression from the rc11 Inbox header compaction (#263): the wordmark `<Image>` was sized by `height`+`aspectRatio` in the new flex row, which let Yoga fall back toward the PNG's full intrinsic width and blow the brand up to fill the screen on real Android (visible in rc11/rc12). Now sized with an explicit `width`+`height` (#266). Also corrects the `screenshot` dev skill (tooling only): drops the now-unneeded wordmark fixup and the wrong "correct on native" note. Build = `android-apk.yml` run #124. |
| `v1.0.0-rc12` | 2026-06-28 | `7bf7ad0` | Security + account hygiene. Auth tokens (incl. the long-lived Supabase `refresh_token`) moved out of the plaintext local SQLite into OS-backed secure storage — iOS Keychain / Android Keystore via `expo-secure-store` — with byte-safe chunking and a one-time migration that wipes the legacy plaintext copy (#261). Anonymous-user accumulation stopped at both ends: logout no longer mints a fresh anonymous user (lazy creation on the next save) and clears the departed account's cloud-owned rows from the local cache, behind a sign-out confirmation dialog; plus a backend Tier A cleanup migration (`SECURITY DEFINER`, daily `pg_cron`) that deletes only empty + idle anonymous `auth.users` (#264). Build = `android-apk.yml` run #123. |
| `v1.0.0-rc11` | 2026-06-28 | `706cddd` | Inbox header compaction to reclaim wasted vertical space: the hero collapses to a single row (brand wordmark with the saved-count inline, a bare settings gear, tagline line dropped), inter-section paddings tightened, and the Sort/Tags/view-mode controls now sit on one row (the "Browse" caption that forced the view segment onto a near-empty second line is removed) (#263). Also lands a `screenshot` dev skill — real web-render screenshots without an emulator — which is tooling only, not user-facing. Build = `android-apk.yml` run #122. (rc10 = run #120 @ `4c8e5af`; its row is logged in #258.) |
| `v1.0.0-rc10` | 2026-06-28 | `7b27271` | New Inbox **Compact** layout option between Cards and List (#256). The browse-by-tag route's no-collection scope is now labelled "받은함 / Inbox" (was "컬렉션 없음 / No collection"), matching the unified label used everywhere else — the one place the rc9 route slipped (#257). Build = `android-apk.yml` run #121. (First attempt run #120 @ `4c8e5af` built the APK but failed at the redundant artifact-upload step on the account's full Actions artifact quota, so it never published to `dev`; #259 removes that step and adds CI-quota guards, and run #121 rebuilds the same app code on top of it.) |
| `v1.0.0-rc9` | 2026-06-27 | `382333b` | Browse-by-tag rewritten as its own `/browse/tags` route (native Back) to end the large-library freeze and the post-drill-in Back hang (Sentry STASH-A/STASH-B) that the rc8 80-cap didn't fix: an adaptive, one-screen tag cloud (native flexbox → correct CJK wrapping) plus a virtualized full tag list, both driven by one debounced co-occurrence search; the in-Inbox cloud branch and its hand-rolled back-stack are removed, and a latent `Math.min/max(...)` stack-overflow in tag aggregation is fixed (#252). Bookmark Detail's tag-browse now `dismissTo`s the Inbox with a fresh nonce so it pops the stack cleanly and re-applies on repeat taps (#253). Build = `android-apk.yml` run #119. |
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
