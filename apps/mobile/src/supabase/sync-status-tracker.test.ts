import assert from 'node:assert/strict';
import { test } from 'node:test';

import { trackSyncStatus } from '@/supabase/sync-status-tracker';
import type { SupabaseAuthSession } from '@/supabase/types';

const NOW = '2026-08-04T00:00:00.000Z';

function sessionFor(userId: string): SupabaseAuthSession {
  return {
    access_token: 'token-123',
    refresh_token: 'refresh-123',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: 9999999999,
    user: {
      id: userId,
      is_anonymous: false,
      user_metadata: {},
    },
  };
}

function fakeWriter() {
  const calls: Array<{ token: string; data: Record<string, unknown> }> = [];
  return {
    calls,
    upsertSyncStatus: async (token: string, data: Record<string, unknown>) => {
      calls.push({ token, data });
    },
  };
}

test('upserts app_version and last_synced_at for the authenticated user', async () => {
  const client = fakeWriter();

  await trackSyncStatus({
    client,
    session: sessionFor('user-1'),
    runtime: { appVersion: '1.0.0-rc17', platform: 'android' },
    now: NOW,
  });

  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].token, 'token-123');
  assert.deepEqual(client.calls[0].data, {
    user_id: 'user-1',
    app_version: '1.0.0-rc17',
    last_synced_at: NOW,
    updated_at: NOW,
  });
});

test('writes a null app_version when the runtime value is missing', async () => {
  const client = fakeWriter();

  await trackSyncStatus({
    client,
    session: sessionFor('user-1'),
    runtime: { appVersion: null, platform: 'android' },
    now: NOW,
  });

  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].data.app_version, null);
  assert.equal(client.calls[0].data.last_synced_at, NOW);
});

test('swallows write failures instead of throwing (best-effort)', async () => {
  const client = {
    upsertSyncStatus: async () => {
      throw new Error('network down');
    },
  };

  await assert.doesNotReject(
    trackSyncStatus({
      client,
      session: sessionFor('user-1'),
      runtime: { appVersion: '1.0.0-rc17', platform: 'android' },
      now: NOW,
    }),
  );
});
