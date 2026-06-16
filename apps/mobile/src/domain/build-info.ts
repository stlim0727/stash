/**
 * Build provenance baked into the bundle at build time.
 *
 * The values come from STATIC `process.env.EXPO_PUBLIC_*` reads so Expo inlines
 * them into the release bundle (a dynamic `process.env[key]` would read empty in
 * production — see `scripts/check-static-env.mjs`). CI sets them per build; a
 * local/dev build leaves them empty and the app shows a "local build" label.
 */

declare const process: { env: Record<string, string | undefined> };

export interface BuildInfo {
  /** Full commit SHA the build came from, or null in local/dev builds. */
  sha: string | null;
  /** First 7 chars of the SHA, for compact display. */
  shortSha: string | null;
  /** Git ref (branch or tag) the build came from, if provided. */
  ref: string | null;
  /** Canonical URL to the exact commit on GitHub, if provided. */
  commitUrl: string | null;
}

export function getBuildInfo(): BuildInfo {
  const sha = (process.env.EXPO_PUBLIC_GIT_SHA ?? '').trim();
  const ref = (process.env.EXPO_PUBLIC_GIT_REF ?? '').trim();
  const commitUrl = (process.env.EXPO_PUBLIC_COMMIT_URL ?? '').trim();

  return {
    sha: sha || null,
    shortSha: sha ? sha.slice(0, 7) : null,
    ref: ref || null,
    commitUrl: commitUrl || null,
  };
}

/** One-line label, e.g. `main @ 7b6e2a9`, `7b6e2a9`, or `local build`. */
export function describeBuild(info: BuildInfo = getBuildInfo()): string {
  if (!info.shortSha) {
    return 'local build (no commit baked in)';
  }
  return info.ref ? `${info.ref} @ ${info.shortSha}` : info.shortSha;
}
