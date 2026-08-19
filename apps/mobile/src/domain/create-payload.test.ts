import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPayloadFromBookmark, isUploadableCreate } from './create-payload.ts';
import type { Bookmark } from '@/domain/types';

function bookmark(overrides: Partial<Bookmark> = {}): Bookmark {
  const now = '2026-06-20T00:00:00.000Z';
  return {
    id: 'b1',
    user_id: 'u',
    url: 'https://example.com/a',
    canonical_url: null,
    url_hash: 'https://example.com/a',
    title: null,
    description: null,
    notes: null,
    source_app: null,
    content_type: 'url',
    preview_image_url: null,
    favicon_url: null,
    site_name: null,
    collection_id: null,
    is_archived: false,
    created_at: now,
    updated_at: now,
    last_saved_at: now,
    metadata_status: 'complete',
    sync_status: 'synced',
    ...overrides,
  } as Bookmark;
}

test('rebuilds a URL bookmark payload from its row', () => {
  const payload = createPayloadFromBookmark(
    bookmark({ id: 'b1', url: 'https://example.com/x', title: 'T', notes: 'N' }),
  );
  assert.deepEqual(payload, {
    id: 'b1',
    url: 'https://example.com/x',
    title: 'T',
    notes: 'N',
    client_id: undefined,
  });
});

test('carries a text note body back as shared_text (not url)', () => {
  const payload = createPayloadFromBookmark(
    bookmark({ id: 'b1', url: null, content_type: 'text', description: 'a thought', title: 'Note' }),
  );
  assert.deepEqual(payload, {
    id: 'b1',
    title: 'Note',
    notes: undefined,
    shared_text: 'a thought',
    client_id: undefined,
  });
});

test('carries the row client_id so a rebuilt create stays idempotent', () => {
  const urlPayload = createPayloadFromBookmark(
    bookmark({ url: 'https://example.com/x', client_id: 'cid-1' }),
  );
  assert.equal(urlPayload.client_id, 'cid-1');

  const textPayload = createPayloadFromBookmark(
    bookmark({ url: null, content_type: 'text', description: 'a thought', client_id: 'cid-2' }),
  );
  assert.equal(textPayload.client_id, 'cid-2');
});

test('rebuilds an image bookmark payload with content_type but no url/shared_text', () => {
  const payload = createPayloadFromBookmark(
    bookmark({
      id: 'b1',
      url: null,
      content_type: 'image',
      title: 'Screenshot',
      preview_image_url: null,
      client_id: 'cid-3',
    }),
  );
  assert.deepEqual(payload, {
    id: 'b1',
    content_type: 'image',
    title: 'Screenshot',
    notes: undefined,
    preview_image_url: undefined,
    client_id: 'cid-3',
  });
});

test('carries an already-uploaded preview_image_url through the rebuilt image payload', () => {
  const payload = createPayloadFromBookmark(
    bookmark({
      id: 'b1',
      url: null,
      content_type: 'image',
      preview_image_url: 'https://storage.example.com/bookmark-images/u1/b1',
    }),
  );
  assert.equal(payload.preview_image_url, 'https://storage.example.com/bookmark-images/u1/b1');
});

test('isUploadableCreate accepts a URL payload', () => {
  assert.equal(isUploadableCreate({ url: 'https://example.com' }), true);
});

test('isUploadableCreate accepts a shared_text payload', () => {
  assert.equal(isUploadableCreate({ shared_text: 'hello' }), true);
});

test('isUploadableCreate accepts an image payload even before it is uploaded', () => {
  assert.equal(isUploadableCreate({ content_type: 'image' }), true);
  assert.equal(isUploadableCreate({ content_type: 'image', preview_image_url: undefined }), true);
});

test('isUploadableCreate rejects a payload with neither url, a non-empty body, nor an image', () => {
  assert.equal(isUploadableCreate({ title: 'x' }), false);
  assert.equal(isUploadableCreate({ shared_text: '   ' }), false);
});
