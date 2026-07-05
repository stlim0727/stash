import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
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
const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const { useEffect } = require('react');
  return {
    useRouter: () => ({
      navigate: mockNavigate,
      push: mockPush,
      replace: jest.fn(),
      back: jest.fn(),
      dismissTo: jest.fn(),
    }),
    // The screen resets the shared scroll signal on focus; run it as a mount
    // effect (the screen is always focused in these tests).
    useFocusEffect: (cb: () => void | (() => void)) => useEffect(cb, []),
    // `library.tsx` imports TAB_BAR_HEIGHT from `./_layout`, which pulls `Tabs`
    // from expo-router at module load; a harmless stub keeps that import happy.
    Tabs: Object.assign(() => null, { Screen: () => null }),
  };
});

import LibraryScreen from '@/app/(tabs)/library';
import { BookmarksProvider } from '@/store/bookmarks';
import type { Collection } from '@/domain/types';
import type { FakeRepositoryModule } from './helpers/fake-repository';
import { makeStoredBookmark } from './helpers/fake-repository';

function makeCollection(id: string, name: string): Collection {
  const now = '2026-06-12T00:00:00.000Z';
  return { id, user_id: 'user-test', name, description: null, created_at: now, updated_at: now };
}

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

function renderLibrary() {
  return render(
    <BookmarksProvider>
      <LibraryScreen />
    </BookmarksProvider>,
  );
}

beforeEach(() => {
  mockNavigate.mockClear();
  mockPush.mockClear();
});

test('lists an "All items" row plus one row per non-empty collection with a fingerprint subtitle', async () => {
  fakeRepo.__reset(
    [
      makeStoredBookmark({
        id: '7e64cf1e-0000-4000-8000-00000000000a',
        title: 'Work A',
        collection_id: 'col-work',
        site_name: 'WIRED',
        created_at: '2026-06-01T00:00:00.000Z',
      }),
      makeStoredBookmark({
        id: '7e64cf1e-0000-4000-8000-00000000000b',
        title: 'Work B',
        collection_id: 'col-work',
        site_name: 'WIRED',
        created_at: '2026-06-20T00:00:00.000Z',
      }),
      makeStoredBookmark({
        id: '7e64cf1e-0000-4000-8000-00000000000c',
        title: 'Loose link',
        collection_id: null,
      }),
    ],
    {
      tags: [],
      bookmarkTags: [],
      collections: [makeCollection('col-work', 'Work'), makeCollection('col-empty', 'Empty')],
    },
  );

  const screen = await renderLibrary();

  // "All items" counts every active bookmark (collected + loose).
  await waitFor(() => expect(screen.getByText('All items')).toBeTruthy());
  expect(screen.getByTestId('library-row-all')).toBeTruthy();

  // The Work collection row carries a real content fingerprint: count, a
  // last-added relative time, and the repeated site.
  expect(screen.getByText('Work')).toBeTruthy();
  expect(screen.getByText(/2 items/)).toBeTruthy();
  expect(screen.getByText(/last added/)).toBeTruthy();
  expect(screen.getByText(/WIRED/)).toBeTruthy();

  // An empty collection (no active bookmarks) is not shown — every row leads
  // somewhere, like the Inbox browse shelf.
  expect(screen.queryByText('Empty')).toBeNull();
});

test('shows the calm empty state on a first run with no bookmarks', async () => {
  fakeRepo.__reset([]);

  const screen = await renderLibrary();

  await waitFor(() => expect(screen.getByTestId('library-empty')).toBeTruthy());
  expect(screen.getByText('Everything you keep lives here')).toBeTruthy();
  // No browse rows on an empty library.
  expect(screen.queryByTestId('library-row-all')).toBeNull();
});

test('tapping a collection opens the Inbox tab scoped to that collection', async () => {
  fakeRepo.__reset(
    [
      makeStoredBookmark({
        id: '7e64cf1e-0000-4000-8000-00000000000d',
        title: 'Work doc',
        collection_id: 'col-work',
      }),
    ],
    { tags: [], bookmarkTags: [], collections: [makeCollection('col-work', 'Work')] },
  );

  const screen = await renderLibrary();
  await waitFor(() => expect(screen.getByTestId('library-row-col-work')).toBeTruthy());

  await fireEvent.press(screen.getByTestId('library-row-col-work'));

  // It hands the Inbox tab the collection facet (with a fresh nonce) so the
  // items render there with the existing cards.
  expect(mockNavigate).toHaveBeenCalledWith({
    pathname: '/',
    params: { collection: 'col-work', t: expect.any(String) },
  });
});

test('renders the shared top-right header cluster: search + settings icons', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({ id: '7e64cf1e-0000-4000-8000-0000000000f1', title: 'A link' }),
  ]);

  const screen = await renderLibrary();
  await waitFor(() => expect(screen.getByTestId('tab-header-search')).toBeTruthy());
  expect(screen.getByTestId('tab-header-settings')).toBeTruthy();
});

test('the header search icon navigates to the Inbox with a focusSearch param', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({ id: '7e64cf1e-0000-4000-8000-0000000000f2', title: 'A link' }),
  ]);

  const screen = await renderLibrary();
  await waitFor(() => expect(screen.getByTestId('tab-header-search')).toBeTruthy());

  await fireEvent.press(screen.getByTestId('tab-header-search'));
  expect(mockNavigate).toHaveBeenCalledWith({
    pathname: '/',
    params: { focusSearch: '1', t: expect.any(String) },
  });
});

test('the header settings icon opens the Settings screen', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({ id: '7e64cf1e-0000-4000-8000-0000000000f3', title: 'A link' }),
  ]);

  const screen = await renderLibrary();
  await waitFor(() => expect(screen.getByTestId('tab-header-settings')).toBeTruthy());

  await fireEvent.press(screen.getByTestId('tab-header-settings'));
  expect(mockPush).toHaveBeenCalledWith('/settings');
});

test('tapping "All items" switches to the Inbox tab', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({ id: '7e64cf1e-0000-4000-8000-00000000000e', title: 'A link' }),
  ]);

  const screen = await renderLibrary();
  await waitFor(() => expect(screen.getByTestId('library-row-all')).toBeTruthy());

  await fireEvent.press(screen.getByTestId('library-row-all'));

  expect(mockNavigate).toHaveBeenCalledWith('/');
});
