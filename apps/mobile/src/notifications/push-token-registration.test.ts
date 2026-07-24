import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deregisterPushToken, registerPushToken } from '@/notifications/push-token-registration';
import type { SupabaseAuthSession } from '@/supabase/types';

function session(): SupabaseAuthSession {
  return {
    access_token: 'token-123',
    refresh_token: 'refresh-123',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: 9999999999,
    user: { id: 'user-1', is_anonymous: false },
  };
}

function fakeWriter() {
  const upserts: Array<{ token: string; body: Record<string, unknown> }> = [];
  const deletes: Array<{ token: string; value: string }> = [];
  return {
    upserts,
    deletes,
    upsertPushToken: async (token: string, body: Record<string, unknown>) => {
      upserts.push({ token, body });
    },
    deletePushToken: async (token: string, value: string) => {
      deletes.push({ token, value });
    },
  };
}

test('registerPushToken upserts scoped to the session user and returns true', async () => {
  const client = fakeWriter();
  const ok = await registerPushToken({
    client,
    session: session(),
    token: 'ExponentPushToken[abc]',
    platform: 'ios',
    now: () => '2026-07-24T00:00:00.000Z',
  });

  assert.equal(ok, true);
  assert.equal(client.upserts.length, 1);
  assert.equal(client.upserts[0].token, 'token-123');
  assert.deepEqual(client.upserts[0].body, {
    user_id: 'user-1',
    token: 'ExponentPushToken[abc]',
    platform: 'ios',
    updated_at: '2026-07-24T00:00:00.000Z',
  });
});

test('registerPushToken defaults `now` to the real clock when not injected', async () => {
  const client = fakeWriter();
  await registerPushToken({
    client,
    session: session(),
    token: 'ExponentPushToken[abc]',
    platform: 'ios',
  });

  assert.equal(typeof client.upserts[0].body.updated_at, 'string');
  assert.ok(!Number.isNaN(Date.parse(client.upserts[0].body.updated_at as string)));
});

test('registerPushToken swallows failures and returns false (best-effort)', async () => {
  const client = {
    upsertPushToken: async () => {
      throw new Error('network down');
    },
    deletePushToken: async () => {},
  };
  const ok = await registerPushToken({
    client,
    session: session(),
    token: 'ExponentPushToken[abc]',
    platform: 'android',
  });

  assert.equal(ok, false);
});

test('deregisterPushToken deletes the given token and returns true', async () => {
  const client = fakeWriter();
  const ok = await deregisterPushToken({
    client,
    session: session(),
    token: 'ExponentPushToken[abc]',
  });

  assert.equal(ok, true);
  assert.deepEqual(client.deletes, [{ token: 'token-123', value: 'ExponentPushToken[abc]' }]);
});

test('deregisterPushToken swallows failures and returns false (best-effort)', async () => {
  const client = {
    upsertPushToken: async () => {},
    deletePushToken: async () => {
      throw new Error('network down');
    },
  };
  const ok = await deregisterPushToken({
    client,
    session: session(),
    token: 'ExponentPushToken[abc]',
  });

  assert.equal(ok, false);
});
