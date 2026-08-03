import { act, render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

// Sentry STASH-4W: the AI-suggestions breakdown row must swap in
// "quota reached" copy (no reset time — that's already shown elsewhere, see
// settings.aiQuotaExceeded) once a live 429 sets `aiQuotaExceeded`. Driving
// that state for real needs an authenticated session and a mocked API (the
// same harness ai-enrichment-store.test.tsx uses), which is heavier than the
// no-session harness in settings-sync-breakdown.test.tsx covers the rest of
// the STASH-4W logic — split into its own file for that reason.
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);

const mockSession = {
  access_token: 'token',
  refresh_token: 'refresh',
  token_type: 'bearer',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'user-test' },
};

jest.mock('@/supabase/auth-provider', () => ({
  useSupabaseAuth: () => ({
    status: 'anonymous',
    session: mockSession,
    isSignedIn: true,
    userId: mockSession.user.id,
    email: null,
    displayName: null,
    avatarUrl: null,
    message: null,
    signIn: jest.fn(async () => ({ ok: true })),
    signOut: jest.fn(async () => {}),
    ensureAnonymousSession: jest.fn(async () => mockSession),
  }),
  SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
}));

// Never resolves: keeps a metadata-pending fixture stable (see the same note
// in settings-sync-breakdown.test.tsx) — this file also needs it to keep a
// freshly-added bookmark's own metadata pending for the duration of the test.
jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: () => new Promise(() => {}),
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));
jest.mock('@/share/export-data', () => ({ deliverExport: jest.fn(async () => {}) }));

jest.mock('@/api/bookmarks', () => {
  const empty = async () => [];
  const requestEnrichment = jest.fn(async (bookmarkId: string) => ({
    id: 'enrichment-new',
    bookmark_id: bookmarkId,
    user_id: 'user-test',
    summary: null,
    topics: [],
    suggested_tags: [],
    suggested_collection_id: null,
    suggested_collection_name: null,
    model: 'dummy-v0',
    status: 'complete',
    confidence: null,
    degraded: false,
    degraded_reason: null,
    created_at: '2026-08-03T00:00:00.000Z',
    updated_at: '2026-08-03T00:00:00.000Z',
  }));
  const addTags = jest.fn(async ({ tags, source }: { tags: string[]; source: string }) =>
    tags.map((name) => ({
      id: `tag-${name}`,
      user_id: 'user-test',
      name,
      slug: name,
      source,
      created_at: '2026-08-03T00:00:00.000Z',
    })),
  );
  const updateBookmark = jest.fn(async () => undefined);
  const listBookmarkIds = jest.fn(async () => [] as string[]);
  // Never resolves: keeps a freshly-queued create's sync_status 'pending'
  // (isSyncable) for the whole test, so the "Waiting to upload" stage stays
  // non-zero.
  const createBookmark = jest.fn(() => new Promise(() => {}));
  const createBookmarks = jest.fn(
    async (inputs: Array<{ id?: string }>) =>
      inputs.map((input) => ({
        bookmark_id: input.id ?? '00000000-0000-4000-8000-000000000000',
        status: 'created' as const,
        metadata_status: 'pending' as const,
      })),
  );
  const listEnrichmentsUpdatedSince = jest.fn(async () => [] as unknown[]);
  const enqueuePendingEnrichment = jest.fn(async () => {});
  const fetchPendingEnrichmentStatuses = jest.fn(
    async (bookmarkIds: string[]) =>
      bookmarkIds.map((bookmark_id) => ({ bookmark_id, status: 'pending' })),
  );
  const createBookmarkApi = jest.fn(() => ({
    requestEnrichment,
    addTags,
    createBookmark,
    createBookmarks,
    updateBookmark,
    listBookmarksUpdatedSince: empty,
    listBookmarkIds,
    listEnrichmentsUpdatedSince,
    listTags: empty,
    listBookmarkTags: empty,
    listCollections: empty,
    enqueuePendingEnrichment,
    fetchPendingEnrichmentStatuses,
  }));
  return {
    __spies: { requestEnrichment, createBookmark, listBookmarkIds },
    createBookmarkApi,
  };
});

import SettingsScreen from '@/app/settings';
import { BookmarksProvider, useBookmarks } from '@/store/bookmarks';
import { SupabaseRequestError } from '@/supabase/client';
import { makeStoredBookmark, type FakeRepositoryModule } from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;
const apiMock = jest.requireMock('@/api/bookmarks') as {
  __spies: { requestEnrichment: jest.Mock; createBookmark: jest.Mock; listBookmarkIds: jest.Mock };
};

const AI_TRIGGER_ID = '7e64cf1e-0000-4000-8000-000000000001';
const METADATA_PENDING_ID = '7e64cf1e-0000-4000-8000-000000000002';

type Store = ReturnType<typeof useBookmarks>;

beforeEach(() => {
  jest.clearAllMocks();
  fakeRepo.__reset([]);
});

test('AI quota reached: the AI breakdown row uses the quota-reached copy (no reset time) alongside other active stages (STASH-4W)', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({ id: AI_TRIGGER_ID, metadata_status: 'complete' }),
    makeStoredBookmark({ id: METADATA_PENDING_ID, metadata_status: 'pending' }),
  ]);
  await fakeRepo.repository.setMeta('pending_ai_trigger', JSON.stringify([AI_TRIGGER_ID]));
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    throw new SupabaseRequestError('Supabase request failed with HTTP 429', 429, 'hourly_limit', 30);
  });

  const storeRef: { current: Store | null } = { current: null };
  function Probe() {
    storeRef.current = useBookmarks();
    return null;
  }

  const screen = await render(
    <BookmarksProvider>
      <Probe />
      <SettingsScreen />
    </BookmarksProvider>,
  );

  // Let the startup pull settle first (mirrors sync-paused.test.tsx) so its
  // own state updates land before the test proceeds, instead of leaking into
  // later act() batches.
  await waitFor(() => expect(storeRef.current?.isLoading).toBe(false));
  await waitFor(() => expect(storeRef.current?.lastPulledAt).not.toBeNull());

  // The deferred auto-AI-trigger effect fires requestAiEnrichment on mount
  // (pending_ai_trigger is seeded and the bookmark's metadata is already
  // complete), which 429s and sets aiQuotaExceeded.
  await waitFor(() => expect(storeRef.current!.aiQuotaExceeded).not.toBeNull());

  // Now queue a second, unrelated create — its upload hangs (mocked
  // createBookmark never resolves), keeping "Waiting to upload" non-zero for
  // the rest of the test without racing the AI dispatch loop (which defers AI
  // work until the sync queue is clear — see the deferred-dispatch effect).
  await act(async () => {
    storeRef.current!.addBookmark({ url: 'https://example.com/still-uploading' });
  });

  await waitFor(() => expect(screen.getByText('Waiting to upload')).toBeTruthy());
  expect(screen.getByText('Fetching info')).toBeTruthy();
  // "AI suggestions" is ambiguous with the Preferences mode-selector row's
  // own label — its unique quota-reached value text below is the real check.
  expect(screen.getAllByText('AI suggestions').length).toBeGreaterThanOrEqual(2);
  // Deliberately no reset time in the breakdown row's own copy — that's
  // shown separately by the pre-existing Preferences settings.aiQuotaExceeded
  // row (also visible here), whose formatting this must not duplicate.
  expect(screen.getByText('1 bookmark · quota reached')).toBeTruthy();
});
