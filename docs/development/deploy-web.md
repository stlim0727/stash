# Deploying Stash on the web (Cloudflare Workers)

The web build is a **static** Expo export (`expo export --platform web` → `apps/mobile/dist`) talking to the existing Supabase backend over REST. There is no server to run — it deploys as a **Workers Static Assets** project (assets-only, no Worker script). Cloudflare Workers is free, serves from the global CDN, and pairs with the at-cost Cloudflare Registrar. (New Cloudflare accounts create static sites under **Workers**; the older **Pages** flow works too if your dashboard still offers it — the difference is only the create screen.)

Working brand/domain: **`keepory.app`**. Nothing in the code hard-codes the origin — the bookmarklet and the PWA manifest are origin-relative — so the same build works on any domain and picks up `keepory.app` automatically once it's served from there.

## 1. Connect the repo (Git integration)

Cloudflare dashboard → **Workers & Pages → Create → Import a repository** → pick the `stash` repo → set the build config below → **Deploy**. Every push to the production branch then auto-deploys, and each PR gets a preview URL.

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Build command | `pnpm install && cd apps/mobile && CI=1 pnpm exec expo export --platform web` |
| Deploy command | `npx wrangler deploy` *(the default)* |
| Node version | 22 (auto-detected from `.node-version`) |

There is **no output-directory field to fill in** — `wrangler.toml` at the repo root supplies it: it declares `assets.directory = "./apps/mobile/dist"` and `assets.not_found_handling = "single-page-application"`, and `wrangler deploy` uploads that folder as an assets-only Worker (no `main` script). The same config drives a manual `npx wrangler deploy` from a CLI/CI.

### Build environment variables

Cloud sync is compiled into the bundle at build time, so set these as **build-time** environment variables on the project (Settings → Variables and Secrets → *Build* variables). Without them the site still runs, but local-only (no sign-in / sync):

- `EXPO_PUBLIC_SUPABASE_URL` — the Supabase project URL.
- `EXPO_PUBLIC_SUPABASE_ANON_KEY` — the publishable anon key.
- `EXPO_PUBLIC_SENTRY_DSN` — *(optional)* enables Sentry on web.
- `EXPO_PUBLIC_GIT_SHA` — *(optional)* stamps the build commit in Settings (`CF_PAGES_COMMIT_SHA` can be mapped to it).

## 2. Custom domain

Buy `keepory.app` at **Cloudflare Registrar** (at-cost, free WHOIS privacy; note Registrar domains must keep Cloudflare nameservers, though DNS records stay editable). Then in the Worker → **Settings → Domains & Routes → Add → Custom domain** → `keepory.app`; DNS is wired automatically and HTTPS is issued in a few minutes. Optionally grab `keepory.co` and redirect it to `keepory.app`.

## 3. Register the OAuth redirect (required for web sign-in)

Web sign-in uses the same hand-rolled PKCE flow as native, but its redirect resolves to `https://<origin>/auth/callback` via `Linking.createURL` — so it must be allow-listed:

- **Supabase → Authentication → URL Configuration → Redirect URLs**: add
  - `https://keepory.app/auth/callback`
  - `http://localhost:8081/auth/callback` (Expo web dev server, for local testing)

The provider-side redirect (Google/Apple) stays pointed at Supabase's own `…supabase.co/auth/v1/callback` and needs no change — Supabase validates the app's `redirectTo` against the allow-list above.

## 4. How routing works

The app exports with `web.output: "single"` (SPA) in `app.json`, so `expo export --platform web` emits **`index.html` plus static assets only** — `/manifest.webmanifest`, the PWA icons, and the `/_expo/*` bundles — and **no per-route HTML**. `wrangler.toml` sets [`assets.not_found_handling = "single-page-application"`](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/). Cloudflare serves the static assets directly for matching paths, and every **navigation** request that matches no file — which is every app route: `/`, `/add`, `/settings`, `/auth/callback`, and the dynamic `/bookmark/<id>` (plus any deep link) — resolves to `/index.html` (200), which expo-router then client-renders. Asset requests are matched first, so the SPA fallback never rewrites the app's own JS/manifest/icons.

> On the older **Pages** flow this is automatic (no `404.html` → Pages assumes an SPA), and you must **not** add a `_redirects` catch-all — on Pages, `_redirects` rules are [always followed even when an asset matches](https://developers.cloudflare.com/pages/configuration/redirects/), which would rewrite the JS bundles/manifest/icons and break the app. The Workers `not_found_handling` setting above is the equivalent that is asset-safe by design.

## 5. Capture surfaces pick up the domain automatically

- **Bookmarklet** (Settings → *Save from your browser*, web only) is built from `window.location.origin` at click time, so it targets `https://keepory.app/add?url=…` once served there.
- **PWA Web Share Target**: `public/manifest.webmanifest` declares `share_target → /add` with origin-relative paths, so an installed PWA on Android registers `keepory.app` in the OS share sheet. Installability + share-sheet capture can only be validated on a real device against the live HTTPS origin (iOS Safari has no Web Share Target).

## Local verification

```sh
cd apps/mobile && CI=1 pnpm exec expo export --platform web   # builds apps/mobile/dist
# dist/ is gitignored — delete it afterwards
```

CI also runs this export on every PR (`.github/workflows/ci.yml`, "Web export builds"), so a change that breaks the web target fails the build.
