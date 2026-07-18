import { BackHandler, Platform, ToastAndroid } from 'react-native';
import { ShareIntentModule } from 'expo-share-intent';

/**
 * Post-capture dismissal for a *toast-mode* share.
 *
 * The OS share flow always foregrounds the host app, so we can't literally
 * "not show Stash at all". The next best thing — and what a toast-mode user is
 * really asking for — is to get straight back out of the way: confirm the save
 * and return to whatever app they shared from, never stranding them on a stale
 * Bookmark Detail or Settings screen that was merely left over in memory from a
 * previous session and has nothing to do with what they just shared.
 *
 * Only Android can self-dismiss. `BackHandler.exitApp()` finishes the
 * share-launched activity, which hands control back to the previous app, and a
 * system `ToastAndroid` (a window-level overlay that outlives our activity)
 * carries the confirmation across the handoff. iOS and web cannot send
 * themselves to the background, so we report `false` and let the caller land on
 * the Inbox instead — a clean, relevant screen.
 *
 * Returns whether the app was dismissed. When `true` the caller must NOT
 * navigate (the in-app UI is going away); when `false` it should land on the
 * Inbox and show its own in-app toast.
 */
/**
 * Whether `dismissAfterShare` will actually self-dismiss on this platform —
 * only Android can. Callers use this to decide, *before* the app exits,
 * whether the user will be left without an in-app confirmation (and so needs a
 * "confirm on next open" record). It's the single source of truth for that
 * condition, shared with `dismissAfterShare` below.
 */
export function canDismissAfterShare(): boolean {
  return Platform.OS === 'android';
}

export async function dismissAfterShare(message: string): Promise<boolean> {
  if (!canDismissAfterShare()) {
    return false;
  }
  // Fire the confirmation before we leave so it survives the activity finishing.
  ToastAndroid.show(message, ToastAndroid.LONG);
  if (ShareIntentModule && typeof ShareIntentModule.dismissApp === 'function') {
    const success = await ShareIntentModule.dismissApp('');
    if (success === false) {
      console.error('dismissAfterShare failed: native dismissApp returned false (no currentActivity)');
      return false;
    }
  } else {
    BackHandler.exitApp();
  }
  return true;
}
