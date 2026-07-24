/**
 * Fire-and-forget registration/deregistration of an Expo push token against
 * `push_tokens` (STASH #579). Mirrors `supabase/app-version-tracker.ts`'s
 * shape: the side effect takes an injectable, minimal client interface so it
 * is unit-testable without a network or a real Supabase client, and it NEVER
 * throws — a failed register/deregister is the caller's (Settings screen's)
 * problem to retry on the next toggle or app launch, never something that
 * should block or break anything else ("Capture is sacred" extends to this:
 * notifications must never be able to affect a bookmark save).
 *
 * Registered (non-anonymous) users only — see the push_tokens migration for
 * the RLS-level enforcement of that; this module doesn't re-check anonymity
 * itself, the caller (Settings) is responsible for only calling
 * `registerPushToken` for an authenticated session, same pattern as
 * `trackAppVersionMetadata` trusting its caller for session validity.
 */
import type { SupabaseAuthSession } from '@/supabase/types';

/** The slice of Supabase REST this needs — kept minimal so a fake can satisfy
 *  it in tests without any HTTP. */
export interface PushTokenWriter {
  upsertPushToken(
    accessToken: string,
    body: { user_id: string; token: string; platform: 'ios' | 'android'; updated_at: string },
  ): Promise<unknown>;
  deletePushToken(accessToken: string, token: string): Promise<unknown>;
}

export interface RegisterPushTokenParams {
  client: PushTokenWriter;
  session: SupabaseAuthSession;
  token: string;
  platform: 'ios' | 'android';
  /** Injected so this stays deterministic/testable, same as
   *  `trackAppVersionMetadata`'s `now` param. */
  now?: () => string;
}

/** Upsert `token` for the current session's user. Returns whether it
 *  succeeded; never throws. `updated_at` is set explicitly on every call —
 *  this table has no DB-side trigger to bump it automatically (matches this
 *  codebase's convention of every write setting it by hand, e.g.
 *  `ai_enrichments` in supabase/functions/ai-enrich/index.ts) — so a
 *  re-registration on relaunch is visible as a fresh "last seen" instead of
 *  silently keeping the original insert time forever. */
export async function registerPushToken(params: RegisterPushTokenParams): Promise<boolean> {
  try {
    await params.client.upsertPushToken(params.session.access_token, {
      user_id: params.session.user.id,
      token: params.token,
      platform: params.platform,
      updated_at: (params.now ?? (() => new Date().toISOString()))(),
    });
    return true;
  } catch (err) {
    console.warn('[push-notifications] Failed to register push token:', err);
    return false;
  }
}

export interface DeregisterPushTokenParams {
  client: PushTokenWriter;
  session: SupabaseAuthSession;
  token: string;
}

/** Delete `token` (owner-scoped by RLS via the forwarded access token, so
 *  this can only ever remove the caller's own row). Returns whether it
 *  succeeded; never throws. */
export async function deregisterPushToken(params: DeregisterPushTokenParams): Promise<boolean> {
  try {
    await params.client.deletePushToken(params.session.access_token, params.token);
    return true;
  } catch (err) {
    console.warn('[push-notifications] Failed to deregister push token:', err);
    return false;
  }
}
