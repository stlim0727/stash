/**
 * Fire-and-forget tracking of per-user preferences.
 *
 * Stamps `locale` into `public.user_preferences` (and `auth.users.raw_user_meta_data`)
 * so server-side triggers (like `dispatch_ai_enrichment`) and background workers can
 * process bookmarks/memos in the user's preferred language.
 *
 * Best-effort: this NEVER throws and never blocks capture or UI — a failed write
 * is silently swallowed and simply retried on the next session start or preference change.
 */
import type { SupabaseAuthSession } from '@/supabase/types';

export interface UserPreferencesWriter {
  upsertUserPreferences(accessToken: string, data: Record<string, unknown>): Promise<unknown>;
  updateUserMetadata?(accessToken: string, data: Record<string, unknown>): Promise<unknown>;
}

export interface TrackUserPreferencesParams {
  client: UserPreferencesWriter;
  session: SupabaseAuthSession;
  locale: string;
  preference?: string;
  now: string;
}

export async function trackUserPreferences({
  client,
  session,
  locale,
  preference,
  now,
}: TrackUserPreferencesParams): Promise<void> {
  const trimmed = typeof locale === 'string' && locale.trim() ? locale.trim() : 'en';

  try {
    await client.upsertUserPreferences(session.access_token, {
      user_id: session.user.id,
      locale: trimmed,
      ...(preference ? { preference } : {}),
      updated_at: now,
    });
  } catch {
    // Best-effort: a failed write is retried on the next session start or preference change.
  }

  const metaChanged =
    session.user.user_metadata?.locale !== trimmed ||
    (preference && session.user.user_metadata?.preference !== preference);

  if (typeof client.updateUserMetadata === 'function' && metaChanged) {
    try {
      await client.updateUserMetadata(session.access_token, {
        locale: trimmed,
        ...(preference ? { preference } : {}),
        locale_updated_at: now,
      });
    } catch {
      // Best-effort: updating user_metadata is secondary to user_preferences table.
    }
  }
}
