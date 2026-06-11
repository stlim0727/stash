# Stash

Stash is a planned mobile bookmark app inspired by Raindrop.io, with a simpler inbox-first UI and a capture flow optimized for saving links from any app without interrupting the user.

## Product Direction

- Cross-platform mobile app for iOS and Android.
- React Native with Expo for the app foundation.
- Supabase for auth, cloud sync, and Postgres-backed bookmark storage.
- Anonymous-first auth with account linking later.
- Share from any app with an immediate, short, non-blocking toast.
- Cloud-synced bookmarks with local offline queueing.
- Clean read/write/modify APIs for future AI categorization, sorting, summarization, and deduplication.

## Design Docs

- [Product spec](docs/design/product-spec.md)
- [Architecture overview](docs/architecture/overview.md)
- [Data model](docs/architecture/data-model.md)
- [Bookmark API contract](docs/api/bookmarks.md)
