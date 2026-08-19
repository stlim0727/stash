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

/**
 * Must match the `bookmark-images` Storage bucket's `file_size_limit` (see
 * `supabase/migrations/20260819071500_bookmark_images_storage_bucket.sql`).
 * Checked client-side before an upload attempt, the same way `isUrlTooLong`
 * (domain/urls.ts) stops a doomed create before it's ever sent — without
 * this, an oversized local capture (still saved and rendered fine locally;
 * capture is sacred and never gated on this) would queue for upload and
 * fail against the bucket's own limit on every retry, forever.
 */
export const MAX_UPLOAD_IMAGE_BYTES = 15 * 1024 * 1024;

/**
 * The reverse of `MIME_TO_EXT`, for recovering a MIME type from a durable
 * local file's extension (the local copy's name is the only thing the
 * upload step has to go on — see `localImageFileName`). Where two MIME types
 * share an extension (`image/jpeg`/`image/jpg` both store as `.jpg`), the
 * canonical `image/jpeg` wins for the upload's Content-Type header — the
 * choice never affects local rendering, only what gets recorded server-side.
 */
const EXT_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};

/**
 * LAST-RESORT fallback MIME type, used only for a row captured before
 * `Bookmark.local_image_mime_type` existed (see domain/types.ts) — every
 * current capture records the OS share sheet's real MIME type at capture
 * time and uploads under that, never this guess. For an old row with no
 * recorded type, `mimeTypeForImageUri` below can only recover a MIME from
 * the local file's own extension; for an unmapped format (e.g. `image/jxl`,
 * which still passes `isImageMime` and gets captured under its own
 * extension via the filename fallback in `extensionForImage`) that lookup
 * fails and lands here. This is a deliberately narrow, honestly-labeled
 * trade-off for that legacy-only case specifically: guessing an allowlisted
 * type risks mislabeling the Content-Type for a format that turns out not
 * to actually be JPEG, but the alternative (a non-image type like
 * `application/octet-stream`) would have Storage permanently reject the
 * upload on every retry forever, for an image that already captured and
 * renders locally just fine. Matches `DEFAULT_IMAGE_EXT`'s existing "assume
 * the most common format when unsure" convention in this same file.
 */
const DEFAULT_UPLOAD_MIME = 'image/jpeg';

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

/** Lowercased extension (no dot) from a local file URI, or '' when there is none. */
function extensionFromUri(uri: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(uri.trim());
  return match ? match[1].toLowerCase() : '';
}

/**
 * Best-effort MIME type for a durable local image file, recovered from its
 * extension (`localImageFileName` always names the file `<id>.<ext>` using
 * `extensionForImage`, so this is the exact reverse lookup). This is a
 * FALLBACK ONLY, for a row with no recorded `local_image_mime_type` (a
 * capture from before that field existed) — every current capture records
 * the OS share sheet's real MIME type directly and should use that instead
 * of calling this at all (see the upload call site in store/bookmarks.tsx).
 */
export function mimeTypeForImageUri(uri: string): string {
  return EXT_TO_MIME[extensionFromUri(uri)] ?? DEFAULT_UPLOAD_MIME;
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
