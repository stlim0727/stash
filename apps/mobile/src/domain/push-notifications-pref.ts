/**
 * Whether the user opted in to "Notify when AI catches up" (STASH #579) — a
 * push notification the server sends once a user's `pending_ai_enrichment`
 * overflow backlog (see #578) fully drains to zero.
 *
 * Off by default: this is a deliberate opt-in feature (a cold OS permission
 * prompt on first launch would be a bad first impression), not something
 * that silently turns on. Follows the same shape as `domain/share-behavior.ts`
 * and `domain/ai-suggestions-pref.ts`: a persistence key plus parse/serialize
 * helpers, persisted through the repository meta store from Settings.
 *
 * This module only tracks the LOCAL intent (what the user asked for). The
 * actual OS permission request and Expo push-token registration are side
 * effects owned by `notifications/push-token-registration.ts` and the
 * Settings screen — kept out of this file so it stays platform-free and
 * unit-testable without React Native or expo-notifications.
 */
export const PUSH_NOTIFICATIONS_PREF_KEY = 'pref.notifications.ai_drained';

/** The last Expo push token this device successfully registered, cached
 *  locally purely so turning the toggle back OFF can deregister it (a
 *  DELETE by token value) without needing to re-request OS permission or
 *  re-mint a token just to find out what to delete. Cleared once the
 *  deregister call is issued (best-effort either way; see
 *  `notifications/push-token-registration.ts`). */
export const LAST_REGISTERED_PUSH_TOKEN_PREF_KEY = 'meta.notifications.push_token';

/** Off by default (opt-in). */
export const DEFAULT_PUSH_NOTIFICATIONS_ENABLED = false;

export function serializePushNotificationsEnabled(enabled: boolean): string {
  return enabled ? 'true' : 'false';
}

export function parsePushNotificationsEnabled(raw: string | null | undefined): boolean {
  return raw === 'true';
}
