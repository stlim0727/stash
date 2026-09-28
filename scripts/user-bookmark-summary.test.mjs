import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchJsonWithTimeout, main } from './user-bookmark-summary.mjs';

async function report(t, args) {
  const users = Array.from({ length: 22 }, (_, i) => ({
    id: `${String(i).padStart(8, '0')}-private-uuid`, is_anonymous: true,
    created_at: '2026-01-01T00:00:00Z',
    user_metadata: { platform: i % 2 ? 'android' : 'web', app_version: '1.2.3', app_version_updated_at: '2999-01-01T00:00:00Z' },
  }));
  users.push({ id: 'registered', email: '\u001b[31mhello\n@example.com', user_metadata: { platform: '\u001b]0;bad\u0007', app_version: '\nforged row' } });
  users.push({
    id: 'registered-controls',
    email: '\u001b[31mhello\n@example.com',
    user_metadata: { platform: '\u001b]0;bad\u0007', app_version: '\nforged row' },
  });
  const bookmarks = users.slice(0, 22).map(u => ({ user_id: u.id, is_archived: false }));
  bookmarks.push({ user_id: users[0].id, is_archived: true, collection_id: 'archived-only' });
  t.mock.method(globalThis, 'fetch', async url => ({
    ok: true,
    json: async () => {
      const request = new URL(url);
      if (url.includes('/auth/')) {
        return { users: request.searchParams.get('page') === '1' ? users : [] };
      }
      if (request.searchParams.get('offset') === '0' && url.includes('bookmarks?')) return bookmarks;
      if (request.searchParams.get('offset') === '0' && url.includes('cleanup')) {
        return [{ deleted_count: 7 }];
      }
      return [];
    },
  }));
  const lines = [];
  t.mock.method(console, 'log', (...parts) => lines.push(parts.join(' ')));
  await main(args, { url: 'https://fixture.invalid', key: 'fixture' });
  return lines.join('\n');
}

test('JSON report redacts anonymous IDs and separates versions, archives, and unfiltered totals', async t => {
  const output = await report(t, ['--json']);
  const data = JSON.parse(output);
  assert.equal(data.cumulative_unfiltered_accounts, 31);
  assert.equal(data.historical_automation_classification, 'unknown');
  assert.equal(data.cumulative_lifetime_sessions, undefined);
  assert.equal(data.users[0].id, '00000000');
  assert.equal(output.includes('private-uuid'), false);
  assert.equal(data.users[0].collections_used, 0);
  assert.equal(data.users[0].archived, 1);
  assert.equal(data.users[0].last_active, '2026-01-01T00:00:00Z');
  assert.equal(data.users[0].version_seen, null);
  assert.equal(data.version_adoption.filter(row => row.app_version === '1.2.3').length, 2);
  assert.equal(data.users.at(-1).platform, null);
  assert.equal(data.users.at(-1).app_version, null);
  assert.equal(data.users.at(-1).email, 'hello@example.com');
});

test('text report includes all nonempty anonymous users without terminal controls', async t => {
  const output = await report(t, []);
  assert.equal((output.match(/\(anon\) \d{8}/g) ?? []).length, 22);
  assert.equal(output.includes('\u001b'), false);
  assert.equal(output.includes('\u001b'), false);
  assert.match(output, /Cumulative Unfiltered Accounts/);
});

for (const ok of [true, false]) {
  test(`deadline also aborts a stalled ${ok ? 'JSON' : 'error'} body`, async t => {
    t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
      const read = () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('body aborted')), { once: true }));
      return { ok, status: 500, json: read, text: read };
    });
    await assert.rejects(fetchJsonWithTimeout('https://fixture.invalid', {}, 15), /body aborted/);
  });
}
