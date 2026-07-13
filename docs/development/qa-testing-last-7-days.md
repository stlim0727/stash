# QA Testing Guide: Last 7 Days (July 6 – July 13, 2026)

This document provides a human-tester checklist to verify all major features, bug fixes, and performance improvements merged over the last 7 days.

---

## Category 1: SQLite Storage & Cold Boot Resilience (Native Mobile)

### Changes
- Added a non-blocking directory preflight check that repairs/creates the SQLite directory on boot.
- Resolved native database opening crashes due to directory permission/existence errors.
- Handled trailing slash path resolution and directory check logic (`file.exists` vs `Paths.info`) to bypass Android URI conversion false-negatives.
- Cadence-gated SQLite reopen churn alerts to keep Sentry reporting clean.

### How to Verify (Human Tester)
1. **Clean Install Boot:** Delete the app from a real Android/iOS device (or completely clear the app's storage and cache).
2. **Launch:** Open the app. Verify it successfully boots to the empty Inbox state without freezing, looping, crashing, or showing the local-storage error banner.
3. **Persistence:** Save a test bookmark, force-close the app, and reopen it. Verify the bookmark is still present and editable.
4. **Re-launch:** Force-close and reopen the app multiple times to ensure the database opens smoothly without triggering churn alerts.

---

## Category 2: Real-time Multi-Device Sync (Supabase WebSockets)

### Changes
- Plumbed real-time WebSocket client broadcast nudges. Creates, updates, and deletes on one device now trigger instant pulls on other active devices.
- Handled background/foreground lifecycles (clearing sync debounce on backgrounding, catch-up pull queuing on foregrounding).
- Routed queued sync operations through a reference to prevent stale React hook closures (resolving a bug where logging out would mistakenly mint a temporary anonymous account and wipe data).
- Added a sync-watermark recovery mechanism to ensure all cloud rows are correctly pulled after a user logs in.

### How to Verify (Human Tester)
1. **Simultaneous Real-time Sync:** Log in to the same user account on two isolated clients: two physical devices, two different browsers, two separate browser profiles, or one client with site storage cleared/isolated. Do not use two normal windows in the same browser profile; they share the same web `install_device_id` and will ignore each other's realtime nudges.
2. **Modifications:** Create, edit, or delete a bookmark in Client A. Client B must update its UI and display the modified state after the realtime nudge/sync settles, without requiring manual refresh.
3. **Background Resume:** Minimize Client B, add a bookmark in Client A, and then bring Client B back to the foreground. Verify the new bookmark appears after the foreground catch-up sync.
4. **Login Restore:** With at least one older bookmark already present in the cloud account, sign in from a fresh or storage-cleared isolated client. Verify the older cloud bookmark is restored on login even if it predates the client's previous sync watermark.
5. **Log out:** Log out of your account from Settings. Verify the Settings account card shows the signed-out state with inline sign-in options, and that the app does not mint a fresh anonymous user in the background until a later save explicitly needs one.

---

## Category 3: Cross-Device AI Suggestion Sync

### Changes
- Migrated the AI suggestion review state (ignored tags/folders) from local-only device storage to cloud-synced text array columns on the database.
- Dismissals are now preserved across all of a user's devices.
- Suppressed generic recommended folder/tag suggestions (like "web" or "bookmark").
- Handled preview/metadata fetching failures gracefully and added manual refresh controls for AI suggestions.

### How to Verify (Human Tester)
1. **Account Setup:** Sign Client A and Client B back into the same account after the logout check above, and open the same synced bookmark on both clients.
2. **Suggestion Setup:** Wait for AI suggestions or use a bookmark that already has a visible AI tag suggestion chip on both clients. Do not start the dismissal check until a dismissible tag suggestion is visible.
3. **Dismiss Sync:** In Client A, click **X** to dismiss (ignore) the suggested tag.
4. **Verification:** Open or refresh the same bookmark in Client B. Wait for the sync/nudge to settle, then verify that the dismissed tag suggestion is gone.
5. **Schema-Behind Fallback:** In a staging or developer-assisted stale-schema environment where PostgREST has not yet exposed the optional dismissal columns, dismiss a suggestion and confirm the local dismissal is preserved while sync queues a retry. After the schema cache/columns are available, sync again and verify the dismissal reaches Client B.
6. **Tag Relevance:** Add a new bookmark. Ensure the AI-suggested tags are specific to the content rather than generic labels.
7. **Manual Refresh:** If a bookmark fails to extract metadata initially, use the **Preview** action in the detail page action bar to retry metadata extraction. Verify AI suggestions regenerate only after the preview/metadata refresh succeeds.

---

## Category 4: Share Sheet Intake Hardening

### Changes
- Handled YouTube Shorts shared via text format, ensuring they are resolved as URLs rather than failing or falling back to raw notes.
- Preserved share intents received during a cold start (when the app process was completely terminated).
- Added error logging for unsaveable share intents.

### How to Verify (Human Tester)
1. **YouTube Shorts Share:** On a real Android build, go to the YouTube mobile app, open a YouTube Short, and share it into Stash through the Android share sheet. Verify the shared text intent creates a bookmark, resolves the redirect, and fetches its preview successfully.
2. **Cold Start Share:** Force-terminate the Stash app. Share a webpage link from your mobile browser. On Android toast-mode capture, verify Stash durably saves the bookmark, dismisses back to the source app, and shows the saved confirmation on the next app open. On iOS/web, verify the app stays open and shows the in-app saved confirmation rather than launching into a blank inbox.

---

## Category 5: UI/UX & Web Visual Polish

### Changes
- Upgraded the overall theme: dark-first palettes, smooth layout shadows, and web ambient backdrop animation.
- Added **inline details** for desktop web, allowing bookmarks to expand directly within the grid/list layout instead of forcing a modal.
- Enhanced the library Graph view: anchored pinch-zoom to gesture center, enabled pinch-to-pan, and hid untagged nodes to declutter the layout.
- Integrated a feedback screenshot tool.

### How to Verify (Human Tester)
1. **Desktop Inline Detail:** On desktop web, click a bookmark card in the grid. It should slide open inline inside the grid cleanly, adjusting column flow without layout glitches.
2. **Graph Fixture:** Before opening Graph View, create or import at least two active bookmarks that share the same tag, plus one active untagged bookmark.
3. **Interactive Graph:** Go to the Graph View. Verify that the shared-tag bookmarks appear, pinch-to-zoom focuses on the center of your fingers, dragging pans the canvas, and the untagged bookmark is hidden from the graph.
4. **Report Screenshot:** From the screen you want captured, click the floating **Report a problem** button. On the Report page, turn on **Include screenshot**, verify the thumbnail preview appears, and submit.
