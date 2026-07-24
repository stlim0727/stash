/**
 * The real `PushTokenWriter`, built on this repo's hand-rolled direct-REST
 * Supabase client (no supabase-js — see `api/bookmarks.ts` for the
 * established convention this mirrors).
 */
import { createSupabaseClient, StashSupabaseClient } from '@/supabase/client';
import type { PushTokenWriter } from '@/notifications/push-token-registration';

export function createPushTokenWriter(client: StashSupabaseClient): PushTokenWriter {
  return {
    upsertPushToken: (accessToken, body) =>
      client.request('/rest/v1/push_tokens?on_conflict=user_id,token', {
        method: 'POST',
        accessToken,
        // merge-duplicates so re-registering the same (user_id, token) pair
        // updates the existing row (bumping updated_at) instead of a 409 —
        // matches the unique constraint on push_tokens.
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body,
      }),
    // Scoped by `token=eq.` alone (not also user_id): RLS already restricts a
    // DELETE to the caller's own rows, and scoping by token additionally
    // means a stale/mismatched local copy of the token can't accidentally
    // target someone else's row shape — there is nothing to match beyond it.
    deletePushToken: (accessToken, token) =>
      client.request(`/rest/v1/push_tokens?token=eq.${encodeURIComponent(token)}`, {
        method: 'DELETE',
        accessToken,
        headers: { Prefer: 'return=minimal' },
      }),
  };
}

/**
 * The writer Settings actually uses — bundles `createSupabaseClient()`
 * behind this same module so a caller (and its tests) only ever need to mock
 * `@/notifications/push-token-client`, never the shared `@/supabase/client`
 * module the rest of the app (sync, auth) also depends on. Mocking that
 * shared module from a Settings test would otherwise leak into unrelated
 * store sync calls in the same test file.
 */
export function createDefaultPushTokenWriter(): PushTokenWriter {
  return createPushTokenWriter(createSupabaseClient());
}
