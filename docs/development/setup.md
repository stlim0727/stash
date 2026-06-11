# Development Setup

This guide describes the baseline development environment for Stash. The repository currently contains product and architecture documentation plus root-level tooling. The Expo mobile app will be added in the next milestone.

## Required now

- Git.
- Node.js matching the repository policy in `.node-version` and `package.json`.
- pnpm through Corepack or a standalone pnpm install.

## Required later

These tools are not required for the current docs/tooling milestone, but they will be needed as the mobile app and backend are added.

- Expo CLI, preferably through `pnpm exec expo` or package scripts rather than a global install.
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
pnpm dev
pnpm lint
pnpm typecheck
pnpm test
pnpm format
pnpm format:check
```

Until the Expo app is added, `dev`, `typecheck`, and `test` are intentional placeholders that explain the missing implementation rather than failing.

## Environment variables

Copy `.env.example` to `.env.local` when Supabase integration starts:

```bash
cp .env.example .env.local
```

Do not commit real secrets or project-specific private keys. Expo public values that are safe for clients should use the `EXPO_PUBLIC_` prefix.

## Current environment audit

The current container has Git, Node.js, npm, npx, Yarn, pnpm, and Java available. Expo CLI, EAS CLI, Supabase CLI, Xcode, CocoaPods, and Android Debug Bridge were not globally available during the initial audit. That is acceptable for Milestone 0, but mobile and backend milestones should add install instructions or package scripts as those tools become necessary.
