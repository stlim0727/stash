# Google Play Store Preparation

Last updated: 2026-07-10.

This is the working checklist for publishing Keepory to Google Play. It is
based on the current repository state and the current Google Play requirements:

- Target API: new apps and app updates must target Android 15 / API 35 or
  higher as of 2025-08-31.
- New Play releases should use an Android App Bundle (`.aab`) and Play App
  Signing, not the internal debug-signed APK workflow.
- Store listing fields are shared across testing tracks, so the listing,
  privacy policy, data safety form, and app content declarations should be ready
  before closed/open testing.

Official references:

- Target API: https://developer.android.com/google/play/requirements/target-sdk
- App signing: https://support.google.com/googleplay/android-developer/answer/9842756
- App setup/listing: https://support.google.com/googleplay/android-developer/answer/9859152

## Current Repo State

- App display name: `Keepory` (`apps/mobile/app.json`).
- Android package: `com.stash.app`.
- App version: `1.1.0`.
- EAS production profile exists and should produce the store build:
  `eas build --profile production --platform android`.
- Internal APK CI exists in `.github/workflows/android-apk.yml`, but it builds
  a debug-signed, arm64-only APK for sideload/Firebase App Distribution. Do not
  upload that APK to Google Play.
- App icon and adaptive icon assets exist under
  `apps/mobile/assets/images/`.
- The current `docs/privacy.html` is for the Stash Library Assistant GPT and
  Public API. It is not suitable as the mobile app privacy policy without
  rewriting.
- Local `pnpm` must be run through Corepack or downgraded to the repo range:
  the globally installed `pnpm` was 11.7.0, while the repo requires
  `>=10 <11`. `corepack pnpm -v` returned 10.28.1.
- `corepack pnpm --filter mobile exec expo config --type public` currently
  fails locally because Expo cannot resolve the `expo-splash-screen` plugin from
  the current dependency layout. CI does a hoisted install before native builds,
  so store-build verification should run from a fresh hoisted install or via EAS.

## Release Blockers

Resolve these before submitting a production or open-testing release:

1. Decide the permanent Android package name.
   `com.stash.app` is already in `app.json`, but the public brand is Keepory.
   Google Play package names are effectively permanent after publication. If the
   public package should be `com.keepory.app` or another identifier, change it
   before the first Play upload.

2. Create a mobile-app privacy policy.
   It must cover the Android app, not only the GPT/API integration. Host it at a
   stable public URL, preferably under `https://keepory.app/`.

3. Provide an account/data deletion path.
   Play Console data safety/account deletion declarations need a clear user path
   and usually a web URL for account deletion requests. The app currently has
   sign-out behavior, but sign-out is not account deletion.

4. Verify a store-ready Android App Bundle.
   Build with the production profile and confirm target SDK, versionCode,
   signing, package name, app label, icon, and runtime config.

5. Real-device smoke test the native path.
   Native SQLite and share-intent remain the highest-risk unverified path for
   this project. A Play-bound build should be installed and tested on a real
   Android device before upload.

6. Complete Data safety and App content declarations.
   These are policy declarations, not code tasks. They should match actual app
   behavior and backend/Sentry/Supabase configuration.

## Build Path

Use EAS for the Play build:

```bash
cd apps/mobile
corepack pnpm dlx eas-cli login
corepack pnpm dlx eas-cli build --profile production --platform android
```

Expected output: `.aab` suitable for Play Console upload.

Do not use `.github/workflows/android-apk.yml` for Play upload. That workflow is
for internal testing and sideload distribution only.

Before building:

- Ensure `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` are set
  in the production EAS environment.
- Set `EXPO_PUBLIC_SENTRY_DSN` only if production crash reporting should be
  enabled for the store build.
- Ensure Sentry source map secrets are configured if crash reporting is enabled:
  `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, and `SENTRY_PROJECT`.
- Confirm `apps/mobile/app.json` version and EAS remote versionCode are correct.

Post-build checks:

```bash
# Inspect the built app bundle locally if downloaded from EAS.
bundletool dump manifest --bundle app-release.aab
```

Confirm:

- `package="com.stash.app"` or the final chosen package.
- `versionName="1.1.0"` or the intended release version.
- `versionCode` is greater than every previous Play upload.
- `targetSdkVersion` is at least 35.
- No unexpected dangerous permissions appear.

## Play Console Setup

One-time setup:

1. Create a Google Play Developer account.
2. Create the app in Play Console:
   - App name: `Keepory`
   - Default language: English or Korean, based on launch market.
   - App or game: App
   - Free or paid: Free, unless monetization is ready.
3. Enroll in Play App Signing.
4. Upload the first production EAS `.aab` to an internal testing track first.
5. Add testers and complete all required declarations.
6. Promote to closed/open testing only after the internal build passes QA.

## Store Listing Draft

Short description, 80 chars max:

```text
Save links, notes, and images from any app into a clean bookmark inbox.
```

Full description draft:

```text
Keepory is a fast bookmark inbox for links, notes, and images you want to save
without interrupting what you are doing.

Save from any app through Android share, organize bookmarks with tags and
folders, search across titles, URLs, notes, tags, and sites, and keep your
library available offline. Optional sync backs up your library so it can follow
you across devices.

Key features:
- One-tap capture from the Android share sheet
- Local-first bookmark storage with offline access
- Tags, folders, trash, search, and multiple inbox layouts
- Korean and English interface support
- Optional AI-assisted summaries and tag suggestions
- Privacy-conscious diagnostics and crash reporting
```

Suggested category:

- Productivity, or Tools. Productivity fits the bookmark/library workflow
  better.

Suggested contact email:

- Use the public support email that will also appear in the privacy policy.

## Data Safety Working Notes

Validate these before submitting; do not copy blindly into Play Console.

Likely collected by first party:

- User IDs / account identifiers: Supabase auth user id for sync/account state.
- Email address: only if email sign-in is enabled for the user.
- User content: bookmark URLs, titles, notes, descriptions, tags, collections,
  and image bookmarks.
- App activity / diagnostics: sync status, coarse diagnostics, crash/error
  reports when Sentry is enabled.

Likely shared with service providers:

- Supabase: auth, database, edge functions, and sync backend.
- Sentry: crash/error monitoring when configured. Project code sets
  `sendDefaultPii` to false and uses only an opaque user id.
- AI provider behind the `ai-enrich` edge function if AI suggestions are used.
  Confirm the current provider and retention terms before declaring.

Likely not collected:

- Precise location.
- Contacts.
- Financial info.
- Health and fitness data.
- Advertising ID, unless a dependency introduces it later.

Security practices to claim only after verification:

- Data encrypted in transit: yes if all backend calls are HTTPS.
- Users can request data deletion: only after the deletion path and URL exist.
- Data encrypted at rest on device: do not claim this yet. Local bookmark
  encryption is still listed as future work.

## Privacy Policy Must Cover

The mobile privacy policy should include:

- What the app stores locally.
- What sync uploads to Supabase.
- What anonymous sessions are and how they are used.
- What account sign-in stores.
- What data is sent to AI enrichment and when.
- What diagnostics/crash reports may include, and the current redaction rules.
- Whether image bookmarks stay local or sync/upload behavior once implemented.
- Data retention and deletion.
- Contact email.
- Effective date.

## QA Checklist Before Upload

Run automated checks:

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:components
```

Run native smoke on a real Android device:

- Fresh install opens to an empty Inbox without crash.
- Add URL manually and confirm it persists after app restart.
- Share a URL from Chrome/KakaoTalk/etc. into Keepory and confirm capture.
- Share text without a URL and confirm text-note capture.
- Share an image and confirm local image bookmark capture.
- Delete to Trash, restore, then permanently delete.
- Search by title, URL, tag, and collection.
- Sign in, sync, restart, and confirm the library remains available.
- Sign out and confirm previous account-owned synced rows are not visible.
- Report-a-problem flow redacts user content as expected.
- Confirm Settings shows the intended app version/build provenance.

## First Submission Sequence

1. Decide package name and make any needed `app.json` changes before Play app
   creation.
2. Write and publish the mobile privacy policy.
3. Add or publish an account/data deletion request path.
4. Configure EAS production environment and Sentry source-map secrets if needed.
5. Build production Android `.aab` with EAS.
6. Inspect manifest and permissions.
7. Install/test the Play-bound build on a real Android device.
8. Create Play Console app and complete store listing, app content, data safety,
   target audience, and privacy declarations.
9. Upload to internal testing.
10. Fix Play pre-launch report or policy findings.
11. Promote to closed/open/production track when QA and policy are clean.
