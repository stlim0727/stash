/**
 * Pure extraction of `extra.eas.projectId` from Expo's config `extra` blob.
 * Split out from `push-permission.ts` (which imports `expo-notifications` and
 * `react-native`, neither loadable under the plain Node test lane) so this
 * one piece of real logic — "is a projectId configured?" — has an actual
 * test instead of only ever being observed on a device. See
 * `push-permission.ts` for why a missing projectId matters (STASH #579).
 */
export function resolveEasProjectId(extra: unknown): string | null {
  if (typeof extra !== 'object' || extra === null) {
    return null;
  }
  const eas = (extra as { eas?: unknown }).eas;
  if (typeof eas !== 'object' || eas === null) {
    return null;
  }
  const projectId = (eas as { projectId?: unknown }).projectId;
  return typeof projectId === 'string' && projectId.trim() ? projectId.trim() : null;
}
