/**
 * Data export — turn the user's library into portable files they can keep or
 * import elsewhere, so their bookmarks are never trapped in Stash.
 *
 * Two formats are produced, both from these pure helpers (no platform APIs, so
 * they are unit-testable and reused by the web download and native share
 * delivery shims in src/share/export-data):
 *
 *  - Netscape bookmark HTML — the universal format every browser and most
 *    bookmark apps (Raindrop, Pocket, …) can import. Collections become
 *    folders; tags ride along in the `TAGS` attribute.
 *  - JSON backup — full fidelity (notes, tags with source/confidence, the
 *    latest AI enrichment, timestamps) for a faithful re-import into Stash.
 */

import type { AIEnrichment, Bookmark, Collection, Tag } from '@/domain/types';

/** Bumped when the JSON backup shape changes in a breaking way. */
export const EXPORT_SCHEMA_VERSION = 1;

export interface ExportInput {
  bookmarks: Bookmark[];
  /** Tags applied to each bookmark, keyed by bookmark id. */
  tagsByBookmark: Record<string, Tag[]>;
  /** The user's collections — folder names in HTML, manifest in JSON. */
  collections: Collection[];
  /** Latest AI enrichment per bookmark, keyed by bookmark id. */
  enrichmentByBookmark?: Record<string, AIEnrichment | undefined>;
  /** ISO timestamp stamped into the export. Defaults to now. */
  exportedAt?: string;
  /** App version recorded in the JSON manifest, when known. */
  appVersion?: string;
}

interface JsonBackupBookmark extends Bookmark {
  collection_name: string | null;
  tags: Array<Pick<Tag, 'name' | 'slug' | 'source'>>;
  enrichment: Pick<
    AIEnrichment,
    'summary' | 'topics' | 'suggested_tags' | 'status' | 'model' | 'confidence'
  > | null;
}

export interface JsonBackup {
  app: 'stash';
  schema_version: number;
  exported_at: string;
  app_version: string | null;
  counts: { bookmarks: number; collections: number };
  collections: Collection[];
  bookmarks: JsonBackupBookmark[];
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Netscape ADD_DATE / LAST_MODIFIED are Unix seconds; '' when unparseable. */
function toUnixSeconds(iso: string | null | undefined): string {
  if (!iso) {
    return '';
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? '' : String(Math.floor(ms / 1000));
}

function bookmarkTitle(bookmark: Bookmark): string {
  return bookmark.title?.trim() || bookmark.url || bookmark.description?.trim() || 'Untitled';
}

/** A short, file-system-friendly date suffix (YYYY-MM-DD) for filenames. */
export function exportDateStamp(exportedAt = new Date().toISOString()): string {
  return (exportedAt.split('T')[0] ?? exportedAt).slice(0, 10);
}

export function exportFilename(kind: 'html' | 'json', exportedAt?: string): string {
  const stamp = exportDateStamp(exportedAt);
  return kind === 'html' ? `stash-bookmarks-${stamp}.html` : `stash-backup-${stamp}.json`;
}

export function buildJsonBackup(input: ExportInput): JsonBackup {
  const exportedAt = input.exportedAt ?? new Date().toISOString();
  const collectionName = new Map(input.collections.map((c) => [c.id, c.name]));

  const bookmarks: JsonBackupBookmark[] = input.bookmarks.map((bookmark) => {
    const tags = (input.tagsByBookmark[bookmark.id] ?? []).map((tag) => ({
      name: tag.name,
      slug: tag.slug,
      source: tag.source,
    }));
    const enrichment = input.enrichmentByBookmark?.[bookmark.id];
    return {
      ...bookmark,
      collection_name: bookmark.collection_id
        ? (collectionName.get(bookmark.collection_id) ?? null)
        : null,
      tags,
      enrichment: enrichment
        ? {
            summary: enrichment.summary,
            topics: enrichment.topics,
            suggested_tags: enrichment.suggested_tags,
            status: enrichment.status,
            model: enrichment.model,
            confidence: enrichment.confidence,
          }
        : null,
    };
  });

  return {
    app: 'stash',
    schema_version: EXPORT_SCHEMA_VERSION,
    exported_at: exportedAt,
    app_version: input.appVersion ?? null,
    counts: { bookmarks: bookmarks.length, collections: input.collections.length },
    collections: input.collections,
    bookmarks,
  };
}

export function toJsonBackup(input: ExportInput): string {
  return `${JSON.stringify(buildJsonBackup(input), null, 2)}\n`;
}

/** One `<DT><A>` entry (plus an optional `<DD>` note), indented for the folder. */
function htmlEntry(input: ExportInput, bookmark: Bookmark, indent: string): string {
  const href = escapeHtml(bookmark.url ?? '');
  const addDate = toUnixSeconds(bookmark.created_at);
  const lastModified = toUnixSeconds(bookmark.updated_at);
  const tagNames = (input.tagsByBookmark[bookmark.id] ?? []).map((tag) => tag.name);

  const attrs = [`HREF="${href}"`];
  if (addDate) {
    attrs.push(`ADD_DATE="${addDate}"`);
  }
  if (lastModified) {
    attrs.push(`LAST_MODIFIED="${lastModified}"`);
  }
  if (tagNames.length > 0) {
    attrs.push(`TAGS="${escapeHtml(tagNames.join(','))}"`);
  }

  let line = `${indent}<DT><A ${attrs.join(' ')}>${escapeHtml(bookmarkTitle(bookmark))}</A>\n`;
  const note = bookmark.notes?.trim() || bookmark.description?.trim();
  if (note) {
    line += `${indent}<DD>${escapeHtml(note)}\n`;
  }
  return line;
}

/**
 * Render the library as a Netscape bookmark file. Bookmarks without a URL
 * (text-only saves) are omitted here — they have no `HREF` to import — but are
 * preserved in the JSON backup. Collections are emitted as folders; everything
 * uncategorized sits at the top level.
 */
export function toNetscapeHtml(input: ExportInput): string {
  const withUrl = input.bookmarks.filter((bookmark) => !!bookmark.url);

  const byCollection = new Map<string | null, Bookmark[]>();
  for (const bookmark of withUrl) {
    const key = bookmark.collection_id ?? null;
    const list = byCollection.get(key);
    if (list) {
      list.push(bookmark);
    } else {
      byCollection.set(key, [bookmark]);
    }
  }

  const lines: string[] = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file. It will be read and overwritten.',
    '     Exported from Stash. -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Stash Bookmarks</H1>',
    '<DL><p>',
  ];

  // Uncategorized bookmarks first, at the top level.
  for (const bookmark of byCollection.get(null) ?? []) {
    lines.push(htmlEntry(input, bookmark, '    ').trimEnd());
  }

  // Then one folder per collection that actually holds bookmarks.
  for (const collection of input.collections) {
    const items = byCollection.get(collection.id);
    if (!items || items.length === 0) {
      continue;
    }
    const addDate = toUnixSeconds(collection.created_at);
    const folderAttrs = addDate ? ` ADD_DATE="${addDate}"` : '';
    lines.push(`    <DT><H3${folderAttrs}>${escapeHtml(collection.name)}</H3>`);
    lines.push('    <DL><p>');
    for (const bookmark of items) {
      lines.push(htmlEntry(input, bookmark, '        ').trimEnd());
    }
    lines.push('    </DL><p>');
  }

  lines.push('</DL><p>');
  return `${lines.join('\n')}\n`;
}
