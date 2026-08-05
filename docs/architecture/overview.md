# Architecture Overview

## Recommended Stack

- Mobile app: React Native with Expo.
- Native integrations: Expo config plugins plus custom native modules where share extensions require platform code.
- Backend: Supabase.
- Database: Postgres through Supabase.
- Auth: Supabase Auth with anonymous-first sessions and later account linking.
- Local storage: SQLite or equivalent durable local store for offline queue and cached bookmarks.

## System Components

```text
+----------------------+       +-----------------------+
|  iOS / Android Apps  |       |  Platform Share Sheet |
|                      |<------|  URL/Text Payload     |
+----------+-----------+       +-----------------------+
           |
           v
+----------------------+
| Share Intake Layer   |
| - parse payload      |
| - validate URL/text  |
| - local queue write  |
| - non-blocking toast |
+----------+-----------+
           |
           v
+----------------------+
| Local Data Layer     |
| - pending saves      |
| - cached bookmarks   |
| - retry state        |
+----------+-----------+
           |
           v
+----------------------+
| Sync Service         |
| - create/update      |
| - conflict handling  |
| - metadata jobs      |
+----------+-----------+
           |
           v
+----------------------+
| Supabase Backend     |
| - auth               |
| - Postgres           |
| - row-level security |
| - edge functions     |
+----------------------+
```

## Share Intake Requirements

The share intake path must be optimized for speed and minimal interruption.

- Do not open a full editor by default.
- Do not block on cloud network requests before showing confirmation.
- Write to local durable storage first.
- Queue cloud sync in the background.
- Show only a short toast, snackbar, or platform-equivalent confirmation.
- If parsing fails, show a short non-blocking failure toast and retain diagnostics when possible.

## Toast Behavior

The toast shown after sharing content into Stash should be:

- Short-lived.
- Non-modal.
- Non-blocking for touches and navigation.
- Safe to dismiss automatically.
- Informational only.

Suggested copy:

- Success: `Saved to Stash`
- Queued offline: `Saved offline. Will sync later.`
- Duplicate: `Already in Stash`
- Failure: `Could not save to Stash`

## Sync Strategy

The app should treat local save as the source of immediate user confirmation. Cloud sync is eventually consistent.

For the current client/server state model—including the local sync outbox,
metadata fetch, AI scheduler, server overflow queue, and the display-only
Settings projection—see [Bookmark Processing Statechart](bookmark-processing-statechart.md).

1. Receive shared content.
2. Normalize the payload.
3. Generate a local ID.
4. Persist the local bookmark with `sync_status = pending`.
5. Show non-blocking toast.
6. Start background sync.
7. Upsert bookmark into Supabase.
8. Update local row with remote ID and `sync_status = synced`.
9. Trigger metadata enrichment.

## Conflict and Deduplication Strategy

Deduplication should use canonicalized URLs when possible.

- Strip common tracking parameters where safe.
- Resolve canonical URL during metadata enrichment.
- Prevent duplicate active bookmarks for the same user and canonical URL.
- If duplicate is detected during share intake, keep the existing bookmark and optionally update `last_saved_at`.

## Security Model

- Every bookmark belongs to one authenticated user ID.
- Row-level security must prevent cross-user access.
- AI or automation clients must operate through user-scoped API operations.
- Service-role access should only be used in trusted server-side functions.

## AI-Ready Design

Future AI systems should not need direct unsafe database access. They should interact through explicit operations that support:

- Reading user bookmarks.
- Updating tags and collections.
- Writing summaries.
- Marking AI processing status.
- Recording explanations or confidence scores for generated metadata.

AI-generated fields must be distinguishable from user-authored fields.
