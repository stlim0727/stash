#!/usr/bin/env bash
#
# Build the Expo web export for the Cloudflare Workers deploy, stamping build
# provenance (commit SHA / branch) into the bundle so Settings shows the deployed
# build ("<branch> @ <sha>") instead of "local build".
#
# Used in two places:
#   1. The Cloudflare dashboard "Build command" — keep it short: `bash
#      scripts/web-build.sh`. This runs in the BUILD phase, where Workers Builds
#      exposes WORKERS_CI_COMMIT_SHA / WORKERS_CI_BRANCH, so the commit is stamped.
#   2. The wrangler.toml [build] hook (deploy phase) as a self-contained fallback
#      when dist wasn't produced by the build command. The commit env vars are not
#      present there, so provenance falls back to git and, failing that, empty
#      (degrading to "local build") — the deploy still succeeds.
#
# Keeping the logic here (versioned, testable) means the dashboard command stays a
# single trivial token instead of a long, special-character-heavy one that the
# Cloudflare build-config form can reject.
set -eo pipefail

# Repo root, regardless of where this is invoked from.
cd "$(dirname "$0")/.."

pnpm install

# Prefer Cloudflare's git env vars; fall back to the checkout's git metadata.
# `|| true` keeps a failed `git rev-parse` (no .git in the checkout) from aborting
# under `set -e`, so the export always runs.
SHA="${WORKERS_CI_COMMIT_SHA:-$(git rev-parse HEAD 2>/dev/null || true)}"
REF="${WORKERS_CI_BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)}"

cd apps/mobile
EXPO_PUBLIC_GIT_SHA="$SHA" \
  EXPO_PUBLIC_GIT_REF="$REF" \
  EXPO_PUBLIC_COMMIT_URL="${SHA:+https://github.com/stlim0727/stash/commit/$SHA}" \
  CI=1 pnpm exec expo export --platform web
