/**
 * Native splash operations using expo-splash-screen.
 */

import * as SplashScreen from 'expo-splash-screen';

export async function preventAutoHideAsync(): Promise<boolean> {
  return SplashScreen.preventAutoHideAsync();
}

export async function hideAsync(): Promise<boolean | void> {
  return SplashScreen.hideAsync();
}
