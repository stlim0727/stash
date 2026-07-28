/**
 * Web delivery for a data export: trigger a browser download of the generated
 * file. The native counterpart (export-data.native.ts) writes a file and opens
 * the share sheet instead; Metro resolves the right one per platform.
 */

export interface ExportFile {
  filename: string;
  /** MIME type, e.g. 'application/json' or 'text/html'. */
  mimeType: string;
  contents: string;
}

export async function deliverExport(file: ExportFile): Promise<void> {
  if (typeof document === 'undefined' || typeof URL?.createObjectURL !== 'function') {
    throw new Error('Exporting is not available in this environment.');
  }

  const blob = new Blob([file.contents], { type: file.mimeType });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Web counterpart of the native save-to-device path (never surfaced in the web
 * UI — a browser download already saves directly, so it just reuses the
 * download). Exists so settings.tsx can import it from either platform module.
 */
export async function saveExportToDevice(file: ExportFile): Promise<boolean> {
  await deliverExport(file);
  return true;
}
