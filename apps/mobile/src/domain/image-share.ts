/**
 * Pure helpers for capturing an image shared into the app (M-image-share).
 *
 * The share sheet hands us files with a temporary on-device `path`, a
 * `mimeType`, and a `fileName`. This module decides which shared file is an
 * image, what extension to store it under, and a sensible human title from the
 * filename. Kept dependency-free (no expo / native modules) so it runs in the
 * Node test lane; the durable copy itself lives in `storage/image-store`.
 */

/** Common image MIME types → the extension we store the local copy under. */
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
};

/** Fallback extension when neither the MIME type nor the filename resolves one. */
const DEFAULT_IMAGE_EXT = 'jpg';

/** True when `mime` names an image type (`image/...`). */
export function isImageMime(mime: string | null | undefined): boolean {
  return typeof mime === 'string' && mime.trim().toLowerCase().startsWith('image/');
}

/** A shared file as it reaches us from the OS share sheet (subset we use). */
export interface ShareFileLike {
  path?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
}

/** A normalized image picked out of a share payload, ready to capture. */
export interface SharedImage {
  /** Temporary on-device URI of the shared file (must be copied to be durable). */
  uri: string;
  mimeType: string;
  /** Original filename, when the OS provided one. */
  fileName: string | null;
}

/**
 * The first image file in a share payload, or null when there is none. We
 * capture a single image (multi-image batches are out of scope), so the first
 * image wins.
 */
export function pickSharedImage(
  files: ReadonlyArray<ShareFileLike> | null | undefined,
): SharedImage | null {
  if (!files) {
    return null;
  }
  for (const file of files) {
    if (file && typeof file.path === 'string' && file.path && isImageMime(file.mimeType)) {
      return {
        uri: file.path,
        mimeType: (file.mimeType as string).trim().toLowerCase(),
        fileName: file.fileName?.trim() ? file.fileName.trim() : null,
      };
    }
  }
  return null;
}

/** Lowercased extension from a filename (no dot), or null when there is none. */
function extensionFromFileName(fileName: string | null | undefined): string | null {
  if (!fileName) {
    return null;
  }
  const match = /\.([a-z0-9]+)$/i.exec(fileName.trim());
  return match ? match[1].toLowerCase() : null;
}

/**
 * The file extension to store a shared image under: the MIME mapping first
 * (most reliable), then the original filename's extension, then a safe default.
 */
export function extensionForImage(image: Pick<SharedImage, 'mimeType' | 'fileName'>): string {
  return (
    MIME_TO_EXT[image.mimeType?.trim().toLowerCase()] ??
    extensionFromFileName(image.fileName) ??
    DEFAULT_IMAGE_EXT
  );
}

/** Durable local filename for a captured image: `<bookmarkId>.<ext>`. */
export function localImageFileName(bookmarkId: string, image: Pick<SharedImage, 'mimeType' | 'fileName'>): string {
  return `${bookmarkId}.${extensionForImage(image)}`;
}

/**
 * A readable title derived from a shared image's filename: the base name with
 * the extension dropped and separators tidied to spaces. Returns null when the
 * filename is missing or yields nothing usable, so the caller can fall back to
 * the localized "Untitled".
 */
export function imageTitleFromFileName(fileName: string | null | undefined): string | null {
  if (!fileName) {
    return null;
  }
  // Drop any leading directory components the OS may include, then the extension.
  const base = fileName.trim().split(/[\\/]/).pop() ?? '';
  const withoutExt = base.replace(/\.[a-z0-9]+$/i, '');
  const cleaned = withoutExt.replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || null;
}
