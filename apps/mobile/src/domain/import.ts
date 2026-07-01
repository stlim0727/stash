/**
 * Data import — the mirror of src/domain/export. Pure parsers that turn a
 * previously exported file back into a normalized list of items the store can
 * re-ingest, so a user can move into Stash (or restore a backup) as easily as
 * they can leave it.
 *
 * Three sources are understood, all parsed by these platform-free helpers (so
 * they are unit-testable and reused by the web/native import shims in
 * src/share/import-data):
 *
 *  - Stash JSON backup — the file produced by `toJsonBackup`.
 *  - Netscape bookmark HTML — the universal format exported by every browser
 *    and most bookmark apps (and by Stash's own HTML export). Folders map to a
 *    collection name; the `TAGS` attribute maps to tags.
 *  - Pocket CSV — the export from getpocket.com, so the wave of users leaving
 *    Pocket can move into Stash directly. `tags` (pipe-separated) map to tags.
 */

/** A single re-ingestable item, normalized across both source formats. */
export interface ImportItem {
  url: string | null;
  title: string | null;
  notes: string | null;
  /** Tag names parsed from the source (deduped, order preserved). */
  tags: string[];
  /** Folder (HTML) or collection name (JSON), when the source recorded one. */
  collection: string | null;
}

/** Thrown when a file can't be understood as a supported import format. */
export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

/** Reverse of export's `escapeHtml`, plus the common numeric/`&#39;` entities. */
function unescapeHtml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    // &amp; last so an escaped entity like "&amp;lt;" is not double-decoded.
    .replaceAll('&amp;', '&');
}

/** Trim to a non-empty string, or null. */
function cleanString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Split a tag list, drop blanks, and dedupe (case-sensitively, order kept). */
function normalizeTags(raw: string[]): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const name of raw) {
    const trimmed = name.trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      tags.push(trimmed);
    }
  }
  return tags;
}

/**
 * Parse a Stash JSON backup (the output of `toJsonBackup`). Lenient about the
 * exact shape — any object with a `bookmarks` array is accepted, and per-item
 * fields default sensibly — but a non-JSON or structurally wrong file throws an
 * ImportError so the UI can explain what went wrong.
 */
export function parseJsonBackup(text: string): ImportItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ImportError("This file isn't valid JSON.");
  }

  const bookmarks = (parsed as { bookmarks?: unknown })?.bookmarks;
  if (!Array.isArray(bookmarks)) {
    throw new ImportError("This doesn't look like a Stash backup — no bookmarks were found.");
  }

  return bookmarks.map((raw): ImportItem => {
    const entry = (raw ?? {}) as Record<string, unknown>;
    // Tags may be plain strings or the backup's { name, slug, source } objects.
    const tags = Array.isArray(entry.tags)
      ? normalizeTags(
          entry.tags
            .map((tag) =>
              typeof tag === 'string' ? tag : cleanString((tag as { name?: unknown })?.name) ?? '',
            )
            .filter((name) => name.length > 0),
        )
      : [];
    return {
      url: cleanString(entry.url),
      title: cleanString(entry.title),
      // `notes` is the user-authored field; `description` is generated page
      // metadata. Never restore a generated description as user notes — that
      // would corrupt the user-vs-generated separation and then sync the
      // generated text as if the user had typed it.
      notes: cleanString(entry.notes),
      tags,
      collection: cleanString(entry.collection_name),
    };
  });
}

const HREF_ATTR = /href\s*=\s*["']([^"']*)["']/i;
const TAGS_ATTR = /tags\s*=\s*["']([^"']*)["']/i;
// Anchor entries, folder headings, and list closes, matched in document order.
const TOKEN =
  /<a\s+([^>]*)>([\s\S]*?)<\/a>|<h3[^>]*>([\s\S]*?)<\/h3>|<\/dl>/gi;

/**
 * Parse a Netscape bookmark HTML file. Walks the document in order, tracking a
 * folder stack (`<H3>` opens a folder, `</DL>` closes one) so each link is
 * tagged with the collection it sits in. Links without an `HREF` are skipped;
 * `TAGS` becomes the item's tags. `<DD>` notes are not associated (browsers
 * rarely emit them and their placement is ambiguous), so notes stay null here.
 */
export function parseNetscapeHtml(text: string): ImportItem[] {
  const items: ImportItem[] = [];
  const folders: string[] = [];

  TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN.exec(text)) !== null) {
    const [whole, anchorAttrs, anchorText, folderName] = match;

    if (folderName !== undefined) {
      folders.push(unescapeHtml(folderName).trim());
      continue;
    }
    if (whole.toLowerCase() === '</dl>') {
      folders.pop();
      continue;
    }

    // Anchor: an HREF is required to be a re-ingestable bookmark.
    const href = anchorAttrs?.match(HREF_ATTR)?.[1];
    if (!href) {
      continue;
    }
    const tagsRaw = anchorAttrs?.match(TAGS_ATTR)?.[1];
    items.push({
      url: unescapeHtml(href).trim() || null,
      title: cleanString(unescapeHtml(anchorText ?? '')),
      notes: null,
      tags: tagsRaw ? normalizeTags(unescapeHtml(tagsRaw).split(',')) : [],
      collection: folders.length > 0 ? (folders[folders.length - 1] ?? null) : null,
    });
  }

  return items;
}

/**
 * Parse RFC 4180-ish CSV into rows of fields. Handles quoted fields (with commas
 * and newlines inside quotes), `""` escaped quotes, CRLF or LF line endings, and
 * a leading UTF-8 BOM. Blank lines are dropped.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  // Strip a leading UTF-8 BOM so the first header cell isn't "﻿title".
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    // Skip blank lines (a single empty field).
    if (!(row.length === 1 && row[0].trim() === '')) {
      rows.push(row);
    }
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      endField();
    } else if (c === '\n') {
      endRow();
    } else if (c !== '\r') {
      field += c;
    }
  }
  // Flush the trailing field/row when the file doesn't end with a newline.
  if (field.length > 0 || row.length > 0) {
    endRow();
  }
  return rows;
}

/**
 * Parse a Pocket CSV export (`getpocket.com/export`, the format the shutdown
 * data export produces). Columns are matched by header name so column order
 * doesn't matter: `url` (required), `title`, and `tags` (Pocket separates tags
 * with `|`). `time_added`/`status` are ignored — archived and unread items are
 * imported alike, as active bookmarks. Rows without a URL are skipped.
 */
export function parsePocketCsv(text: string): ImportItem[] {
  const rows = parseCsv(text);
  if (rows.length === 0) {
    throw new ImportError('This file is empty.');
  }

  const header = (rows[0] ?? []).map((cell) => cell.trim().toLowerCase());
  const urlIdx = header.indexOf('url');
  if (urlIdx === -1) {
    throw new ImportError("This doesn't look like a Pocket export — no 'url' column was found.");
  }
  const titleIdx = header.indexOf('title');
  const tagsIdx = header.indexOf('tags');

  const items: ImportItem[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const url = cleanString(row[urlIdx]);
    if (!url) {
      continue;
    }
    const rawTags = tagsIdx >= 0 ? (row[tagsIdx] ?? '') : '';
    items.push({
      url,
      title: titleIdx >= 0 ? cleanString(row[titleIdx]) : null,
      notes: null,
      // Pocket delimits tags with a pipe within the single CSV field.
      tags: rawTags ? normalizeTags(rawTags.split('|')) : [],
      collection: null,
    });
  }
  return items;
}

/** Pick the right parser for a file kind. */
export function parseImport(kind: 'json' | 'html' | 'csv', text: string): ImportItem[] {
  if (kind === 'json') {
    return parseJsonBackup(text);
  }
  return kind === 'csv' ? parsePocketCsv(text) : parseNetscapeHtml(text);
}
