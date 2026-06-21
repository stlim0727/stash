/**
 * Web stub for the captured-image store. Image sharing is a native-only capture
 * path (the share intent is a no-op on web), so there is no durable file system
 * to copy into — we just return the source URI unchanged. The native
 * counterpart (`image-store.native.ts`) copies the shared file into the app's
 * document directory so the OS can't reclaim it.
 */

export async function copyImageToLibrary(sourceUri: string, _fileName: string): Promise<string> {
  return sourceUri;
}
