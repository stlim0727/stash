import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AIEnrichment, Bookmark, Collection, Tag } from './types.ts';
import {
  CSV_COLUMNS,
  EXPORT_SCHEMA_VERSION,
  buildJsonBackup,
  exportFilename,
  toCsv,
  toJsonBackup,
  toNetscapeHtml,
  type ExportInput,
} from './export.ts';

function bookmark(overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    id: 'b1',
    user_id: 'u1',
    url: 'https://example.com/article',
    canonical_url: null,
    url_hash: 'https://example.com/article',
    title: 'Example Article',
    description: null,
    notes: null,
    source_app: null,
    content_type: 'url',
    preview_image_url: null,
    favicon_url: null,
    site_name: null,
    collection_id: null,
    is_archived: false,
    created_at: '2026-01-02T03:04:05.000Z',
    updated_at: '2026-01-03T03:04:05.000Z',
    last_saved_at: '2026-01-02T03:04:05.000Z',
    metadata_status: 'complete',
    sync_status: 'synced',
    ...overrides,
  };
}

function tag(name: string, overrides: Partial<Tag> = {}): Tag {
  return {
    id: `tag-${name}`,
    user_id: 'u1',
    name,
    slug: name.toLowerCase(),
    source: 'user',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function collection(id: string, name: string): Collection {
  return {
    id,
    user_id: 'u1',
    name,
    description: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

const baseInput = (overrides: Partial<ExportInput> = {}): ExportInput => ({
  bookmarks: [bookmark()],
  tagsByBookmark: {},
  collections: [],
  exportedAt: '2026-06-18T12:00:00.000Z',
  ...overrides,
});

test('exportFilename uses a date-stamped, format-specific name', () => {
  assert.equal(exportFilename('html', '2026-06-18T12:00:00.000Z'), 'stash-bookmarks-2026-06-18.html');
  assert.equal(exportFilename('json', '2026-06-18T12:00:00.000Z'), 'stash-backup-2026-06-18.json');
  assert.equal(exportFilename('csv', '2026-06-18T12:00:00.000Z'), 'stash-bookmarks-2026-06-18.csv');
});

test('buildJsonBackup captures tags, enrichment, and a collection name', () => {
  const enrichment: AIEnrichment = {
    id: 'e1',
    bookmark_id: 'b1',
    user_id: 'u1',
    summary: 'A short summary.',
    topics: ['tech'],
    suggested_tags: [{ name: 'ai', confidence: 0.9 }],
    suggested_collection_id: null,
    model: 'test-model',
    status: 'complete',
    confidence: 0.9,
    created_at: '2026-01-04T00:00:00.000Z',
    updated_at: '2026-01-04T00:00:00.000Z',
  };
  const input = baseInput({
    bookmarks: [bookmark({ collection_id: 'c1' })],
    tagsByBookmark: { b1: [tag('reading'), tag('ml', { source: 'ai' })] },
    collections: [collection('c1', 'Read Later')],
    enrichmentByBookmark: { b1: enrichment },
    appVersion: '1.2.3',
  });

  const backup = buildJsonBackup(input);

  assert.equal(backup.schema_version, EXPORT_SCHEMA_VERSION);
  assert.equal(backup.exported_at, '2026-06-18T12:00:00.000Z');
  assert.equal(backup.app_version, '1.2.3');
  assert.deepEqual(backup.counts, { bookmarks: 1, collections: 1 });

  const [entry] = backup.bookmarks;
  assert.equal(entry.collection_name, 'Read Later');
  assert.deepEqual(
    entry.tags.map((t) => `${t.name}:${t.source}`),
    ['reading:user', 'ml:ai'],
  );
  assert.equal(entry.enrichment?.summary, 'A short summary.');
  assert.deepEqual(entry.enrichment?.suggested_tags, [{ name: 'ai', confidence: 0.9 }]);
});

test('toJsonBackup emits parseable, trailing-newline JSON', () => {
  const json = toJsonBackup(baseInput());
  assert.ok(json.endsWith('\n'));
  const parsed = JSON.parse(json);
  assert.equal(parsed.app, 'stash');
  assert.equal(parsed.bookmarks.length, 1);
});

test('null enrichment is preserved as null in the backup', () => {
  const backup = buildJsonBackup(baseInput());
  assert.equal(backup.bookmarks[0]?.enrichment, null);
  assert.equal(backup.bookmarks[0]?.collection_name, null);
});

test('toNetscapeHtml renders a valid header and a top-level entry', () => {
  const html = toNetscapeHtml(
    baseInput({ tagsByBookmark: { b1: [tag('reading'), tag('tech')] } }),
  );

  assert.ok(html.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>'));
  assert.match(html, /<H1>Stash Bookmarks<\/H1>/);
  // created_at 2026-01-02T03:04:05Z -> 1767323045 unix seconds.
  assert.match(html, /ADD_DATE="1767323045"/);
  assert.match(html, /HREF="https:\/\/example\.com\/article"/);
  assert.match(html, /TAGS="reading,tech"/);
  assert.match(html, />Example Article<\/A>/);
});

test('toNetscapeHtml groups collections into folders and keeps uncategorized at top level', () => {
  const html = toNetscapeHtml(
    baseInput({
      bookmarks: [
        bookmark({ id: 'b1', url: 'https://top.example', title: 'Top Level' }),
        bookmark({ id: 'b2', url: 'https://filed.example', title: 'Filed', collection_id: 'c1' }),
      ],
      collections: [collection('c1', 'Research')],
    }),
  );

  assert.match(html, /<DT><H3[^>]*>Research<\/H3>/);
  // The folder entry is nested deeper than the top-level one.
  assert.match(html, /\n {8}<DT><A [^>]*>Filed<\/A>/);
  assert.match(html, /\n {4}<DT><A [^>]*>Top Level<\/A>/);
});

test('toNetscapeHtml keeps bookmarks whose collection is missing from the manifest', () => {
  const html = toNetscapeHtml(
    baseInput({
      bookmarks: [
        bookmark({ id: 'b1', url: 'https://orphan.example', title: 'Orphaned', collection_id: 'missing' }),
      ],
      collections: [], // collection metadata unavailable / sanitized away
    }),
  );

  // No folder is emitted for the unknown collection, but the bookmark survives
  // at the top level rather than disappearing.
  assert.doesNotMatch(html, /<H3/);
  assert.match(html, /\n {4}<DT><A [^>]*>Orphaned<\/A>/);
});

test('toNetscapeHtml omits url-less bookmarks but the JSON backup keeps them', () => {
  const input = baseInput({
    bookmarks: [
      bookmark({ id: 'b1', url: 'https://has-url.example', title: 'Has URL' }),
      bookmark({ id: 'b2', url: null, content_type: 'text', title: 'Just a thought' }),
    ],
  });

  const html = toNetscapeHtml(input);
  assert.match(html, />Has URL<\/A>/);
  assert.doesNotMatch(html, /Just a thought/);

  const backup = buildJsonBackup(input);
  assert.equal(backup.bookmarks.length, 2);
});

test('escapes HTML-significant characters in titles, notes, and tags', () => {
  const html = toNetscapeHtml(
    baseInput({
      bookmarks: [
        bookmark({
          id: 'b1',
          url: 'https://example.com/?a=1&b=2',
          title: 'Tom & Jerry <fun>',
          notes: 'Quote: "hi" & <stuff>',
        }),
      ],
      tagsByBookmark: { b1: [tag('a&b')] },
    }),
  );

  assert.match(html, /Tom &amp; Jerry &lt;fun&gt;/);
  assert.match(html, /<DD>Quote: &quot;hi&quot; &amp; &lt;stuff&gt;/);
  assert.match(html, /HREF="https:\/\/example\.com\/\?a=1&amp;b=2"/);
  assert.match(html, /TAGS="a&amp;b"/);
});

test('unparseable timestamps drop ADD_DATE rather than emitting NaN', () => {
  const html = toNetscapeHtml(
    baseInput({ bookmarks: [bookmark({ created_at: 'not-a-date', updated_at: 'nope' })] }),
  );
  assert.doesNotMatch(html, /ADD_DATE/);
  assert.doesNotMatch(html, /NaN/);
});

test('toCsv emits a header row and one CRLF-terminated row per bookmark', () => {
  const csv = toCsv(
    baseInput({
      bookmarks: [bookmark({ collection_id: 'c1' })],
      tagsByBookmark: { b1: [tag('reading'), tag('tech')] },
      collections: [collection('c1', 'Research')],
    }),
  );

  const lines = csv.split('\r\n');
  assert.equal(lines[0], CSV_COLUMNS.join(','));
  // Header + one data row + trailing empty (from the final CRLF).
  assert.equal(lines.length, 3);
  assert.equal(lines[2], '');
  assert.ok(csv.endsWith('\r\n'));

  const row = lines[1] ?? '';
  assert.match(row, /^https:\/\/example\.com\/article,Example Article,/);
  // Tags are comma-joined within a single (quoted) cell.
  assert.match(row, /"reading, tech"/);
  assert.match(row, /Research/);
  assert.match(row, /,false$/);
});

test('toCsv keeps url-less saves, unlike the HTML export', () => {
  const csv = toCsv(
    baseInput({
      bookmarks: [
        bookmark({ id: 'b1', url: 'https://has-url.example', title: 'Has URL' }),
        bookmark({ id: 'b2', url: null, content_type: 'text', title: 'Just a thought' }),
      ],
    }),
  );
  const dataRows = csv.trimEnd().split('\r\n').slice(1);
  assert.equal(dataRows.length, 2);
  // The url-less row still appears, just with an empty leading cell.
  assert.ok(dataRows.some((row) => row.startsWith(',Just a thought,')));
});

test('toCsv escapes commas, quotes, and newlines per RFC 4180', () => {
  const csv = toCsv(
    baseInput({
      bookmarks: [
        bookmark({
          id: 'b1',
          title: 'Tom, "Jerry"',
          notes: 'line one\nline two',
        }),
      ],
    }),
  );
  // Comma + embedded quotes -> wrapped and quotes doubled.
  assert.match(csv, /"Tom, ""Jerry"""/);
  // A newline inside a field stays inside its quoted cell.
  assert.match(csv, /"line one\nline two"/);
});

test('toCsv marks archived rows', () => {
  const csv = toCsv(baseInput({ bookmarks: [bookmark({ is_archived: true })] }));
  assert.match(csv.trimEnd().split('\r\n')[1] ?? '', /,true$/);
});
