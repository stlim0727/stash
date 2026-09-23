import { useSyncExternalStore } from 'react';

const failedImageUris = new Set<string>();
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
  failedImageUris.add(uri);
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
  failedImageUris.delete(uri);
  notify();
}

type PreviewImageLoadEvent = {
  source?: { width: number; height: number };
};

type BrowserImage = {
  naturalWidth: number;
  naturalHeight: number;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  src: string;
};

/**
 * Check if an image decoded with non-zero dimensions.
 *
 * react-native-web forwards a browser load event without `source`, so its
 * dimensions must be verified separately with `verifyWebPreviewImage`.
 */
export function didPreviewImageLoad(event: PreviewImageLoadEvent | undefined): boolean {
  return Boolean(event?.source && event.source.width > 0 && event.source.height > 0);
}

/**
 * Verify a react-native-web image with a browser Image instance whose decoded
 * dimensions remain available after the load callback. The event forwarded by
 * react-native-web has a null target by then, so its dimensions cannot be read
 * directly. The timeout also catches the observed aborted-load/0x0 case where
 * neither a usable load nor an error is reported.
 */
export function verifyWebPreviewImage(
  uri: string,
  createImage: () => BrowserImage = () => new globalThis.Image() as unknown as BrowserImage,
  timeoutMs = 10_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const image = createImage();
    let settled = false;
    const finish = (loaded: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      image.onload = null;
      image.onerror = null;
      resolve(loaded);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    image.onload = () => finish(image.naturalWidth > 0 && image.naturalHeight > 0);
    image.onerror = () => finish(false);
    image.src = uri;
  });
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
  failedImageUris.clear();
  listeners.clear();
  failureVersion = 0;
}
