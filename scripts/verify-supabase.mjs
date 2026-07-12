/**
 * End-to-end verification of the Supabase cloud layer (Milestones 5-7)
 * against a real project, exercising the app's own client and API code.
 *
 * Usage:
 *   EXPO_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co \
 *   EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon-or-publishable-key> \
 *   pnpm verify:supabase
 *
 * Requires: the project's initial migration applied and anonymous sign-ins
 * enabled. Creates throwaway anonymous users; cleans up the rows it creates.
 */
import { register } from 'node:module';

register('./alias-loader.mjs', import.meta.url);

const { getSupabaseConfigState } = await import('../apps/mobile/src/supabase/config.ts');
const { createSupabaseClient, SupabaseRequestError } = await import(
  '../apps/mobile/src/supabase/client.ts'
);
const { clearSupabaseSession } = await import('../apps/mobile/src/supabase/session-storage.ts');
const { createBookmarkApi } = await import('../apps/mobile/src/api/bookmarks.ts');

let passed = 0;
const cleanups = [];

function ok(name, detail = '') {
  passed += 1;
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, error) {
  console.error(`  ✗ ${name}`);
  console.error(`    ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
  throw new VerificationAbort();
}

class VerificationAbort extends Error {}

async function expectRejects(name, promise) {
  try {
    await promise;
    fail(name, 'expected the operation to fail, but it succeeded');
  } catch (error) {
    if (error instanceof VerificationAbort) {
      throw error;
    }
    ok(name, error instanceof Error ? error.message : String(error));
  }
}

async function testRealtimeChannel(session, userId, expectSuccess) {
  const configState = getSupabaseConfigState();
  if (configState.status !== 'configured') {
    throw new Error('Supabase is not configured');
  }

  const { RealtimeClient } = await import('@supabase/realtime-js');
  const rtUrl = configState.config.url.replace(/^http/, 'ws') + '/realtime/v1';

  return new Promise((resolve, reject) => {
    const rt = new RealtimeClient(rtUrl, {
      params: {
        apikey: configState.config.anonKey,
      },
    });

    rt.setAuth(session.access_token);
    rt.connect();

    const channel = rt.channel(`sync:private:${userId}`, {
      config: {
        private: true,
        broadcast: { self: false },
      },
    });

    let socketOpened = false;
    rt.onOpen(() => {
      socketOpened = true;
    });

    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        rt.disconnect();
        if (!socketOpened) {
          reject(new Error('WebSocket connection could not be opened (network offline or Realtime disabled)'));
        } else if (expectSuccess) {
          reject(new Error('realtime connection timed out (expected success)'));
        } else {
          reject(new Error('realtime connection timed out without receiving CHANNEL_ERROR (expected rejection)'));
        }
      }
    }, 5000);

    channel.subscribe((status, err) => {
      if (settled) return;
      if (status === 'SUBSCRIBED') {
        settled = true;
        clearTimeout(timeout);
        rt.disconnect();
        if (expectSuccess) {
          resolve();
        } else {
          reject(new Error('anonymous user successfully joined private channel (expected rejection)'));
        }
      } else if (status === 'CHANNEL_ERROR') {
        settled = true;
        clearTimeout(timeout);
        rt.disconnect();
        if (!expectSuccess) {
          resolve();
        } else {
          reject(new Error(`authenticated user failed to join private channel (status: ${status}, error: ${err})`));
        }
      }
    });
  });
}

function toSession(response) {
  if (
    !response.access_token ||
    !response.refresh_token ||
    !response.token_type ||
    !response.expires_in ||
    !response.user
  ) {
    throw new Error('Supabase auth response did not include a complete session.');
  }

  return {
    access_token: response.access_token,
    refresh_token: response.refresh_token,
    token_type: response.token_type,
    expires_in: response.expires_in,
    expires_at: response.expires_at ?? Math.floor(Date.now() / 1000) + response.expires_in,
    user: response.user,
  };
}

try {
  console.log('Supabase end-to-end verification\n');

  // --- M5: configuration + anonymous auth ---
  const configState = getSupabaseConfigState();
  if (configState.status !== 'configured') {
    fail('configuration', `missing env: ${configState.missing.join(', ')}`);
  }
  ok('configuration', configState.config.url);

  const client = createSupabaseClient();
  let session;
  try {
    session = await client.signInAnonymously();
  } catch (error) {
    if (error instanceof SupabaseRequestError && /anonymous/i.test(error.message)) {
      fail(
        'anonymous sign-in',
        'Anonymous sign-ins appear to be disabled. Enable them: Authentication → Sign In / Up.',
      );
    }
    fail('anonymous sign-in', error);
  }
  ok('anonymous sign-in', `user ${session.user.id}`);

  const refreshed = await client.refreshSession(session.refresh_token);
  if (!refreshed.access_token || refreshed.access_token === session.access_token) {
    fail('token refresh', 'no new access token returned');
  }
  ok('token refresh');
  session = refreshed;

  const restored = await client.restoreSession();
  if (restored.outcome !== 'active' || restored.session.user.id !== session.user.id) {
    fail('session restore', 'restored session missing or for a different user');
  }
  ok('session restore');

  // --- M6: bookmark API against real schema + RLS ---
  const api = createBookmarkApi(session);
  const testUrl = `https://example.com/stash-verify-${Date.now()}`;

  const created = await api.createBookmark({ url: testUrl, notes: 'verification run' });
  if (created.status !== 'created') {
    fail('createBookmark', `expected status created, got ${created.status}`);
  }
  ok('createBookmark', created.bookmark_id);
  cleanups.push(() => api.deleteBookmark(created.bookmark_id, true));

  const duplicate = await api.createBookmark({ url: testUrl });
  if (duplicate.status !== 'duplicate' || duplicate.bookmark_id !== created.bookmark_id) {
    fail('duplicate save', `expected duplicate of ${created.bookmark_id}, got ${JSON.stringify(duplicate)}`);
  }
  ok('duplicate save reuses bookmark');

  const listed = await api.listBookmarks();
  if (!listed.some((bookmark) => bookmark.id === created.bookmark_id)) {
    fail('listBookmarks', 'created bookmark not in list');
  }
  ok('listBookmarks');

  await api.updateBookmark(created.bookmark_id, { title: 'Verified title', notes: 'updated' });
  const detailAfterUpdate = await api.getBookmark(created.bookmark_id);
  if (detailAfterUpdate?.bookmark.title !== 'Verified title') {
    fail('updateBookmark', 'title did not persist');
  }
  ok('updateBookmark + getBookmark');

  const tags = await api.addTags({
    bookmark_id: created.bookmark_id,
    tags: ['verify', 'Read Later'],
    source: 'user',
  });
  if (tags.length !== 2) {
    fail('addTags', `expected 2 tags, got ${tags.length}`);
  }
  cleanups.push(async () => {
    for (const tag of tags) {
      await client.request(`/rest/v1/tags?id=eq.${tag.id}`, {
        method: 'DELETE',
        accessToken: session.access_token,
      });
    }
  });
  const detailWithTags = await api.getBookmark(created.bookmark_id);
  if (detailWithTags?.tags.length !== 2) {
    fail('tags on detail', `expected 2, got ${detailWithTags?.tags.length}`);
  }
  ok('addTags + tags on detail');

  await api.removeTags({ bookmark_id: created.bookmark_id, tags: ['verify'] });
  const detailAfterRemove = await api.getBookmark(created.bookmark_id);
  if (detailAfterRemove?.tags.length !== 1) {
    fail('removeTags', `expected 1 tag left, got ${detailAfterRemove?.tags.length}`);
  }
  ok('removeTags');

  const enrichment = await api.updateAIEnrichment({
    bookmark_id: created.bookmark_id,
    summary: 'Verification summary',
    topics: ['testing'],
    suggested_tags: [{ name: 'verified', confidence: 0.99 }],
    status: 'complete',
    model: 'verify-script',
  });
  if (enrichment.summary !== 'Verification summary') {
    fail('updateAIEnrichment', 'summary did not persist');
  }
  const detailWithEnrichment = await api.getBookmark(created.bookmark_id);
  if (detailWithEnrichment?.enrichment?.id !== enrichment.id) {
    fail('enrichment on detail', 'latest enrichment not returned');
  }
  ok('updateAIEnrichment + enrichment on detail');

  await api.applyAISuggestions({ bookmark_id: created.bookmark_id, tag_names: ['verified'] });
  const detailAfterApply = await api.getBookmark(created.bookmark_id);
  if (!detailAfterApply?.tags.some((tag) => tag.slug === 'verified')) {
    fail('applyAISuggestions', 'suggested tag was not promoted');
  }
  cleanups.push(async () => {
    const verifiedTag = detailAfterApply.tags.find((tag) => tag.slug === 'verified');
    if (verifiedTag) {
      await client.request(`/rest/v1/tags?id=eq.${verifiedTag.id}`, {
        method: 'DELETE',
        accessToken: session.access_token,
      });
    }
  });
  ok('applyAISuggestions');

  // --- tags/collections pull + collection creation ---
  const allTags = await api.listTags();
  if (!tags.every((tag) => allTags.some((row) => row.id === tag.id))) {
    fail('listTags', 'created tags missing from full tag list');
  }
  const allLinks = await api.listBookmarkTags();
  if (!allLinks.some((link) => link.bookmark_id === created.bookmark_id)) {
    fail('listBookmarkTags', 'bookmark tag links missing');
  }
  const newCollection = await api.createCollection(`Verify ${Date.now()}`);
  cleanups.push(() =>
    client.request(`/rest/v1/collections?id=eq.${newCollection.id}`, {
      method: 'DELETE',
      accessToken: session.access_token,
    }),
  );
  const allCollections = await api.listCollections();
  if (!allCollections.some((row) => row.id === newCollection.id)) {
    fail('listCollections', 'created collection missing from list');
  }
  ok('tag/collection pull + createCollection');

  // --- M7+ pull queries ---
  const pulledBookmarks = await api.listBookmarksUpdatedSince(null);
  if (!pulledBookmarks.some((bookmark) => bookmark.id === created.bookmark_id)) {
    fail('pull: listBookmarksUpdatedSince', 'created bookmark missing from full pull');
  }
  const pulledIds = await api.listBookmarkIds();
  if (!pulledIds.includes(created.bookmark_id)) {
    fail('pull: listBookmarkIds', 'created bookmark missing from ID list');
  }
  const pulledEnrichments = await api.listEnrichmentsUpdatedSince(null);
  if (!pulledEnrichments.some((row) => row.id === enrichment.id)) {
    fail('pull: listEnrichmentsUpdatedSince', 'enrichment missing from full pull');
  }
  const future = new Date(Date.now() + 60_000).toISOString();
  const noneSinceFuture = await api.listBookmarksUpdatedSince(future);
  if (noneSinceFuture.length !== 0) {
    fail('pull: incremental filter', `expected 0 rows since the future, got ${noneSinceFuture.length}`);
  }
  ok('pull queries (full, IDs, enrichments, incremental filter)');

  // NOTE (review #6): this assert is intentionally archive-by-default, and is
  // correct for the REST surface. The app-side `trashBookmark` performs a
  // move-to-trash (sets `deleted_at`), but the REST `api.deleteBookmark`
  // (apps/mobile/src/api/bookmarks.ts) only sets `is_archived` — it has NO
  // trash/`deleted_at` semantics. So "archive-by-default delete" is the right
  // expectation here; do NOT change it to assert `deleted_at`. Whether the REST
  // API *should* gain move-to-trash semantics to match the app is a product
  // decision flagged for the owner, not changed in this script.
  const archived = await api.deleteBookmark(created.bookmark_id);
  void archived;
  const detailAfterArchive = await api.getBookmark(created.bookmark_id);
  if (detailAfterArchive?.bookmark.is_archived !== true) {
    fail('archive (default delete)', 'bookmark is not archived');
  }
  ok('archive-by-default delete');

  // --- M5/M6: RLS isolation with a second anonymous user ---
  await clearSupabaseSession();
  const sessionB = await client.signInAnonymously();
  if (sessionB.user.id === session.user.id) {
    fail('second anonymous user', 'same user returned twice');
  }
  const apiB = createBookmarkApi(sessionB);

  const listedB = await apiB.listBookmarks({ is_archived: true });
  if (listedB.some((bookmark) => bookmark.id === created.bookmark_id)) {
    fail('RLS list isolation', "user B can see user A's bookmark");
  }
  ok('RLS: list isolation');

  const foreignDetail = await apiB.getBookmark(created.bookmark_id);
  if (foreignDetail !== null) {
    fail('RLS read isolation', "user B can read user A's bookmark");
  }
  ok('RLS: read isolation');

  await expectRejects(
    'RLS: write isolation (cross-user update rejected)',
    apiB.updateBookmark(created.bookmark_id, { title: 'hijacked' }),
  );

  // --- realtime broadcast policy verification ---
  console.log('\nVerifying realtime broadcast policies...');

  // Test 1: Anonymous user (User A) is denied subscription
  try {
    await testRealtimeChannel(session, session.user.id, false);
    ok('Realtime RLS: anonymous subscription rejected');
  } catch (error) {
    fail('Realtime RLS: anonymous subscription check failed', error);
  }

  // Test 2: Real authenticated user is allowed subscription
  const testEmail = 'realtime-policy-verifier@keepory.app';
  const testPass = 'verifier-password-91823';
  let realSession;
  try {
    const signupResponse = await client.request('/auth/v1/signup', {
      method: 'POST',
      body: { email: testEmail, password: testPass },
    });
    if (signupResponse && signupResponse.access_token) {
      realSession = toSession(signupResponse);
    }
  } catch (error) {
    // If signup fails (most likely user already exists), attempt login
    try {
      const loginResponse = await client.request('/auth/v1/token?grant_type=password', {
        method: 'POST',
        body: { email: testEmail, password: testPass },
      });
      realSession = toSession(loginResponse);
    } catch (loginError) {
      fail(
        'Realtime RLS: real user authentication failed. If testing locally, ensure email confirmation is disabled on your Supabase project (Authentication -> Provider Settings).',
        loginError
      );
    }
  }

  if (!realSession) {
    fail('Realtime RLS: signup succeeded but did not return a session access token (email confirmation is likely enabled).');
  }

  try {
    await testRealtimeChannel(realSession, realSession.user.id, true);
    ok('Realtime RLS: authenticated subscription approved');
  } catch (error) {
    fail('Realtime RLS: authenticated subscription check failed', error);
  }

  // Test 3: Authenticated User A cannot subscribe to User B's channel
  try {
    await testRealtimeChannel(realSession, session.user.id, false);
    ok("Realtime RLS: User A rejected from subscribing to User B's channel");
  } catch (error) {
    fail("Realtime RLS: User A cross-subscription security check failed", error);
  }

  cleanups.push(async () => {
    try {
      await client.request('/auth/v1/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${realSession.access_token}` },
      });
    } catch {
      // ignore logout failure on cleanup
    }
  });

  console.log(`\nAll ${passed} checks passed.`);
} catch (error) {
  if (!(error instanceof VerificationAbort)) {
    console.error('\nUnexpected failure:', error);
    process.exitCode = 1;
  }
  console.error(`\nStopped after ${passed} passing check(s).`);
} finally {
  let cleaned = 0;
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
      cleaned += 1;
    } catch {
      // best-effort cleanup
    }
  }
  if (cleanups.length > 0) {
    console.log(`Cleanup: ${cleaned}/${cleanups.length} steps completed.`);
  }
}
