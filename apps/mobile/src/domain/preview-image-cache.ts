import { useSyncExternalStore } from 'react';

export const PREVIEW_IMAGE_RETRY_MS = 60_000;
const failedImageUris = new Map<string, ReturnType<typeof setTimeout> | null>();
const listeners = new Set<() => void>();
let failureVersion = 0;

function notify() {
  failureVersion += 1;
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Record that a preview image URI failed to load (e.g. 403 Forbidden, 404, or expired CDN signature).
 * This prevents React Native <Image> from leaving a blank empty box occupying screen space (STASH-6P).
 */
export function markPreviewImageFailed(uri: string | null | undefined): void {
  if (!uri || failedImageUris.has(uri)) {
    return;
  }
  // Missing device files cannot recover without a new local preview. Retain
  // that failure so a working uploaded fallback is not replaced every minute.
  if (uri.startsWith('file://')) {
    failedImageUris.set(uri, null);
    notify();
    return;
  }
  // A transport error is not permanent. Expiry notifies mounted screens too,
  // allowing them to retry without navigation or a full app restart.
  const timer = setTimeout(() => clearPreviewImageFailed(uri), PREVIEW_IMAGE_RETRY_MS);
  (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  failedImageUris.set(uri, timer);
  notify();
}

/**
 * Check if a preview image URI is known to have failed loading.
 */
export function isPreviewImageFailed(uri: string | null | undefined): boolean {
  if (!uri) {
    return false;
  }
  return failedImageUris.has(uri);
}

/**
 * Clear the failure record for a URI (e.g. when the user explicitly requests preview refresh).
 */
export function clearPreviewImageFailed(uri: string | null | undefined): void {
  if (!uri || !failedImageUris.has(uri)) {
    return;
  }
  const timer = failedImageUris.get(uri);
  if (timer) clearTimeout(timer);
  failedImageUris.delete(uri);
  notify();
}

/** Prefer the local copy, but retain a usable uploaded image after local failure. */
export function selectPreviewImageUri(
  localUri: string | null | undefined,
  remoteUri: string | null | undefined,
): string | null {
  return [localUri, remoteUri].find((uri) => uri && !isPreviewImageFailed(uri)) ?? null;
}

type PreviewImageLoadEvent = {
  source?: { width: number; height: number };
};

/**
 * Check if an image decoded with non-zero dimensions.
 *
 * Keepory's react-native-web patch makes its ImageLoader match the native
 * event shape, preserving the original request's decoded dimensions instead
 * of forwarding a browser event whose target has already been cleared.
 */
export function didPreviewImageLoad(event: PreviewImageLoadEvent | undefined): boolean {
  return Boolean(event?.source && event.source.width > 0 && event.source.height > 0);
}

export function subscribePreviewImageFailures(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

export function getPreviewImageFailuresVersion(): number {
  return failureVersion;
}

/**
 * React hook to reactively track whether a specific preview URI has failed.
 */
export function useIsPreviewImageFailed(uri: string | null | undefined): boolean {
  return useSyncExternalStore(
    subscribePreviewImageFailures,
    () => isPreviewImageFailed(uri),
    () => isPreviewImageFailed(uri),
  );
}

/**
 * React hook to re-render a component when any preview image failure occurs.
 */
export function usePreviewImageFailuresVersion(): number {
  return useSyncExternalStore(
    subscribePreviewImageFailures,
    getPreviewImageFailuresVersion,
    getPreviewImageFailuresVersion,
  );
}

export function resetPreviewImageFailuresForTest(): void {
  for (const timer of failedImageUris.values()) {
    if (timer) clearTimeout(timer);
  }
  failedImageUris.clear();
  listeners.clear();
  failureVersion = 0;
}
