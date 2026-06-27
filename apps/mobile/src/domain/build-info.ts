/**
 * Build provenance surfaced in Settings and in feedback diagnostics.
 *
 * The values are stamped into the app config's `extra` block at build time by
 * `app.config.js` (which reads the CI-provided env vars) and read back at
 * runtime from `expo-constants` `Constants.expoConfig.extra`.
 *
 * We deliberately do NOT read `process.env.EXPO_PUBLIC_*` here. Those are
 * inlined into the JS bundle by Babel and then frozen in Metro's content-keyed
 * transform cache: because this module's source never changes between builds,
 * a cache hit keeps serving whatever commit first populated the cache, so the
 * APK reports a stale commit even though it was built from newer source. Routing
 * the values through `extra` piggybacks on the same runtime-config channel as
 * `version` — which is regenerated from app.config.js every build and is immune
 * to the transform cache — so the provenance updates on every build.
 *
 * Callers read the raw values from `Constants.expoConfig?.extra` and pass them
 * in, keeping this module pure and platform-free (Node-testable).
 */

/** Raw provenance values as read from `Constants.expoConfig.extra`. */
export interface BuildInfoSource {
  /** Full commit SHA, or null/absent in local/dev builds. */
  gitSha?: string | null;
  /** Git ref (branch or tag) the build came from, if provided. */
  gitRef?: string | null;
  /** Canonical URL to the exact commit on GitHub, if provided. */
  commitUrl?: string | null;
}

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

function clean(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function getBuildInfo(source: BuildInfoSource | null | undefined = {}): BuildInfo {
  const sha = clean(source?.gitSha);
  const ref = clean(source?.gitRef);
  const commitUrl = clean(source?.commitUrl);

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
