import { requireOptionalNativeModule } from 'expo';
import { Platform, ToastAndroid } from 'react-native';

/**
 * After a toast-mode share capture we'd rather not strand the user inside Stash:
 * the share was a fire-and-forget gesture from another app, so the natural thing
 * is to confirm and step back to wherever they came from.
 *
 * Two platform constraints shape this:
 *  - `expo-share-intent` has no way to avoid foregrounding the host app — it
 *    always launches Stash to hand off the URL — so the best we can do is drop
 *    back out once we've captured. That requires the native `ShareReturn`
 *    Android module (`Activity.moveTaskToBack`), which has no RN equivalent.
 *  - iOS forbids an app from backgrounding itself, so there is nothing to call;
 *    the native module is Android-only and resolves to `null` everywhere else
 *    (including Expo Go and unit tests, where no native code is linked).
 *
 * Both helpers are therefore no-ops off Android, and callers fall back to the
 * in-app capture toast and staying put.
 */

interface ShareReturnModule {
  /** Send Stash's task to the background; returns whether Android moved it. */
  moveTaskToBack(): boolean;
}

/**
 * Looked up lazily (not at import time) so the platform guard runs first and so
 * tests can stub it. Resolves to `null` when the native module isn't linked.
 */
function nativeModule(): ShareReturnModule | null {
  try {
    return requireOptionalNativeModule<ShareReturnModule>('ShareReturn');
  } catch {
    return null;
  }
}

/**
 * Show the capture confirmation as a floating OS toast. Unlike the in-app
 * `CaptureToastProvider`, an Android `Toast` keeps rendering over the previous
 * app after we background Stash — so the confirmation is still visible once
 * `returnToPreviousApp` has handed control back. Returns `true` when shown.
 */
export function showSystemToast(message: string): boolean {
  if (Platform.OS !== 'android') {
    return false;
  }
  ToastAndroid.show(message, ToastAndroid.SHORT);
  return true;
}

/**
 * Send Stash to the background so the app the share came from is revealed.
 * Android only; returns `false` (and changes nothing) elsewhere or when the
 * native module isn't linked, so the caller stays in the app.
 */
export function returnToPreviousApp(): boolean {
  if (Platform.OS !== 'android') {
    return false;
  }
  const native = nativeModule();
  if (!native) {
    return false;
  }
  try {
    return native.moveTaskToBack();
  } catch {
    return false;
  }
}
