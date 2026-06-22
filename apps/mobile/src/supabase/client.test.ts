import assert from 'node:assert/strict';
import { test } from 'node:test';

import { errorMessageFrom } from './client.ts';

test('errorMessageFrom prefers GoTrue/PostgREST human-readable keys', () => {
  assert.equal(errorMessageFrom({ msg: 'bad login' }, 400), 'bad login');
  assert.equal(errorMessageFrom({ message: 'permission denied' }, 403), 'permission denied');
  assert.equal(
    errorMessageFrom({ error: 'invalid_grant', error_description: 'token expired' }, 401),
    'token expired',
  );
});

test('errorMessageFrom surfaces an edge function { error } body (was opaque before)', () => {
  // ai-enrich / feedback-bridge return { error: '…' }. Previously this fell
  // through to the HTTP fallback and the real reason was lost.
  assert.equal(errorMessageFrom({ error: 'Failed to save enrichment' }, 400), 'Failed to save enrichment');
  assert.equal(errorMessageFrom({ error: 'bookmark_id is required' }, 400), 'bookmark_id is required');
});

test('errorMessageFrom falls back to a plain-text body, then the HTTP status', () => {
  assert.equal(errorMessageFrom('gateway timeout', 504), 'gateway timeout');
  assert.equal(errorMessageFrom(null, 400), 'Supabase request failed with HTTP 400');
  assert.equal(errorMessageFrom({}, 500), 'Supabase request failed with HTTP 500');
  // Non-string keys are ignored, not coerced.
  assert.equal(errorMessageFrom({ error: 42 }, 400), 'Supabase request failed with HTTP 400');
});
