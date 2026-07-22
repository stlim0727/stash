import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAppOpenEvent, createScreenViewedEvent, createCaptureCompletedEvent } from './events.ts';
import {
  getSanitizationReason,
  isForbiddenKey,
  isSensitiveValue,
  sanitizeEvent,
  sanitizeEventWithReason,
} from './sanitize.ts';

test('valid app_open events pass sanitization', () => {
  const platforms = ['ios', 'android', 'web'] as const;
  const authStates = [
    'anonymous',
    'authenticated',
    'signed_out',
    'session_expired',
    'not_configured',
  ] as const;

  for (const platform of platforms) {
    for (const auth_state of authStates) {
      const input = createAppOpenEvent(platform, auth_state);
      const sanitized = sanitizeEvent(input);
      assert.deepEqual(sanitized, input);
      assert.equal(getSanitizationReason(input), null);
    }
  }
});

test('valid screen_viewed events pass sanitization', () => {
  const screens = [
    'inbox',
    'add_bookmark',
    'settings',
    'review',
    'report',
    'trash',
    'browse_tags',
    'graph',
    'bookmark_detail',
  ] as const;

  for (const screen of screens) {
    const input = createScreenViewedEvent(screen);
    const sanitized = sanitizeEvent(input);
    assert.deepEqual(sanitized, input);
    assert.equal(getSanitizationReason(input), null);
  }
});

test('rejects unknown event names', () => {
  const input = { name: 'unknown_event', properties: { screen: 'inbox' } };
  assert.equal(sanitizeEvent(input), null);
  assert.match(getSanitizationReason(input) ?? '', /Unknown event name/);
});

test('rejects unknown properties on known events', () => {
  const input = {
    name: 'app_open',
    properties: {
      platform: 'ios',
      auth_state: 'anonymous',
      extra_prop: 'val',
    },
  };
  assert.equal(sanitizeEvent(input), null);
  assert.match(getSanitizationReason(input) ?? '', /Unknown property "extra_prop"/);
});

test('rejects missing required properties on known events', () => {
  const input = {
    name: 'app_open',
    properties: {
      platform: 'ios',
    },
  };
  assert.equal(sanitizeEvent(input), null);
  assert.match(getSanitizationReason(input) ?? '', /Missing required property "auth_state"/);
});

test('rejects forbidden keys and tokens case-insensitively', () => {
  const forbiddenKeys = [
    'url',
    'my_url',
    'uri',
    'href',
    'title',
    'page_title',
    'note',
    'text',
    'body_text',
    'query',
    'search',
    'search_query',
    'tag',
    'tags',
    'collection',
    'prompt',
    'email',
    'user_email',
    'user',
    'user_id',
    'userId',
    'USER',
    'account',
    'account_id',
    'bookmark',
    'bookmarkId',
    'attempt',
    'attempt_count',
    'attemptCount',
    'id',
    'uuid',
    'client_id',
    'timestamp',
  ];

  for (const key of forbiddenKeys) {
    assert.equal(isForbiddenKey(key), true, `Key "${key}" should be forbidden`);

    const input = {
      name: 'screen_viewed',
      properties: {
        screen: 'inbox',
        [key]: 'val',
      },
    };
    assert.equal(sanitizeEvent(input), null, `Event with property key "${key}" should be rejected`);
  }
});

test('allows valid non-forbidden keys', () => {
  const validKeys = ['platform', 'auth_state', 'screen', 'name', 'properties'];
  for (const key of validKeys) {
    assert.equal(isForbiddenKey(key), false, `Key "${key}" should be allowed`);
  }
});

test('detects sensitive values', () => {
  const sensitiveValues = [
    'http://example.com',
    'https://secure.site/page',
    'example.com',
    'sub.domain.co.uk',
    'user@domain.com',
    '123e4567-e89b-12d3-a456-426614174000',
    'bm_12345678',
    'usr_abc12345',
    '2026-07-21T12:00:00Z',
  ];

  for (const val of sensitiveValues) {
    assert.equal(isSensitiveValue(val), true, `Value "${val}" should be flagged as sensitive`);
  }
});

test('rejects values matching sensitive patterns or invalid enum values', () => {
  const invalidAppOpens = [
    { platform: 'https://evil.com', auth_state: 'anonymous' },
    { platform: 'ios', auth_state: 'user@domain.com' },
    { platform: 'windows', auth_state: 'anonymous' },
    { platform: 'ios', auth_state: 'invalid_auth' },
  ];

  for (const props of invalidAppOpens) {
    const input = { name: 'app_open', properties: props };
    assert.equal(sanitizeEvent(input), null);
  }
});

test('rejects non-plain objects, arrays, and primitives', () => {
  const invalidInputs = [
    null,
    undefined,
    123,
    'app_open',
    true,
    ['app_open'],
    { name: 'app_open', properties: null },
    { name: 'app_open', properties: ['ios', 'anonymous'] },
    { name: 'app_open', properties: 'ios' },
  ];

  for (const input of invalidInputs) {
    assert.equal(sanitizeEvent(input), null);
    assert.notEqual(getSanitizationReason(input), null);
  }
});

test('rejects non-finite numbers', () => {
  const inputNaN = {
    name: 'screen_viewed',
    properties: { screen: 'inbox', num: NaN },
  };
  const inputInf = {
    name: 'screen_viewed',
    properties: { screen: 'inbox', num: Infinity },
  };

  assert.equal(sanitizeEvent(inputNaN), null);
  assert.equal(sanitizeEvent(inputInf), null);
});

test('protects against prototype pollution', () => {
  const pollutedObject = JSON.parse(
    '{"name":"app_open","properties":{"platform":"ios","auth_state":"anonymous"},"__proto__":{"polluted":true}}',
  );
  assert.equal(sanitizeEvent(pollutedObject), null);

  const pollutedProps = JSON.parse(
    '{"name":"app_open","properties":{"platform":"ios","auth_state":"anonymous","__proto__":{"polluted":true}}}',
  );
  assert.equal(sanitizeEvent(pollutedProps), null);

  class CustomClass {
    name = 'app_open';
    properties = { platform: 'ios', auth_state: 'anonymous' };
  }
  assert.equal(sanitizeEvent(new CustomClass()), null);
});

test('returns frozen clean event and detailed result', () => {
  const input = createAppOpenEvent('web', 'signed_out');
  const result = sanitizeEventWithReason(input);

  assert.equal(result.reason, null);
  assert.notEqual(result.event, null);
  assert.ok(Object.isFrozen(result.event));
  assert.ok(Object.isFrozen(result.event?.properties));
  assert.deepEqual(result.event, input);
});

test('valid capture_completed events pass sanitization', () => {
  const event = createCaptureCompletedEvent('share', 'created', true, 120, 'android');
  const sanitized = sanitizeEvent(event);
  assert.deepEqual(sanitized, event);
  assert.equal(getSanitizationReason(event), null);
});

test('rejects invalid properties on capture_completed', () => {
  const invalidEvents = [
    { name: 'capture_completed', properties: { source: 'not_share', result: 'created', durable: true, persistence_ms: 100, platform: 'android' } },
    { name: 'capture_completed', properties: { source: 'share', result: 'invalid_result', durable: true, persistence_ms: 100, platform: 'android' } },
    { name: 'capture_completed', properties: { source: 'share', result: 'created', durable: 'yes', persistence_ms: 100, platform: 'android' } },
    { name: 'capture_completed', properties: { source: 'share', result: 'created', durable: true, persistence_ms: 1.5, platform: 'android' } },
    { name: 'capture_completed', properties: { source: 'share', result: 'created', durable: true, persistence_ms: 20000, platform: 'android' } },
    { name: 'capture_completed', properties: { source: 'share', result: 'created', durable: true, persistence_ms: -5, platform: 'android' } },
    { name: 'capture_completed', properties: { source: 'share', result: 'created', durable: true, persistence_ms: 100, platform: 'windows' } },
  ];

  for (const input of invalidEvents) {
    assert.equal(sanitizeEvent(input), null, `Event ${JSON.stringify(input)} should be rejected`);
    assert.notEqual(getSanitizationReason(input), null);
  }
});
