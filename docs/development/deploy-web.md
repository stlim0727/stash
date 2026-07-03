# Deploying Stash on the web (Cloudflare Pages)

The web build is a **static** Expo export (`expo export --platform web` → `apps/mobile/dist`) talking to the existing Supabase backend over REST. There is no server to run, so it hosts on any static host; this guide uses **Cloudflare Pages** (free, unlimited bandwidth, at-cost registrar, a Workers escape hatch if web ever needs a server bit).

Working brand/domain: **`keepory.app`**. Nothing in the code hard-codes the origin — the bookmarklet and the PWA manifest are origin-relative — so the same build works on any domain and picks up `keepory.app` automatically once it's served from there.

## 1. Connect the repo (Git integration)

Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** → pick the `stash` repo → set the build config below → **Save and Deploy**. Every push to the production branch then auto-deploys, and each PR gets a preview URL.

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Root directory | *(repo root)* |
| Build command | `pnpm install && cd apps/mobile && CI=1 pnpm exec expo export --platform web` |
| Build output directory | `apps/mobile/dist` |
| Node version | 22 (auto-detected from `.node-version`) |

`wrangler.toml` at the repo root already declares `pages_build_output_dir = "apps/mobile/dist"`, so `wrangler pages deploy` works too if you ever want to deploy from a CLI/CI instead of the Git integration.

### Build environment variables

Cloud sync is compiled into the bundle at build time, so set these as **build-time** environment variables on the Pages project (Settings → Environment variables). Without them the site still runs, but local-only (no sign-in / sync):

- `EXPO_PUBLIC_SUPABASE_URL` — the Supabase project URL.
- `EXPO_PUBLIC_SUPABASE_ANON_KEY` — the publishable anon key.
- `EXPO_PUBLIC_SENTRY_DSN` — *(optional)* enables Sentry on web.
- `EXPO_PUBLIC_GIT_SHA` — *(optional)* stamps the build commit in Settings (`CF_PAGES_COMMIT_SHA` can be mapped to it).

## 2. Custom domain

Buy `keepory.app` at **Cloudflare Registrar** (at-cost, free WHOIS privacy; note Registrar domains must keep Cloudflare nameservers, though DNS records stay editable). Then in the Pages project → **Custom domains → Set up a domain** → `keepory.app`; DNS is wired automatically and HTTPS is issued in a few minutes. Optionally grab `keepory.co` and redirect it to `keepory.app`.

## 3. Register the OAuth redirect (required for web sign-in)

Web sign-in uses the same hand-rolled PKCE flow as native, but its redirect resolves to `https://<origin>/auth/callback` via `Linking.createURL` — so it must be allow-listed:

- **Supabase → Authentication → URL Configuration → Redirect URLs**: add
  - `https://keepory.app/auth/callback`
  - `http://localhost:8081/auth/callback` (Expo web dev server, for local testing)

The provider-side redirect (Google/Apple) stays pointed at Supabase's own `…supabase.co/auth/v1/callback` and needs no change — Supabase validates the app's `redirectTo` against the allow-list above.

## 4. How routing works

`apps/mobile/public/_redirects` ships a single SPA fallback (`/* /index.html 200`). Cloudflare serves real files first — every route's HTML, `/manifest.webmanifest`, the PWA icons, and `/_expo/*` assets — so the rule only catches paths with no matching file (chiefly the dynamic `/bookmark/<id>` route), which fall back to the app shell and client-render. Capture deep links like `/add?url=…` hit the real `add.html`, so web capture is unaffected.

## 5. Capture surfaces pick up the domain automatically

- **Bookmarklet** (Settings → *Save from your browser*, web only) is built from `window.location.origin` at click time, so it targets `https://keepory.app/add?url=…` once served there.
- **PWA Web Share Target**: `public/manifest.webmanifest` declares `share_target → /add` with origin-relative paths, so an installed PWA on Android registers `keepory.app` in the OS share sheet. Installability + share-sheet capture can only be validated on a real device against the live HTTPS origin (iOS Safari has no Web Share Target).

## Local verification

```sh
cd apps/mobile && CI=1 pnpm exec expo export --platform web   # builds apps/mobile/dist
# dist/ is gitignored — delete it afterwards
```

CI also runs this export on every PR (`.github/workflows/ci.yml`, "Web export builds"), so a change that breaks the web target fails the build.
