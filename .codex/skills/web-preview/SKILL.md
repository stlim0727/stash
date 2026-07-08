---
name: web-preview
description: >-
  Host un-merged branches as shareable web previews on Cloudflare Workers
  preview URLs on the keepory7 workers.dev preview domain —
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
- Preview URL format: **`https://<alias>-keepory7.stlim0727.workers.dev`**, where
  `stlim0727.workers.dev` is the account's registered workers.dev subdomain and
  `<alias>` is the branch/version alias Workers Builds assigns. Find the exact URL
  in the build log (the Cloudflare PR comment links it under *View logs*).
- Production (`keepory.app`) stays **custom-domain-only** — `wrangler.toml` keeps
  `workers_dev = false`, so only preview *versions* are exposed on workers.dev.
- Sync works in previews: the `EXPO_PUBLIC_SUPABASE_*` **build** variables set on
  the Worker (Settings → Variables and Secrets → *Build*) apply to non-production
  builds too, so previews talk to the real Supabase backend over REST. (Confirm
  they aren't scoped production-only — see the smoke test.)

## Setup state (already in place)

The prerequisites are satisfied on this account, so previews are hands-free —
there is nothing for an agent to run:

- **workers.dev subdomain: registered** as `stlim0727.workers.dev` (its route on
  the `keepory7` Worker shows *Disabled*, which is only `workers_dev = false`
  keeping **production** off workers.dev — the subdomain itself exists and serves
  **preview** versions). This is why `preview_urls = true` in `wrangler.toml` is
  safe and does **not** break the `keepory.app` production deploy.
- **Non-production branch builds: enabled** — pushing this branch already
  triggered a Workers build, which is the proof.
- **Preview URLs: opted in** via `preview_urls = true` in `wrangler.toml`
  (Cloudflare's per-Worker Preview URLs default follows `workers_dev`, so the
  explicit opt-in is what keeps them on across production deploys).

Two things worth a glance only if a preview misbehaves:

- The `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` **build**
  variables (Worker → Settings → Variables and Secrets → *Build*) must apply to
  all branches, not production-only, or preview sync comes up OFF — the smoke
  test below catches this. They're the public URL + publishable anon key already
  shipping in production, safe as plain build vars (RLS protects the data).
- *(Only if testing Google/Apple sign-in on a preview — anonymous capture + sync
  need none of this.)* The PKCE redirect resolves to `https://<origin>/auth/callback`
  and preview origins are dynamic, so allow-list what you need in **Supabase →
  Authentication → URL Configuration → Redirect URLs**, e.g.
  `https://*-keepory7.stlim0727.workers.dev/auth/callback` (add the exact preview
  origin if wildcards aren't accepted).

## Primary path — push the branch / open a PR

"Preview this branch on the web" is just:

1. Make sure the branch is **pushed** to `origin`.
2. **Open (or update) a PR** — or push any non-production branch. Workers Builds
   runs `bash scripts/web-build.sh` (the export + provenance) and `wrangler
   versions upload`, and the Cloudflare bot comments the build result on the PR.
3. Open that comment's **View logs** link and grab the `Version Preview URL`
   (`https://<alias>-keepory7.stlim0727.workers.dev`) from the `versions upload`
   output. Hand it to the user and run the smoke test below.

That's the whole job. No local build, no `wrangler` CLI, no token — the agent
sandbox has no Cloudflare credentials and doesn't need them here.

If the build succeeds but no `Version Preview URL` appears in the log, Preview
URLs are off at the Worker level — the `preview_urls = true` opt-in only sticks
once it has been applied by a deploy; confirm it under `keepory7` → Settings →
Domains & Routes → Preview URLs. Don't fake a URL that isn't live.

## Smoke-test any preview URL

```sh
BASE="https://<alias>-keepory7.stlim0727.workers.dev"   # Version Preview URL from the build log
for p in / /settings /bookmark/abc; do
  curl -s -o /dev/null -w "$p -> %{http_code} %{content_type}\n" "$BASE$p"
done
MANIFEST=$(curl -fsS "$BASE/manifest.webmanifest")
printf '%s' "$MANIFEST" | grep -q '"share_target"' \
  && echo "manifest: share target present" || { echo "manifest: missing share_target"; exit 1; }
# Confirm sync is wired: the Supabase host should appear in the entry bundle.
JS=$(curl -s "$BASE/" | grep -oE '/_expo/static/js/web/entry-[a-f0-9]+\.js' | head -1)
curl -s "$BASE$JS" | grep -qo 'stzutoejnhzxzhjsjtsi.supabase.co' \
  && echo "sync: enabled" || echo "sync: OFF"
```

Expect `/`, `/settings`, `/bookmark/abc` all **200 text/html** (SPA fallback via
`not_found_handling = "single-page-application"` in `wrangler.toml`),
`manifest.webmanifest` containing `share_target`, and the Supabase host present. `curl` reaches
external hosts through the agent proxy, so this works from the sandbox even though
headless Chromium can't (see AGENTS.md).

## Report

End with: the preview URL, that it came from Cloudflare's Git-integration
auto-build (branch/PR → Workers Builds → `versions upload`), the smoke-test
results (SPA routing + sync-enabled), and — only if the user wants real-account
OAuth on the preview — the redirect allow-list reminder. If the one-time setup
isn't done yet, say so and point at the setup steps rather than reporting a URL
that isn't live.
