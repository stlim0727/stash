import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planAppVersionMetadataUpdate } from '@/domain/app-version-metadata';

const NOW = '2026-06-29T00:00:00.000Z';

test('plans a write when no version is stored yet', () => {
  const patch = planAppVersionMetadataUpdate(
    null,
    { appVersion: '1.0.0-rc8', platform: 'android' },
    NOW,
  );
  assert.deepEqual(patch, {
    app_version: '1.0.0-rc8',
    platform: 'android',
    app_version_updated_at: NOW,
  });
});

test('plans a write when the version changed', () => {
  const patch = planAppVersionMetadataUpdate(
    { app_version: '1.0.0-rc7', platform: 'android' },
    { appVersion: '1.0.0-rc8', platform: 'android' },
    NOW,
  );
  assert.equal(patch?.app_version, '1.0.0-rc8');
  assert.equal(patch?.app_version_updated_at, NOW);
});

test('plans a write when only the platform changed', () => {
  const patch = planAppVersionMetadataUpdate(
    { app_version: '1.0.0-rc8', platform: 'android' },
    { appVersion: '1.0.0-rc8', platform: 'ios' },
    NOW,
  );
  assert.equal(patch?.platform, 'ios');
});

test('returns null when stored values already match (no redundant write)', () => {
  const patch = planAppVersionMetadataUpdate(
    { app_version: '1.0.0-rc8', platform: 'android' },
    { appVersion: '1.0.0-rc8', platform: 'android' },
    NOW,
  );
  assert.equal(patch, null);
});

test('ignores surrounding whitespace when comparing', () => {
  const patch = planAppVersionMetadataUpdate(
    { app_version: '1.0.0-rc8', platform: 'android' },
    { appVersion: '  1.0.0-rc8  ', platform: ' android ' },
    NOW,
  );
  assert.equal(patch, null);
});

test('returns null when runtime values are missing (never persists junk)', () => {
  assert.equal(planAppVersionMetadataUpdate(null, {}, NOW), null);
  assert.equal(
    planAppVersionMetadataUpdate(null, { appVersion: '1.0.0', platform: '' }, NOW),
    null,
  );
  assert.equal(
    planAppVersionMetadataUpdate(null, { appVersion: '', platform: 'android' }, NOW),
    null,
  );
});

test('preserves unrelated user_metadata keys by only reading our own', () => {
  // The planner must not depend on or echo back OAuth profile fields.
  const patch = planAppVersionMetadataUpdate(
    { full_name: 'Ada', avatar_url: 'https://x/y.png' } as Record<string, unknown>,
    { appVersion: '1.0.0', platform: 'ios' },
    NOW,
  );
  assert.deepEqual(patch, {
    app_version: '1.0.0',
    platform: 'ios',
    app_version_updated_at: NOW,
  });
});
