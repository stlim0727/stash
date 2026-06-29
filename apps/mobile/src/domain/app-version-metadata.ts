/**
 * Plans the per-user app-version metadata write.
 *
 * We track which app version / platform each user is on by stamping it into the
 * GoTrue user's `user_metadata` (queryable later as
 * `auth.users.raw_user_meta_data->>'app_version'`). Unlike `feedback_reports`
 * — which only captures a version when someone files a report — this records
 * the *current* version for every user as soon as the app has a session.
 *
 * This module is intentionally PURE and dependency-free (Node-testable). The
 * caller gathers the live runtime values (expo-constants version, Platform.OS)
 * and the current `user_metadata`, and passes them in; this decides whether a
 * write is needed and, if so, the exact patch to send.
 *
 * Change-only: we return a patch ONLY when the version or platform actually
 * differs from what is already stored, so steady-state app launches do not
 * hammer GoTrue with redundant writes.
 */

/** The version fields we own inside `user_metadata`. */
export interface AppVersionMetadata {
  /** App version string, e.g. `1.0.0-rc8` (from `Constants.expoConfig.version`). */
  app_version: string;
  /** Platform identifier — `ios` | `android` | `web` (`Platform.OS`). */
  platform: string;
  /** ISO timestamp of when this version/platform was last stamped. */
  app_version_updated_at: string;
}

/** Live runtime values the caller reads from the device. */
export interface AppVersionRuntime {
  appVersion?: string | null;
  platform?: string | null;
}

/**
 * Existing `user_metadata` may carry our keys plus unrelated OAuth profile
 * fields — we only ever read/merge our own keys and never touch the rest.
 * Values can be `null` (GoTrue stores explicit nulls), so model that.
 */
export type UserMetadataLike =
  | ({ app_version?: string | null; platform?: string | null } & Record<string, unknown>)
  | null
  | undefined;

function clean(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Decide whether the user's app-version metadata needs updating.
 *
 * Returns the patch to merge into `user_metadata`, or `null` when the stored
 * values already match the runtime (no write needed) or when the runtime values
 * are missing/empty (never persist junk like an empty version).
 */
export function planAppVersionMetadataUpdate(
  current: UserMetadataLike,
  runtime: AppVersionRuntime,
  now: string,
): AppVersionMetadata | null {
  const appVersion = clean(runtime.appVersion);
  const platform = clean(runtime.platform);

  // Without a real version AND platform there is nothing meaningful to record.
  if (!appVersion || !platform) {
    return null;
  }

  const storedVersion = clean(current?.app_version);
  const storedPlatform = clean(current?.platform);

  if (storedVersion === appVersion && storedPlatform === platform) {
    return null;
  }

  return {
    app_version: appVersion,
    platform,
    app_version_updated_at: now,
  };
}
