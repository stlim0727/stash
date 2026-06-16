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
