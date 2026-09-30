# UX roadmap assessment — September 30, 2026

Assessed by Codex against main `444441e`, roadmap #843 and tasks #844–#850.
The user explicitly approved lighter evidence gathering instead of requiring
all 28 screenshots before implementation. Historical evidence remains untouched.

## Delivery order

Proceed sequentially: unobstructed reporting and shared UI foundations (#845),
Home and browsing (#846), Add and Detail (#847), status/Tags/copy (#848), then
release verification (#849). Retain offline tagging as a separate architecture
change (#850). Do not remove its UI gate before durable operations are verified.

The phase boundaries are useful, but #845's reporting and styling can ship as
separate reviewable changes. Do not claim the whole phase complete after only
removing the overlay. Preserve user layout preferences and search restoration.
Treat specified heights as normal-font targets; expanded text needs flexible
heights. The 192-check matrix is correctly calculated, but web captures cannot
prove native keyboard, font scaling, hardware Back, or physical-device behavior.
Eight-person usability testing requires actual participants; automated checks
cannot substitute for those results.

## Historical finding audit

This is a source audit, not a claim of visual reproduction. “Unverified” means
a fresh interactive or visual check is still needed. References are relative
to `apps/mobile/src` at the assessed revision.

| Finding | Status | Current evidence / next action |
| --- | --- | --- |
| 1. Home hierarchy | Unverified; selection entry already resolved | `app/index.tsx` still exposes search, Settings, sort, graph, tags and layout controls. Check hierarchy in the live render. Do not restore a dedicated selection button. |
| 2. Browsing cards/rows | Unverified | `app/index.tsx` list title uses one line, thumbnails have accent borders and opening badges. Address in #846. |
| 3. Floating feedback obstruction | Unverified visually; overlay confirmed in source | `_layout.tsx` wraps every route in `FloatingReportButton`, which positions its control over content. Remove in the first #845 delivery. |
| 4. Detail action hierarchy | Unverified; historical full-width deletion claim stale | `app/bookmark/[id].tsx` now groups actions, including Trash, in an action bar. Primary/secondary hierarchy still needs #847. |
| 5. Save/sync clarity | Unverified | Retain tagging restrictions until #850. Verify storage lifecycle before promising durable persistence in #848. |
| 6. Add content model | Unverified | `app/add.tsx` uses one form with optional URL and memo fields. Explicit Link/Note modes remain planned in #847. |
| 7. Selection collision | Already resolved | Existing top-left selection indicator and hidden fallback favicon; exclude from new backlog. |
| 8. Graph usefulness | Unverified | Keep accessible; redesign deferred by #843. |
| 9. Tags browser | Partially already resolved; other observations unverified | `app/browse/tags.tsx` already renders `headerTitle`. Recheck view names, initial mode, counts and contrast in #848. |
| 10. Reporting form | Unverified | `app/report.tsx` has distinct account states and diagnostics sharing. Check all states before simplifying in #848. |
| 11. Visual language/copy | Unverified | Shared Card defaults to elevation with radius 24; Button is pill shaped. Audit localization and contrast during #845/#848. |

## Evidence limits

The reduced baseline does not satisfy every original checkbox in #844. Keep
that issue open until its remaining capture requirements are either completed
or explicitly revised. No participant tests or native-device checks have been
performed as part of this assessment.
