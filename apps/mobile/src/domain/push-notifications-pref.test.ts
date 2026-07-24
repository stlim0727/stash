import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_PUSH_NOTIFICATIONS_ENABLED,
  PUSH_NOTIFICATIONS_PREF_KEY,
  parsePushNotificationsEnabled,
  serializePushNotificationsEnabled,
} from './push-notifications-pref.ts';

test('default is off (opt-in feature)', () => {
  assert.equal(DEFAULT_PUSH_NOTIFICATIONS_ENABLED, false);
});

test('persistence key matches the agreed name', () => {
  assert.equal(PUSH_NOTIFICATIONS_PREF_KEY, 'pref.notifications.ai_drained');
});

test('serialize/parse round-trips both states', () => {
  assert.equal(parsePushNotificationsEnabled(serializePushNotificationsEnabled(true)), true);
  assert.equal(parsePushNotificationsEnabled(serializePushNotificationsEnabled(false)), false);
});

test('parse falls back to off (not the default constant, literally off) for missing/garbage input', () => {
  assert.equal(parsePushNotificationsEnabled(null), false);
  assert.equal(parsePushNotificationsEnabled(undefined), false);
  assert.equal(parsePushNotificationsEnabled(''), false);
  assert.equal(parsePushNotificationsEnabled('garbage'), false);
});
