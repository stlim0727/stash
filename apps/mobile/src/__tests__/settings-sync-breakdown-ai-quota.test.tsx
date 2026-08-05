import { render, waitFor, within } from '@testing-library/react-native';
import type { ReactNode } from 'react';

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
jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: async () => ({ patch: {}, metadata_status: 'complete' }),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: jest.fn(),
    navigate: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
  }),
}));
jest.mock('@/share/export-data', () => ({ deliverExport: jest.fn(async () => {}) }));

jest.mock('@/api/bookmarks', () => {
  const empty = async () => [];
  const requestEnrichment = jest.fn();
  const createBookmarkApi = jest.fn(() => ({
    requestEnrichment,
    addTags: empty,
    createBookmark: jest.fn(),
    createBookmarks: jest.fn(async () => []),
    updateBookmark: jest.fn(),
    listBookmarksUpdatedSince: empty,
    listBookmarkIds: empty,
    listEnrichmentsUpdatedSince: empty,
    listTags: empty,
    listBookmarkTags: empty,
    listCollections: empty,
    enqueuePendingEnrichment: jest.fn(async () => {}),
    fetchPendingEnrichmentStatuses: jest.fn(async () => []),
    fetchAiQueueSnapshot: jest.fn(async () => []),
  }));
  return {
    __spies: { requestEnrichment },
    createBookmarkApi,
  };
});

import SettingsScreen from '@/app/settings';
import { BookmarksProvider, useBookmarks } from '@/store/bookmarks';
import { SupabaseRequestError } from '@/supabase/client';
import {
  makeStoredBookmark,
  type FakeRepositoryModule,
} from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;
const apiMock = jest.requireMock('@/api/bookmarks') as {
  __spies: { requestEnrichment: jest.Mock };
};

const AI_TRIGGER_ID = '7e64cf1e-0000-4000-8000-000000000001';
type Store = ReturnType<typeof useBookmarks>;

function expectedResetTime(retryAt: number): string {
  const isToday = new Date(retryAt).toDateString() === new Date().toDateString();
  return new Date(retryAt).toLocaleString(
    'en',
    isToday
      ? { hour: 'numeric', minute: '2-digit' }
      : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  fakeRepo.__reset([]);
});

test('AI quota is a modifier on the exclusive AI count and includes its reset time', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({ id: AI_TRIGGER_ID, metadata_status: 'complete' }),
  ]);
  await fakeRepo.repository.setMeta(
    'pending_ai_trigger',
    JSON.stringify([AI_TRIGGER_ID]),
  );
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    throw new SupabaseRequestError(
      'Supabase request failed with HTTP 429',
      429,
      'hourly_limit',
      30,
    );
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

  await waitFor(() => expect(storeRef.current?.isLoading).toBe(false));
  await waitFor(() => expect(storeRef.current!.aiQuotaExceeded).not.toBeNull());

  const resetTime = expectedResetTime(storeRef.current!.aiQuotaExceeded!.retryAt);
  expect(
    within(screen.getByTestId('processing-stage-ai')).getByText(
      `1 bookmark · resumes ${resetTime}`,
    ),
  ).toBeTruthy();
  expect(
    within(screen.getByTestId('processing-summary')).getByText(
      '1 bookmark remaining',
    ),
  ).toBeTruthy();
});
