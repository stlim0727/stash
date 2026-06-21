import {
  addPendingShareSave,
  parsePendingShareConfirm,
  serializePendingShareConfirm,
  SHARE_CONFIRM_PREF_KEY,
  type PendingShareConfirm,
} from '@/domain/share-confirm';
import { getPreference, setPreference } from '@/storage/preferences';

/**
 * Durable read/write for the "confirm on next open" record (see
 * `domain/share-confirm.ts`). Backed by the same meta store as other
 * preferences so it survives the app exiting after a toast-mode share.
 *
 * Every operation is best-effort: a confirmation is a nicety layered on top of
 * an already-durable capture, so a storage hiccup must never throw into — and
 * break — the share path. Capture is sacred.
 */

/**
 * Record that `addedSaves` genuinely new item(s) were stashed, accumulating
 * onto anything not yet confirmed. Awaitable on purpose: the share handler
 * must let this write settle *before* it dismisses the app, or `exitApp()`
 * could cut it off and the reopened app would have nothing to confirm.
 */
export async function recordPendingShareConfirm(addedSaves = 1): Promise<void> {
  try {
    const prev = parsePendingShareConfirm(await getPreference(SHARE_CONFIRM_PREF_KEY));
    const next = addPendingShareSave(prev, addedSaves);
    await setPreference(SHARE_CONFIRM_PREF_KEY, serializePendingShareConfirm(next));
  } catch {
    // Best-effort — never let confirmation bookkeeping interfere with capture.
  }
}

/**
 * Read the pending record and clear it in the same breath, so two foreground
 * events racing (a mount and an AppState transition) can't both surface the
 * same confirmation. Returns `null` when there is nothing to confirm.
 */
export async function takePendingShareConfirm(): Promise<PendingShareConfirm | null> {
  try {
    const pending = parsePendingShareConfirm(await getPreference(SHARE_CONFIRM_PREF_KEY));
    if (!pending) {
      return null;
    }
    await setPreference(SHARE_CONFIRM_PREF_KEY, serializePendingShareConfirm({ savedCount: 0 }));
    return pending;
  } catch {
    return null;
  }
}
