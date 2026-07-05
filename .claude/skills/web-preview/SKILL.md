---
name: web-preview
description: >-
  Host un-merged branches as shareable web previews on Cloudflare Workers
  preview URLs (https://<branch-alias>-keepory7.<subdomain>.workers.dev) —
  separate from Cloudflare production (keepory.app). Use whenever the user asks
  to "preview this branch on the web", "host an unmerged web version", "deploy a
  web preview", "share a web build", or wants to click through a WIP change in a
  real browser before it merges. Primary path is Cloudflare's Git integration:
  push the branch / open a PR and Workers Builds auto-publishes a preview URL —
  no per-deploy limits, no token, no Netlify.
---

# Host un-merged branches as Cloudflare Workers preview URLs

The **preview** counterpart to `web-deploy` (which ships production to Cloudflare
Workers at `keepory.app`). Same static Expo export (`expo export --platform web`
→ `apps/mobile/dist`), same Supabase backend over REST, same `wrangler.toml` —
just published as a **preview version** (not a live deploy) so branches can be
clicked through **before they merge to `main`**. This never touches the
`keepory.app` production route.

**Why Cloudflare Workers preview URLs (we moved off Netlify).** The build is fully
static, so it runs on any host — it used to live on Netlify
(`stash-web-preview.netlify.app`). Netlify's Free plan is stingy (300 build
min/month, and a private-repo *one Git contributor* limit that our
`Co-authored-by: Claude` trailer trips, so Git-integration builds fail red).
Cloudflare Workers Builds is far roomier (**3,000 build min/month free**) and it's
the **same platform production already runs on**, so previews and production share
one config (`wrangler.toml`) and one deploy pipeline. Every non-production
branch/PR gets a preview URL automatically — no CLI, no token, no per-deploy
ceiling.

**How Workers previews differ from a live deploy.** Workers Builds runs
`wrangler deploy` (goes live on `keepory.app`) **only** for the production branch
`main`. For every **non-production** branch it runs `wrangler versions upload`
instead — this uploads a *version* and serves it at a **preview URL** on
`workers.dev`, without ever touching the production route. Both run the same
`[build] command = bash scripts/web-build.sh` from `wrangler.toml`, so previews
get the identical export + provenance stamp as production.

## Fixed facts about the preview setup

- Worker: **`keepory7`** (the same Worker as production — `wrangler.toml`).
- Preview URL format: **`https://<alias>-keepory7.<subdomain>.workers.dev`**,
  where `<subdomain>` is the account's registered workers.dev subdomain and
  `<alias>` is the branch/version alias Workers Builds assigns. Cloudflare posts
  the exact URL as a **deployment status / comment on the PR**.
- Production (`keepory.app`) stays **custom-domain-only** — `wrangler.toml` keeps
  `workers_dev = false`, so only preview *versions* are exposed on workers.dev.
- Sync works in previews: the `EXPO_PUBLIC_SUPABASE_*` **build** variables set on
  the Worker (Settings → Variables and Secrets → *Build*) apply to non-production
  builds too, so previews talk to the real Supabase backend over REST. (Confirm
  they aren't scoped production-only — see the smoke test.)

## ⚠️ One-time setup (the user must do this in the dashboard — no API path)

Preview URLs require a **workers.dev subdomain**, which our production config
deliberately never registered (it's custom-domain-only). Registering one and
enabling preview builds is a dashboard-only action an agent cannot do. **This
must be done *before* `preview_urls = true` in `wrangler.toml` reaches `main`** —
`wrangler deploy` **fails** with `preview_urls = true` and no subdomain, which
would break the `keepory.app` production deploy. Hand the user these steps:

1. Cloudflare dashboard → **Workers & Pages → (account) → register a
   `workers.dev` subdomain** if the account has none (free, one-time). This is
   what preview URLs are served on; it does **not** expose production on
   workers.dev (that's gated by `workers_dev = false`).
2. The **`keepory7`** Worker → **Settings → Domains & Routes → Preview URLs →
   Enable** (matches the committed `preview_urls = true`).
3. The **`keepory7`** Worker → **Settings → Builds → enable "Builds for
   non-production branches"** so every branch/PR (not just `main`) triggers a
   build → preview.
4. Confirm the `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY`
   **build** variables apply to all branches (not production-only), so preview
   sync works. They're the public URL + publishable anon key already shipping in
   production, safe to keep as plain build vars (RLS protects the data).
5. *(Only if testing Google/Apple sign-in on a preview — anonymous capture + sync
   need none of this.)* The PKCE redirect resolves to `https://<origin>/auth/callback`
   and preview origins are dynamic, so allow-list what you need in **Supabase →
   Authentication → URL Configuration → Redirect URLs**, e.g.
   `https://*-keepory7.<subdomain>.workers.dev/auth/callback` (add the exact
   preview origin if wildcards aren't accepted).

After that, the flow is hands-free — there is nothing for an agent to run.

## Primary path — push the branch / open a PR

Once the one-time setup is done, "preview this branch on the web" is just:

1. Make sure the branch is **pushed** to `origin`.
2. **Open (or update) a PR** — or push any non-production branch if branch builds
   are enabled. Workers Builds runs `bash scripts/web-build.sh` (the export +
   provenance) and `wrangler versions upload`, then attaches the preview URL to
   the PR as a deployment status/comment.
3. Grab that URL from the PR and hand it to the user. Run the smoke test below.

That's the whole job. No local build, no `wrangler` CLI, no token — the agent
sandbox has no Cloudflare credentials and doesn't need them here.

### Until the one-time setup lands

Before the subdomain + preview-build toggles are done, **no preview URL is
produced** — a pushed branch just won't get one, and (until the wrangler change
merges) the config is unchanged. If a preview is needed *right now* in that gap,
the fastest stopgap is a local `expo export` served over a localhost static
server (what the `screenshot` skill does) for a self-view; a *shareable* URL has
to wait for the setup. Don't fake a `workers.dev` URL that isn't live yet.

## Smoke-test any preview URL

```sh
BASE="https://<alias>-keepory7.<subdomain>.workers.dev"   # from the PR's deploy status
for p in / /settings /bookmark/abc; do
  curl -s -o /dev/null -w "$p -> %{http_code} %{content_type}\n" "$BASE$p"
done
curl -s -o /dev/null -w "manifest -> %{http_code}\n" "$BASE/manifest.webmanifest"
# Confirm sync is wired: the Supabase host should appear in the entry bundle.
JS=$(curl -s "$BASE/" | grep -oE '/_expo/static/js/web/entry-[a-f0-9]+\.js' | head -1)
curl -s "$BASE$JS" | grep -qo 'stzutoejnhzxzhjsjtsi.supabase.co' \
  && echo "sync: enabled" || echo "sync: OFF"
```

Expect `/`, `/settings`, `/bookmark/abc` all **200 text/html** (SPA fallback via
`not_found_handling = "single-page-application"` in `wrangler.toml`),
`manifest.webmanifest` **200**, and the Supabase host present. `curl` reaches
external hosts through the agent proxy, so this works from the sandbox even though
headless Chromium can't (see AGENTS.md).

## Report

End with: the preview URL, that it came from Cloudflare's Git-integration
auto-build (branch/PR → Workers Builds → `versions upload`), the smoke-test
results (SPA routing + sync-enabled), and — only if the user wants real-account
OAuth on the preview — the redirect allow-list reminder. If the one-time setup
isn't done yet, say so and point at the setup steps rather than reporting a URL
that isn't live.
