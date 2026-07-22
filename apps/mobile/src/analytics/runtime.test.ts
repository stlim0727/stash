import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createScreenViewedEvent } from './events.ts';
import { AnalyticsRuntime, type AnalyticsTransport } from './runtime.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('captures only after explicit enable and rejects unsafe events', async () => {
  const captured: unknown[] = [];
  const transport: AnalyticsTransport = {
    capture: (event) => captured.push(event),
    optOut: async () => {},
  };
  const runtime = new AnalyticsRuntime(async () => transport);

  runtime.capture(createScreenViewedEvent('inbox'));
  assert.equal(captured.length, 0);

  await runtime.enable();
  runtime.capture(createScreenViewedEvent('inbox'));
  runtime.capture({ name: 'screen_viewed', properties: { screen: 'inbox', url: 'secret' } });
  assert.deepEqual(captured, [createScreenViewedEvent('inbox')]);

  await runtime.disable();
  runtime.capture(createScreenViewedEvent('settings'));
  assert.deepEqual(captured, [createScreenViewedEvent('inbox')]);
});

test('opt-out closes the gate synchronously and discards a racing client', async () => {
  const created = deferred<AnalyticsTransport | null>();
  let optedOut = 0;
  const transport: AnalyticsTransport = {
    capture: () => assert.fail('capture must stay gated'),
    optOut: async () => {
      optedOut += 1;
    },
  };
  const runtime = new AnalyticsRuntime(() => created.promise);

  const enabling = runtime.enable();
  void runtime.disable();
  runtime.capture(createScreenViewedEvent('settings'));
  created.resolve(transport);
  await enabling;
  await Promise.resolve();

  assert.equal(optedOut, 1);
});

test('named privacy boundary rejects AI content and a raw account UUID end to end', async () => {
  const captured: unknown[] = [];
  const runtime = new AnalyticsRuntime(async () => ({
    capture: (event) => captured.push(event),
    optOut: async () => {},
  }));
  await runtime.enable();

  runtime.capture({
    name: 'screen_viewed',
    properties: { screen: 'inbox', summary: 'private AI summary' },
  });
  runtime.capture({
    name: 'app_open',
    properties: {
      platform: 'ios',
      auth_state: 'anonymous',
      account_id: '123e4567-e89b-12d3-a456-426614174000',
    },
  });

  assert.deepEqual(captured, []);
});

test('a missing transport never presents as enabled or captures later', async () => {
  const runtime = new AnalyticsRuntime(async () => null);
  assert.equal(await runtime.enable(true), false);
  runtime.capture(createScreenViewedEvent('inbox'));
  assert.equal(await runtime.reloadBooleanFlag('ads-master-enabled'), false);
});
