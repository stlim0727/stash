import { fireEvent, render, waitFor } from '@testing-library/react-native';
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

const mockNavigate = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ navigate: mockNavigate, push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
  // The detail screen reads the bookmark id from the route.
  useLocalSearchParams: () => ({ id: 'bookmark-raindrop' }),
}));

import BookmarkDetailScreen from '@/app/bookmark/[id]';
import { BookmarksProvider } from '@/store/bookmarks';
import type { FakeRepositoryModule } from './helpers/fake-repository';
import { makeStoredBookmark } from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

function renderDetail() {
  return render(
    <BookmarksProvider>
      <BookmarkDetailScreen />
    </BookmarksProvider>,
  );
}

test('tapping a tag chip navigates to the Inbox filtered by that tag', async () => {
  // The seeded sample "bookmark-raindrop" carries the mock tag "design".
  fakeRepo.__reset([makeStoredBookmark({ id: 'bookmark-raindrop', title: 'Raindrop review' })]);

  const screen = await renderDetail();
  await waitFor(() => expect(screen.getByText('Raindrop review')).toBeTruthy());

  await fireEvent.press(screen.getByLabelText('Browse #design'));

  expect(mockNavigate).toHaveBeenCalledWith({ pathname: '/', params: { tag: 'tag-design' } });
});
