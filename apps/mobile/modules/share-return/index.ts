import { requireOptionalNativeModule } from 'expo';

/**
 * Thin handle on the native `ShareReturn` Android module. It is intentionally
 * optional: the module only exists on Android (see `expo-module.config.json`),
 * so on iOS/web — and in Expo Go or unit tests, where no native code is linked —
 * this resolves to `null` and callers fall back to staying in the app.
 *
 * App code should prefer `@/share/return-to-app`, which wraps this with the
 * platform guards and the floating-toast fallback.
 */
export interface ShareReturnModule {
  /**
   * Send Stash's task to the background, revealing whatever app the share came
   * from. Returns `true` when Android actually moved the task.
   */
  moveTaskToBack(): boolean;
}

const ShareReturn = requireOptionalNativeModule<ShareReturnModule>('ShareReturn');

export default ShareReturn;
