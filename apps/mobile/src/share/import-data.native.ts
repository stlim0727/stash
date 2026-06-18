/**
 * Native side of "import my data": open the system document picker, then read
 * the chosen file's text with expo-file-system. The web counterpart
 * (import-data.ts) uses a browser file input instead. Parsing is done by the
 * caller via src/domain/import.
 */

import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';

import type { ImportPickResult } from '@/share/import-data';

export type { ImportPickResult } from '@/share/import-data';

// MIME types per kind. 'text/plain' is included because some providers hand
// back .json/.html files with a generic text type, and being permissive here is
// safer than hiding the user's file behind a too-strict filter.
const PICKER_TYPES: Record<'json' | 'html', string[]> = {
  json: ['application/json', 'text/plain'],
  html: ['text/html', 'text/plain'],
};

export async function pickImportFile(kind: 'json' | 'html'): Promise<ImportPickResult | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: PICKER_TYPES[kind],
    // Copy into the cache dir so the URI is a stable local file we can read.
    copyToCacheDirectory: true,
    multiple: false,
  });

  const asset = result.canceled ? undefined : result.assets?.[0];
  if (!asset) {
    return null;
  }

  const text = await new File(asset.uri).text();
  return { name: asset.name ?? 'import', text };
}
