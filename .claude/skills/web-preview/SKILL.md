---
name: web-preview
description: >-
  Host an un-merged branch's web build as a shareable Netlify preview
  (stash-web-preview.netlify.app) — separate from Cloudflare production
  (keepory.app). Use whenever the user asks to "preview this branch on the web",
  "host an unmerged web version", "deploy a web preview", "put this branch on
  Netlify", "share a web build", or wants to click through a WIP change in a real
  browser before it merges. Produces the same outcome every time: a static Expo
  export of the current branch (with sync wired to the live Supabase backend),
  an SPA-safe deploy, a smoke-tested live URL, and the OAuth follow-up flagged.
---

# Host an un-merged branch as a Netlify web preview

The **preview** counterpart to `web-deploy` (which ships production to Cloudflare
Workers at `keepory.app`). Same static Expo export (`expo export --platform web`
→ `apps/mobile/dist`), same Supabase backend over REST — just published to a
throwaway Netlify site so a branch can be clicked through **before it merges to
`main`**. This never touches `keepory.app` and never pushes to Cloudflare.

**Why Netlify and not Cloudflare for previews:** the build is fully static, so it
runs on any host. Netlify applies its SPA catch-all (`/* → /index.html 200`)
*after* matching real files, so it's asset-safe — unlike Cloudflare **Pages**,
where a `_redirects` catch-all is always followed and rewrites the JS bundle
(this is exactly why production is on Workers Static Assets, per
`docs/development/deploy-web.md`). On Netlify the catch-all is the correct,
supported SPA pattern.

**Config of record stays Cloudflare.** `wrangler.toml` + `scripts/web-build.sh`
own production. The Netlify bits here (`netlify.toml`, `_redirects`, `.netlify/`)
are **transient and gitignored** — this skill regenerates them each run, like
`dist/`. Do not commit them.

## Fixed facts about the preview site

- Netlify project: **`stash-web-preview`** (team `stlim0727`)
- Site ID: **`f7a9729d-7cf3-4405-a61b-fac5c7ec6cc0`**
- Live URL: **https://stash-web-preview.netlify.app**

Reuse this site every time (redeploys overwrite it) — don't create a new one per
branch unless the user wants parallel previews.

## Prerequisites the sandbox does NOT have

1. **`NETLIFY_AUTH_TOKEN`** — no token/CLI is baked into the sandbox, and the
   Netlify **MCP** deploy hands back an `npx @netlify/mcp --proxy-path <opaque>`
   command that Claude Code's auto-mode classifier **refuses to run**. So the
   deploy must go through the standard `netlify-cli` with a token. Ask the user
   for a Netlify **personal access token** (Netlify → User settings →
   Applications → Personal access tokens → New access token). Remind them a
   token pasted into chat is in the transcript — use a short expiry and revoke
   after. Never hard-code or commit it.
2. **Supabase env** — `EXPO_PUBLIC_SUPABASE_URL` + anon key are compiled into the
   bundle at build time; without them the preview runs local-only (no sign-in /
   sync). Pull them from the Supabase MCP (they're publishable — the same anon
   key already ships in the production web bundle):
   - `mcp__Supabase__get_project_url` → the URL
   - `mcp__Supabase__get_publishable_keys` → the `publishable` (or `anon`) key

## Steps

### 1. Build the web export for the current branch, with sync wired up
```sh
cd apps/mobile
export EXPO_PUBLIC_SUPABASE_URL="https://<ref>.supabase.co"
export EXPO_PUBLIC_SUPABASE_ANON_KEY="<publishable-or-anon-key>"
export CI=1
rm -rf dist
pnpm exec expo export --platform web
```
A failing export is the fastest signal the branch broke the web bundle — read the
error (Metro/expo-router issues surface here, not in `pnpm typecheck`). Confirm
`dist/index.html` exists and that there are **no** per-route `.html` files (a
correct SPA build emits only `index.html` + assets).

### 2. Make the static build SPA-safe on Netlify
Write the SPA fallback into the publish dir **and** a transient `netlify.toml`
that stops Netlify from re-running its auto-detected `expo export` (Netlify's
build env has neither the Supabase vars nor expo installed, so a rebuild there
would ship a broken/local-only bundle):

```sh
printf '/*    /index.html   200\n' > apps/mobile/dist/_redirects
```

`netlify.toml` at repo root (gitignored — regenerated each run):
```toml
[build]
  # dist/ is prebuilt locally and uploaded as-is; override Netlify's
  # auto-detected `expo export` so it does NOT rebuild.
  command = "echo 'using prebuilt apps/mobile/dist'"
  publish = "apps/mobile/dist"

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

### 3. Deploy the prebuilt dir via netlify-cli
```sh
NETLIFY_AUTH_TOKEN="<token>" npx -y netlify-cli@latest deploy \
  --dir apps/mobile/dist \
  --site f7a9729d-7cf3-4405-a61b-fac5c7ec6cc0 \
  --prod
```
`--dir` publishes the prebuilt assets; the no-op build command above keeps
Netlify from rebuilding. Grab the **Production URL** from the output.

### 4. Smoke-test the live URL
```sh
BASE="https://stash-web-preview.netlify.app"
for p in / /settings /bookmark/abc; do
  curl -s -o /dev/null -w "$p -> %{http_code} %{content_type}\n" "$BASE$p"
done
curl -s -o /dev/null -w "manifest -> %{http_code}\n" "$BASE/manifest.webmanifest"
# Confirm sync is wired: the Supabase host should appear in the entry bundle.
JS=$(curl -s "$BASE/" | grep -oE '/_expo/static/js/web/entry-[a-f0-9]+\.js' | head -1)
curl -s "$BASE$JS" | grep -qo '<ref>.supabase.co' && echo "sync: enabled" || echo "sync: OFF"
```
Expect `/`, `/settings`, `/bookmark/abc` all **200 text/html** (SPA fallback),
`manifest.webmanifest` **200**, and the Supabase host present.

### 5. Flag the OAuth follow-up (don't skip)
The app is **anonymous-first**, so capture + sync work on the preview with **no**
extra setup. But **Google/Apple sign-in** resolves its PKCE redirect to
`https://stash-web-preview.netlify.app/auth/callback`, which must be allow-listed
in **Supabase → Authentication → URL Configuration → Redirect URLs**. That's a
**dashboard action** — there is no Supabase MCP tool for the auth URI allow-list,
so tell the user to add it if they need to test real-account OAuth on the preview.

### 6. Clean up
```sh
rm -rf apps/mobile/dist netlify.toml apps/mobile/.netlify
```
`dist/`, `netlify.toml`, and `.netlify/` are all gitignored, but remove them so
nothing local lingers.

## Report

End with: the live URL, what built (pass/fail + export errors), the smoke-test
results (SPA routing + sync-enabled), and the OAuth allow-list reminder if the
user wants real-account sign-in. Note that the token should be revoked if it was
a throwaway.
