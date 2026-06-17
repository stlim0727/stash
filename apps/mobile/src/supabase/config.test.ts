import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { describeSupabaseConfig, getSupabaseConfigState } from './config.ts';

const ENV_KEYS = ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY'];

function clearEnv() {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

afterEach(clearEnv);

test('missing when neither url nor anon key is set', () => {
  clearEnv();
  const state = getSupabaseConfigState();
  assert.equal(state.status, 'missing');
  if (state.status !== 'missing') {
    throw new Error('unreachable');
  }
  assert.deepEqual(state.missing, ['url', 'anonKey']);
  assert.equal(describeSupabaseConfig(state), 'Missing EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY');
});

test('missing reports only the url when the anon key is present', () => {
  clearEnv();
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
  const state = getSupabaseConfigState();
  assert.equal(state.status, 'missing');
  if (state.status !== 'missing') {
    throw new Error('unreachable');
  }
  assert.deepEqual(state.missing, ['url']);
  assert.match(describeSupabaseConfig(state), /Missing EXPO_PUBLIC_SUPABASE_URL$/);
});

test('missing reports only the anon key when the url is present', () => {
  clearEnv();
  process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
  const state = getSupabaseConfigState();
  assert.equal(state.status, 'missing');
  if (state.status !== 'missing') {
    throw new Error('unreachable');
  }
  assert.deepEqual(state.missing, ['anonKey']);
  assert.match(describeSupabaseConfig(state), /Missing EXPO_PUBLIC_SUPABASE_ANON_KEY$/);
});

test('blank/whitespace-only values are treated as missing', () => {
  clearEnv();
  process.env.EXPO_PUBLIC_SUPABASE_URL = '   ';
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = '\t';
  const state = getSupabaseConfigState();
  assert.equal(state.status, 'missing');
  if (state.status !== 'missing') {
    throw new Error('unreachable');
  }
  assert.deepEqual(state.missing, ['url', 'anonKey']);
});

test('configured when both url and anon key are set', () => {
  clearEnv();
  process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
  const state = getSupabaseConfigState();
  assert.equal(state.status, 'configured');
  if (state.status !== 'configured') {
    throw new Error('unreachable');
  }
  assert.equal(state.config.url, 'https://project.supabase.co');
  assert.equal(state.config.anonKey, 'anon-key');
  assert.equal(describeSupabaseConfig(state), 'Configured from Expo public environment');
});

test('trims surrounding whitespace and a trailing slash from the url', () => {
  clearEnv();
  process.env.EXPO_PUBLIC_SUPABASE_URL = '  https://project.supabase.co/  ';
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = '  anon-key  ';
  const state = getSupabaseConfigState();
  if (state.status !== 'configured') {
    throw new Error('expected configured');
  }
  assert.equal(state.config.url, 'https://project.supabase.co');
  assert.equal(state.config.anonKey, 'anon-key');
});
