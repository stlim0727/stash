---
name: web-preview
description: >-
  Host un-merged branches as shareable Netlify web previews
  (stash-web-preview.netlify.app) — separate from Cloudflare production
  (keepory.app). Use whenever the user asks to "preview this branch on the web",
  "host an unmerged web version", "deploy a web preview", "put this branch on
  Netlify", "share a web build", or wants to click through a WIP change in a real
  browser before it merges. Primary path is a manual netlify-cli deploy (works on
  the Netlify Free plan with this PRIVATE repo); Git-integration auto-deploys are
  documented too but need a public repo or Netlify Pro (see the plan note).
---

# Host un-merged branches as Netlify web previews

The **preview** counterpart to `web-deploy` (which ships production to Cloudflare
Workers at `keepory.app`). Same static Expo export (`expo export --platform web`
→ `apps/mobile/dist`), same Supabase backend over REST — just published to a
Netlify site so branches can be clicked through **before they merge to `main`**.
This never touches `keepory.app` and never pushes to Cloudflare.

**Why Netlify and not Cloudflare for previews:** the build is fully static, so it
runs on any host. Netlify applies its SPA catch-all (`/* → /index.html 200`)
*after* matching real files, so it's asset-safe — unlike Cloudflare **Pages**,
where a `_redirects` catch-all is always followed and rewrites the JS bundle
(this is exactly why production is on Workers Static Assets, per
`docs/development/deploy-web.md`). On Netlify the catch-all is the correct,
supported SPA pattern.

**Config of record stays Cloudflare.** `wrangler.toml` + `scripts/web-build.sh`
own production. `netlify.toml` (repo root, committed) drives only the preview
site; only the CLI's local `.netlify/` state dir is gitignored.

## Fixed facts about the preview site

- Netlify project: **`stash-web-preview`** (team `stlim0727`)
- Site ID: **`f7a9729d-7cf3-4405-a61b-fac5c7ec6cc0`**
- Primary URL: **https://stash-web-preview.netlify.app** (mirrors the production branch)
- `netlify.toml` supplies the build command, `apps/mobile/dist` publish dir, the
  **public** Supabase URL + publishable anon key (build-time, so sync works),
  `SECRETS_SCAN_OMIT_KEYS` for those `EXPO_PUBLIC_*` values, and the SPA redirect.

## ⚠️ Plan constraint — why the CLI path is primary here

`stlim0727/stash` is a **private** repo on the Netlify **Free** plan, which allows
**one Git contributor** on private repos. Every commit here carries a
`Co-authored-by: Claude …` trailer, which Netlify counts as a *second*
contributor — so Git-integration builds fail with **"Build failed: unrecognized
Git contributor."** (learned the hard way; the linked repo just produces red
failed builds on every push). CLI deploys upload a prebuilt folder and **skip**
the contributor check, so **the Manual CLI path below is the one that works** for
this repo. Git-integration only becomes viable if the repo goes **public** or the
account upgrades to **Netlify Pro** — until then, don't link the repo (or unlink
it) to avoid failing-build noise.

## Primary path — netlify-cli deploy (works on Free + private repo)

Build the branch locally with sync baked in, then upload the prebuilt dir. No Git
build runs, so the contributor limit never applies.

- **`NETLIFY_AUTH_TOKEN`** — store it once as an env var on the Claude Code web
  environment (claude.ai/code → environment selector → settings icon →
  Environment variables → `NETLIFY_AUTH_TOKEN=nfp_…`, `.env` format, **no quotes**;
  note there's no encrypted secrets store yet, so it's visible to anyone who can
  edit the environment). Then it's present as `$NETLIFY_AUTH_TOKEN` in new sessions
  and this path is hands-free. If absent, ask the user for a personal access token
  (Netlify → User settings → Applications → Personal access tokens); a token pasted
  into chat is in the transcript, so suggest a short expiry + revoke. **Never**
  commit it. Check with `test -n "$NETLIFY_AUTH_TOKEN"` before prompting.

```sh
# Build whatever is checked out (repo-root-relative paths; subshell keeps cwd).
# --clear is REQUIRED: a Metro cache left by an earlier `expo export` that ran
# WITHOUT these EXPO_PUBLIC_* vars (e.g. a PR's web-export check) bakes them in as
# empty, so sync silently comes up OFF. Clearing the transform cache re-inlines them.
export CI=1
rm -rf apps/mobile/dist
( cd apps/mobile \
    && EXPO_PUBLIC_SUPABASE_URL="https://stzutoejnhzxzhjsjtsi.supabase.co" \
       EXPO_PUBLIC_SUPABASE_ANON_KEY="sb_publishable_TBMfShK_vzySRN6n3yRcpA_P-WXe-5n" \
       pnpm exec expo export --platform web --clear )

# Un-dot asset directories: Netlify's `deploy --dir` SKIPS any directory whose name
# starts with "." — and Expo exports the vector-icon fonts under `.pnpm/`, so every
# icon renders as tofu (the font 404s → SPA catch-all serves index.html). Rename the
# `.pnpm` segment and rewrite the bundle references. (`/__node_modules/` is untouched
# — the pattern requires a literal `/.pnpm/`.)
( cd apps/mobile/dist \
    && find . -depth -type d -name '.pnpm' -exec sh -c 'mv "$1" "$(dirname "$1")/pnpm_"' _ {} \; \
    && find . -type f \( -name '*.js' -o -name '*.css' -o -name '*.json' -o -name '*.html' \) \
         -exec sed -i 's#/\.pnpm/#/pnpm_/#g' {} + )

printf '/*    /index.html   200\n' > apps/mobile/dist/_redirects

# Deploy the prebuilt dir. --no-build skips the Git build (and its contributor
# check). --prod overwrites stash-web-preview.netlify.app; swap for
# --alias "<slug>" to get a distinct URL per branch without touching the primary.
npx -y netlify-cli@latest deploy \
  --dir apps/mobile/dist \
  --site f7a9729d-7cf3-4405-a61b-fac5c7ec6cc0 \
  --no-build \
  --prod

rm -rf apps/mobile/dist apps/mobile/.netlify   # gitignored, but don't leave litter
```

Then run the smoke test below. To host several branches at once, replace `--prod`
with `--alias "$(git rev-parse --abbrev-ref HEAD | tr '/' '-' | cut -c1-37)"` →
`https://<branch-slug>--stash-web-preview.netlify.app`.

## Alternative path — Git integration (ONLY if repo is public or on Netlify Pro)

Blocked on Free+private (see the plan note above). If that changes: once the repo
is linked to the site (one-time dashboard step below), **every push builds
automatically** and there is nothing to run:

- Push to the **production branch** (`main`) → deploys to
  `https://stash-web-preview.netlify.app`.
- Open/push a **PR** → a Deploy Preview builds at
  `https://deploy-preview-<PR#>--stash-web-preview.netlify.app`.
- Push any **branch** (if branch deploys are enabled) → builds at
  `https://<branch-slug>--stash-web-preview.netlify.app`.

So "preview this branch" usually just means: make sure it's pushed, then hand the
user the deploy-preview URL for its PR. The build uses the committed
`netlify.toml`, so sync is already wired.

### One-time setup (the user must do the link in the dashboard)

Linking a GitHub repo to a Netlify site installs/authorizes the Netlify GitHub
App via an OAuth flow — there is **no API/MCP path**, so an agent cannot do it.
Hand the user these steps:

1. Netlify → the **`stash-web-preview`** site → **Project configuration → Build &
   deploy → Continuous deployment → Link repository** → pick `stlim0727/stash`.
2. **Production branch:** `main`. Leave build command / publish / env **empty** —
   the committed `netlify.toml` supplies them.
3. **Deploy Previews:** enable "Deploy Previews" for PRs (on by default). To also
   build every branch, set **Branch deploys → All**.
4. Supabase OAuth (only if testing Google/Apple sign-in, not anonymous): the
   PKCE redirect resolves to `https://<origin>/auth/callback`, and preview
   origins are dynamic, so allow-list what you need in **Supabase → Authentication
   → URL Configuration → Redirect URLs**, e.g.
   `https://deploy-preview-*--stash-web-preview.netlify.app/auth/callback` (add
   the exact PR origin if wildcards aren't accepted). Anonymous-first capture +
   sync need none of this. No Supabase MCP tool covers the allow-list — it's a
   dashboard action.

After linking, trigger the first build by pushing (or re-running the latest
deploy in the dashboard). Verify with the smoke test below.

## Smoke-test any preview URL

```sh
BASE="https://stash-web-preview.netlify.app"   # or the deploy-preview / alias URL
for p in / /settings /bookmark/abc; do
  curl -s -o /dev/null -w "$p -> %{http_code} %{content_type}\n" "$BASE$p"
done
curl -s -o /dev/null -w "manifest -> %{http_code}\n" "$BASE/manifest.webmanifest"
# Confirm sync is wired: the Supabase host should appear in the entry bundle.
JS=$(curl -s "$BASE/" | grep -oE '/_expo/static/js/web/entry-[a-f0-9]+\.js' | head -1)
curl -s "$BASE$JS" | grep -qo 'stzutoejnhzxzhjsjtsi.supabase.co' \
  && echo "sync: enabled" || echo "sync: OFF"
```

Expect `/`, `/settings`, `/bookmark/abc` all **200 text/html** (SPA fallback),
`manifest.webmanifest` **200**, and the Supabase host present.

## Report

End with: the preview URL, how it deployed (Git-integration auto-build vs manual
CLI), the smoke-test results (SPA routing + sync-enabled), and — only if the user
wants real-account OAuth — the redirect allow-list reminder. If a throwaway token
was used, note it should be revoked.
