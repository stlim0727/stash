import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  buildSentryInitOptions,
  describeSentryConfig,
  getSentryConfigState,
  parseSampleRate,
} from './sentry-config.ts';

const ENV_KEYS = [
  'EXPO_PUBLIC_SENTRY_DSN',
  'EXPO_PUBLIC_SENTRY_ENVIRONMENT',
  'EXPO_PUBLIC_SENTRY_TRACES_SAMPLE_RATE',
];

function clearEnv() {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

afterEach(clearEnv);

test('disabled when no DSN is set', () => {
  clearEnv();
  const state = getSentryConfigState();
  assert.equal(state.status, 'disabled');
  assert.match(describeSentryConfig(state), /Disabled/);
  assert.equal(buildSentryInitOptions(state), null);
});

test('enabled with a DSN; environment defaults to development', () => {
  clearEnv();
  process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://k@o1.ingest.sentry.io/2';
  const state = getSentryConfigState();
  assert.equal(state.status, 'enabled');
  if (state.status !== 'enabled') {
    throw new Error('unreachable');
  }
  assert.equal(state.config.dsn, 'https://k@o1.ingest.sentry.io/2');
  assert.equal(state.config.environment, 'development');
  assert.equal(state.config.tracesSampleRate, 0);
  assert.match(describeSentryConfig(state), /Enabled \(development\)/);
});

test('reads environment and traces sample rate from env', () => {
  clearEnv();
  process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://k@o1.ingest.sentry.io/2';
  process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT = 'production';
  process.env.EXPO_PUBLIC_SENTRY_TRACES_SAMPLE_RATE = '0.25';
  const state = getSentryConfigState();
  if (state.status !== 'enabled') {
    throw new Error('expected enabled');
  }
  assert.equal(state.config.environment, 'production');
  assert.equal(state.config.tracesSampleRate, 0.25);
});

test('parseSampleRate clamps invalid/out-of-range values to 0 (tracing off)', () => {
  assert.equal(parseSampleRate(''), 0);
  assert.equal(parseSampleRate('abc'), 0);
  assert.equal(parseSampleRate('-1'), 0);
  assert.equal(parseSampleRate('2'), 0);
  assert.equal(parseSampleRate('0.5'), 0.5);
  assert.equal(parseSampleRate('1'), 1);
});

test('buildSentryInitOptions sets safe defaults and attaches release', () => {
  process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://k@o1.ingest.sentry.io/2';
  const options = buildSentryInitOptions(getSentryConfigState(), {
    release: '1.4.0',
    dist: '42',
  });
  assert.ok(options);
  assert.equal(options.enableNativeCrashHandling, true);
  assert.equal(options.sendDefaultPii, false);
  assert.equal(options.release, '1.4.0');
  assert.equal(options.dist, '42');
  clearEnv();
});

test('buildSentryInitOptions omits release/dist when blank', () => {
  process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://k@o1.ingest.sentry.io/2';
  const options = buildSentryInitOptions(getSentryConfigState(), {
    release: '   ',
    dist: null,
  });
  assert.ok(options);
  assert.equal('release' in options, false);
  assert.equal('dist' in options, false);
  clearEnv();
});
