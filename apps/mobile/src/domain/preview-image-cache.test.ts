import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import {
  PREVIEW_IMAGE_RETRY_MS,
  selectPreviewImageUri,
  clearPreviewImageFailed,
  didPreviewImageLoad,
  getPreviewImageFailuresVersion,
  isPreviewImageFailed,
  markPreviewImageFailed,
  resetPreviewImageFailuresForTest,
  subscribePreviewImageFailures,
} from './preview-image-cache.ts';

beforeEach(() => {
  resetPreviewImageFailuresForTest();
});

test('markPreviewImageFailed records failed URIs and notifies subscribers', () => {
  let notified = 0;
  const unsubscribe = subscribePreviewImageFailures(() => {
    notified += 1;
  });

  assert.equal(isPreviewImageFailed('https://example.com/img1.jpg'), false);
  assert.equal(getPreviewImageFailuresVersion(), 0);

  markPreviewImageFailed('https://example.com/img1.jpg');
  assert.equal(isPreviewImageFailed('https://example.com/img1.jpg'), true);
  assert.equal(notified, 1);
  assert.equal(getPreviewImageFailuresVersion(), 1);

  // Duplicate mark should no-op and not re-notify
  markPreviewImageFailed('https://example.com/img1.jpg');
  assert.equal(notified, 1);
  assert.equal(getPreviewImageFailuresVersion(), 1);

  // Null/empty URIs are ignored
  markPreviewImageFailed(null);
  markPreviewImageFailed(undefined);
  markPreviewImageFailed('');
  assert.equal(notified, 1);

  unsubscribe();
});

test('clearPreviewImageFailed removes failed URIs and notifies subscribers', () => {
  markPreviewImageFailed('https://example.com/img2.jpg');
  assert.equal(isPreviewImageFailed('https://example.com/img2.jpg'), true);

  let notified = 0;
  const unsubscribe = subscribePreviewImageFailures(() => {
    notified += 1;
  });

  clearPreviewImageFailed('https://example.com/img2.jpg');
  assert.equal(isPreviewImageFailed('https://example.com/img2.jpg'), false);
  assert.equal(notified, 1);

  // Clearing non-existent URI no-ops
  clearPreviewImageFailed('https://example.com/img2.jpg');
  assert.equal(notified, 1);

  unsubscribe();
});

test('didPreviewImageLoad validates native dimensions', () => {
  assert.equal(didPreviewImageLoad({ source: { width: 100, height: 100 } }), true);
  assert.equal(didPreviewImageLoad({ source: { width: 0, height: 100 } }), false);
  assert.equal(didPreviewImageLoad({ source: { width: 100, height: 0 } }), false);
  assert.equal(didPreviewImageLoad({ source: { width: 0, height: 0 } }), false);
  assert.equal(didPreviewImageLoad({}), false);
  assert.equal(didPreviewImageLoad(undefined), false);
});

test('failed local image falls through to its uploaded copy', () => {
  const local = 'file:///missing.jpg';
  const remote = 'https://example.com/upload.jpg';
  assert.equal(selectPreviewImageUri(local, remote), local);
  markPreviewImageFailed(local);
  assert.equal(selectPreviewImageUri(local, remote), remote);
  markPreviewImageFailed(remote);
  assert.equal(selectPreviewImageUri(local, remote), null);
  assert.equal(selectPreviewImageUri(null, null), null);
});

test('missing local images stay failed while an uploaded fallback is available', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const local = 'file:///missing.jpg';
  const remote = 'https://example.com/upload.jpg';
  markPreviewImageFailed(local);
  t.mock.timers.tick(PREVIEW_IMAGE_RETRY_MS);
  assert.equal(isPreviewImageFailed(local), true);
  assert.equal(selectPreviewImageUri(local, remote), remote);
});

test('temporary failures expire and notify mounted previews to retry', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const uri = 'https://example.com/transient.jpg';
  markPreviewImageFailed(uri);
  let notified = 0;
  const unsubscribe = subscribePreviewImageFailures(() => notified++);
  t.mock.timers.tick(PREVIEW_IMAGE_RETRY_MS - 1);
  assert.equal(isPreviewImageFailed(uri), true);
  t.mock.timers.tick(1);
  assert.equal(isPreviewImageFailed(uri), false);
  assert.equal(selectPreviewImageUri(null, uri), uri);
  assert.equal(notified, 1);
  unsubscribe();
});
