# Settings feature

Keep the route thin and behavior in the relevant section/action hook. Shared
activity values still come from the screen's projection of the store; avoid a
second sync/quota calculation inside individual rows.

Export must retain collection, tag, and enrichment snapshots; import/reset must
retain busy/readiness guards. Analytics and replay preferences preserve their
SDK availability checks. Push registration remains permission-aware and account
scoped. The screen still supports full-screen and web-sheet presentation.

Use the root task map for focused account, export/import, reset, preference,
quota/sync, and sheet suites. Preserve public route paths and UI test IDs.
