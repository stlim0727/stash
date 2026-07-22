import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAppOpenEvent, createScreenViewedEvent, createCaptureCompletedEvent } from './events.ts';
import {
  AD_EXPERIMENT_FLAG_KEY,
  ANALYTICS_STATE_KEY,
  clearPostHogAnalyticsState,
  createPostHogHttpTransport,
} from './posthog.ts';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

const baseOptions = {
  apiKey: 'phc_test',
  host: 'https://eu.i.posthog.com',
  idFactory: () => `ka_${'a'.repeat(32)}`,
  now: () => '2026-07-21T00:00:00.000Z',
  freshOptIn: true,
};

test('wire payload contains only the documented pseudonymous fields', async () => {
  const storage = memoryStorage();
  const requests: Array<{ input: string; init: RequestInit }> = [];
  const transport = await createPostHogHttpTransport({
    ...baseOptions,
    storage,
    fetcher: async (input, init) => {
      requests.push({ input, init });
      return new Response(null, { status: 200 });
    },
  });
  assert.ok(transport);

  transport.capture(createAppOpenEvent('android', 'authenticated'));
  await transport.flush();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].input, 'https://eu.i.posthog.com/batch/');
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
    api_key: 'phc_test',
    batch: [
      {
        event: 'app_open',
        properties: {
          distinct_id: `ka_${'a'.repeat(32)}`,
          platform: 'android',
          auth_state: 'authenticated',
          $geoip_disable: true,
          $process_person_profile: false,
        },
        timestamp: '2026-07-21T00:00:00.000Z',
      },
    ],
  });
});

test('capture then immediate opt-out starts no network and clears queue and identity', async () => {
  const storage = memoryStorage();
  let fetches = 0;
  const transport = await createPostHogHttpTransport({
    ...baseOptions,
    storage,
    fetcher: async () => {
      fetches += 1;
      return new Response(null, { status: 200 });
    },
  });
  assert.ok(transport);

  transport.capture(createScreenViewedEvent('inbox'));
  await transport.optOut();
  await transport.flush();

  assert.equal(fetches, 0);
  assert.equal(
    storage.values.get(ANALYTICS_STATE_KEY),
    JSON.stringify({ version: 1, enabled: false, installationId: null, queue: [] }),
  );
});

test('opt-out aborts an in-flight request and prevents later capture', async () => {
  const storage = memoryStorage();
  let started = false;
  let aborted = false;
  const transport = await createPostHogHttpTransport({
    ...baseOptions,
    storage,
    fetcher: (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        started = true;
        init.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      }),
  });
  assert.ok(transport);

  transport.capture(createScreenViewedEvent('settings'));
  while (!started) await Promise.resolve();
  await transport.optOut();
  transport.capture(createScreenViewedEvent('graph'));
  await transport.flush();

  assert.equal(aborted, true);
  assert.equal(
    storage.values.get(ANALYTICS_STATE_KEY),
    JSON.stringify({ version: 1, enabled: false, installationId: null, queue: [] }),
  );
});

test('cleanup retries, verifies, and is independent of a live transport', async () => {
  const storage = memoryStorage({ [ANALYTICS_STATE_KEY]: 'stale' });
  let attempts = 0;
  const originalSet = storage.set;
  storage.set = async (key, value) => {
    attempts += 1;
    if (attempts < 3) throw new Error('temporary failure');
    await originalSet(key, value);
  };

  await clearPostHogAnalyticsState(storage);
  assert.equal(attempts, 3);
  assert.match(storage.values.get(ANALYTICS_STATE_KEY) ?? '', /"enabled":false/);
});

test('a fresh opt-in cannot revive a pre-opt-out queue or identifier', async () => {
  const staleState = {
    version: 1,
    enabled: true,
    installationId: `ka_${'b'.repeat(32)}`,
    queue: [
      {
        event: createScreenViewedEvent('inbox'),
        occurredAt: '2026-07-20T00:00:00.000Z',
      },
    ],
  };
  const storage = memoryStorage({ [ANALYTICS_STATE_KEY]: JSON.stringify(staleState) });
  await clearPostHogAnalyticsState(storage);
  let fetches = 0;
  const transport = await createPostHogHttpTransport({
    ...baseOptions,
    storage,
    fetcher: async () => {
      fetches += 1;
      return new Response(null, { status: 200 });
    },
  });
  assert.ok(transport);
  await transport.flush();

  assert.equal(fetches, 0);
  assert.notEqual(storage.values.get(ANALYTICS_STATE_KEY), JSON.stringify(staleState));
  assert.match(storage.values.get(ANALYTICS_STATE_KEY) ?? '', new RegExp(`ka_${'a'.repeat(32)}`));
});

test('a disabled atomic state never resumes without a fresh explicit opt-in', async () => {
  const storage = memoryStorage({
    [ANALYTICS_STATE_KEY]: JSON.stringify({
      version: 1,
      enabled: false,
      installationId: null,
      queue: [],
    }),
  });
  let fetches = 0;
  const transport = await createPostHogHttpTransport({
    ...baseOptions,
    freshOptIn: false,
    storage,
    fetcher: async () => {
      fetches += 1;
      return new Response(null, { status: 200 });
    },
  });

  assert.equal(transport, null);
  assert.equal(fetches, 0);
  assert.match(storage.values.get(ANALYTICS_STATE_KEY) ?? '', /"enabled":false/);
});

test('later captures persist while an earlier network drain is still pending', async () => {
  const storage = memoryStorage();
  let started = false;
  let fetches = 0;
  let finish!: (response: Response) => void;
  const transport = await createPostHogHttpTransport({
    ...baseOptions,
    storage,
    fetcher: async () => {
      fetches += 1;
      if (fetches > 1) return new Response(null, { status: 503 });
      return new Promise<Response>((resolve) => {
        started = true;
        finish = resolve;
      });
    },
  });
  assert.ok(transport);

  transport.capture(createScreenViewedEvent('inbox'));
  while (!started) await Promise.resolve();
  transport.capture(createScreenViewedEvent('graph'));

  let persistedQueueLength = 0;
  for (let attempt = 0; attempt < 20 && persistedQueueLength < 2; attempt += 1) {
    await Promise.resolve();
    const raw = storage.values.get(ANALYTICS_STATE_KEY);
    persistedQueueLength = raw ? JSON.parse(raw).queue.length : 0;
  }
  assert.equal(persistedQueueLength, 2);

  finish(new Response(null, { status: 503 }));
  await transport.flush();
});

test('fresh boolean flag refresh uses the same pseudonymous identity and fails closed', async () => {
  const storage = memoryStorage();
  const requests: Array<{ input: string; init: RequestInit }> = [];
  const transport = await createPostHogHttpTransport({
    ...baseOptions,
    storage,
    fetcher: async (input, init) => {
      requests.push({ input, init });
      return new Response(
        JSON.stringify({ flags: { [AD_EXPERIMENT_FLAG_KEY]: { enabled: true } } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  });
  assert.ok(transport);

  assert.equal(await transport.reloadBooleanFlag(AD_EXPERIMENT_FLAG_KEY), true);
  assert.equal(await transport.reloadBooleanFlag('unknown-flag'), false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].input, 'https://eu.i.posthog.com/flags/?v=2');
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
    token: 'phc_test',
    distinct_id: `ka_${'a'.repeat(32)}`,
    groups: {},
    person_properties: {},
    group_properties: {},
    geoip_disable: true,
    flag_keys_to_evaluate: [AD_EXPERIMENT_FLAG_KEY],
  });
});

test('rejects every host except the exact EU ingestion origin', async () => {
  const storage = memoryStorage();
  for (const badHost of [
    'http://eu.i.posthog.com',
    'https://us.i.posthog.com',
    'https://eu.i.posthog.com/path',
    'https://user@eu.i.posthog.com',
    'https://evil.example',
  ]) {
    assert.equal(
      await createPostHogHttpTransport({ ...baseOptions, host: badHost, storage }),
      null,
    );
  }
});

test('wire payload contains only capture_completed properties on capture_completed events', async () => {
  const storage = memoryStorage();
  const requests: Array<{ input: string; init: RequestInit }> = [];
  const transport = await createPostHogHttpTransport({
    ...baseOptions,
    storage,
    fetcher: async (input, init) => {
      requests.push({ input, init });
      return new Response(null, { status: 200 });
    },
  });
  assert.ok(transport);

  transport.capture(createCaptureCompletedEvent('share', 'created', true, 150, 'android'));
  await transport.flush();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].input, 'https://eu.i.posthog.com/batch/');
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
    api_key: 'phc_test',
    batch: [
      {
        event: 'capture_completed',
        properties: {
          distinct_id: `ka_${'a'.repeat(32)}`,
          source: 'share',
          result: 'created',
          durable: true,
          persistence_ms: 150,
          platform: 'android',
          $geoip_disable: true,
          $process_person_profile: false,
        },
        timestamp: '2026-07-21T00:00:00.000Z',
      },
    ],
  });
});
