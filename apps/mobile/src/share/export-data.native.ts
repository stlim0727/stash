/**
 * Native delivery for a data export: write the generated file into the app's
 * cache directory, then open the system share sheet so the user can save it to
 * Files/Drive, AirDrop it, or send it anywhere. The web counterpart
 * (export-data.ts) triggers a browser download instead.
 */

import { File, Paths } from 'expo-file-system';
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

  await Share.share(
    {
      url: target.uri,
      title: file.filename,
    },
    { subject: file.filename },
  );
}
