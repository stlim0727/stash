---
name: web-deploy
description: >-
  Build, verify, and ship the Stash web app (Cloudflare Workers Static Assets at
  keepory.app). Use whenever the user asks to "deploy the web build", "ship the
  web app", "push to keepory.app", "check the web export", "verify the web
  build", or is chasing a web-only display/routing/provenance bug. Produces the
  same outcome every time: a clean web export, verified SPA routing + commit
  stamp, and a deploy (or a clear reason not to) grounded in the repo's real
  config (wrangler.toml, scripts/web-build.sh).
---

# Deploy / verify the Stash web app

The *doer* for the web platform. The web build is a **static** Expo export
(`expo export --platform web` → `apps/mobile/dist`) served from **Cloudflare
Workers Static Assets** at **`keepory.app`** — no server, same Supabase backend
over REST. The authoritative operator doc is `docs/development/deploy-web.md`;
the config of record is **`wrangler.toml`** (repo root) and **`scripts/web-build.sh`**.
If this file ever disagrees with those, they win — fix this file.

**Key fact about how deploy actually works here:** every push to `main` (the
production branch) auto-deploys via Cloudflare's Git integration, and the deploy
phase runs `bash scripts/web-build.sh` (wired as `[build] command` in
`wrangler.toml`) — Cloudflare does **not** just serve a folder you built. So the
common cases are (a) **verify** a change exports and routes correctly before it
merges, and (b) **diagnose** a live web bug. An agent in this sandbox generally
**cannot** run `wrangler deploy` (no Cloudflare creds); a manual deploy is the
user's action or a `main` push. Say so rather than pretending to deploy.

## Step 1 — Build the web export locally (the verify most changes need)

```sh
cd apps/mobile && CI=1 pnpm exec expo export --platform web
```

- This writes `apps/mobile/dist/`, which is **gitignored — delete it afterwards**
  (`rm -rf apps/mobile/dist`). Leaving it around risks committing a build.
- A failing export is the fastest signal a change broke the web bundle. Read the
  error; Metro/expo-router issues surface here, not in `pnpm typecheck`.
- To reproduce the *real* deploy build (including the provenance stamp), run
  `bash scripts/web-build.sh` from the repo root instead — it runs the export
  **and** resolves `EXPO_PUBLIC_GIT_SHA` (from `WORKERS_CI_*` → the `git` binary
  → `.git/HEAD`, degrading to "local build"). Use this when debugging the
  Settings build-line / provenance, not for a plain "does it compile" check.

## Step 2 — Verify the two things web uniquely gets wrong

1. **SPA routing.** The app exports with `web.output: "single"` (SPA) in
   `app.json`, so the export emits **`index.html` plus static assets only**
   (`/_expo/*`, `/manifest.webmanifest`, PWA icons) — **not** per-route HTML.
   `wrangler.toml` sets `assets.not_found_handling = "single-page-application"`,
   so **every route** — `/`, `/add`, `/settings`, `/auth/callback`, and the
   dynamic `/bookmark/<id>` — is served by the fallback to `/index.html`, which
   expo-router then client-renders. Real assets are matched **first**, so the
   fallback never rewrites the app's own JS. Do **not** expect a `dist/add.html`
   (or any route file) to exist — a correct SPA build has none; only assets are
   emitted. **Never add a Pages-style `_redirects` catch-all** — on Pages it is
   always followed and rewrites the bundles; `not_found_handling` is the
   asset-safe equivalent and the reason we're on Workers Static Assets.
2. **Origin-relative capture surfaces.** Nothing hard-codes the origin. The
   **bookmarklet** (`src/ui/BookmarkletButton.web.tsx` + pure
   `src/domain/web-capture.ts`) is built from `window.location.origin` at click
   time; the **PWA Web Share Target** (`apps/mobile/public/manifest.webmanifest`,
   `share_target → /add`) is origin-relative. If you touched either, keep them
   origin-relative so the same build works on any domain.

Also sanity-check anything **web-only** the change touches: responsive desktop
layout (multi-column Inbox, Settings as a right-side sheet on wide viewports),
self-hosted Inter font, and that cloud sync is gated on the build-time
`EXPO_PUBLIC_SUPABASE_*` env (absent → the site runs local-only, by design).

## Step 3 — Deploy (or state why you can't)

- **Normal path:** merging to `main` auto-deploys. If the task is "ship it",
  the move is usually to get the change onto `main` (PR → merge), then confirm
  the live site once Cloudflare finishes.
- **Manual deploy** (`npx wrangler deploy` from repo root) needs Cloudflare
  credentials this sandbox does not have. Do not fake it — if a manual deploy is
  wanted, hand the exact command to the user or note it's a `main`-push.
- **OAuth on a new origin**: web sign-in resolves its PKCE redirect to
  `https://<origin>/auth/callback`, which must be allow-listed in
  **Supabase → Authentication → URL Configuration** (`keepory.app` +
  `localhost:8081` for dev). Flag this if the origin/domain changed.

## Report

End with: what built (pass/fail + any export errors), what you verified (SPA
routing / capture surfaces / the specific web bug), and the deploy status —
either "merged to `main` → auto-deploys, confirm live" or the exact manual
command + why the agent couldn't run it. Remind that `apps/mobile/dist/` was
deleted (it's gitignored).
