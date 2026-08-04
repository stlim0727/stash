/**
 * Fire-and-forget tracking of the per-user sync status.
 *
 * Stamps `app_version` + `last_synced_at` into `public.user_sync_status`
 * once a sync pass actually completes (upload + pull), for the admin
 * dashboard (GH #687). This is a SECONDARY source: `app-version-tracker.ts`
 * already stamps `app_version` into `auth.users.raw_user_meta_data` on
 * launch, and `admin_user_overview` reads that first, falling back to this
 * table's `app_version` only when the metadata one is empty — this column is
 * reserved for a per-sync (rather than per-launch) stamp. `last_synced_at`
 * has no other source.
 *
 * Best-effort: this NEVER throws and never blocks/delays sync — a failed
 * write is silently swallowed and simply retried on the next successful sync
 * pass. No separate retry/queue machinery.
 */
import type { AppVersionRuntime } from '@/domain/app-version-metadata';
import type { SupabaseAuthSession } from '@/supabase/types';

/** The slice of the Supabase client this tracker needs (keeps it testable). */
export interface SyncStatusWriter {
  upsertSyncStatus(accessToken: string, data: Record<string, unknown>): Promise<unknown>;
}

export interface TrackSyncStatusParams {
  client: SyncStatusWriter;
  session: SupabaseAuthSession;
  runtime: AppVersionRuntime;
  /** Injected ISO timestamp (keeps callers deterministic / testable). */
  now: string;
}

/**
 * Stamp `app_version` + `last_synced_at` for the authenticated user. Always
 * writes (unlike the change-only app-version metadata tracker) — this runs
 * once per completed sync pass, not once per launch, so there is no
 * steady-state hammering to guard against.
 */
export async function trackSyncStatus({
  client,
  session,
  runtime,
  now,
}: TrackSyncStatusParams): Promise<void> {
  const appVersion =
    typeof runtime.appVersion === 'string' && runtime.appVersion.trim()
      ? runtime.appVersion.trim()
      : null;

  try {
    await client.upsertSyncStatus(session.access_token, {
      user_id: session.user.id,
      app_version: appVersion,
      last_synced_at: now,
      updated_at: now,
    });
  } catch {
    // Best-effort: a failed stamp is retried on the next successful sync pass.
  }
}
