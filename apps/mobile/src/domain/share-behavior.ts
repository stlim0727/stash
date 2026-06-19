/**
 * What Stash does *after* it captures a URL shared from another app.
 *
 * Sharing always briefly launches Stash (a constraint of the OS share flow:
 * `expo-share-intent` has no inline-handling mode), but we control what happens
 * once the URL is saved:
 *  - `toast`  — fire-and-forget: confirm and step back out of the way. On
 *               Android we show a floating OS toast and drop straight back to
 *               the app the share came from; on iOS, which won't let an app
 *               background itself, we just show the in-app toast and stay put.
 *  - `inbox`  — instead jump to the Inbox so the freshly stashed item is
 *               immediately visible.
 */
export type ShareBehavior = 'toast' | 'inbox';

/**
 * Toast is the default: a share is meant to be a fast, fire-and-forget capture
 * that returns you to where you were, not a context switch into the Inbox.
 */
export const DEFAULT_SHARE_BEHAVIOR: ShareBehavior = 'toast';

/** Persistence key for the user's chosen post-share behavior (meta store). */
export const SHARE_BEHAVIOR_PREF_KEY = 'pref.share.behavior';

/** Short human label for the active behavior (used in Settings + a11y). */
export function describeShareBehavior(behavior: ShareBehavior): string {
  return behavior === 'inbox' ? 'Open Inbox' : 'Toast only';
}

export function serializeShareBehavior(behavior: ShareBehavior): string {
  return behavior;
}

export function parseShareBehavior(raw: string | null | undefined): ShareBehavior {
  return raw === 'toast' || raw === 'inbox' ? raw : DEFAULT_SHARE_BEHAVIOR;
}
