# Building and Releasing

## Quick path: installable Android APK from CI (no EAS account)

For a real, installable Android APK without any Expo/EAS account, use the
**`.github/workflows/android-apk.yml`** workflow — it does `expo prebuild` →
Gradle `assembleRelease` (debug-signed, standalone) and publishes the APK.

**Every build publishes a GitHub Release with the raw `.apk` plus an install QR
code**, so the phone-only flow is: trigger → open the Release → scan the QR →
tap the downloaded `.apk` → install (allow "install unknown apps" once). No
desktop, no artifact zip to unpack.

- Run it via **workflow dispatch** with the `version` input, or by pushing a tag:
  - clean **`vX.Y.Z`** ⇒ a **versioned, stable** release (non-prerelease, marked
    _latest_), kept forever; its notes come from `docs/release-notes/<tag>.md`.
  - blank dispatch / **hyphenated** tag (e.g. `v0.1.7-rc8`) ⇒ refreshes the single
    rolling **`dev`** prerelease in place, so test builds don't clutter Releases.
- The APK is also still uploaded as a **run artifact** (`stash-android-apk`) for
  tooling — but for installing on a phone, prefer the Release asset (no unzip).
- `gh` CLI: `gh workflow run android-apk.yml -f version=v0.1.7-rc8 --ref main`,
  then grab the link from `gh release view dev` (or `gh run download <run-id> -n
  stash-android-apk` for the raw artifact).
- Build is **arm64-v8a only** (~6–7 min). Step-by-step (incl. the GitHub MCP-tool
  sequence for Claude Code web sessions) is in **`AGENTS.md`**.

> **Why there's still an "install unknown apps" prompt:** that's inherent to
> sideloading any APK outside an app store. To cut the repeat friction, set up
> **[Firebase App Distribution](#firebase-app-distribution-smoother-tester-installs)**
> (below) — testers install once via the App Tester app and new builds arrive
> with a notification.

## Versioning

Stash uses `MAJOR.MINOR.PATCH` (e.g. `0.1.7`). As a **pre-1.0 app** (not a
library with a public API), the practical convention is:

| Bump            | When                                           | Example         |
| --------------- | ---------------------------------------------- | --------------- |
| MINOR (`x.Y.0`) | a feature release                              | `0.1.x → 0.2.0` |
| PATCH (`x.y.Z`) | a bug-fix / hotfix release                     | `0.2.0 → 0.2.1` |
| MAJOR (`X.0.0`) | reserved for the first public/stable milestone | `→ 1.0.0`       |

Rules of thumb:

- **Any code users receive changed → bump the version.** A bug-fix release is a
  PATCH bump (`0.1.7 → 0.1.8`); new features are a MINOR bump (`→ 0.2.0`). Don't
  ship features under a PATCH bump — that's the "patch-as-feature" mismatch.
- **Same code, just rebuilt** (CI re-run, re-sign, refreshed QR) → keep the
  version; the build number distinguishes it.

### Marketing version vs build number

Two independent identifiers — don't conflate them:

- **Version name** — `apps/mobile/app.json` `version` (e.g. `0.1.7`), the human
  SemVer string. Drives `APP_VERSION` → `versionName` (see `app.config.js`, #96).
- **Build number** (`versionCode`) — a monotonic integer set to
  `github.run_number` per CI build, shown in-app as `0.1.7 (58)`. Stores require
  it to increase on every upload of the same version name. Use it only for
  **identical-code rebuilds**, never to paper over a code change.

So two builds of the *same* release are told apart by build number plus the
embedded commit SHA (`EXPO_PUBLIC_GIT_SHA`, shown in Settings and the Release
body). To annotate a build without cutting a new release, SemVer build metadata
after `+` is ignored for ordering: `0.1.7+cc0c8c7`.

### Don't ship different code under the same version

If a build fixes bugs, give it its own number (`0.1.7 → 0.1.8`) rather than
reusing `0.1.7` with a higher build number — otherwise the only signal that the
code changed is the build number / SHA, which is easy to miss. Reserve the
build-number-only distinction for genuinely identical code.

## Firebase App Distribution (smoother tester installs)

The QR/Release path above still shows a one-time "install unknown apps" prompt
because it's a bare sideload. **Firebase App Distribution** removes the repeat
friction: testers install once through the **App Tester** app, then every new CI
build appears there with a push notification — no per-build toggling, no zip.

The CI step already exists in `android-apk.yml` (`Distribute to Firebase App
Distribution`). It **skips cleanly until two repo secrets are set**, so nothing
breaks before setup. Once configured, every build uploads automatically.

### One-time setup (Firebase Console, ~10 min)

1. **Create / pick a project** at <https://console.firebase.google.com> (the
   free Spark plan covers App Distribution).
2. **Register an Android app**: Project → *Add app* → Android. Use package name
   **`com.stash.app`** (matches `app.json`). A `google-services.json` is offered
   but is **not required** for App Distribution — you can skip it.
3. **Copy the App ID** (Project settings → General → *Your apps*). It looks like
   `1:1234567890:android:abc123def456`.
4. **Add testers**: App Distribution → *Testers & Groups* → create a group with
   alias **`testers`** and add your email (and anyone else). The CI step targets
   the `testers` group by default (override with the `FIREBASE_TESTER_GROUPS`
   repo variable).
5. **Create a service account for CI**:
   - Google Cloud Console → *IAM & Admin* → *Service Accounts* → create one
     (e.g. `github-app-distribution`).
   - Grant it the **Firebase App Distribution Admin** role.
   - *Keys* → *Add key* → *JSON* → download the key file.

### Add the repo secrets

In GitHub → repo *Settings* → *Secrets and variables* → *Actions*:

| Secret | Value |
| --- | --- |
| `FIREBASE_APP_ID` | the App ID from step 3 (`1:…:android:…`) |
| `FIREBASE_SERVICE_ACCOUNT` | the **entire contents** of the downloaded JSON key |

Optional variable (not a secret): `FIREBASE_TESTER_GROUPS` — comma-separated
group aliases if you don't want the `testers` default.

### Using it

- Trigger the **Android APK** workflow as before. After the build, the APK is
  uploaded to App Distribution and your testers get an email/notification.
- **First time per tester**: accept the email invite → install the *App Tester*
  app → allow "install unknown apps" for App Tester **once**. After that, new
  builds are one tap from the App Tester app — no further prompts.
- The GitHub Release + QR path keeps working in parallel; Firebase is additive.

> Security: `FIREBASE_SERVICE_ACCOUNT` is written to a temp file in CI (never an
> inline CLI flag) and deleted after upload. Treat the JSON key like a password;
> rotate it from the Cloud Console if it leaks.

The rest of this doc covers the EAS-based path for store/internal builds.

## EAS builds

Stash uses [EAS Build](https://docs.expo.dev/build/introduction/) to produce
installable iOS and Android builds. Build profiles are defined in
`apps/mobile/eas.json`.

> **Why builds, not Expo Go:** the app depends on native modules
> (`expo-sqlite`, `expo-share-intent`) that are not part of the Expo Go
> runtime. Use a development build / dev client instead of Expo Go.

## Prerequisites

- An [Expo account](https://expo.dev) and `eas-cli` (`npm i -g eas-cli`, or run
  via `pnpm dlx eas-cli`).
- `eas login` once on your machine.
- For iOS device/store builds: an Apple Developer account. Set a
  `DEVELOPMENT_TEAM` in Xcode for the generated app and the Share Extension
  target (the `expo-share-intent` plugin creates the extension during prebuild).

## Identifiers

- iOS bundle identifier: `com.stash.app`
- Android package: `com.stash.app`
- iOS Share Extension app group: `group.com.stash.app` (generated by the
  share-intent plugin).

Update these in `apps/mobile/app.json` before a real public release.

## Build profiles (`eas.json`)

| Profile       | Use                                                            |
| ------------- | ------------------------------------------------------------- |
| `development` | Dev client for daily work; iOS builds for the simulator.      |
| `preview`     | Internal distribution (Android APK) for testers.              |
| `production`  | Store-ready build with auto-incrementing version.             |

## Common commands

Run from `apps/mobile/` (or pass `--cwd`):

```bash
# Internal preview builds (shareable install links)
eas build --profile preview --platform android
eas build --profile preview --platform ios

# Development client for local native work
eas build --profile development --platform android

# Production builds
eas build --profile production --platform all
```

### Local native run (alternative to EAS)

With Android Studio / Xcode installed you can build locally:

```bash
pnpm --filter mobile android   # expo run:android
pnpm --filter mobile ios       # expo run:ios (macOS)
```

`expo prebuild` generates the native `ios/` and `android/` projects on demand;
both are gitignored and regenerated from `app.json` + config plugins.

## Crash & error monitoring (Sentry)

Unhandled JS/native errors are reported to [Sentry](https://sentry.io) via
`@sentry/react-native`. The wiring is split the same way as the rest of the app:

- `src/observability/sentry-config.ts` — pure, unit-tested config (reads env, no SDK).
- `src/observability/sentry.ts` — thin SDK shell (`initSentry`, `wrapWithSentry`).
- `src/app/_layout.tsx` — calls `initSentry()` at boot and wraps the root.
- `app.json` — the `@sentry/react-native/expo` config plugin (native setup +
  source-map upload during EAS Build).

**Monitoring is off until a DSN is set**, so local and preview builds never
report by accident. Configure the client with Expo public env vars (e.g. in
`.env`, EAS build env, or `eas.json`):

| Variable                                | Purpose                                                       |
| --------------------------------------- | ------------------------------------------------------------- |
| `EXPO_PUBLIC_SENTRY_DSN`                | Sentry DSN. Unset ⇒ monitoring disabled.                      |
| `EXPO_PUBLIC_SENTRY_ENVIRONMENT`        | `development` (default) / `preview` / `production`.           |
| `EXPO_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` | 0..1 performance trace sample rate; `0` (off) by default.     |

Privacy: `sendDefaultPii` is `false` (no IP/cookies); only an opaque user id is
attached if you call `setSentryUser`.

### Source maps + releases

Two pieces make stack traces readable and trackable:

1. **Source maps** are uploaded automatically during **EAS Build** by the Expo
   config plugin when these build-time secrets are present:
   `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` (set via
   `eas secret:create` / the EAS dashboard).
2. **Release + commit association** is created by the
   `.github/workflows/sentry-release.yml` workflow when a `v*` tag is pushed
   (or via manual dispatch). It needs the same three values as **repository
   secrets**; the job skips cleanly if `SENTRY_AUTH_TOKEN` is unset.

## Smoke test checklist for an internal build

1. Launch → lands on Inbox (sample data on first run).
2. Add Bookmark → a URL appears immediately; invalid input shows an inline error.
3. Restart the app → saved bookmarks and the pending queue survive.
4. Open a bookmark → metadata (title/site/favicon) populates shortly after save.
5. Archive / Delete from the detail screen behave as expected.
6. Share a link from another app → it is saved to Stash with a toast, no editor.
7. With Supabase configured → Settings shows an anonymous session and the queue drains.
