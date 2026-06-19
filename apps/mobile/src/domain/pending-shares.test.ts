import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addPendingShare,
  parsePendingShares,
  removePendingShare,
  serializePendingShares,
  type PendingShare,
} from './pending-shares.ts';

const share = (url: string, title?: string): PendingShare => ({
  url,
  title,
  captured_at: '2026-06-19T00:00:00.000Z',
});

test('parsePendingShares tolerates absent or corrupt values', () => {
  assert.deepEqual(parsePendingShares(null), []);
  assert.deepEqual(parsePendingShares(undefined), []);
  assert.deepEqual(parsePendingShares(''), []);
  assert.deepEqual(parsePendingShares('not json'), []);
  assert.deepEqual(parsePendingShares('{}'), []);
});

test('parsePendingShares keeps only well-formed entries', () => {
  const raw = JSON.stringify([
    { url: 'https://a.com', captured_at: '2026-06-19T00:00:00.000Z' },
    { url: 'https://b.com', title: 'B', captured_at: '2026-06-19T00:00:00.000Z' },
    { url: 123, captured_at: 'x' }, // bad url
    { url: 'https://c.com' }, // missing captured_at
    { url: 'https://d.com', title: 5, captured_at: 'x' }, // bad title
  ]);
  assert.deepEqual(parsePendingShares(raw), [
    { url: 'https://a.com', captured_at: '2026-06-19T00:00:00.000Z' },
    { url: 'https://b.com', title: 'B', captured_at: '2026-06-19T00:00:00.000Z' },
  ]);
});

test('addPendingShare de-duplicates by URL, newest wins', () => {
  const list = [share('https://a.com')];
  const next = addPendingShare(list, share('https://a.com', 'fresh'));
  assert.equal(next.length, 1);
  assert.equal(next[0].title, 'fresh');
});

test('addPendingShare appends distinct URLs', () => {
  const next = addPendingShare([share('https://a.com')], share('https://b.com'));
  assert.deepEqual(
    next.map((item) => item.url),
    ['https://a.com', 'https://b.com'],
  );
});

test('removePendingShare drops the matching URL only', () => {
  const list = [share('https://a.com'), share('https://b.com')];
  assert.deepEqual(
    removePendingShare(list, 'https://a.com').map((item) => item.url),
    ['https://b.com'],
  );
  assert.deepEqual(removePendingShare(list, 'https://missing.com'), list);
});

test('serialize/parse round-trips', () => {
  const list = [share('https://a.com', 'A'), share('https://b.com', 'B')];
  assert.deepEqual(parsePendingShares(serializePendingShares(list)), list);

  // A title-less entry round-trips without an explicit `title: undefined` key.
  const titleless: PendingShare = { url: 'https://c.com', captured_at: '2026-06-19T00:00:00.000Z' };
  assert.deepEqual(parsePendingShares(serializePendingShares([titleless])), [titleless]);
});
