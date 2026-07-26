import assert from 'node:assert/strict';
import { test } from 'node:test';

import { displayTitle, isTitleDerived, siteLabel } from './item-display.ts';

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

test('isTitleDerived is true when title_is_derived was recorded', () => {
  assert.equal(
    isTitleDerived({ title: 'Generated title', url: 'https://example.com', title_is_derived: true }),
    true,
  );
});

test('isTitleDerived is true for a raw URL fallback even without title_is_derived', () => {
  assert.equal(isTitleDerived({ title: null, url: 'https://example.com' }), true);
  assert.equal(isTitleDerived({ title: '   ', url: 'https://example.com' }), true);
});

test('isTitleDerived is false for a real user-authored title', () => {
  assert.equal(
    isTitleDerived({ title: 'My title', url: 'https://example.com', title_is_derived: false }),
    false,
  );
});

test('isTitleDerived is false for a URL-less note falling back to description', () => {
  assert.equal(isTitleDerived({ title: null, url: null }), false);
});

test('siteLabel prefers site_name when present', () => {
  assert.equal(siteLabel({ site_name: 'Example Site', url: 'https://example.com/a' }), 'Example Site');
});

test('siteLabel falls back to a parsed hostname with www. stripped', () => {
  assert.equal(siteLabel({ site_name: null, url: 'https://www.example.com/a' }), 'example.com');
});

test('siteLabel falls back to the raw URL when it fails to parse', () => {
  assert.equal(siteLabel({ site_name: null, url: 'not a url' }), 'not a url');
});

test('siteLabel returns an empty string when there is no url', () => {
  assert.equal(siteLabel({ site_name: null, url: null }), '');
});

test('siteLabel treats a whitespace-only site_name as missing and falls back to hostname', () => {
  assert.equal(siteLabel({ site_name: '   ', url: 'https://www.example.com/a' }), 'example.com');
});
