import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isUuid } from './validation.ts';

// The handler validates body.bookmark_id with isUuid() immediately after the
// non-empty check and BEFORE any DB call (see index.ts ~:191) — so a forged id
// is rejected with a 400 before it can reach id=eq.${bookmarkId} /
// bookmark_id=eq.${bookmarkId}, where on the server path the service-role key
// bypasses RLS. These cases pin that gate's accept/reject behavior.

test('isUuid: accepts well-formed UUIDs (any case)', () => {
  assert.equal(isUuid('123e4567-e89b-12d3-a456-426614174000'), true);
  assert.equal(isUuid('123E4567-E89B-12D3-A456-426614174000'), true);
  assert.equal(isUuid('00000000-0000-0000-0000-000000000000'), true);
});

test('isUuid: rejects PostgREST-param injection payloads in bookmark_id', () => {
  // The exact server-path smuggling shape the guard must stop.
  assert.equal(isUuid('123e4567-e89b-12d3-a456-426614174000&select=*&or=(is_archived.eq.false)'), false);
  assert.equal(isUuid('x&select=*'), false);
  assert.equal(isUuid('abc&or=(...)'), false);
  // A bare id with a trailing structural char must not slip through.
  assert.equal(isUuid('123e4567-e89b-12d3-a456-426614174000)'), false);
  assert.equal(isUuid('123e4567-e89b-12d3-a456-426614174000,'), false);
});

test('isUuid: rejects malformed / empty / non-uuid ids', () => {
  assert.equal(isUuid(''), false);
  assert.equal(isUuid('not-a-uuid'), false);
  // Right shape, wrong length.
  assert.equal(isUuid('123e4567-e89b-12d3-a456-42661417400'), false);
  // Plausible-but-invalid (non-hex char).
  assert.equal(isUuid('123e4567-e89b-12d3-a456-42661417400g'), false);
});

test('isUuid: stays identical to public-api/filters.ts isUuid (no divergent regex)', () => {
  // Pin the cross-function parity: the same anchored pattern must accept/reject
  // the same way. If this drifts, fix both — do not relax this test.
  const filtersRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const sample of [
    '123e4567-e89b-12d3-a456-426614174000',
    '123E4567-E89B-12D3-A456-426614174000',
    'x&select=*&or=(...)',
    'null',
    '',
    '123e4567-e89b-12d3-a456-42661417400',
  ]) {
    assert.equal(isUuid(sample), filtersRe.test(sample), `mismatch for ${JSON.stringify(sample)}`);
  }
});
