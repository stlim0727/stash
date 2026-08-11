import assert from 'node:assert/strict';
import test from 'node:test';

import { syncStatusLabel } from './status.ts';
import { createT } from './translate.ts';

test('describes a transient sync failure as waiting for connection', () => {
  const dnsError =
    'fetch failed: java.net.UnknownHostException: Unable to resolve host "example.supabase.co"';

  assert.equal(syncStatusLabel(createT('en'), 'failed', dnsError), 'sync waiting for connection');
  assert.equal(syncStatusLabel(createT('ko'), 'failed', dnsError), '동기화 연결 대기 중');
});

test('keeps genuine sync failures labeled as failed', () => {
  assert.equal(syncStatusLabel(createT('en'), 'failed', 'HTTP 500'), 'sync failed');
});
