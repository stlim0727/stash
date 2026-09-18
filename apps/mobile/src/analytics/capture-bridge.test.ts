import assert from 'node:assert/strict';
import test from 'node:test';

import { captureAnalytics, registerAnalyticsCapture } from './capture-bridge.ts';
import { createSyncRecoveredEvent } from './events.ts';

test('capture bridge forwards events only while its provider registration is active', () => {
  const received: unknown[] = [];
  const unregister = registerAnalyticsCapture((event) => received.push(event));
  const event = createSyncRecoveredEvent(1, null, 'other');

  captureAnalytics(event);
  unregister();
  captureAnalytics(event);

  assert.deepEqual(received, [event]);
});
