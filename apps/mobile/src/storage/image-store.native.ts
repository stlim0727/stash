/**
 * Native captured-image store: copy a shared image out of its temporary share
 * location into the app's document directory, where it survives until the
 * bookmark is deleted. The OS may reclaim the share-sheet's temp file at any
 * time, so a durable copy is what keeps an image bookmark from going blank.
 *
 * Cloud upload of the binary is deferred to 0.3.x; for now the returned URI is
 * stored on the bookmark as `local_image_uri` and rendered directly.
 */

import { Directory, File, Paths } from 'expo-file-system';

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
