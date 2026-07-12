import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRemoteAppConfig } from './app-config.ts';

test('parseRemoteAppConfig maps public app_config rows', () => {
  assert.deepEqual(
    parseRemoteAppConfig([
      { key: 'min_app_version', value: '1.2.0' },
      { key: 'latest_app_version', value: '1.3.0' },
      { key: 'update_url', value: 'https://example.com/update' },
      { key: 'update_message', value: 'Please update.' },
    ]),
    {
      minAppVersion: '1.2.0',
      latestAppVersion: '1.3.0',
      updateUrl: 'https://example.com/update',
      updateMessage: 'Please update.',
    },
  );
});

test('parseRemoteAppConfig treats missing and blank values as absent', () => {
  assert.deepEqual(
    parseRemoteAppConfig([
      { key: 'min_app_version', value: '   ' },
      { key: 'other', value: 'ignored' },
    ]),
    {
      minAppVersion: null,
      latestAppVersion: null,
      updateUrl: null,
      updateMessage: null,
    },
  );
});
