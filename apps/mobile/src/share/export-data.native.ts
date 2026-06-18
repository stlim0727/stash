/**
 * Native delivery for a data export: write the generated file into the app's
 * cache directory, then open the system share sheet so the user can save it to
 * Files/Drive, AirDrop it, or send it anywhere. The web counterpart
 * (export-data.ts) triggers a browser download instead.
 *
 * Uses expo-sharing, which forwards a content URI + MIME type to the platform
 * share intent — unlike React Native's `Share`, whose `url` is ignored on
 * Android, so the generated file would not be attached there. `Share` remains
 * only as a last-resort fallback when sharing is unavailable.
 */

import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Share } from 'react-native';

import type { ExportFile } from '@/share/export-data';

export type { ExportFile } from '@/share/export-data';

export async function deliverExport(file: ExportFile): Promise<void> {
  // Cache dir: a transient working copy is fine since the share sheet hands the
  // user a durable destination. The OS may reclaim it later.
  const target = new File(Paths.cache, file.filename);
  // Overwrite any stale copy from a previous export of the same day.
  if (target.exists) {
    target.delete();
  }
  target.create();
  target.write(file.contents);

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(target.uri, {
      mimeType: file.mimeType,
      dialogTitle: file.filename,
      UTI: file.mimeType === 'application/json' ? 'public.json' : 'public.html',
    });
    return;
  }

  // Fallback: at least surface the file URI on platforms where the sharing
  // module isn't available (the file is still written to disk above).
  await Share.share({ url: target.uri, title: file.filename }, { subject: file.filename });
}
