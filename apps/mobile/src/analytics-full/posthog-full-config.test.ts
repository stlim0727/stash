import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  POSTHOG_FULL_AUTOCAPTURE_OPTIONS,
  buildPostHogFullInitOptions,
  describePostHogFullConfig,
  getPostHogFullConfigState,
  isApprovedPostHogHost,
} from './posthog-full-config.ts';

const ENV_KEYS = [
  'EXPO_PUBLIC_POSTHOG_FULL_SDK_ENABLED',
  'EXPO_PUBLIC_POSTHOG_API_KEY',
  'EXPO_PUBLIC_POSTHOG_HOST',
];

function clearEnv() {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

afterEach(clearEnv);

test('disabled when the build-time gate is unset, even with valid project vars', () => {
  clearEnv();
  process.env.EXPO_PUBLIC_POSTHOG_API_KEY = 'phc_test';
  process.env.EXPO_PUBLIC_POSTHOG_HOST = 'https://eu.i.posthog.com';
  const state = getPostHogFullConfigState();
  assert.equal(state.status, 'disabled');
  assert.match(describePostHogFullConfig(state), /FULL_SDK_ENABLED/);
});

test('disabled when the gate is on but the API key is missing', () => {
  clearEnv();
  process.env.EXPO_PUBLIC_POSTHOG_FULL_SDK_ENABLED = 'true';
  process.env.EXPO_PUBLIC_POSTHOG_HOST = 'https://eu.i.posthog.com';
  const state = getPostHogFullConfigState();
  assert.equal(state.status, 'disabled');
  assert.match(describePostHogFullConfig(state), /API_KEY/);
});

test('disabled when the host is not the approved EU origin', () => {
  clearEnv();
  process.env.EXPO_PUBLIC_POSTHOG_FULL_SDK_ENABLED = 'true';
  process.env.EXPO_PUBLIC_POSTHOG_API_KEY = 'phc_test';
  process.env.EXPO_PUBLIC_POSTHOG_HOST = 'https://us.i.posthog.com';
  const state = getPostHogFullConfigState();
  assert.equal(state.status, 'disabled');
  assert.match(describePostHogFullConfig(state), /EU host/);
});

test('enabled only when the gate, key, and EU host are all present', () => {
  clearEnv();
  process.env.EXPO_PUBLIC_POSTHOG_FULL_SDK_ENABLED = 'true';
  process.env.EXPO_PUBLIC_POSTHOG_API_KEY = 'phc_test';
  process.env.EXPO_PUBLIC_POSTHOG_HOST = 'https://eu.i.posthog.com';
  const state = getPostHogFullConfigState();
  assert.equal(state.status, 'enabled');
  if (state.status !== 'enabled') {
    throw new Error('unreachable');
  }
  assert.equal(state.config.apiKey, 'phc_test');
  assert.equal(state.config.host, 'https://eu.i.posthog.com');
  assert.equal(describePostHogFullConfig(state), 'Enabled');
});

test('a non-"true" value for the build gate is treated as disabled', () => {
  clearEnv();
  process.env.EXPO_PUBLIC_POSTHOG_FULL_SDK_ENABLED = '1';
  process.env.EXPO_PUBLIC_POSTHOG_API_KEY = 'phc_test';
  process.env.EXPO_PUBLIC_POSTHOG_HOST = 'https://eu.i.posthog.com';
  assert.equal(getPostHogFullConfigState().status, 'disabled');
});

test('isApprovedPostHogHost accepts only the exact EU origin', () => {
  assert.equal(isApprovedPostHogHost('https://eu.i.posthog.com'), true);
  assert.equal(isApprovedPostHogHost('https://eu.i.posthog.com/'), true);
  assert.equal(isApprovedPostHogHost('https://us.i.posthog.com'), false);
  assert.equal(isApprovedPostHogHost('https://eu.i.posthog.com/foo'), false);
  assert.equal(isApprovedPostHogHost('http://eu.i.posthog.com'), false);
  assert.equal(isApprovedPostHogHost('https://evil.example.com?eu.i.posthog.com'), false);
  assert.equal(isApprovedPostHogHost('not a url'), false);
  assert.equal(isApprovedPostHogHost(''), false);
});

test('buildPostHogFullInitOptions asks for conservative masking and starts opted out', () => {
  const options = buildPostHogFullInitOptions({
    apiKey: 'phc_test',
    host: 'https://eu.i.posthog.com',
  });
  assert.equal(options.host, 'https://eu.i.posthog.com');
  assert.equal(options.disableGeoip, true);
  assert.equal(options.defaultOptIn, false);
  assert.equal(options.captureAppLifecycleEvents, false);
  assert.equal(options.enableSessionReplay, true);
  assert.deepEqual(options.sessionReplayConfig, {
    maskAllTextInputs: true,
    maskAllImages: true,
    maskAllSandboxedViews: true,
    captureNetworkTelemetry: false,
  });
});

test('autocapture never captures touches or raw SDK screen names', () => {
  // Screens are captured manually (see PostHogFullScreenTracker) through the
  // same closed allowlist the base analytics client uses, not the SDK's own
  // autocapture (which doesn't work for expo-router apps anyway).
  assert.equal(POSTHOG_FULL_AUTOCAPTURE_OPTIONS.captureScreens, false);
  assert.equal(POSTHOG_FULL_AUTOCAPTURE_OPTIONS.captureTouches, false);
});
