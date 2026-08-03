import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PENDING_ENRICHMENT_RESTORE_KEY,
  dropPendingEnrichmentRestores,
  enqueuePendingEnrichmentRestore,
  parsePendingEnrichmentRestores,
  rekeyPendingEnrichmentRestores,
  type PendingEnrichmentRestore,
} from './pending-enrichment-restore.ts';
import type { ImportedEnrichment } from './import.ts';

function enrichment(overrides: Partial<ImportedEnrichment> = {}): ImportedEnrichment {
  return {
    summary: 'A concise summary.',
    topics: ['reading'],
    suggested_tags: [{ name: 'tech', confidence: 0.9 }],
    status: 'complete',
    model: 'gpt-5',
    confidence: 0.87,
    ...overrides,
  };
}

function entry(overrides: Partial<PendingEnrichmentRestore> = {}): PendingEnrichmentRestore {
  return {
    bookmark_id: 'b1',
    enrichment: enrichment(),
    status: 'pending',
    last_error: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('parsePendingEnrichmentRestores round-trips a well-formed queue', () => {
  const queue = [entry(), entry({ bookmark_id: 'b2', status: 'failed', last_error: 'boom' })];
  const parsed = parsePendingEnrichmentRestores(JSON.stringify(queue));
  assert.deepEqual(parsed, queue);
});

test('parsePendingEnrichmentRestores tolerates null/empty/garbage input', () => {
  assert.deepEqual(parsePendingEnrichmentRestores(null), []);
  assert.deepEqual(parsePendingEnrichmentRestores(''), []);
  assert.deepEqual(parsePendingEnrichmentRestores('not json'), []);
  assert.deepEqual(parsePendingEnrichmentRestores(JSON.stringify({ not: 'an array' })), []);
});

test('parsePendingEnrichmentRestores drops malformed entries but keeps well-formed ones', () => {
  const good = entry();
  const raw = JSON.stringify([
    good,
    { bookmark_id: 'b2' }, // missing enrichment/status
    { bookmark_id: 'b3', status: 'pending', enrichment: { topics: [] } }, // missing suggested_tags
    { bookmark_id: 'b4', status: 'bogus', enrichment: enrichment() }, // bad status
    null,
  ]);
  assert.deepEqual(parsePendingEnrichmentRestores(raw), [good]);
});

test('enqueuePendingEnrichmentRestore supersedes an earlier entry for the same bookmark', () => {
  const first = entry({ status: 'failed', last_error: 'timeout' });
  const second = entry({ status: 'pending', last_error: null });
  const queue = enqueuePendingEnrichmentRestore([first], second);
  assert.deepEqual(queue, [second]);
});

test('enqueuePendingEnrichmentRestore appends when the bookmark id differs', () => {
  const a = entry({ bookmark_id: 'a' });
  const b = entry({ bookmark_id: 'b' });
  assert.deepEqual(enqueuePendingEnrichmentRestore([a], b), [a, b]);
});

test('rekeyPendingEnrichmentRestores remaps a local id to its resolved remote id', () => {
  const queue = [entry({ bookmark_id: 'local-1' }), entry({ bookmark_id: 'local-2' })];
  const idMap = new Map([['local-1', 'remote-1']]);
  const rekeyed = rekeyPendingEnrichmentRestores(queue, idMap);
  assert.deepEqual(
    rekeyed.map((item) => item.bookmark_id),
    ['remote-1', 'local-2'],
  );
});

test('dropPendingEnrichmentRestores removes only the named bookmarks', () => {
  const queue = [entry({ bookmark_id: 'a' }), entry({ bookmark_id: 'b' }), entry({ bookmark_id: 'c' })];
  const remaining = dropPendingEnrichmentRestores(queue, ['b']);
  assert.deepEqual(
    remaining.map((item) => item.bookmark_id),
    ['a', 'c'],
  );
});

test('the meta storage key is stable', () => {
  assert.equal(PENDING_ENRICHMENT_RESTORE_KEY, 'pending_enrichment_restore');
});
