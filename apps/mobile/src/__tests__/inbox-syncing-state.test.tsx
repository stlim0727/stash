import { render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

// The post-sign-in "empty for several seconds" gap: the local durable load has
// finished (isLoading false) with an empty cache, while the cloud pull is still
// in flight (isSyncing true). The Inbox must show a syncing progress state, not
// the "your stash is empty" onboarding — flashing the empty card there reads as
// if signing in lost the user's data. Driving the real store into that state
// needs a live auth session + sync, so we stub the store to isolate this UI
// branch.
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('expo-router', () => {
  const { useEffect } = require('react');
  return {
    useRouter: () => ({ push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn() }),
    useLocalSearchParams: () => ({}),
    usePathname: () => '/',
    useFocusEffect: (cb: () => void | (() => void)) => useEffect(cb, []),
  };
});
jest.mock('@/supabase/auth-provider', () => ({
  useSupabaseAuth: () => ({ status: 'authenticated', session: {}, userId: 'user-1' }),
}));
jest.mock('@/storage/preferences', () => ({
  getPreference: async () => null,
  setPreference: async () => {},
}));

let mockStoreOverrides: Record<string, unknown> = {};
jest.mock('@/store/bookmarks', () => ({
  useBookmarks: () => ({
    inbox: [],
    isLoading: false,
    isSyncing: false,
    loadError: false,
    collections: [],
    unseenSuggestionIds: new Set(),
    getTagsForBookmark: () => [],
    getCollection: () => undefined,
    getEnrichment: () => undefined,
    getReviewedSuggestions: () => new Set(),
    getDismissedFolderSuggestions: () => new Set(),
    clearUnseenSuggestions: () => {},
    trashBookmark: () => {},
    restoreBookmark: () => {},
    deleteBookmark: () => {},
    assignCollection: () => {},
    markBookmarkAccessed: () => {},
    ...mockStoreOverrides,
  }),
}));

import InboxScreen from '@/app/index';
import { CaptureToastProvider } from '@/ui/capture-toast';

function renderInbox() {
  return render(
    <CaptureToastProvider>
      <InboxScreen />
    </CaptureToastProvider>,
  );
}

afterEach(() => {
  mockStoreOverrides = {};
});

test('shows a syncing progress state (not the empty onboarding) while the first pull runs', async () => {
  mockStoreOverrides = { isSyncing: true };
  const screen = await renderInbox();

  await waitFor(() => expect(screen.getByTestId('inbox-syncing')).toBeTruthy());
  expect(screen.getByText('Syncing your bookmarks…')).toBeTruthy();
  // The empty-library onboarding must NOT show — that's the misleading "data
  // lost" flash this replaces.
  expect(screen.queryByTestId('inbox-empty-onboarding')).toBeNull();
});

test('falls through to the empty onboarding once the pull settles with no bookmarks', async () => {
  mockStoreOverrides = { isSyncing: false };
  const screen = await renderInbox();

  await waitFor(() => expect(screen.getByTestId('inbox-empty-onboarding')).toBeTruthy());
  expect(screen.queryByTestId('inbox-syncing')).toBeNull();
});
