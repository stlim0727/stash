# Stash Product Spec

## Vision

Stash is a simple, cloud-synced bookmark app for saving links and shared content from any mobile app with minimal interruption. It is inspired by Raindrop.io, but the first product principle is speed: capture now, organize later.

## Goals

- Let users save links from any app without breaking their current phone flow.
- Sync bookmarks to the cloud so they are available across devices.
- Keep the UI simple, inbox-first, and search-first.
- Expose clean read/write/modify bookmark operations so future AI features can categorize, sort, summarize, deduplicate, and enrich saved content.
- Preserve enough metadata for later automation without forcing users to organize every save manually.

## Non-goals for MVP

- Full Raindrop.io feature parity.
- Browser extension support.
- Public collections or social sharing.
- In-app AI categorization or summarization.
- Full article offline archiving.
- Complex folder nesting.

## Target Platforms

The MVP targets iOS and Android from day one using React Native with Expo. Native share integration is required on both platforms because sharing from other apps is a core product behavior.

## Primary User Experience

### Save from another app

1. User taps the platform share button in another app.
2. User chooses Stash from the share sheet.
3. Stash accepts the shared URL or text payload in the background.
4. Stash immediately queues the content for saving.
5. Stash shows a short non-blocking toast confirming the save attempt.
6. User remains in their current phone flow without needing to open the full app.

The toast must be brief and non-modal. It must not block touch interaction, require confirmation, or force the user into Stash.

### Browse saved bookmarks

1. User opens Stash.
2. The default screen shows an Inbox of recently saved bookmarks.
3. User can search, open, edit, archive, tag, or move bookmarks to a collection.
4. Bookmark metadata may continue to update in the background after initial save.

### Manual save

1. User opens Stash.
2. User taps Add.
3. User pastes or types a URL.
4. Stash saves immediately and fetches metadata in the background.

## MVP Screens

### Inbox

- Search input at the top.
- Simple chronological list of bookmarks.
- Each item shows title or URL, domain, save time, and sync status if needed.
- Optional small metadata preview when available.
- Empty state that explains sharing links into Stash.

### Bookmark Detail

- URL.
- Title.
- Description.
- Notes.
- Tags.
- Collection.
- Metadata status.
- Archive/delete actions.

### Add Bookmark

- URL input.
- Save action.
- Optional note field.

### Settings

- Account state.
- Cloud sync status.
- Sign in/link account actions.
- Export/delete account placeholders.

## Authentication

The MVP should use anonymous-first authentication with optional account linking later. This keeps first-save friction low while still allowing cloud sync and future cross-device continuity.

Recommended account linking options:

- Apple sign-in.
- Google sign-in.
- Email magic link.

## Organization Model

The first UI should be inbox-first. The data model should support both tags and collections, but the MVP should avoid making users organize content during capture.

- Every new bookmark lands in Inbox by default.
- Tags are optional.
- A bookmark can belong to zero or one collection initially.
- AI-generated tags and suggested collections can be added later without changing the core schema.

## Metadata Strategy

The app should save raw shared content first, then enrich it asynchronously.

Initial save captures:

- URL or shared text.
- Source app when available.
- Created timestamp.
- User ID.
- Local pending/synced state.

Background enrichment may add:

- Title.
- Description.
- Site name.
- Favicon URL.
- Image preview URL.
- Canonical URL.
- Content type.

## Offline and Sync Behavior

Stash should support offline capture.

- If the device is offline, shared content is saved to a local queue.
- A non-blocking toast should still appear after local queueing succeeds.
- The app syncs queued saves when network connectivity returns.
- Bookmark rows should preserve sync state so the UI can show pending or failed saves.

## Success Metrics

- Median share-to-confirmation time below 500 ms after selecting Stash.
- Save flow requires zero taps after selecting Stash from the share sheet.
- At least 99% of valid URLs are either synced or retained in a retry queue.
- Users can find recent bookmarks from the Inbox in under five seconds.
