import assert from 'node:assert/strict';
import { test } from 'node:test';

import { trackAppVersionMetadata } from '@/supabase/app-version-tracker';
import type { SupabaseAuthSession } from '@/supabase/types';

const NOW = '2026-06-29T00:00:00.000Z';

function sessionWith(metadata: Record<string, unknown> = {}): SupabaseAuthSession {
  return {
    access_token: 'token-123',
    refresh_token: 'refresh-123',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: 9999999999,
    user: {
      id: 'user-1',
      is_anonymous: false,
      user_metadata: metadata,
    },
  };
}

function fakeWriter() {
  const calls: Array<{ token: string; data: Record<string, unknown> }> = [];
  return {
    calls,
    updateUserMetadata: async (token: string, data: Record<string, unknown>) => {
      calls.push({ token, data });
      return { id: 'user-1' };
    },
  };
}

test('writes and returns merged session when the version changed', async () => {
  const client = fakeWriter();
  const result = await trackAppVersionMetadata({
    client,
    session: sessionWith({ full_name: 'Ada' }),
    runtime: { appVersion: '1.0.0-rc8', platform: 'android' },
    now: NOW,
  });

  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].token, 'token-123');
  assert.deepEqual(client.calls[0].data, {
    app_version: '1.0.0-rc8',
    platform: 'android',
    app_version_updated_at: NOW,
  });
  // OAuth profile fields are preserved alongside the new keys.
  assert.deepEqual(result?.user.user_metadata, {
    full_name: 'Ada',
    app_version: '1.0.0-rc8',
    platform: 'android',
    app_version_updated_at: NOW,
  });
});

test('does not write when already up to date', async () => {
  const client = fakeWriter();
  const result = await trackAppVersionMetadata({
    client,
    session: sessionWith({ app_version: '1.0.0-rc8', platform: 'android' }),
    runtime: { appVersion: '1.0.0-rc8', platform: 'android' },
    now: NOW,
  });

  assert.equal(client.calls.length, 0);
  assert.equal(result, null);
});

test('swallows write failures and returns null (best-effort)', async () => {
  const client = {
    updateUserMetadata: async () => {
      throw new Error('network down');
    },
  };
  const result = await trackAppVersionMetadata({
    client,
    session: sessionWith(),
    runtime: { appVersion: '1.0.0-rc8', platform: 'android' },
    now: NOW,
  });

  assert.equal(result, null);
});

test('does not write when runtime values are missing', async () => {
  const client = fakeWriter();
  const result = await trackAppVersionMetadata({
    client,
    session: sessionWith(),
    runtime: { appVersion: null, platform: 'android' },
    now: NOW,
  });

  assert.equal(client.calls.length, 0);
  assert.equal(result, null);
});
