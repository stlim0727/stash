import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canonicalizeImageMimeType,
  extensionForImage,
  imageTitleFromFileName,
  isImageMime,
  localImageFileName,
  mimeTypeForImageUri,
  pickSharedImage,
} from './image-share.ts';

test('isImageMime recognizes image types case-insensitively', () => {
  assert.equal(isImageMime('image/png'), true);
  assert.equal(isImageMime('IMAGE/JPEG'), true);
  assert.equal(isImageMime(' image/heic '), true);
  assert.equal(isImageMime('text/plain'), false);
  assert.equal(isImageMime('application/pdf'), false);
  assert.equal(isImageMime(null), false);
  assert.equal(isImageMime(undefined), false);
});

test('pickSharedImage returns the first image file', () => {
  const picked = pickSharedImage([
    { path: 'file:///tmp/note.txt', mimeType: 'text/plain', fileName: 'note.txt' },
    { path: 'file:///tmp/shot.png', mimeType: 'image/png', fileName: 'shot.png' },
    { path: 'file:///tmp/other.jpg', mimeType: 'image/jpeg', fileName: 'other.jpg' },
  ]);
  assert.deepEqual(picked, {
    uri: 'file:///tmp/shot.png',
    mimeType: 'image/png',
    fileName: 'shot.png',
  });
});

test('pickSharedImage returns null when there is no image (or no files)', () => {
  assert.equal(
    pickSharedImage([{ path: 'file:///tmp/note.txt', mimeType: 'text/plain', fileName: 'n' }]),
    null,
  );
  assert.equal(pickSharedImage(null), null);
  assert.equal(pickSharedImage(undefined), null);
  assert.equal(pickSharedImage([]), null);
});

test('pickSharedImage skips image entries without a usable path', () => {
  assert.equal(pickSharedImage([{ path: '', mimeType: 'image/png', fileName: 'x.png' }]), null);
  assert.equal(
    pickSharedImage([{ path: null, mimeType: 'image/png', fileName: 'x.png' }]),
    null,
  );
});

test('pickSharedImage normalizes the mime type and blank filenames', () => {
  const picked = pickSharedImage([
    { path: 'file:///tmp/a.PNG', mimeType: ' IMAGE/PNG ', fileName: '   ' },
  ]);
  assert.deepEqual(picked, { uri: 'file:///tmp/a.PNG', mimeType: 'image/png', fileName: null });
});

test('extensionForImage prefers the MIME mapping', () => {
  assert.equal(extensionForImage({ mimeType: 'image/png', fileName: 'whatever.bin' }), 'png');
  assert.equal(extensionForImage({ mimeType: 'image/jpeg', fileName: null }), 'jpg');
  assert.equal(extensionForImage({ mimeType: 'image/svg+xml', fileName: null }), 'svg');
});

test('extensionForImage falls back to the filename, then a default', () => {
  assert.equal(extensionForImage({ mimeType: 'image/x-weird', fileName: 'pic.webp' }), 'webp');
  assert.equal(extensionForImage({ mimeType: 'image/x-weird', fileName: 'pic' }), 'jpg');
  assert.equal(extensionForImage({ mimeType: '', fileName: null }), 'jpg');
});

test('localImageFileName names the file by bookmark id and extension', () => {
  assert.equal(
    localImageFileName('local-abc', { mimeType: 'image/png', fileName: 'shot.png' }),
    'local-abc.png',
  );
});

test('imageTitleFromFileName tidies the base name', () => {
  assert.equal(imageTitleFromFileName('IMG_1234.JPG'), 'IMG 1234');
  assert.equal(imageTitleFromFileName('my-cool_screenshot.png'), 'my cool screenshot');
  assert.equal(imageTitleFromFileName('/tmp/share/photo.heic'), 'photo');
});

test('imageTitleFromFileName returns null when nothing usable remains', () => {
  assert.equal(imageTitleFromFileName(null), null);
  assert.equal(imageTitleFromFileName(undefined), null);
  assert.equal(imageTitleFromFileName('.png'), null);
  assert.equal(imageTitleFromFileName('   '), null);
});

test('mimeTypeForImageUri recovers the MIME type from the durable local filename', () => {
  assert.equal(mimeTypeForImageUri('file:///docs/stash-images/abc-123.png'), 'image/png');
  assert.equal(mimeTypeForImageUri('file:///docs/stash-images/abc-123.jpg'), 'image/jpeg');
  assert.equal(mimeTypeForImageUri('file:///docs/stash-images/abc-123.HEIC'), 'image/heic');
});

test('mimeTypeForImageUri falls back to an allowlisted image type for an unknown extension (never a non-image type the Storage bucket would permanently reject)', () => {
  assert.equal(mimeTypeForImageUri('file:///docs/stash-images/abc-123'), 'image/jpeg');
  assert.equal(mimeTypeForImageUri('file:///docs/stash-images/abc-123.xyz'), 'image/jpeg');
});

test('canonicalizeImageMimeType normalizes a real-but-nonstandard alias to the bucket-allowlisted form', () => {
  // Some share providers report image/jpg (not image/jpeg) for a plain
  // JPEG — MIME_TO_EXT already treats them as the same format, but the
  // bucket's allowlist only contains the standard image/jpeg spelling.
  assert.equal(canonicalizeImageMimeType('image/jpg'), 'image/jpeg');
  assert.equal(canonicalizeImageMimeType('IMAGE/JPG'), 'image/jpeg');
  assert.equal(canonicalizeImageMimeType('  image/jpg  '), 'image/jpeg');
});

test('canonicalizeImageMimeType leaves an already-canonical or unmapped type unchanged', () => {
  assert.equal(canonicalizeImageMimeType('image/jpeg'), 'image/jpeg');
  assert.equal(canonicalizeImageMimeType('image/png'), 'image/png');
  // No established canonical form to normalize an unmapped format to — the
  // real, honest type is preserved rather than guessed at.
  assert.equal(canonicalizeImageMimeType('image/jxl'), 'image/jxl');
});
