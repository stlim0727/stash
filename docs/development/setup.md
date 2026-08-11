# Development Setup

This guide describes the baseline development environment for Stash. The repository contains product and architecture documentation, root-level tooling, and the Expo mobile app under `apps/mobile`.

## Required now

- Git.
- Node.js matching the repository policy in `.node-version` and `package.json`.
- pnpm through Corepack or a standalone pnpm install.
- Expo CLI, available through `pnpm exec expo` or the package scripts — no global install needed.

## Required later

These tools are not required yet, but they will be needed as native builds and the backend are added.

- EAS CLI for cloud builds and native development builds.
- Supabase CLI for local database work, migrations, and Edge Functions.
- Android Studio and Android platform tools for Android emulator/device testing.
- Xcode and CocoaPods on macOS for iOS simulator/device testing.

## Install dependencies

```bash
pnpm install
```

## Common commands

```bash
pnpm dev          # start the Expo dev server for apps/mobile
pnpm dev:android  # start and open on an Android emulator/device
pnpm dev:ios      # start and open on an iOS simulator/device (macOS)
pnpm dev:web      # start and open in a web browser
pnpm lint
pnpm typecheck
pnpm test
pnpm format
pnpm format:check
```

`pnpm dev` starts the Expo dev server; press `a`, `i`, or `w` in the terminal (or scan the QR code with Expo Go) to open the app. `test` remains an intentional placeholder until automated tests are added alongside app features.

## Environment variables

Copy `.env.example` to `.env.local` when Supabase integration starts:

```bash
cp .env.example .env.local
```

Do not commit real secrets or project-specific private keys. Expo public values that are safe for clients should use the `EXPO_PUBLIC_` prefix.

## Current environment audit

The current container has Git, Node.js, npm, npx, Yarn, pnpm, and Java available. Expo CLI, EAS CLI, Supabase CLI, Xcode, CocoaPods, and Android Debug Bridge were not globally available during the initial audit. That is acceptable for Milestone 0, but mobile and backend milestones should add install instructions or package scripts as those tools become necessary.

## Supabase environment

Milestone 5 introduces the client-side Supabase bootstrap. Copy `.env.example` to `.env.local` (or provide the variables in your Expo environment) and set:

- `EXPO_PUBLIC_SUPABASE_URL` — your Supabase project URL.
- `EXPO_PUBLIC_SUPABASE_ANON_KEY` — your client-safe anon/publishable key.

Anonymous sign-ins must also be enabled in the Supabase Auth provider settings. Without real project credentials the app stays local-first and reports the missing configuration from Settings.

## Crash & error monitoring (Sentry)

The app reports unhandled crashes (`Sentry.wrap` + native crash handling) **and**
handled error-level logs — `console.error(...)` and direct `recordLog('error', …)`
are forwarded to Sentry as exceptions, with URLs/emails scrubbed from the message
and stack first (see `apps/mobile/src/observability/`). Monitoring is a **no-op
until a DSN is configured**, so local and preview environments never report by
accident.

To enable it, create a React Native project in Sentry, then provide its DSN via
the `EXPO_PUBLIC_SENTRY_DSN` environment variable wherever you build:

- **Local dev** — add `EXPO_PUBLIC_SENTRY_DSN` to your `.env.local`.
- **Android APK CI** (CircleCI `android_apk` job) — set a CircleCI project/context
  environment variable named `EXPO_PUBLIC_SENTRY_DSN`; the job already passes it
  through to the build, and a CI guard asserts it gets inlined into the bundle.
- **EAS builds** — set it as an EAS secret / `eas.json` env value.

Optional tuning:

- `EXPO_PUBLIC_SENTRY_ENVIRONMENT` — environment tag (defaults to `development`).
- `EXPO_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` — `0..1` performance-tracing sample
  rate (defaults to `0`, i.e. tracing off).

Privacy: `sendDefaultPii` is off and only an opaque user id is ever attached —
never email or bookmark content.

To confirm the DSN → project pipeline is live, run the smoke test (it sends a
synthetic event tagged `environment:verify` / `logger:stash-verify` and asserts
the ingest API accepted it):

```bash
EXPO_PUBLIC_SENTRY_DSN=<your-dsn> pnpm verify:sentry
```

Resolve/ignore the resulting `verify` event in Sentry so it stays out of real
issues.

For in-app feedback issues (`STASH-N` short IDs), use the repo helper instead of
hand-rolling Sentry API calls:

```bash
pnpm sentry:issue STASH-22
pnpm sentry:issue STASH-22 --release 1.2.0-rc5
pnpm sentry:issue STASH-22 --resolve
```

It reads `SENTRY_AUTH_TOKEN` plus optional `SENTRY_ORG` / `SENTRY_PROJECT` from
the shell, `.env.local`, or the file pointed to by `SENTRY_ENV_FILE`.

## Product analytics — full PostHog SDK (session replay, flags, surveys)

This is a **trial running alongside Sentry, not a replacement for it** —
Sentry stays the crash/error monitor. It's a separate, heavier layer on top
of the existing privacy-safe analytics client
(`apps/mobile/src/analytics/`, unaffected by this): the official
`posthog-react-native` SDK (`apps/mobile/src/analytics-full/`), adding
session replay, richer feature flags, and in-app surveys. Touch autocapture
(`captureTouches`) is deliberately off — tapping a specific bookmark card
would signal which bookmark a user interacted with — so this phase of the
trial does not produce PostHog's interaction heatmaps; that would need a
separate, privacy-safe touch-capture design as a follow-up.

Two independent gates must both be on before anything is ever recorded:

1. **Build-time** — `EXPO_PUBLIC_POSTHOG_FULL_SDK_ENABLED=true`, alongside the
   existing `EXPO_PUBLIC_POSTHOG_API_KEY` / `EXPO_PUBLIC_POSTHOG_HOST` (same
   EU-hosted PostHog project the base analytics client uses). Unset in
   production until the trial is deliberately turned on for a build/channel —
   without it the SDK is never constructed.
2. **Runtime** — a Settings toggle ("Enable session replay & feature
   previews"), separate from and dependent on the base "Share privacy-safe
   usage analytics" toggle (broader consent is a prerequisite; turning the
   base toggle off also turns this one off). Off by default even once the
   build-time gate is on.

For local testing, set all three env vars in `.env.local` and opt in through
both Settings toggles.

**Masking is safety-critical and must be verified manually, not just by
reading the code.** Bookmark titles, URLs, tags, notes, and images are
exactly the content class session replay could otherwise expose, so
`buildPostHogFullInitOptions` in `posthog-full-config.ts` pins conservative
`sessionReplayConfig` masking explicitly rather than trusting SDK defaults.
Before enabling the build-time gate on any channel real users can reach
(including internal/beta), do a manual pass: build with the gate and both
toggles on, seed realistic bookmark content, navigate through Inbox/Library/
bookmark detail/search, then inspect the resulting recording in the PostHog
dashboard for any unmasked title/URL/tag/note/image content.

Consent durability has the same ceiling as the base analytics client's own
`writeVerifiedState` (3 retries with a read-back verify, then give up —
`posthog-full-runtime.tsx`'s `writeVerifiedPreference`): a disable that fails
all 3 durable-write attempts still opts the in-memory client out immediately
(so nothing records for the rest of that session) and surfaces a Settings
error prompting a retry, but if the app is killed before the user retries,
the next launch's stored preference could still read stale. As part of the
manual pass, worth also killing the app immediately after a simulated
preference-write failure on disable and confirming the next launch's
behavior.

### OAuth sign-in (Apple / Google)

Settings offers "Sign in with Apple / Google", which upgrades the anonymous account to a permanent one. The client uses a browser-based PKCE flow against GoTrue (`/auth/v1/authorize` → `grant_type=pkce`), so no `supabase-js` dependency or custom backend is needed. To enable it on a project:

1. **Enable the providers** under Authentication → Sign In / Up → Auth Providers (Apple and/or Google), supplying each provider's client ID/secret from the Apple Developer / Google Cloud consoles.
2. **Allow the redirect URLs** under Authentication → URL Configuration → Redirect URLs:
   - `stash://auth/callback` (native iOS/Android — the app's `scheme`).
   - your web origin's `/auth/callback` (only if you run the web build).
3. **Enable manual linking** (Authentication → settings) so signing in while anonymous *links* the new identity to the existing user and keeps their bookmarks. If linking is disabled the app falls back to a plain sign-in (a separate account).

Notes / limitations:

- The full OAuth round-trip needs the provider credentials above plus a device or emulator; it cannot be exercised in a headless CI/sandbox session.
- For App Store submission, Apple's guideline 4.8 expects a *native* "Sign in with Apple" button when other social logins are offered. The current browser flow is fine for development/internal builds; swapping in `expo-apple-authentication` (native button + `grant_type=id_token`) is a pre-submission follow-up.
