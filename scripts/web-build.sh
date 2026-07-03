#!/usr/bin/env bash
#
# Build the Expo web export for the Cloudflare Workers deploy, stamping build
# provenance (commit SHA / branch) into the bundle so Settings shows the deployed
# build ("<branch> @ <sha>") instead of "local build".
#
# This runs from wrangler.toml's [build] hook during `wrangler deploy` (the deploy
# phase). Cloudflare's WORKERS_CI_* env vars are only guaranteed in the *build*
# phase, so we resolve the commit from whatever is present, in order:
#   1. $WORKERS_CI_COMMIT_SHA / $WORKERS_CI_BRANCH (build phase, or if set here)
#   2. the `git` binary, if on PATH
#   3. reading `.git/HEAD` directly — works in a checkout that has .git but no
#      git binary and no env vars (handles both a detached HEAD and a branch ref)
# Provenance is best-effort: it must never fail the build. If nothing resolves,
# the bundle degrades to "local build" and the deploy still succeeds.
#
# Not using `set -e`: provenance resolution intentionally tolerates failures, so
# only the genuinely required steps (install, export) gate the build via `|| exit`.

cd "$(dirname "$0")/.." || exit 1

pnpm install || exit 1

# --- resolve commit SHA (best-effort) ---
SHA="${WORKERS_CI_COMMIT_SHA:-}"
if [ -z "$SHA" ] && command -v git >/dev/null 2>&1; then
  SHA="$(git rev-parse HEAD 2>/dev/null || true)"
fi
if [ -z "$SHA" ] && [ -f .git/HEAD ]; then
  head="$(cat .git/HEAD 2>/dev/null || true)"
  case "$head" in
    "ref: "*) SHA="$(cat ".git/${head#ref: }" 2>/dev/null || true)" ;;
    *) SHA="$head" ;;
  esac
fi
# Keep only a valid hex SHA; anything else becomes empty (→ "local build").
SHA="$(printf '%s' "$SHA" | tr -cd '0-9a-f')"

# --- resolve branch/ref (best-effort; cosmetic) ---
REF="${WORKERS_CI_BRANCH:-}"
if [ -z "$REF" ] && command -v git >/dev/null 2>&1; then
  REF="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
fi
[ "$REF" = "HEAD" ] && REF=""  # detached checkout: no meaningful branch name

COMMIT_URL=""
[ -n "$SHA" ] && COMMIT_URL="https://github.com/stlim0727/stash/commit/$SHA"

echo "web-build: provenance SHA=[$SHA] REF=[$REF] (git=$(command -v git || echo none), dotgit=$( [ -e .git ] && echo yes || echo no ))"

cd apps/mobile || exit 1
EXPO_PUBLIC_GIT_SHA="$SHA" \
  EXPO_PUBLIC_GIT_REF="$REF" \
  EXPO_PUBLIC_COMMIT_URL="$COMMIT_URL" \
  CI=1 pnpm exec expo export --platform web || exit 1
