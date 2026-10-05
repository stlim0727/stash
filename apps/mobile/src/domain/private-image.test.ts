import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateImageReference, signedImageUrl } from './private-image.ts';

const base = 'https://project.supabase.co';
test('old/new image references are owner scoped; foreign hosts never receive credentials', () => {
  for (const access of ['public', 'authenticated', 'sign']) {
    const uri = `${base}/storage/v1/object/${access}/bookmark-images/a/b`;
    assert.deepEqual(privateImageReference(uri, base, 'a'), { kind: 'private', path: 'a/b' });
    assert.deepEqual(privateImageReference(uri, base, 'other'), { kind: 'blocked' });
    assert.deepEqual(privateImageReference(uri, base, null), { kind: 'blocked' });
    assert.deepEqual(privateImageReference(uri.replace(base, 'https://evil.test'), base, 'a'), { kind: 'blocked' });
  }
  assert.deepEqual(privateImageReference('https://external.test/image.png', base, 'a'), { kind: 'external' });
  assert.deepEqual(privateImageReference('file:///image.png', base, 'a'), { kind: 'external' });
  assert.deepEqual(privateImageReference(`${base}/storage/v1/object/public/bookmark-images/a/%2e%2e%2fb`, base, 'a'), { kind: 'blocked' });
});

test('signed responses must match the exact project/object and include a token', () => {
  assert.equal(signedImageUrl(base, 'a/b', { signedURL: '/object/sign/bookmark-images/a/b?token=signature' }), `${base}/storage/v1/object/sign/bookmark-images/a/b?token=signature`);
  for (const value of [null, {}, { signedURL: '/object/sign/bookmark-images/other/b?token=x' }, { signedURL: 'https://evil.test/storage/v1/object/sign/bookmark-images/a/b?token=x' }, { signedURL: '/object/sign/bookmark-images/a/b' }]) {
    assert.throws(() => signedImageUrl(base, 'a/b', value));
  }
});
