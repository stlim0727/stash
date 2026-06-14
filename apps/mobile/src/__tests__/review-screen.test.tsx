import { render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);
jest.mock('@/supabase/auth-provider', () => ({
  useSupabaseAuth: () => ({
    status: 'not_configured',
    session: null,
    userId: null,
    message: 'not configured',
    ensureAnonymousSession: async () => null,
  }),
  SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: async () => ({ patch: {}, metadata_status: 'complete' }),
}));
jest.mock('expo-router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
  useRouter: () => ({ push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({}),
}));

import ReviewScreen from '@/app/review';
import { BookmarksProvider } from '@/store/bookmarks';
import type { FakeRepositoryModule } from './helpers/fake-repository';
import { makeEnrichment, makeStoredBookmark } from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

function renderReview() {
  return render(
    <BookmarksProvider>
      <ReviewScreen />
    </BookmarksProvider>,
  );
}

test('lists bookmarks with pending high-confidence suggestions and their chips', async () => {
  const id = '7e64cf1e-0000-4000-8000-0000000000a1';
  fakeRepo.__reset(
    [makeStoredBookmark({ id, title: 'A bookmark to review' })],
    undefined,
    [
      makeEnrichment({
        bookmark_id: id,
        suggested_tags: [
          { name: 'design', confidence: 0.9 },
          { name: 'video', confidence: 0.7 },
          // Below the 0.6 threshold — must not appear.
          { name: 'noise', confidence: 0.3 },
        ],
      }),
    ],
  );

  const screen = await renderReview();

  await waitFor(() => expect(screen.getByText('A bookmark to review')).toBeTruthy());
  expect(screen.getByText('＋ design')).toBeTruthy();
  expect(screen.getByText('＋ video')).toBeTruthy();
  expect(screen.queryByText('＋ noise')).toBeNull();
  // Two suggestions -> an "Accept all" affordance.
  expect(screen.getByText('Accept all')).toBeTruthy();
});

test('shows the empty state when nothing is pending', async () => {
  fakeRepo.__reset([makeStoredBookmark({ title: 'Plain bookmark' })]);

  const screen = await renderReview();

  await waitFor(() => expect(screen.getByText('No suggestions to review.')).toBeTruthy());
});
