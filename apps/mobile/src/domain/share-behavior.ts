/**
 * What Stash does *after* it captures a URL shared from another app.
 *
 * Sharing always briefly launches the host app (a constraint of the OS share
 * flow), but we control what happens once the URL is saved:
 *  - `toast`  — confirm with a short, modeless toast and stay out of the way,
 *               never navigating; this matches the original fast-capture intent.
 *  - `inbox`  — additionally jump to the Inbox so the freshly stashed item is
 *               immediately visible.
 */
export type ShareBehavior = 'toast' | 'inbox';

/**
 * Toast-only is the default: a share is meant to be a fast, fire-and-forget
 * capture, not a context switch into the Inbox.
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
