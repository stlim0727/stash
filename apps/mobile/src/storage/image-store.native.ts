/**
 * Native captured-image store: copy a shared image out of its temporary share
 * location into the app's document directory, where it survives until the
 * bookmark is deleted. The OS may reclaim the share-sheet's temp file at any
 * time, so a durable copy is what keeps an image bookmark from going blank.
 *
 * The durable local copy is also what `uploadImageFile` below reads from for
 * cloud sync — the binary is uploaded straight off disk (native's `File.upload`
 * streams it directly), never round-tripped through JS memory.
 */

import { Directory, File, Paths, UploadType } from 'expo-file-system';

/** Subdirectory under the document directory that holds captured images. */
const IMAGE_DIR = 'stash-images';

/**
 * Copy `sourceUri` into `documentDirectory/stash-images/<fileName>` and return
 * the durable URI. Overwrites any existing file with the same name (the name is
 * derived from the bookmark id, so a re-copy is the same image). Rejects if the
 * copy fails so the caller can record the capture as not durably persisted.
 */
export async function copyImageToLibrary(sourceUri: string, fileName: string): Promise<string> {
  const dir = new Directory(Paths.document, IMAGE_DIR);
  if (!dir.exists) {
    dir.create({ intermediates: true, idempotent: true });
  }
  const destination = new File(dir, fileName);
  if (destination.exists) {
    destination.delete();
  }
  await new File(sourceUri).copy(destination);
  return destination.uri;
}

/**
 * The durable local image file's size in bytes (0 if it no longer exists),
 * for the pre-upload size check in store/bookmarks.tsx — checked BEFORE
 * `uploadImageFile` below so an oversized file never even attempts (and
 * fails forever against) the bucket's own `file_size_limit`.
 */
export function localFileSizeBytes(localUri: string): number {
  return new File(localUri).size;
}

/**
 * Uploads a durable local image file (a bookmark's `local_image_uri`) to
 * `uploadUrl` (a Supabase Storage object endpoint) with the given headers —
 * used by create-sync to push an image-only bookmark's binary to the cloud
 * before creating its row (see `api/bookmarks.ts`'s `imageUploadTarget`).
 * Rejects on a network failure OR a non-2xx response, so the caller (a
 * queued sync entry) always sees a real failure and retries with the usual
 * backoff rather than silently treating a rejected upload as done.
 */
export async function uploadImageFile(
  localUri: string,
  uploadUrl: string,
  headers: Record<string, string>,
): Promise<void> {
  const result = await new File(localUri).upload(uploadUrl, {
    httpMethod: 'POST',
    uploadType: UploadType.BINARY_CONTENT,
    headers,
  });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Image upload failed with HTTP ${result.status}: ${result.body.slice(0, 200)}`);
  }
}
