import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ALLOWED_AUTH_STATES,
  ALLOWED_PLATFORMS,
  ALLOWED_SCREENS,
  createAppOpenEvent,
  createScreenViewedEvent,
  EVENT_CATALOG,
} from './events.ts';

test('createAppOpenEvent builds valid app_open payload', () => {
  const event = createAppOpenEvent('ios', 'authenticated');
  assert.deepEqual(event, {
    name: 'app_open',
    properties: {
      platform: 'ios',
      auth_state: 'authenticated',
    },
  });
});

test('createScreenViewedEvent builds valid screen_viewed payload', () => {
  const event = createScreenViewedEvent('inbox');
  assert.deepEqual(event, {
    name: 'screen_viewed',
    properties: {
      screen: 'inbox',
    },
  });
});

test('EVENT_CATALOG contains closed catalog definitions', () => {
  assert.deepEqual(Array.from(EVENT_CATALOG.app_open.platform), ['ios', 'android', 'web']);
  assert.deepEqual(Array.from(EVENT_CATALOG.app_open.auth_state), [
    'anonymous',
    'authenticated',
    'signed_out',
    'session_expired',
    'not_configured',
  ]);
  assert.deepEqual(Array.from(EVENT_CATALOG.screen_viewed.screen), [
    'inbox',
    'add_bookmark',
    'settings',
    'review',
    'report',
    'trash',
    'browse_tags',
    'graph',
    'bookmark_detail',
  ]);
});

test('Allowed sets match catalog sets', () => {
  assert.equal(EVENT_CATALOG.app_open.platform, ALLOWED_PLATFORMS);
  assert.equal(EVENT_CATALOG.app_open.auth_state, ALLOWED_AUTH_STATES);
  assert.equal(EVENT_CATALOG.screen_viewed.screen, ALLOWED_SCREENS);
});
