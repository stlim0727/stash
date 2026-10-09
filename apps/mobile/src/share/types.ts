/**
 * Platform-neutral data transport types for import and export operations.
 * Shared by both native and web platform delivery implementations.
 */

export interface ExportFile {
  filename: string;
  /** MIME type, e.g. 'application/json' or 'text/html'. */
  mimeType: string;
  contents: string;
}

export interface ImportPickResult {
  name: string;
  text: string;
}
