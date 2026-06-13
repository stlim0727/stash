import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Linking } from 'react-native';

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
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));

import InboxScreen from '@/app/index';
import { BookmarksProvider } from '@/store/bookmarks';
import type { FakeRepositoryModule } from './helpers/fake-repository';
import { makeStoredBookmark } from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

function renderInbox() {
  return render(
    <BookmarksProvider>
      <InboxScreen />
    </BookmarksProvider>,
  );
}

test('renders stored bookmarks with their titles', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-00000000000a',
      title: 'Local-first software',
      url: 'https://www.inkandswitch.com/local-first/',
      url_hash: 'https://www.inkandswitch.com/local-first/',
    }),
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-00000000000b',
      title: 'Raindrop review',
      url: 'https://raindrop.io/',
      url_hash: 'https://raindrop.io/',
    }),
  ]);

  const screen = await renderInbox();

  await waitFor(() => expect(screen.getByText('Local-first software')).toBeTruthy());
  expect(screen.getByText('Raindrop review')).toBeTruthy();
});

test('search filters the list and shows the match count', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-00000000000a',
      title: 'Local-first software',
      url: 'https://www.inkandswitch.com/local-first/',
      url_hash: 'https://www.inkandswitch.com/local-first/',
    }),
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-00000000000b',
      title: 'Raindrop review',
      url: 'https://raindrop.io/',
      url_hash: 'https://raindrop.io/',
    }),
  ]);

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Raindrop review')).toBeTruthy());

  await fireEvent.changeText(screen.getByPlaceholderText('Search title, notes, or URL'), 'local-first');

  expect(screen.getByText('Matches (1)')).toBeTruthy();
  expect(screen.getByText('Local-first software')).toBeTruthy();
  expect(screen.queryByText('Raindrop review')).toBeNull();
});

test('the card Open action opens the bookmark URL in the system browser', async () => {
  const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  fakeRepo.__reset([
    makeStoredBookmark({
      title: 'Local-first software',
      url: 'https://www.inkandswitch.com/local-first/',
      url_hash: 'https://www.inkandswitch.com/local-first/',
    }),
  ]);

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Local-first software')).toBeTruthy());

  await fireEvent.press(screen.getByLabelText('Open link'));

  expect(openURL).toHaveBeenCalledWith('https://www.inkandswitch.com/local-first/');
  openURL.mockRestore();
});

test('shows the no-matches empty state for an unmatched search', async () => {
  fakeRepo.__reset([makeStoredBookmark({ title: 'Only one' })]);

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Only one')).toBeTruthy());

  await fireEvent.changeText(screen.getByPlaceholderText('Search title, notes, or URL'), 'zzz');

  expect(screen.getByText('No bookmarks match your search.')).toBeTruthy();
});
