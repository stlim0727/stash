import assert from 'node:assert/strict';
import { test } from 'node:test';

import { displayTitle } from './item-display.ts';

test('prefers a user-authored title over everything else', () => {
  assert.equal(
    displayTitle({ title: 'My title', url: 'https://example.com', description: 'body' }),
    'My title',
  );
});

test('falls back to the URL when there is no title', () => {
  assert.equal(
    displayTitle({ title: null, url: 'https://example.com', description: null }),
    'https://example.com',
  );
});

test('uses the saved text for a URL-less note (no title, no url)', () => {
  assert.equal(
    displayTitle({ title: null, url: null, description: '내일 3시에 회의 있습니다' }),
    '내일 3시에 회의 있습니다',
  );
});

test('treats a whitespace-only title as absent', () => {
  assert.equal(
    displayTitle({ title: '   ', url: null, description: 'the note body' }),
    'the note body',
  );
});

test('returns null when there is nothing to show', () => {
  assert.equal(displayTitle({ title: null, url: null, description: null }), null);
  assert.equal(displayTitle({ title: '  ', url: null, description: '  ' }), null);
});
