/**
 * Web side of "import my data": open the browser file picker, read the chosen
 * file as text, and hand it back. The native counterpart (import-data.native.ts)
 * uses the system document picker + expo-file-system instead; Metro resolves the
 * right one per platform. Parsing is done by the caller via src/domain/import.
 */

export interface ImportPickResult {
  /** The picked file's name, for display in the result message. */
  name: string;
  /** The file's full text contents. */
  text: string;
}

/** File-type hints per import kind, so the picker filters to sensible files. */
const ACCEPT: Record<'json' | 'html' | 'csv', string> = {
  json: '.json,application/json',
  html: '.html,.htm,text/html',
  csv: '.csv,text/csv',
};

/** Returns the picked file's text, or null if the user cancelled. */
export async function pickImportFile(
  kind: 'json' | 'html' | 'csv',
): Promise<ImportPickResult | null> {
  if (typeof document === 'undefined') {
    throw new Error('Importing is not available in this environment.');
  }

  return new Promise<ImportPickResult | null>((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = ACCEPT[kind];
    input.style.display = 'none';

    const cleanup = () => input.remove();

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        cleanup();
        resolve(null);
        return;
      }
      file
        .text()
        .then((text) => resolve({ name: file.name, text }))
        .catch(reject)
        .finally(cleanup);
    });
    // Modern browsers fire 'cancel' when the picker is dismissed with no choice.
    input.addEventListener('cancel', () => {
      cleanup();
      resolve(null);
    });

    document.body.appendChild(input);
    input.click();
  });
}
