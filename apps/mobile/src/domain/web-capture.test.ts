import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildBookmarklet, firstParam, parseCaptureParams } from './web-capture.ts';

test('firstParam returns a trimmed string and ignores blanks', () => {
  assert.equal(firstParam('https://a.com'), 'https://a.com');
  assert.equal(firstParam('  spaced  '), 'spaced');
  assert.equal(firstParam(['first', 'second']), 'first');
  assert.equal(firstParam(undefined), undefined);
  assert.equal(firstParam(''), undefined);
  assert.equal(firstParam('   '), undefined);
});

test('parseCaptureParams returns null when no capture params are present', () => {
  assert.equal(parseCaptureParams({}), null);
  assert.equal(parseCaptureParams({ url: '', text: '   ' }), null);
});

test('parseCaptureParams normalizes a url param and carries the title', () => {
  const intent = parseCaptureParams({ url: 'https://example.com/x', title: 'Example' });
  assert.ok(intent);
  assert.equal(intent.url, 'https://example.com/x');
  assert.equal(intent.title, 'Example');
});

test('parseCaptureParams recovers a url that carries trailing text', () => {
  // A source page that appends a title after the link must not be lost — the URL
  // is extracted rather than rejected wholesale.
  const intent = parseCaptureParams({ url: 'https://example.com/x some title' });
  assert.ok(intent);
  assert.equal(intent.url, 'https://example.com/x');
});

test('parseCaptureParams falls back to text when the url is unsaveable', () => {
  // A non-http scheme is not a saveable bookmark URL; it falls through to the
  // text-note path (url null) rather than dropping the capture.
  const intent = parseCaptureParams({ url: 'javascript:alert(1)', text: 'keep me' });
  assert.ok(intent);
  assert.equal(intent.url, null);
  assert.equal(intent.text, 'keep me');
});

test('parseCaptureParams treats a text/note-only share as a note', () => {
  const intent = parseCaptureParams({ text: 'a plain note with no link' });
  assert.ok(intent);
  assert.equal(intent.url, null);
  assert.equal(intent.text, 'a plain note with no link');

  // `note` is accepted as an alias for `text`.
  const fromNote = parseCaptureParams({ note: 'via note param' });
  assert.equal(fromNote?.text, 'via note param');
});

test('parseCaptureParams takes the first value of array-shaped params', () => {
  const intent = parseCaptureParams({ url: ['https://a.com', 'https://b.com'] });
  // normalizeUrl canonicalizes a bare host with a trailing slash.
  assert.equal(intent?.url, 'https://a.com/');
});

test('buildBookmarklet targets the /add endpoint and tolerates a trailing slash', () => {
  const a = buildBookmarklet('https://stash.app');
  const b = buildBookmarklet('https://stash.app/');
  assert.equal(a, b);
  assert.ok(a.startsWith('javascript:'));
  assert.ok(a.includes("https://stash.app/add?url='+encodeURIComponent(window.location.href)"));
  assert.ok(a.includes('encodeURIComponent(document.title)'));
});
