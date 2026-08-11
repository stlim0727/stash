import assert from 'node:assert/strict';
import test from 'node:test';

import { syncStatusLabel } from './status.ts';
import { createT } from './translate.ts';

test('describes a transient sync failure as waiting for connection', () => {
  assert.equal(
    syncStatusLabel(createT('en'), 'failed', 'transient_network'),
    'sync waiting for connection',
  );
  assert.equal(
    syncStatusLabel(createT('ko'), 'failed', 'transient_network'),
    '동기화 연결 대기 중',
  );
});

test('keeps genuine sync failures labeled as failed', () => {
  assert.equal(syncStatusLabel(createT('en'), 'failed', 'other'), 'sync failed');
});
