import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planAccountTransition } from './account-transition.ts';
import type { Bookmark } from '@/domain/types';

const REMOTE_A = '7e64cf1e-0000-4000-8000-00000000000a';
const REMOTE_B = '7e64cf1e-0000-4000-8000-00000000000b';

function bookmark(overrides: Partial<Bookmark> = {}): Bookmark {
  const now = '2026-06-16T00:00:00.000Z';
  return {
    id: REMOTE_A,
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
    deleted_at: null,
    created_at: now,
    updated_at: now,
    last_saved_at: now,
    metadata_status: 'complete',
    sync_status: 'synced',
    ...overrides,
  };
}

test('first sync has nothing to reconcile', () => {
  const plan = planAccountTransition(null, { id: 'anon', isAnonymous: true }, [bookmark()]);
  assert.equal(plan.kind, 'first');
  assert.deepEqual(plan.rehome, []);
  assert.deepEqual(plan.drop, []);
  assert.equal(plan.resetWatermark, false);
});

test('same user is a no-op', () => {
  const plan = planAccountTransition(
    { id: 'u1', isAnonymous: false },
    { id: 'u1', isAnonymous: false },
    [bookmark()],
  );
  assert.equal(plan.kind, 'none');
  assert.deepEqual(plan.drop, []);
});

test('anonymous -> real account carries the synced rows over (re-home)', () => {
  const rows = [bookmark({ id: REMOTE_A }), bookmark({ id: REMOTE_B })];
  const plan = planAccountTransition(
    { id: 'anon', isAnonymous: true },
    { id: 'google-user', isAnonymous: false },
    rows,
  );
  assert.equal(plan.kind, 'carry-over');
  assert.deepEqual(
    plan.rehome.map((b) => b.id),
    [REMOTE_A, REMOTE_B],
  );
  assert.deepEqual(plan.drop, []);
  assert.equal(plan.resetWatermark, true);
});

test('real account A -> real account B drops A’s local cache (no merge)', () => {
  const plan = planAccountTransition(
    { id: 'A', isAnonymous: false },
    { id: 'B', isAnonymous: false },
    [bookmark({ id: REMOTE_A })],
  );
  assert.equal(plan.kind, 'switch');
  assert.deepEqual(plan.rehome, []);
  assert.deepEqual(plan.drop, [REMOTE_A]);
  assert.equal(plan.resetWatermark, true);
});

test('only cloud-owned rows are touched — local/seed rows are left alone', () => {
  const rows = [
    bookmark({ id: REMOTE_A, sync_status: 'synced' }),
    bookmark({ id: 'local-abc', sync_status: 'pending' }), // device-local
    bookmark({ id: 'bookmark-seed-1', sync_status: 'synced' }), // seeded sample
    bookmark({ id: REMOTE_B, sync_status: 'pending' }), // synced id but not yet synced
  ];
  const plan = planAccountTransition(
    { id: 'anon', isAnonymous: true },
    { id: 'real', isAnonymous: false },
    rows,
  );
  // Only the genuinely cloud-owned row (UUID id + synced) is carried over.
  assert.deepEqual(
    plan.rehome.map((b) => b.id),
    [REMOTE_A],
  );
});

test('re-homed/dropped rows no longer match — transition is self-idempotent', () => {
  // After a carry-over the rows become local-pending; re-running plans nothing.
  const afterRehome = [bookmark({ id: 'local-xyz', sync_status: 'pending' })];
  const plan = planAccountTransition(
    { id: 'anon', isAnonymous: true },
    { id: 'real', isAnonymous: false },
    afterRehome,
  );
  assert.deepEqual(plan.rehome, []);
  assert.deepEqual(plan.drop, []);
});
