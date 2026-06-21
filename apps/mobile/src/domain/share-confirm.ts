/**
 * The "confirm on next open" record for a toast-mode share.
 *
 * On Android a toast-mode share dismisses Stash entirely once the capture is
 * durably written (see `share/dismiss.ts`), handing control back to the app you
 * shared from. The only confirmation you get in that moment is a fleeting
 * system toast that's long gone by the time you reopen Stash — which is exactly
 * when the "wait, did that actually save?" doubt shows up. So before exiting we
 * persist this small record; the next time the app comes to the foreground we
 * surface a modeless confirmation toast (with a "View" shortcut to the Inbox)
 * on whatever screen you happen to land on, never yanking you elsewhere.
 *
 * Pure data — no React, no storage, no native imports — so the Node test lane
 * can exercise it directly.
 */

/** Persistence key for the pending share confirmation (meta store). */
export const SHARE_CONFIRM_PREF_KEY = 'pref.share.pendingConfirm';

export interface PendingShareConfirm {
  /** How many genuinely new items were stashed since the last confirmation. */
  savedCount: number;
}

/**
 * Parse a stored record. Returns `null` for anything missing, malformed, or
 * carrying nothing worth confirming (a zero/negative count), so callers can
 * treat "no record" and "empty record" identically.
 */
export function parsePendingShareConfirm(raw: string | null | undefined): PendingShareConfirm | null {
  if (!raw) {
    return null;
  }
  try {
    const data = JSON.parse(raw) as { savedCount?: unknown };
    const savedCount =
      typeof data?.savedCount === 'number' && Number.isFinite(data.savedCount)
        ? Math.floor(data.savedCount)
        : 0;
    return savedCount > 0 ? { savedCount } : null;
  } catch {
    return null;
  }
}

export function serializePendingShareConfirm(value: PendingShareConfirm): string {
  return JSON.stringify({ savedCount: value.savedCount });
}

/**
 * Fold a freshly-saved capture into the pending record. Multiple shares can
 * stack up before the app is reopened (each Android share launches, saves, and
 * exits on its own), so counts accumulate rather than overwrite.
 */
export function addPendingShareSave(prev: PendingShareConfirm | null, added = 1): PendingShareConfirm {
  const base = prev?.savedCount ?? 0;
  return { savedCount: base + Math.max(0, Math.floor(added)) };
}
