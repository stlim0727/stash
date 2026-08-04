import { render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

// Sentry STASH-4W: the single headline "N syncing" number doesn't distinguish
// upload vs. metadata-fetch vs. AI-tagging work. These tests drive the store
// with a mutable auth mock that (deliberately, like settings-account.test.tsx)
// carries no `session` field — every store code path that would attempt a
// real network call gates on `auth.session` and no-ops without one, so
// seeded queue/meta state stays put for the whole test instead of draining.
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);

const mockAuth = {
  status: 'anonymous' as 'anonymous' | 'authenticated' | 'not_configured',
  email: null as string | null,
  displayName: null as string | null,
  avatarUrl: null as string | null,
  isSignedIn: true,
  userId: 'user-1' as string | null,
  message: '',
  signIn: jest.fn(async () => ({ ok: true })),
  signOut: jest.fn(async () => {}),
  ensureAnonymousSession: jest.fn(async () => null),
};
jest.mock('@/supabase/auth-provider', () => ({
  useSupabaseAuth: () => mockAuth,
  SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
}));
// Never resolves: the store's background-enrichment effect (any loaded
// bookmark with metadata_status 'pending' gets re-enriched on mount) would
// otherwise instantly "repair" the metadata-pending fixtures these tests seed
// to exercise the "Fetching info" stage, before assertions ever run.
jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: () => new Promise(() => {}),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));
jest.mock('@/share/export-data', () => ({ deliverExport: jest.fn(async () => {}) }));

import SettingsScreen from '@/app/settings';
import { AI_SUGGESTIONS_MODE_PREF_KEY } from '@/domain/ai-suggestions-pref';
import { BookmarksProvider } from '@/store/bookmarks';
import { makeStoredBookmark, type FakeRepositoryModule } from './helpers/fake-repository';
import type { Bookmark, LocalPendingBookmark } from '@/domain/types';
import type { TagData } from '@/storage/types';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

function renderSettings() {
  return render(
    <BookmarksProvider>
      <SettingsScreen />
    </BookmarksProvider>,
  );
}

const NOW = '2026-08-03T00:00:00.000Z';

function pendingUploadEntry(localId: string): LocalPendingBookmark {
  return {
    local_id: localId,
    remote_id: null,
    operation: 'create',
    payload: { id: localId, url: `https://example.com/${localId}` },
    sync_status: 'pending',
    retry_count: 0,
    last_error: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function failedUploadEntry(localId: string): LocalPendingBookmark {
  return {
    ...pendingUploadEntry(localId),
    sync_status: 'failed',
    last_error: 'network error',
  };
}

/** Seeds the fake repository's bookmarks/queue/meta in one go — `__reset`
 *  wipes ALL of those, so seeding must happen in a single call rather than
 *  several `__reset`/`enqueue`/`setMeta` calls in sequence. */
async function seed(options: {
  rows?: Bookmark[];
  seedTagData?: TagData;
  queue?: LocalPendingBookmark[];
  meta?: Record<string, string>;
}) {
  fakeRepo.__reset(options.rows ?? [], options.seedTagData);
  for (const entry of options.queue ?? []) {
    await fakeRepo.repository.enqueue(entry);
  }
  for (const [key, value] of Object.entries(options.meta ?? {})) {
    await fakeRepo.repository.setMeta(key, value);
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  fakeRepo.__reset([]);
  mockAuth.status = 'anonymous';
  mockAuth.isSignedIn = true;
});

test('a single active pipeline (uploading only) renders no breakdown rows', async () => {
  await seed({ queue: [pendingUploadEntry('up-1')] });

  const screen = await renderSettings();
  await waitFor(() => expect(screen.getByText('1 item waiting to upload')).toBeTruthy());

  expect(screen.queryByText('Waiting to upload')).toBeNull();
  expect(screen.queryByText('Fetching info')).toBeNull();
});

test('a lone metadata-only stage still renders on its own — the headline never mentions it otherwise (Codex review, PR #670)', async () => {
  await seed({
    rows: [makeStoredBookmark({ id: 'bm-metadata-pending', metadata_status: 'pending' })],
  });

  const screen = await renderSettings();
  await waitFor(() => expect(screen.getByText('All backed up')).toBeTruthy());

  expect(screen.getByText('Fetching info')).toBeTruthy();
  expect(screen.getByText('1 bookmark')).toBeTruthy();
  expect(screen.queryByText('Waiting to upload')).toBeNull();
});

test('two active pipelines (uploading + fetching info) render both breakdown rows with their own counts', async () => {
  await seed({
    rows: [makeStoredBookmark({ id: 'bm-metadata-pending', metadata_status: 'pending' })],
    queue: [pendingUploadEntry('up-1')],
  });

  const screen = await renderSettings();
  // Headline is unaffected by the breakdown — still just the upload count.
  await waitFor(() => expect(screen.getByText('1 item waiting to upload')).toBeTruthy());

  expect(screen.getByText('Waiting to upload')).toBeTruthy();
  expect(screen.getByText('Fetching info')).toBeTruthy();
  // Both stages happen to have a count of 1 bookmark each.
  expect(screen.getAllByText('1 bookmark')).toHaveLength(2);
});

test('three active pipelines (uploading + fetching info + AI) render in fixed order with independent counts', async () => {
  await seed({
    rows: [makeStoredBookmark({ id: 'bm-metadata-pending', metadata_status: 'pending' })],
    queue: [pendingUploadEntry('up-1')],
    meta: { pending_ai_trigger: JSON.stringify(['bm-ai-1', 'bm-ai-2']) },
  });

  const screen = await renderSettings();
  await waitFor(() => expect(screen.getByText('1 item waiting to upload')).toBeTruthy());

  expect(screen.getByText('Waiting to upload')).toBeTruthy();
  expect(screen.getByText('Fetching info')).toBeTruthy();
  // "AI suggestions" is ambiguous with the Preferences mode-selector row's
  // label, so assert on the breakdown row's own (unique) value text instead.
  expect(screen.getAllByText('AI suggestions')).toHaveLength(2);
  expect(screen.getByText('2 bookmarks')).toBeTruthy();
});

test('sync caught up but metadata/AI still working: headline says "All backed up" yet the breakdown still shows (the STASH-4W bug this fixes)', async () => {
  await seed({
    rows: [makeStoredBookmark({ id: 'bm-metadata-pending', metadata_status: 'pending' })],
    meta: { pending_ai_trigger: JSON.stringify(['bm-ai-1']) },
  });

  const screen = await renderSettings();
  await waitFor(() => expect(screen.getByText('All backed up')).toBeTruthy());

  expect(screen.getByText('Fetching info')).toBeTruthy();
  // Fetching-info's own row plus the AI breakdown row both happen to read
  // "1 bookmark" here (metadata todo=1, AI todo=1) — assert both are present.
  expect(screen.getAllByText('1 bookmark')).toHaveLength(2);
});

test('paused excludes the upload stage (nothing is actually uploading) but keeps independently-running background stages visible (Codex review, PR #670)', async () => {
  await seed({
    rows: [makeStoredBookmark({ id: 'bm-metadata-pending', metadata_status: 'pending' })],
    queue: [pendingUploadEntry('up-1')],
    meta: { 'pref.sync.paused': 'true' },
  });

  const screen = await renderSettings();
  await waitFor(() => expect(screen.getByText('Paused — 1 item waiting')).toBeTruthy());

  // "Pause sync" only gates the upload/pull network phases — metadata
  // enrichment (enrichInBackground) is never paused, so it must stay visible
  // even though the headline is in its paused state.
  expect(screen.getByText('Fetching info')).toBeTruthy();
  expect(screen.queryByText('Waiting to upload')).toBeNull();
});

test('paused with only the upload queue non-empty (no independent background work) shows no breakdown', async () => {
  await seed({
    queue: [pendingUploadEntry('up-1')],
    meta: { 'pref.sync.paused': 'true' },
  });

  const screen = await renderSettings();
  await waitFor(() => expect(screen.getByText('Paused — 1 item waiting')).toBeTruthy());

  expect(screen.queryByText('Waiting to upload')).toBeNull();
  expect(screen.queryByText('Fetching info')).toBeNull();
});

test('paused with a non-empty queue caps the AI count at server-queued only — local trigger/dispatch/retry work is genuinely blocked until sync resumes (Codex review, PR #670)', async () => {
  await seed({
    rows: [makeStoredBookmark({ id: 'bm-metadata-pending', metadata_status: 'pending' })],
    queue: [pendingUploadEntry('up-1')],
    meta: {
      'pref.sync.paused': 'true',
      // Two local triggers, but only one is confirmed server-queued — the AI
      // dispatch loop can't drain the other while the queue above is stuck
      // pending (it early-returns whenever any entry is pending/syncing), so
      // the breakdown must report 1 (server-queued), not 2 (the full union).
      pending_ai_trigger: JSON.stringify(['bm-ai-1', 'bm-ai-2']),
      ai_server_queued: JSON.stringify(['bm-ai-1']),
    },
  });

  const screen = await renderSettings();
  await waitFor(() => expect(screen.getByText('Paused — 1 item waiting')).toBeTruthy());

  expect(screen.getByText('Fetching info')).toBeTruthy();
  expect(screen.getAllByText('AI suggestions')).toHaveLength(2);
  // "Fetching info" reads "1 bookmark" (metadata todo=1). The AI row's own
  // count is 1 bookmark too (server-queued only, not 2 — the full local
  // union), but paused-with-a-blocking-queue is a genuinely blocked state, so
  // its value carries that context instead of a bare count.
  expect(screen.getByText('1 bookmark')).toBeTruthy();
  expect(
    screen.getByText('1 bookmark · paused with sync — resumes when you resume sync'),
  ).toBeTruthy();
  expect(screen.queryByText('2 bookmarks')).toBeNull();
});

test('paused with only a failed (not pending/syncing) queue entry does not block local AI work — the drain loop only gates on pending/syncing (Codex review, PR #670)', async () => {
  await seed({
    queue: [failedUploadEntry('up-1')],
    meta: {
      'pref.sync.paused': 'true',
      pending_ai_trigger: JSON.stringify(['bm-ai-1', 'bm-ai-2']),
      ai_server_queued: JSON.stringify(['bm-ai-1']),
    },
  });

  const screen = await renderSettings();
  await waitFor(() => expect(screen.getByText('Paused — 1 item waiting')).toBeTruthy());

  // A lone AI stage still renders on its own (earlier fix), and — unlike the
  // sibling "genuinely blocked" test above — its count is the full local
  // union (2), not capped to server-queued (1): a failed entry can't clear
  // the drain loop's pending/syncing gate, so it was never actually blocking.
  expect(screen.getByText('2 bookmarks')).toBeTruthy();
  expect(screen.queryByText('Waiting to upload')).toBeNull();
});

test('local-only (not signed in) suppresses the breakdown even with multiple non-zero stages', async () => {
  mockAuth.status = 'not_configured';
  mockAuth.isSignedIn = false;
  await seed({
    rows: [makeStoredBookmark({ id: 'bm-metadata-pending', metadata_status: 'pending' })],
    queue: [pendingUploadEntry('up-1')],
    meta: { pending_ai_trigger: JSON.stringify(['bm-ai-1']) },
  });

  const screen = await renderSettings();
  await waitFor(() => expect(screen.getByText('Local only')).toBeTruthy());

  expect(screen.queryByText('Waiting to upload')).toBeNull();
  expect(screen.queryByText('Fetching info')).toBeNull();
});

test('AI suggestions off excludes the AI row but still shows upload+metadata when both are active', async () => {
  await seed({
    rows: [makeStoredBookmark({ id: 'bm-metadata-pending', metadata_status: 'pending' })],
    queue: [pendingUploadEntry('up-1')],
    meta: {
      [AI_SUGGESTIONS_MODE_PREF_KEY]: 'off',
      // A real AI backlog exists, but 'off' mode must exclude it from the breakdown.
      pending_ai_trigger: JSON.stringify(['bm-ai-1', 'bm-ai-2']),
    },
  });

  const screen = await renderSettings();
  await waitFor(() => expect(screen.getByText('Off — never auto-suggest')).toBeTruthy());

  expect(screen.getByText('Waiting to upload')).toBeTruthy();
  expect(screen.getByText('Fetching info')).toBeTruthy();
  // Only the mode-selector row's own label remains — no breakdown AI row.
  expect(screen.getAllByText('AI suggestions')).toHaveLength(1);
});
