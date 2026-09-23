import assert from 'node:assert/strict';
import { test } from 'node:test';

import { trackUserPreferences } from '@/supabase/user-preferences-tracker';
import type { SupabaseAuthSession } from '@/supabase/types';

const NOW = '2026-09-22T02:00:00.000Z';

function sessionFor(userId: string, userMetadata: Record<string, unknown> = {}): SupabaseAuthSession {
  return {
    access_token: 'token-123',
    refresh_token: 'refresh-123',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: 9999999999,
    user: {
      id: userId,
      is_anonymous: false,
      user_metadata: userMetadata,
    },
  };
}

function fakeWriter() {
  const prefCalls: Array<{ token: string; data: Record<string, unknown> }> = [];
  const metaCalls: Array<{ token: string; data: Record<string, unknown> }> = [];
  return {
    prefCalls,
    metaCalls,
    upsertUserPreferences: async (token: string, data: Record<string, unknown>) => {
      prefCalls.push({ token, data });
    },
    updateUserMetadata: async (token: string, data: Record<string, unknown>) => {
      metaCalls.push({ token, data });
    },
  };
}

test('upserts locale and preference into user_preferences and updates user_metadata', async () => {
  const client = fakeWriter();

  await trackUserPreferences({
    client,
    session: sessionFor('user-1'),
    locale: 'ko',
    preference: 'ko',
    now: NOW,
  });

  assert.equal(client.prefCalls.length, 1);
  assert.equal(client.prefCalls[0].token, 'token-123');
  assert.deepEqual(client.prefCalls[0].data, {
    user_id: 'user-1',
    locale: 'ko',
    preference: 'ko',
    updated_at: NOW,
  });

  assert.equal(client.metaCalls.length, 1);
  assert.equal(client.metaCalls[0].token, 'token-123');
  assert.deepEqual(client.metaCalls[0].data, {
    locale: 'ko',
    preference: 'ko',
    locale_updated_at: NOW,
  });
});

test('skips user_metadata update when locale and preference in user_metadata are already matching', async () => {
  const client = fakeWriter();

  await trackUserPreferences({
    client,
    session: sessionFor('user-1', { locale: 'ko', preference: 'ko' }),
    locale: 'ko',
    preference: 'ko',
    now: NOW,
  });

  assert.equal(client.prefCalls.length, 1);
  assert.equal(client.metaCalls.length, 0);
});

test('falls back to "en" when locale is empty or whitespace', async () => {
  const client = fakeWriter();

  await trackUserPreferences({
    client,
    session: sessionFor('user-1'),
    locale: '   ',
    now: NOW,
  });

  assert.equal(client.prefCalls.length, 1);
  assert.equal(client.prefCalls[0].data.locale, 'en');
});

test('never throws when upsertUserPreferences fails', async () => {
  const client = {
    upsertUserPreferences: async () => {
      throw new Error('network down');
    },
  };

  await assert.doesNotReject(
    trackUserPreferences({
      client,
      session: sessionFor('user-1'),
      locale: 'ko',
      now: NOW,
    }),
  );
});

test('skips writes when signal is already aborted', async () => {
  const client = fakeWriter();
  const controller = new AbortController();
  controller.abort();

  await trackUserPreferences({
    client,
    session: sessionFor('user-1'),
    locale: 'ko',
    preference: 'ko',
    now: NOW,
    signal: controller.signal,
  });

  assert.equal(client.prefCalls.length, 0);
  assert.equal(client.metaCalls.length, 0);
});

test('forwards signal to writer and skips updateUserMetadata if aborted during upsert', async () => {
  const prefOptions: any[] = [];
  const controller = new AbortController();

  const client = {
    upsertUserPreferences: async (_token: string, _data: any, options?: { signal?: AbortSignal }) => {
      prefOptions.push(options);
      controller.abort();
    },
    updateUserMetadata: async () => {
      assert.fail('updateUserMetadata should not be called when signal aborts during upsert');
    },
  };

  await trackUserPreferences({
    client,
    session: sessionFor('user-1'),
    locale: 'ko',
    preference: 'ko',
    now: NOW,
    signal: controller.signal,
  });

  assert.equal(prefOptions.length, 1);
  assert.equal(prefOptions[0]?.signal, controller.signal);
});
