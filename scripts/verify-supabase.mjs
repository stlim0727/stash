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
  if (!restored || restored.user.id !== session.user.id) {
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
