import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ImportError,
  parseImport,
  parseJsonBackup,
  parseNetscapeHtml,
  parsePocketCsv,
} from './import.ts';
import { buildJsonBackup, toNetscapeHtml, type ExportInput } from './export.ts';
import type { AIEnrichment, Bookmark, Collection, Tag } from './types.ts';

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
  } as Bookmark;
}

function tag(name: string): Tag {
  return {
    id: `tag-${name}`,
    user_id: 'u1',
    name,
    slug: name.toLowerCase(),
    source: 'user',
    created_at: '2026-01-01T00:00:00.000Z',
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

function enrichment(overrides: Partial<AIEnrichment> = {}): AIEnrichment {
  return {
    id: 'e1',
    bookmark_id: 'b1',
    user_id: 'u1',
    summary: 'A concise summary.',
    topics: ['reading', 'productivity'],
    suggested_tags: [{ name: 'tech', confidence: 0.9 }],
    suggested_collection_id: null,
    suggested_collection_name: null,
    model: 'gpt-5',
    status: 'complete',
    confidence: 0.87,
    degraded: false,
    degraded_reason: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// --- JSON backup ---------------------------------------------------------

test('parseJsonBackup reads url, title, notes, tags, and collection name', () => {
  const json = JSON.stringify({
    app: 'stash',
    bookmarks: [
      {
        url: 'https://example.com/a',
        title: 'A',
        notes: 'my note',
        tags: [{ name: 'reading', slug: 'reading', source: 'user' }, { name: 'tech' }],
        collection_name: 'Research',
      },
    ],
  });
  const [item] = parseJsonBackup(json);
  assert.equal(item?.source, 'stash-backup');
  assert.equal(item?.url, 'https://example.com/a');
  assert.equal(item?.title, 'A');
  assert.equal(item?.notes, 'my note');
  assert.deepEqual(item?.tags, ['reading', 'tech']);
  assert.equal(item?.collection, 'Research');
});

test('parseJsonBackup never restores a generated description as user notes', () => {
  // `description` is generated page metadata; importing it as `notes` would
  // corrupt the user-vs-generated separation, so notes stays null.
  const json = JSON.stringify({ bookmarks: [{ url: 'https://x.example', description: 'desc' }] });
  assert.equal(parseJsonBackup(json)[0]?.notes, null);
});

test('parseJsonBackup accepts plain-string tags', () => {
  const json = JSON.stringify({ bookmarks: [{ url: 'https://x.example', tags: ['a', 'a', ' ', 'b'] }] });
  // Blank dropped, duplicate collapsed.
  assert.deepEqual(parseJsonBackup(json)[0]?.tags, ['a', 'b']);
});

test('parseJsonBackup keeps url-less items (null url) for the caller to skip', () => {
  const json = JSON.stringify({ bookmarks: [{ title: 'A thought', content_type: 'text' }] });
  const [item] = parseJsonBackup(json);
  assert.equal(item?.url, null);
  assert.equal(item?.title, 'A thought');
});

test('parseJsonBackup preserves generated metadata for a lossless restore (#671)', () => {
  const json = JSON.stringify({
    bookmarks: [
      {
        url: 'https://example.com/a',
        description: 'A fetched description.',
        preview_image_url: 'https://example.com/a/preview.png',
        favicon_url: 'https://example.com/favicon.ico',
        site_name: 'Example',
        canonical_url: 'https://example.com/a/',
        content_type: 'article',
      },
    ],
  });
  const [item] = parseJsonBackup(json);
  assert.deepEqual(item?.metadata, {
    description: 'A fetched description.',
    preview_image_url: 'https://example.com/a/preview.png',
    favicon_url: 'https://example.com/favicon.ico',
    site_name: 'Example',
    canonical_url: 'https://example.com/a/',
    content_type: 'article',
  });
});

test('parseJsonBackup leaves metadata undefined when the entry carries no generated fields', () => {
  const json = JSON.stringify({ bookmarks: [{ url: 'https://example.com/a', title: 'A' }] });
  assert.equal(parseJsonBackup(json)[0]?.metadata, undefined);
});

test('parseJsonBackup preserves the AI enrichment snapshot for a lossless restore (#671)', () => {
  const json = JSON.stringify({
    bookmarks: [
      {
        url: 'https://example.com/a',
        enrichment: {
          summary: 'A concise summary.',
          topics: ['reading', 'productivity'],
          suggested_tags: [{ name: 'tech', confidence: 0.9 }],
          status: 'complete',
          model: 'gpt-5',
          confidence: 0.87,
        },
      },
    ],
  });
  const [item] = parseJsonBackup(json);
  assert.deepEqual(item?.enrichment, {
    summary: 'A concise summary.',
    topics: ['reading', 'productivity'],
    suggested_tags: [{ name: 'tech', confidence: 0.9 }],
    status: 'complete',
    model: 'gpt-5',
    confidence: 0.87,
  });
});

test('parseJsonBackup leaves enrichment undefined when the entry has none', () => {
  const json = JSON.stringify({ bookmarks: [{ url: 'https://example.com/a', enrichment: null }] });
  assert.equal(parseJsonBackup(json)[0]?.enrichment, undefined);
});

test('parseJsonBackup drops a malformed suggested_tags entry rather than restoring garbage', () => {
  const json = JSON.stringify({
    bookmarks: [
      {
        url: 'https://example.com/a',
        enrichment: {
          suggested_tags: [{ name: 'tech', confidence: 0.9 }, { name: 'no-confidence' }, { confidence: 0.5 }],
          status: 'complete',
        },
      },
    ],
  });
  const [item] = parseJsonBackup(json);
  assert.deepEqual(item?.enrichment?.suggested_tags, [{ name: 'tech', confidence: 0.9 }]);
});

test('parseJsonBackup throws ImportError on invalid JSON', () => {
  assert.throws(() => parseJsonBackup('{not json'), ImportError);
});

test('parseJsonBackup throws ImportError when there is no bookmarks array', () => {
  assert.throws(() => parseJsonBackup(JSON.stringify({ app: 'stash' })), ImportError);
});

// --- Netscape HTML -------------------------------------------------------

test('parseNetscapeHtml reads top-level links with HREF, title, and TAGS', () => {
  const html = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<DL><p>',
    '    <DT><A HREF="https://example.com/a" TAGS="reading,tech">Example A</A>',
    '</DL><p>',
  ].join('\n');
  const items = parseNetscapeHtml(html);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.url, 'https://example.com/a');
  assert.equal(items[0]?.source, 'netscape-html');
  assert.equal(items[0]?.title, 'Example A');
  assert.deepEqual(items[0]?.tags, ['reading', 'tech']);
  assert.equal(items[0]?.collection, null);
});

test('parseNetscapeHtml assigns links inside a folder to that collection', () => {
  const html = [
    '<DL><p>',
    '    <DT><A HREF="https://top.example">Top</A>',
    '    <DT><H3>Research</H3>',
    '    <DL><p>',
    '        <DT><A HREF="https://filed.example">Filed</A>',
    '    </DL><p>',
    '</DL><p>',
  ].join('\n');
  const items = parseNetscapeHtml(html);
  const byTitle = Object.fromEntries(items.map((i) => [i.title, i]));
  assert.equal(byTitle['Top']?.collection, null);
  assert.equal(byTitle['Filed']?.collection, 'Research');
});

test('parseNetscapeHtml skips links without an HREF', () => {
  const html = '<DL><p><DT><A ADD_DATE="1">No link</A><DT><A HREF="https://ok.example">OK</A></DL><p>';
  const items = parseNetscapeHtml(html);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.url, 'https://ok.example');
});

test('parseNetscapeHtml unescapes entities in titles, urls, and tags', () => {
  const html =
    '<DL><p><DT><A HREF="https://example.com/?a=1&amp;b=2" TAGS="a&amp;b">Tom &amp; Jerry &lt;fun&gt;</A></DL><p>';
  const [item] = parseNetscapeHtml(html);
  assert.equal(item?.url, 'https://example.com/?a=1&b=2');
  assert.equal(item?.title, 'Tom & Jerry <fun>');
  assert.deepEqual(item?.tags, ['a&b']);
});

// --- Round trips ---------------------------------------------------------

const exportInput = (overrides: Partial<ExportInput> = {}): ExportInput => ({
  bookmarks: [bookmark()],
  tagsByBookmark: {},
  collections: [],
  exportedAt: '2026-06-18T12:00:00.000Z',
  ...overrides,
});

test('a Stash JSON backup round-trips back through parseJsonBackup', () => {
  const input = exportInput({
    bookmarks: [bookmark({ collection_id: 'c1', notes: 'keep me' })],
    tagsByBookmark: { b1: [tag('reading'), tag('tech')] },
    collections: [collection('c1', 'Research')],
  });
  const backup = JSON.stringify(buildJsonBackup(input));
  const [item] = parseJsonBackup(backup);
  assert.equal(item?.url, 'https://example.com/article');
  assert.equal(item?.title, 'Example Article');
  assert.equal(item?.notes, 'keep me');
  assert.deepEqual(item?.tags, ['reading', 'tech']);
  assert.equal(item?.collection, 'Research');
});

test('a Stash JSON backup round-trips generated metadata and the AI enrichment snapshot losslessly (#671)', () => {
  const input = exportInput({
    bookmarks: [
      bookmark({
        description: 'A fetched description.',
        preview_image_url: 'https://example.com/preview.png',
        favicon_url: 'https://example.com/favicon.ico',
        site_name: 'Example',
        canonical_url: 'https://example.com/article/',
        content_type: 'article',
      }),
    ],
    enrichmentByBookmark: { b1: enrichment() },
  });
  const backup = JSON.stringify(buildJsonBackup(input));
  const [item] = parseJsonBackup(backup);
  assert.deepEqual(item?.metadata, {
    description: 'A fetched description.',
    preview_image_url: 'https://example.com/preview.png',
    favicon_url: 'https://example.com/favicon.ico',
    site_name: 'Example',
    canonical_url: 'https://example.com/article/',
    content_type: 'article',
  });
  assert.deepEqual(item?.enrichment, {
    summary: 'A concise summary.',
    topics: ['reading', 'productivity'],
    suggested_tags: [{ name: 'tech', confidence: 0.9 }],
    status: 'complete',
    model: 'gpt-5',
    confidence: 0.87,
  });
});

test('a Stash HTML export round-trips back through parseNetscapeHtml', () => {
  const input = exportInput({
    bookmarks: [
      bookmark({ id: 'b1', url: 'https://top.example', title: 'Top Level' }),
      bookmark({ id: 'b2', url: 'https://filed.example', title: 'Filed', collection_id: 'c1' }),
    ],
    tagsByBookmark: { b1: [tag('reading')] },
    collections: [collection('c1', 'Research')],
  });
  const html = toNetscapeHtml(input);
  const items = parseNetscapeHtml(html);
  const byTitle = Object.fromEntries(items.map((i) => [i.title, i]));
  assert.equal(items.length, 2);
  assert.deepEqual(byTitle['Top Level']?.tags, ['reading']);
  assert.equal(byTitle['Top Level']?.collection, null);
  assert.equal(byTitle['Filed']?.collection, 'Research');
});

test('parseNetscapeHtml extracts ADD_DATE timestamp when present', () => {
  const html = '<DL><p><DT><A HREF="https://example.com" ADD_DATE="1699999999">Example</A></DL>';
  const [item] = parseNetscapeHtml(html);
  assert.equal(item?.createdAt, new Date(1699999999 * 1000).toISOString());
});

test('parseImport dispatches to the right parser by kind', () => {
  assert.equal(parseImport('json', JSON.stringify({ bookmarks: [{ url: 'https://x' }] })).length, 1);
  assert.equal(parseImport('html', '<DL><p><DT><A HREF="https://x">X</A></DL><p>').length, 1);
  assert.equal(parseImport('csv', 'url,title\nhttps://x,X').length, 1);
});

test('parsePocketCsv maps url/title/tags by header and splits tags on a pipe', () => {
  const csv = [
    'title,url,time_added,tags,status',
    'My Article,https://example.com/a,1699999999,reading|tech,unread',
    'Archived One,https://example.com/b,1700000000,,archive',
  ].join('\n');
  const items = parsePocketCsv(csv);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    source: 'pocket-csv',
    url: 'https://example.com/a',
    title: 'My Article',
    notes: null,
    tags: ['reading', 'tech'],
    collection: null,
    createdAt: new Date(1699999999 * 1000).toISOString(),
  });
  // Archived items are imported alike, with no tags.
  assert.equal(items[1]?.url, 'https://example.com/b');
  assert.deepEqual(items[1]?.tags, []);
});

test('parsePocketCsv is column-order independent and handles quoted fields + BOM', () => {
  // BOM prefix, url before title, a quoted title containing a comma and quotes,
  // and a CRLF line ending.
  const csv =
    '﻿url,title,tags\r\n' +
    'https://example.com/c,"Hello, ""World""",a|b\r\n';
  const items = parsePocketCsv(csv);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.url, 'https://example.com/c');
  assert.equal(items[0]?.title, 'Hello, "World"');
  assert.deepEqual(items[0]?.tags, ['a', 'b']);
});

test('parsePocketCsv skips rows without a url and rejects a file with no url column', () => {
  const csv = ['title,url', 'Has URL,https://example.com/d', 'No URL,'].join('\n');
  assert.equal(parsePocketCsv(csv).length, 1);

  assert.throws(() => parsePocketCsv('title,note\nfoo,bar'), ImportError);
  assert.throws(() => parsePocketCsv(''), ImportError);
});
