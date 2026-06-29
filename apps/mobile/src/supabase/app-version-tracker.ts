/**
 * Fire-and-forget tracking of the per-user app version.
 *
 * Stamps the current app version + platform into the GoTrue user's
 * `user_metadata` so we can report which version each user is on (queryable as
 * `auth.users.raw_user_meta_data->>'app_version'`). This is best-effort: it
 * NEVER throws and never blocks capture/sync — a failed write just means the
 * stamp is retried on the next launch.
 *
 * The decision of *whether* to write lives in the pure planner
 * (`domain/app-version-metadata`); this module only performs the side effect and
 * returns the locally-merged session so the caller can keep its in-memory copy
 * in sync (which prevents a redundant re-write within the same launch).
 */
import {
  planAppVersionMetadataUpdate,
  type AppVersionRuntime,
} from '@/domain/app-version-metadata';
import type { SupabaseAuthSession } from '@/supabase/types';

/** The slice of the Supabase client this tracker needs (keeps it testable). */
export interface AppVersionMetadataWriter {
  updateUserMetadata(
    accessToken: string,
    data: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface TrackAppVersionParams {
  client: AppVersionMetadataWriter;
  session: SupabaseAuthSession;
  runtime: AppVersionRuntime;
  /** Injected ISO timestamp (keeps callers deterministic / testable). */
  now: string;
}

/**
 * Persist the current app version/platform onto the user when it changed.
 *
 * Returns the session with the new values merged into `user_metadata` on a
 * successful write, or `null` when nothing was written (already up to date,
 * missing runtime values, or the write failed).
 */
export async function trackAppVersionMetadata({
  client,
  session,
  runtime,
  now,
}: TrackAppVersionParams): Promise<SupabaseAuthSession | null> {
  const patch = planAppVersionMetadataUpdate(session.user.user_metadata, runtime, now);
  if (!patch) {
    return null;
  }

  try {
    await client.updateUserMetadata(session.access_token, { ...patch });
  } catch {
    // Best-effort: a failed stamp is retried on the next launch. Never surface
    // this to the user or break the session.
    return null;
  }

  return {
    ...session,
    user: {
      ...session.user,
      user_metadata: { ...session.user.user_metadata, ...patch },
    },
  };
}
