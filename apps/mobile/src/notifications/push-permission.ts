/**
 * OS notification permission + Expo push token retrieval (STASH #579). This
 * is the one file in `notifications/` that touches native modules
 * (`expo-notifications`, `react-native`), which aren't loadable under the
 * plain Node test lane — so it stays a thin, untested wrapper around
 * `resolveEasProjectId` (`notifications/eas-project-id.ts`), which holds the
 * one piece of real logic here and is unit-tested on its own.
 *
 * `Notifications.getExpoPushTokenAsync` requires an EAS `projectId`. This app
 * does not have one configured yet (no `expo.extra.eas.projectId` in
 * app.json/app.config.js, no linked EAS project) — see the #579 PR notes. Do
 * NOT invent one here: `requestPushPermissionAndToken` resolves to
 * `{ outcome: 'no_project_id' }` instead of throwing or silently no-oping in
 * a way that would hide the gap. OS permission is still requested and
 * granted/denied is still tracked, so once a projectId exists, no client
 * change is needed beyond configuring it.
 */
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { resolveEasProjectId } from '@/notifications/eas-project-id';

export type PushPermissionOutcome =
  | { outcome: 'unsupported' } // web, or any platform without push support
  | { outcome: 'denied' }
  | { outcome: 'no_project_id' }
  | { outcome: 'granted'; token: string; platform: 'ios' | 'android' };

/**
 * Request OS notification permission, then mint an Expo push token. Only
 * called from an explicit user action (turning the Settings toggle on) —
 * never on app launch, per #579's "opt-in, not a cold prompt" requirement.
 */
export async function requestPushPermissionAndToken(): Promise<PushPermissionOutcome> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    return { outcome: 'unsupported' };
  }

  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== 'granted') {
    return { outcome: 'denied' };
  }

  const projectId = resolveEasProjectId(Constants.expoConfig?.extra);
  if (!projectId) {
    console.warn(
      '[push-notifications] No EAS projectId configured; cannot mint an Expo push token.',
    );
    return { outcome: 'no_project_id' };
  }

  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
  return { outcome: 'granted', token, platform: Platform.OS };
}
