import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import {
  clearPreviewImageFailed,
  didPreviewImageLoad,
  getPreviewImageFailuresVersion,
  isPreviewImageFailed,
  markPreviewImageFailed,
  resetPreviewImageFailuresForTest,
  subscribePreviewImageFailures,
  verifyWebPreviewImage,
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

test('verifyWebPreviewImage checks decoded browser dimensions', async () => {
  const makeImage = (width: number, height: number) => () => {
    const image = {
      naturalWidth: width,
      naturalHeight: height,
      onload: null as (() => void) | null,
      onerror: null as (() => void) | null,
      _src: '',
      get src() {
        return this._src;
      },
      set src(value: string) {
        this._src = value;
        queueMicrotask(() => this.onload?.());
      },
    };
    return image;
  };

  assert.equal(
    await verifyWebPreviewImage('https://example.com/valid.jpg', makeImage(1200, 630)),
    true,
  );
  assert.equal(
    await verifyWebPreviewImage('https://example.com/empty.jpg', makeImage(0, 0)),
    false,
  );
});
