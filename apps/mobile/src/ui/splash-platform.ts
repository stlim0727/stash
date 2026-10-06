/**
 * Web and Node fallback implementation for splash screen operations.
 *
 * Native platforms override this via `splash-platform.native.ts` to call
 * `expo-splash-screen`. On web, splash auto-hiding is a safe no-op.
 */

export async function preventAutoHideAsync(): Promise<boolean> {
  return true;
}

export async function hideAsync(): Promise<boolean | void> {
  return true;
}
