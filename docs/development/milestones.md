# Development Milestones

This plan turns the current product and architecture docs into an implementation path. The milestones are intentionally ordered so Stash becomes runnable and testable before native share-sheet work and backend complexity are added.

## Guiding sequence

1. Establish a predictable local development environment.
2. Build a runnable Expo app shell.
3. Encode the bookmark domain model in TypeScript.
4. Prove local-first bookmark creation.
5. Make local persistence durable.
6. Add Supabase auth, schema, and sync.
7. Prototype share intake on real devices.
8. Add metadata enrichment and release polish.

## Milestone 0 — Repo and development foundation

**Goal:** make the repository predictable for contributors and automation before application code is introduced.

**Deliverables:**

- Pin the Node.js version policy.
- Choose and configure the package manager.
- Add root package scripts for development, formatting, linting, type checking, and tests.
- Add a development setup guide.
- Add an environment variable template for future Supabase configuration.
- Document missing platform-specific tooling expectations for iOS, Android, Expo, EAS, and Supabase.

**Acceptance criteria:**

- `pnpm install` succeeds.
- `pnpm lint` succeeds.
- `pnpm typecheck` succeeds, even if it is a placeholder until app code exists.
- `pnpm test` succeeds, even if it is a placeholder until tests exist.
- New contributors can identify which local tools are required now versus later.

## Milestone 1 — Expo mobile scaffold

**Goal:** create the first runnable mobile app shell.

**Deliverables:**

- Add an Expo React Native app under `apps/mobile`.
- Use TypeScript from the start.
- Add navigation with Inbox as the default screen.
- Add placeholder screens for Inbox, Bookmark Detail, Add Bookmark, and Settings.
- Add app-level scripts that are callable from the repository root.

**Acceptance criteria:**

- `pnpm install` succeeds from the repository root.
- `pnpm dev` starts the mobile app.
- The app launches into Inbox.
- The MVP screens are reachable in development.

## Milestone 2 — Domain types and mock data

**Goal:** encode the product model before real persistence is introduced.

**Deliverables:**

- Add TypeScript types for bookmarks, tags, bookmark tags, collections, AI enrichments, and local pending bookmarks.
- Add representative mock bookmark data.
- Render mock bookmarks in Inbox and Bookmark Detail.

**Acceptance criteria:**

- Inbox displays sample saved links.
- Bookmark Detail displays URL, title, description, notes, tags, collection, metadata status, and archive/delete placeholders.
- Type checking passes.

## Milestone 3 — Local-first manual bookmark creation

**Goal:** implement the first real user workflow without depending on cloud services.

**Deliverables:**

- Add Bookmark accepts a URL and optional note.
- New bookmarks appear in Inbox immediately.
- New bookmarks receive local sync state and pending metadata state.
- Basic URL validation is implemented.

**Acceptance criteria:**

- A user can save a URL manually.
- The bookmark appears without waiting on a network request.
- Invalid input fails with a clear non-blocking message.

## Milestone 4 — Durable offline queue

**Goal:** replace temporary in-memory state with durable local persistence.

**Deliverables:**

- Add a SQLite-backed local data layer or equivalent durable local store.
- Persist pending bookmark payloads.
- Track retry count, last error, and sync status.
- Add developer-friendly queue inspection helpers.

**Acceptance criteria:**

- A locally saved bookmark survives app restart.
- Pending queue entries survive app restart.
- Failed items remain retryable.

## Milestone 5 — Supabase bootstrap

**Goal:** prepare cloud sync and anonymous-first authentication.

**Deliverables:**

- Add a Supabase client wrapper.
- Add Supabase environment configuration.
- Add initial database migrations for bookmarks, tags, bookmark tags, collections, and AI enrichments.
- Draft row-level security policies.

**Acceptance criteria:**

- The app can initialize Supabase configuration.
- Anonymous auth can be created or restored in development.
- Database tables are scoped by authenticated user ID.

## Milestone 6 — Bookmark API implementation

**Goal:** implement the documented bookmark API contract.

**Deliverables:**

- Implement `createBookmark`, `listBookmarks`, `getBookmark`, `updateBookmark`, `deleteBookmark`, `addTags`, `removeTags`, `updateAIEnrichment`, and `applyAISuggestions`.
- Preserve separation between user-authored fields and generated metadata.
- Make save operations idempotent where possible.

**Acceptance criteria:**

- Duplicate saves reuse or return the existing bookmark.
- Bookmarks are only visible to their owner.
- API behavior matches the documented contract.

## Milestone 7 — Sync service

**Goal:** connect local-first behavior to Supabase with eventual consistency.

**Deliverables:**

- Add a background sync service.
- Upload pending bookmarks.
- Update local rows with remote IDs and synced status.
- Implement retry and error handling.
- Add visible sync status in the app.

**Acceptance criteria:**

- Offline-created bookmarks sync when connectivity and auth are available.
- Sync failures remain visible and retryable.
- Duplicate remote rows are avoided.

## Milestone 8 — Share intake prototype

**Goal:** prove the core save-from-anywhere workflow on real platforms.

**Deliverables:**

- Investigate and implement the Expo/native approach for iOS and Android share intake.
- Persist shared payloads locally before network calls.
- Show short non-blocking confirmation messages.
- Document any platform-specific build requirements.

**Acceptance criteria:**

- At least one platform can share a URL into Stash in a development build.
- The share flow does not open a full editor by default.
- The share flow does not wait on cloud sync before confirmation.

## Milestone 9 — Metadata enrichment placeholder

**Goal:** prepare for rich previews without making enrichment part of the critical save path.

**Deliverables:**

- Add metadata status transitions.
- Add a basic enrichment placeholder for title, favicon, site name, and preview image.
- Keep user-authored fields separate from generated fields.

**Acceptance criteria:**

- Initial saves never block on metadata enrichment.
- Metadata can update after a bookmark is visible.
- Failed enrichment does not fail bookmark creation.

## Milestone 10 — MVP polish and internal release readiness

**Goal:** prepare a usable internal iOS/Android build.

**Deliverables:**

- Add empty, loading, and error states.
- Finish Settings account and sync status placeholders.
- Add archive/delete flows.
- Add EAS build configuration.
- Update release and development docs.

**Acceptance criteria:**

- Internal builds can be produced.
- Manual save, Inbox browsing, detail view, archive/delete, and sync state are usable.
- The app remains optimized for fast capture and later organization.

---

# 0.1.8 cycle — "Korean & internationalization"

M0–M10 delivered the MVP; 0.1.7 added the capabilities (AI enrichment, export,
OAuth, sync hardening). 0.1.8 is a focused **localization** release: speak
Korean, and make AI answer in the user's language.

**Already shipped in the 0.1.7 tree — do _not_ re-plan these** (an earlier draft
of this section incorrectly listed them as new work; they exist on `main`):

- **Client-side search** — Inbox search box over title/url/notes/tags,
  incremental and offline (`apps/mobile/src/app/index.tsx`, `filterBookmarks`).
- **Import** — re-ingest a Stash **JSON** backup *or* a Netscape **HTML**
  bookmarks file, local-first (`settings.tsx`, `domain/import.ts`,
  `share/import-data.ts`, `store/bookmarks.tsx#importBookmarks`).
- **Offline tag editing** — tag add/remove are already optimistic + queued
  through the durable local-first tag-op queue (`store/bookmarks.tsx`).

0.1.8's job is therefore to **localize the existing surfaces** (incl. those
above), not to rebuild them.

## Milestone 11 — Internationalization foundation + Korean

**Goal:** make the UI translatable and ship Korean as the first locale (the
primary audience; capture test data is already Korean).

**Deliverables:**

- Add an i18n layer (`expo-localization` for device locale + a lightweight
  message catalog; no heavy framework needed) with a typed `t()` helper. (None
  exists today — verified no `expo-localization`/i18n in the tree.)
- Extract all user-facing strings from the **existing** screens/components into
  a default English catalog (keys, not inline literals) — Inbox + search,
  Settings (incl. export/import), bookmark Detail, Review, Account, Report.
- Add a Korean (`ko`) catalog; detect device locale with English fallback and a
  manual language override in Settings.
- Locale-aware formatting for dates/counts/pluralization.

**Acceptance criteria:**

- On a Korean device the app renders in Korean; unknown keys fall back to
  English, never to a blank/visible key.
- Capture is never blocked or slowed by locale loading.
- No remaining hardcoded user-facing literals in the touched screens (lint/grep
  guard).
- Note: AI-generated text (summaries/tags) language is handled in M12, not here.

## Milestone 12 — Locale-aware AI output + degraded-mode visibility

**Goal:** make AI answer in the user's language and degrade visibly.

**Deliverables:**

- Prompt Gemini to return summary/tags in the user's locale (ties to M11).
- Surface degraded mode (rate-limit/outage → heuristic fallback) with a clear,
  non-error in-app signal (the #101 free-tier `limit:0` case currently falls
  silently to dummy heuristics, masking the cause).

**Acceptance criteria:**

- For a Korean user, generated summaries/tags come back in Korean.
- An outage/rate-limit is visibly indicated rather than silently degraded.

---

## Deferred to 0.2.0 — "public beta"

Bigger or infra items intentionally held back so 0.1.8 stays a tight point
release:

- Real branding (icon/splash) replacing Expo defaults.
- A tester distribution channel (Firebase App Distribution / Play internal
  testing) that removes the per-install "install unknown apps" prompt — pairs
  with branding as the public-beta theme, and lets the `-rcN` tag convention be
  retired in favor of an auto-updating internal track.
- Native Apple sign-in button (App Store submission requirement) (#49).
- Native silent share extension + system notification (#89).
- `pgvector` embeddings for collection routing as collections grow (#87).
