import { render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('react-native/Libraries/Modal/Modal', () => {
  const React = require('react');
  const { View } = require('react-native');
  const MockModal = ({ visible, children }: { visible?: boolean; children: ReactNode }) =>
    visible === false ? null : React.createElement(View, null, children);
  return { __esModule: true, default: MockModal };
});
jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);
jest.mock('@/supabase/auth-provider', () => ({
  useSupabaseAuth: () => ({
    status: 'not_configured',
    session: null,
    userId: null,
    isSignedIn: false,
    message: 'not configured',
    ensureAnonymousSession: async () => null,
  }),
  SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: async () => ({ patch: {}, metadata_status: 'complete' }),
}));
jest.mock('expo-router', () => {
  const { useEffect } = require('react');
  return {
    Link: ({ children }: { children: ReactNode }) => children,
    useRouter: () => ({ push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn() }),
    useLocalSearchParams: () => ({}),
    useFocusEffect: (cb: () => void | (() => void)) => useEffect(() => cb(), []),
  };
});

import SettingsScreen from '@/app/settings';
import { BookmarksProvider } from '@/store/bookmarks';
import type { FakeRepositoryModule } from './helpers/fake-repository';
import { makeEnrichment, makeStoredBookmark } from './helpers/fake-repository';

const ID = '7e64cf1e-0000-4000-8000-000000000001';
const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

function renderSettings() {
  return render(
    <BookmarksProvider>
      <SettingsScreen />
    </BookmarksProvider>,
  );
}

test('the review row counts a folder-only suggestion instead of "Nothing to review"', async () => {
  // No pending tag suggestions, only a folder recommendation (create "Recipes").
  // This is exactly the case the Review screen lists but settings used to ignore.
  fakeRepo.__reset(
    [makeStoredBookmark({ id: ID, title: 'A bookmark', collection_id: null })],
    undefined,
    [makeEnrichment({ bookmark_id: ID, suggested_collection_name: 'Recipes' })],
  );

  const screen = await renderSettings();

  await waitFor(() => expect(screen.getByText('1 to review')).toBeTruthy());
  expect(screen.queryByText('Nothing to review')).toBeNull();
});

test('the review row drops a folder the user dismissed elsewhere (durable, cross-screen)', async () => {
  // A folder-only suggestion that was already dismissed (on Detail or Review).
  // Settings must honor that durable dismissal, not re-count it.
  fakeRepo.__reset(
    [makeStoredBookmark({ id: ID, title: 'A bookmark', collection_id: null })],
    undefined,
    [makeEnrichment({ bookmark_id: ID, suggested_collection_name: 'Travel' })],
  );
  fakeRepo.__setMeta('dismissed_folder_suggestions', JSON.stringify({ [ID]: ['name:travel'] }));

  const screen = await renderSettings();

  await waitFor(() => expect(screen.getByText('Nothing to review')).toBeTruthy());
});

test('the review row reads "Nothing to review" when no tag or folder suggestion remains', async () => {
  // An enrichment with neither pending tags nor a folder hint — nothing to do.
  fakeRepo.__reset(
    [makeStoredBookmark({ id: ID, title: 'A bookmark', collection_id: null })],
    undefined,
    [makeEnrichment({ bookmark_id: ID })],
  );

  const screen = await renderSettings();

  await waitFor(() => expect(screen.getByText('Nothing to review')).toBeTruthy());
});
