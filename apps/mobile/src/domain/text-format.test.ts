import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoBodyFormat, notesFormat, memoBodyLabel, textForDisplay, parseTextFormat } from './text-format.ts';
import { displayTitle, accessibilityTitle } from './item-display.ts';
import { filterBookmarks } from './search.ts';
import { createPayloadFromBookmark } from './create-payload.ts';
import { buildJsonBackup } from './export.ts';
import { parseJsonBackup } from './import.ts';
import type { Bookmark } from './types.ts';

function makeMockBookmark(): Bookmark {
  return {
    id: 'memo-1', user_id: 'user-1', url: null, canonical_url: null, url_hash: null,
    title: null, description: null, notes: null, source_app: null, content_type: 'text',
    preview_image_url: null, favicon_url: null, site_name: null, collection_id: null,
    is_archived: false, deleted_at: null, created_at: '2026-09-04T00:00:00Z',
    updated_at: '2026-09-04T00:00:00Z', last_saved_at: '2026-09-04T00:00:00Z',
    metadata_status: 'skipped', sync_status: 'pending',
  };
}

test('legacy body and notes formats remain independent', () => {
  assert.equal(memoBodyFormat({}), 'markdown');
  assert.equal(memoBodyFormat({ description_format: null }), 'markdown');
  assert.equal(notesFormat({}), 'plain');
  assert.equal(notesFormat({ notes_format: null }), 'plain');
  assert.equal(parseTextFormat('html'), undefined);
});

test('plain memo titles, previews and symbol search retain literal syntax', () => {
  const source = '# Heading\n\n**literal**\n';
  const bookmark = { ...makeMockBookmark(), title: null, url: null, content_type: 'text' as const,
    description: source, description_format: 'plain' as const };
  assert.equal(textForDisplay(source, memoBodyFormat(bookmark)), source);
  assert.equal(displayTitle(bookmark), '# Heading');
  assert.match(accessibilityTitle(bookmark)!, /\*\*literal\*\*/);
  assert.equal(filterBookmarks([bookmark], '**literal**').length, 1);
  assert.equal(memoBodyLabel({ ...bookmark, description_format: 'markdown' }), 'Heading');
  assert.equal(filterBookmarks([{ ...bookmark, description_format: 'markdown' }], '**literal**').length, 0);
});

test('JSON backup and rebuilt create preserve both formats and raw notes', () => {
  const bookmark = { ...makeMockBookmark(), url: null, content_type: 'text' as const,
    description: '# literal\n', description_format: 'plain' as const,
    notes: '    code\n\n', notes_format: 'markdown' as const };
  const backup = buildJsonBackup({ bookmarks: [bookmark], tagsByBookmark: {}, collections: [] });
  const restored = parseJsonBackup(JSON.stringify(backup))[0];
  assert.equal(restored.description_format, 'plain');
  assert.equal(restored.notes_format, 'markdown');
  assert.equal(restored.notes, bookmark.notes);
  assert.equal(restored.metadata?.raw_description, bookmark.description);
  const payload = createPayloadFromBookmark(bookmark);
  assert.equal(payload.description_format, 'plain');
  assert.equal(payload.notes_format, 'markdown');
  assert.equal(payload.notes, bookmark.notes);
});
