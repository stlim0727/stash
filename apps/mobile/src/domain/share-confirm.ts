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
  /** How many duplicate items were confirmed since the last confirmation. */
  duplicateCount?: number;
  /** The most recently saved/confirmed bookmark id (for jumping directly to it). */
  lastBookmarkId?: string;
}

export type AddPendingShareOptions =
  | number
  | {
      addedSaves?: number;
      addedDuplicates?: number;
      bookmarkId?: string;
    };

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
    const data = JSON.parse(raw) as {
      savedCount?: unknown;
      duplicateCount?: unknown;
      lastBookmarkId?: unknown;
    };
    const savedCount =
      typeof data?.savedCount === 'number' && Number.isFinite(data.savedCount)
        ? Math.floor(data.savedCount)
        : 0;
    const duplicateCount =
      typeof data?.duplicateCount === 'number' && Number.isFinite(data.duplicateCount)
        ? Math.floor(data.duplicateCount)
        : 0;
    const lastBookmarkId =
      typeof data?.lastBookmarkId === 'string' && data.lastBookmarkId.trim()
        ? data.lastBookmarkId.trim()
        : undefined;

    if (savedCount <= 0 && duplicateCount <= 0) {
      return null;
    }
    return {
      savedCount: Math.max(0, savedCount),
      ...(duplicateCount > 0 ? { duplicateCount } : {}),
      ...(lastBookmarkId ? { lastBookmarkId } : {}),
    };
  } catch {
    return null;
  }
}

export function serializePendingShareConfirm(value: PendingShareConfirm): string {
  return JSON.stringify({
    savedCount: value.savedCount,
    ...(value.duplicateCount && value.duplicateCount > 0 ? { duplicateCount: value.duplicateCount } : {}),
    ...(value.lastBookmarkId ? { lastBookmarkId: value.lastBookmarkId } : {}),
  });
}

/**
 * Fold a freshly-saved capture into the pending record. Multiple shares can
 * stack up before the app is reopened (each Android share launches, saves, and
 * exits on its own), so counts accumulate rather than overwrite.
 */
export function addPendingShareSave(
  prev: PendingShareConfirm | null,
  added: AddPendingShareOptions = 1,
): PendingShareConfirm {
  const isNum = typeof added === 'number';
  const rawSaves = isNum ? added : (added.addedSaves ?? 0);
  const rawDuplicates = isNum ? 0 : (added.addedDuplicates ?? 0);
  const stepSaves = Math.max(0, Math.floor(rawSaves));
  const stepDuplicates = Math.max(0, Math.floor(rawDuplicates));
  const bookmarkId = isNum ? prev?.lastBookmarkId : (added.bookmarkId ?? prev?.lastBookmarkId);

  const baseSaves = prev?.savedCount ?? 0;
  const baseDuplicates = prev?.duplicateCount ?? 0;
  const nextSaves = baseSaves + stepSaves;
  const nextDuplicates = baseDuplicates + stepDuplicates;

  return {
    savedCount: nextSaves,
    ...(nextDuplicates > 0 ? { duplicateCount: nextDuplicates } : {}),
    ...(nextSaves > 0 || nextDuplicates > 0 ? (bookmarkId ? { lastBookmarkId: bookmarkId } : {}) : {}),
  };
}
