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
import { makeEnrichment, makeStoredBookmark, type FakeRepositoryModule } from './helpers/fake-repository';
import type { AIEnrichment, Bookmark, LocalPendingBookmark } from '@/domain/types';
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
  enrichments?: AIEnrichment[];
}) {
  fakeRepo.__reset(options.rows ?? [], options.seedTagData, options.enrichments ?? []);
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

test('uploading-only leaves the activity strip empty — the headline already reports that exact count (the duplicate-counter bug this redesign fixes)', async () => {
  await seed({ queue: [pendingUploadEntry('up-1')] });

  const screen = await renderSettings();
  await waitFor(() => expect(screen.getByText('1 item waiting to upload')).toBeTruthy());

  expect(screen.queryByTestId('activity-strip')).toBeNull();
  expect(screen.queryByText('Waiting to upload')).toBeNull();
  expect(screen.queryByText('Fetching info')).toBeNull();
});

test('a lone metadata-only chip still renders on its own — the headline never mentions it otherwise (Codex review, PR #670)', async () => {
  await seed({
    rows: [makeStoredBookmark({ id: 'bm-metadata-pending', metadata_status: 'pending' })],
  });

  const screen = await renderSettings();
  await waitFor(() => expect(screen.getByText('All backed up')).toBeTruthy());

  expect(screen.getByText('Fetching info')).toBeTruthy();
  expect(screen.getByText('· 1')).toBeTruthy();
  expect(screen.queryByText('Waiting to upload')).toBeNull();
});

test('an active upload queue never repeats its own count as a second chip — only the independently-active metadata pipeline gets one', async () => {
  await seed({
    rows: [makeStoredBookmark({ id: 'bm-metadata-pending', metadata_status: 'pending' })],
    queue: [pendingUploadEntry('up-1')],
  });

  const screen = await renderSettings();
  // Headline is unaffected by the strip — still just the upload count.
  await waitFor(() => expect(screen.getByText('1 item waiting to upload')).toBeTruthy());

  expect(screen.queryByText('Waiting to upload')).toBeNull();
  expect(screen.getByText('Fetching info')).toBeTruthy();
  expect(screen.getByText('· 1')).toBeTruthy();
});

test('all three pipelines active at once never shows the upload count twice — the exact scenario from the user report (headline + a duplicate "Waiting to upload" row)', async () => {
  await seed({
    rows: [makeStoredBookmark({ id: 'bm-metadata-pending', metadata_status: 'pending' })],
    queue: [pendingUploadEntry('up-1')],
    meta: { pending_ai_trigger: JSON.stringify(['bm-ai-1', 'bm-ai-2']) },
  });

  const screen = await renderSettings();
  await waitFor(() => expect(screen.getByText('1 item waiting to upload')).toBeTruthy());

  // The headline's own upload count renders exactly once on screen — no
  // second "1 item waiting to upload"/"Waiting to upload" chip repeats it.
  expect(screen.getAllByText('1 item waiting to upload')).toHaveLength(1);
  expect(screen.queryByText('Waiting to upload')).toBeNull();
  // Only the metadata and AI chips render, each with their OWN independent
  // count (never the upload count).
  expect(screen.getByText('Fetching info')).toBeTruthy();
  // "AI suggestions" is ambiguous with the Preferences mode-selector row's
  // label, so both are expected here (mode-selector row + the chip itself).
  expect(screen.getAllByText('AI suggestions')).toHaveLength(2);
  expect(screen.getByText('· 1')).toBeTruthy();
  expect(screen.getByText('· 2')).toBeTruthy();
});

test('sync caught up but metadata/AI still working: headline says "All backed up" yet the strip still shows chips (the STASH-4W bug this fixes)', async () => {
  await seed({
    rows: [makeStoredBookmark({ id: 'bm-metadata-pending', metadata_status: 'pending' })],
    meta: { pending_ai_trigger: JSON.stringify(['bm-ai-1']) },
  });

  const screen = await renderSettings();
  await waitFor(() => expect(screen.getByText('All backed up')).toBeTruthy());

  expect(screen.getByText('Fetching info')).toBeTruthy();
  // Fetching-info's chip and the AI chip both happen to count 1 here
  // (metadata todo=1, AI todo=1) — assert both counts are present.
  expect(screen.getAllByText('· 1')).toHaveLength(2);
});

test('paused excludes the upload chip (nothing is actually uploading — there never was one) but keeps independently-running background chips visible (Codex review, PR #670)', async () => {
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

test('paused with only the upload queue non-empty (no independent background work) shows an empty strip', async () => {
  await seed({
    queue: [pendingUploadEntry('up-1')],
    meta: { 'pref.sync.paused': 'true' },
  });

  const screen = await renderSettings();
  await waitFor(() => expect(screen.getByText('Paused — 1 item waiting')).toBeTruthy());

  expect(screen.queryByTestId('activity-strip')).toBeNull();
  expect(screen.queryByText('Waiting to upload')).toBeNull();
  expect(screen.queryByText('Fetching info')).toBeNull();
});

test('paused with a non-empty queue caps the AI chip count at server-queued only — local trigger/dispatch/retry work is genuinely blocked until sync resumes (Codex review, PR #670)', async () => {
  await seed({
    rows: [makeStoredBookmark({ id: 'bm-metadata-pending', metadata_status: 'pending' })],
    queue: [pendingUploadEntry('up-1')],
    meta: {
      'pref.sync.paused': 'true',
      // Two local triggers, but only one is confirmed server-queued — the AI
      // dispatch loop can't drain the other while the queue above is stuck
      // pending (it early-returns whenever any entry is pending/syncing), so
      // the AI chip must report 1 (server-queued), not 2 (the full union).
      pending_ai_trigger: JSON.stringify(['bm-ai-1', 'bm-ai-2']),
      ai_server_queued: JSON.stringify(['bm-ai-1']),
    },
  });

  const screen = await renderSettings();
  await waitFor(() => expect(screen.getByText('Paused — 1 item waiting')).toBeTruthy());

  expect(screen.getByText('Fetching info')).toBeTruthy();
  expect(screen.getAllByText('AI suggestions')).toHaveLength(2);
  // Fetching info (metadata todo=1) and the AI chip (server-queued only, not
  // the full local union of 2) both read "· 1".
  expect(screen.getAllByText('· 1')).toHaveLength(2);
  expect(screen.queryByText('· 2')).toBeNull();
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

  // A lone AI chip still renders on its own (earlier fix), and — unlike the
  // sibling "genuinely blocked" test above — its count is the full local
  // union (2), not capped to server-queued (1): a failed entry can't clear
  // the drain loop's pending/syncing gate, so it was never actually blocking.
  expect(screen.getByText('· 2')).toBeTruthy();
  expect(screen.queryByText('Waiting to upload')).toBeNull();
});

test('local-only (not signed in) suppresses the strip even with multiple non-zero pipelines', async () => {
  mockAuth.status = 'not_configured';
  mockAuth.isSignedIn = false;
  await seed({
    rows: [makeStoredBookmark({ id: 'bm-metadata-pending', metadata_status: 'pending' })],
    queue: [pendingUploadEntry('up-1')],
    meta: { pending_ai_trigger: JSON.stringify(['bm-ai-1']) },
  });

  const screen = await renderSettings();
  await waitFor(() => expect(screen.getByText('Local only')).toBeTruthy());

  expect(screen.queryByTestId('activity-strip')).toBeNull();
  expect(screen.queryByText('Waiting to upload')).toBeNull();
  expect(screen.queryByText('Fetching info')).toBeNull();
});

test('AI suggestions off excludes the AI chip but still shows the metadata chip when it is active (upload never gets its own chip either way)', async () => {
  await seed({
    rows: [makeStoredBookmark({ id: 'bm-metadata-pending', metadata_status: 'pending' })],
    queue: [pendingUploadEntry('up-1')],
    meta: {
      [AI_SUGGESTIONS_MODE_PREF_KEY]: 'off',
      // A real AI backlog exists, but 'off' mode must exclude it from the strip.
      pending_ai_trigger: JSON.stringify(['bm-ai-1', 'bm-ai-2']),
    },
  });

  const screen = await renderSettings();
  await waitFor(() => expect(screen.getByText('Off — never auto-suggest')).toBeTruthy());

  expect(screen.queryByText('Waiting to upload')).toBeNull();
  expect(screen.getByText('Fetching info')).toBeTruthy();
  expect(screen.getByText('· 1')).toBeTruthy();
  // Only the mode-selector row's own label remains — no AI chip in the strip.
  expect(screen.getAllByText('AI suggestions')).toHaveLength(1);
});

test('no rate-limited-degraded enrichments leaves the degraded-results chip absent', async () => {
  await seed({
    rows: [makeStoredBookmark({ id: 'bm-clean' })],
    enrichments: [
      makeEnrichment({ id: 'enr-clean', bookmark_id: 'bm-clean', degraded: false, degraded_reason: null }),
    ],
  });

  const screen = await renderSettings();
  await waitFor(() => expect(screen.getByText('All backed up')).toBeTruthy());

  expect(screen.queryByTestId('activity-chip-degraded')).toBeNull();
  expect(screen.queryByTestId('activity-strip')).toBeNull();
});

test('a rate-limited-degraded enrichment on load shows the degraded-results chip on its own, with no other pipeline active', async () => {
  await seed({
    rows: [makeStoredBookmark({ id: 'bm-degraded' })],
    enrichments: [
      makeEnrichment({
        id: 'enr-degraded',
        bookmark_id: 'bm-degraded',
        degraded: true,
        degraded_reason: 'rate_limited',
      }),
    ],
  });

  const screen = await renderSettings();
  await waitFor(() => expect(screen.getByText('All backed up')).toBeTruthy());

  expect(screen.getByTestId('activity-chip-degraded')).toBeTruthy();
  expect(screen.getByText('Basic suggestions shown')).toBeTruthy();
  expect(screen.getByText('· 1')).toBeTruthy();
  expect(screen.queryByTestId('activity-chip-ai')).toBeNull();
  expect(screen.queryByTestId('activity-chip-metadata')).toBeNull();
});
