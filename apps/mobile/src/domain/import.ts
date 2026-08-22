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

import type { ContentType, EnrichmentStatus, SuggestedTag } from '@/domain/types';

/**
 * Generated page metadata carried by a Stash JSON backup's bookmark snapshot.
 * Only ever populated for `source: 'stash-backup'` — a restore can use this to
 * skip re-fetching metadata the export already had (#671); other formats have
 * no equivalent snapshot to preserve.
 */
export interface ImportedMetadata {
  description: string | null;
  /**
   * Same value as `description`, but untrimmed — for restoring a URL-less
   * text/Markdown-memo bookmark, whose raw body lives here and can carry
   * meaningful leading/trailing whitespace (e.g. an indented code block).
   * `description` above is trimmed like every other generated-metadata
   * string field, which is correct for those but would silently rewrite a
   * memo's source on restore; this field preserves it losslessly.
   */
  raw_description: string | null;
  preview_image_url: string | null;
  favicon_url: string | null;
  site_name: string | null;
  canonical_url: string | null;
  content_type: ContentType;
}

/**
 * The bookmark's latest AI enrichment, carried by a Stash JSON backup when the
 * export included one (`toJsonBackup`'s `enrichment` field). Lets a restore
 * bring enrichment back losslessly instead of paying to regenerate it (#671).
 */
export interface ImportedEnrichment {
  summary: string | null;
  topics: string[];
  suggested_tags: SuggestedTag[];
  status: EnrichmentStatus;
  model: string | null;
  confidence: number | null;
}

/** A single re-ingestable item, normalized across both source formats. */
export interface ImportItem {
  /** Parser provenance. Present for every item produced by parseImport. */
  source?: 'stash-backup' | 'netscape-html' | 'pocket-csv';
  url: string | null;
  title: string | null;
  notes: string | null;
  /** Tag names parsed from the source (deduped, order preserved). */
  tags: string[];
  /** Folder (HTML) or collection name (JSON), when the source recorded one. */
  collection: string | null;
  /** Generated metadata preserved from a Stash JSON backup, when present. */
  metadata?: ImportedMetadata;
  /** AI enrichment snapshot preserved from a Stash JSON backup, when present. */
  enrichment?: ImportedEnrichment;
  /** Original creation timestamp (ISO string), when preserved from source. */
  createdAt?: string | null;
  /**
   * Stable source identities from a Stash JSON backup — present only for
   * `source: 'stash-backup'`. URL-less rows have no canonical url_hash, so
   * these are import-dedupe keys. A newly restored row must still mint its own
   * primary key because the backup id can belong to another cloud account.
   */
  backupId?: string | null;
  backupClientId?: string | null;
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

const CONTENT_TYPES: readonly ContentType[] = ['url', 'article', 'image', 'video', 'text', 'unknown'];
function cleanContentType(value: unknown): ContentType {
  return typeof value === 'string' && (CONTENT_TYPES as readonly string[]).includes(value)
    ? (value as ContentType)
    : 'url';
}

const ENRICHMENT_STATUSES: readonly EnrichmentStatus[] = ['pending', 'complete', 'failed', 'stale'];
function cleanEnrichmentStatus(value: unknown): EnrichmentStatus {
  return typeof value === 'string' && (ENRICHMENT_STATUSES as readonly string[]).includes(value)
    ? (value as EnrichmentStatus)
    : 'pending';
}

/** Generated metadata fields off a backup bookmark entry, or undefined if none were present. */
function parseImportedMetadata(entry: Record<string, unknown>): ImportedMetadata | undefined {
  const metadata: ImportedMetadata = {
    description: cleanString(entry.description),
    raw_description:
      typeof entry.description === 'string' && entry.description.trim().length > 0
        ? entry.description
        : null,
    preview_image_url: cleanString(entry.preview_image_url),
    favicon_url: cleanString(entry.favicon_url),
    site_name: cleanString(entry.site_name),
    canonical_url: cleanString(entry.canonical_url),
    content_type: cleanContentType(entry.content_type),
  };
  const hasSignal =
    metadata.description !== null ||
    metadata.preview_image_url !== null ||
    metadata.favicon_url !== null ||
    metadata.site_name !== null ||
    metadata.canonical_url !== null ||
    entry.content_type === 'text';
  return hasSignal ? metadata : undefined;
}

/** The `enrichment` snapshot off a backup bookmark entry, or undefined if absent/malformed. */
function parseImportedEnrichment(raw: unknown): ImportedEnrichment | undefined {
  if (raw === null || typeof raw !== 'object') {
    return undefined;
  }
  const entry = raw as Record<string, unknown>;
  const suggestedTags = Array.isArray(entry.suggested_tags)
    ? entry.suggested_tags
        .map((tag): SuggestedTag | null => {
          const name = cleanString((tag as { name?: unknown })?.name);
          const confidence = (tag as { confidence?: unknown })?.confidence;
          return name && typeof confidence === 'number' ? { name, confidence } : null;
        })
        .filter((tag): tag is SuggestedTag => tag !== null)
    : [];
  return {
    summary: cleanString(entry.summary),
    topics: Array.isArray(entry.topics)
      ? entry.topics.filter((topic): topic is string => typeof topic === 'string')
      : [],
    suggested_tags: suggestedTags,
    status: cleanEnrichmentStatus(entry.status),
    model: cleanString(entry.model),
    confidence: typeof entry.confidence === 'number' ? entry.confidence : null,
  };
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
    throw new ImportError("This doesn't look like a Keepory backup — no bookmarks were found.");
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
    const rawCreatedAt = cleanString(entry.created_at);
    return {
      source: 'stash-backup',
      url: cleanString(entry.url),
      title: cleanString(entry.title),
      // `notes` is the user-authored field; `description` is generated page
      // metadata. Never restore a generated description as user notes — that
      // would corrupt the user-vs-generated separation and then sync the
      // generated text as if the user had typed it.
      notes: cleanString(entry.notes),
      tags,
      collection: cleanString(entry.collection_name),
      metadata: parseImportedMetadata(entry),
      enrichment: parseImportedEnrichment(entry.enrichment),
      createdAt:
        rawCreatedAt && !isNaN(new Date(rawCreatedAt).getTime())
          ? new Date(rawCreatedAt).toISOString()
          : null,
      backupId: cleanString(entry.id),
      backupClientId: cleanString(entry.client_id),
    };
  });
}

const HREF_ATTR = /href\s*=\s*["']([^"']*)["']/i;
const TAGS_ATTR = /tags\s*=\s*["']([^"']*)["']/i;
const ADD_DATE_ATTR = /add_date\s*=\s*["']([^"']*)["']/i;
// Anchor entries, folder headings, and list closes, matched in document order.
const TOKEN =
  /<a\s+([^>]*)>([\s\S]*?)<\/a>|<h3[^>]*>([\s\S]*?)<\/h3>|<\/dl>/gi;

function parseAddDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const sec = parseInt(raw, 10);
  if (isNaN(sec) || sec <= 0) return null;
  try {
    return new Date(sec * 1000).toISOString();
  } catch {
    return null;
  }
}

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
    const addDateRaw = anchorAttrs?.match(ADD_DATE_ATTR)?.[1];
    items.push({
      source: 'netscape-html',
      url: unescapeHtml(href).trim() || null,
      title: cleanString(unescapeHtml(anchorText ?? '')),
      notes: null,
      tags: tagsRaw ? normalizeTags(unescapeHtml(tagsRaw).split(',')) : [],
      collection: folders.length > 0 ? (folders[folders.length - 1] ?? null) : null,
      createdAt: parseAddDate(addDateRaw),
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
 * with `|`). `time_added`/`status` are parsed: archived and unread items are
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
  const timeAddedIdx = header.indexOf('time_added');

  const items: ImportItem[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const url = cleanString(row[urlIdx]);
    if (!url) {
      continue;
    }
    const rawTags = tagsIdx >= 0 ? (row[tagsIdx] ?? '') : '';
    const rawTimeAdded = timeAddedIdx >= 0 ? cleanString(row[timeAddedIdx]) : null;
    items.push({
      source: 'pocket-csv',
      url,
      title: titleIdx >= 0 ? cleanString(row[titleIdx]) : null,
      notes: null,
      // Pocket delimits tags with a pipe within the single CSV field.
      tags: rawTags ? normalizeTags(rawTags.split('|')) : [],
      collection: null,
      createdAt: parseAddDate(rawTimeAdded ?? undefined),
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
