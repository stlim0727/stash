/**
 * Native splash operations using expo-splash-screen.
 */

import * as SplashScreen from 'expo-splash-screen';
import { markAppLoaded as sentryMarkAppLoaded } from '@/observability/sentry';

export async function preventAutoHideAsync(): Promise<boolean> {
  return SplashScreen.preventAutoHideAsync();
}

export async function hideAsync(): Promise<boolean | void> {
  return SplashScreen.hideAsync();
}

export function markAppLoaded(): void {
  sentryMarkAppLoaded();
}
