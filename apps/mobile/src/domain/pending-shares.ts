/**
 * A durable record of URLs handed to Stash by the OS share sheet but not yet
 * confirmed saved.
 *
 * The share handler copies the shared URL into React state and defers the
 * actual save until the local store has finished loading (so the in-memory
 * dedupe sees existing bookmarks). React state, however, does not survive the
 * OS killing a backgrounded process — and Android backgrounds Stash the instant
 * a share is handled in the default "toast" mode (the share sheet returns to the
 * source app), so a slow cold-start load can be cut short before the deferred
 * save ever runs. The shared item then silently never appears.
 *
 * Persisting the raw capture here, the moment it arrives, lets the next launch
 * recover any share whose deferred save never landed. Capture stays sacred even
 * across a process death. The list is keyed by normalized URL so a re-record of
 * the same link replaces the older entry rather than piling up.
 */
export const PENDING_SHARES_KEY = 'pending_shares';

export interface PendingShare {
  /** Normalized URL extracted from the shared payload. */
  url: string;
  /** Optional title from the share meta (user-authored at capture). */
  title?: string;
  /** When the share was captured (ISO 8601), for debugging/ordering. */
  captured_at: string;
  /**
   * The app-launch ("session") that recorded this share. Recovery only re-saves
   * shares from a *different* launch — i.e. ones a process kill stranded — so a
   * share the current launch is still handling is never double-saved. Absent on
   * entries written before this field existed (treated as recoverable).
   */
  session_id?: string;
}

/** Parse the persisted queue, tolerating absent/corrupt values. */
export function parsePendingShares(raw: string | null | undefined): PendingShare[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(
          (share): share is PendingShare =>
            !!share &&
            typeof share.url === 'string' &&
            typeof share.captured_at === 'string' &&
            (share.title === undefined || typeof share.title === 'string') &&
            (share.session_id === undefined || typeof share.session_id === 'string'),
        )
      : [];
  } catch {
    return [];
  }
}

export function serializePendingShares(list: PendingShare[]): string {
  return JSON.stringify(list);
}

/** Append a share, de-duplicating by URL (a re-record replaces the old one). */
export function addPendingShare(list: PendingShare[], share: PendingShare): PendingShare[] {
  return [...list.filter((item) => item.url !== share.url), share];
}

/** Drop the recovered/confirmed share for a URL. */
export function removePendingShare(list: PendingShare[], url: string): PendingShare[] {
  return list.filter((item) => item.url !== url);
}
