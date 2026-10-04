import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { StyleSheet, type ViewStyle } from 'react-native';

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
jest.mock('expo-router', () => {
  const { useEffect } = require('react');
  return {
    Link: ({ children }: { children: ReactNode }) => children,
    useRouter: () => ({ push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn() }),
    useLocalSearchParams: () => ({}),
    usePathname: () => '/',
    // Run the focus callback as a mount effect; honours the returned cleanup.
    useFocusEffect: (cb: () => void | (() => void)) => useEffect(cb, []),
  };
});

import InboxScreen from '@/app/index';
import { BookmarksProvider } from '@/store/bookmarks';
import { CaptureToastProvider } from '@/ui/capture-toast';
import type { Collection } from '@/domain/types';
import type { FakeRepositoryModule } from './helpers/fake-repository';
import { makeStoredBookmark } from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

function makeCollection(id: string, name: string): Collection {
  const now = '2026-06-12T00:00:00.000Z';
  return { id, user_id: 'user-test', name, description: null, created_at: now, updated_at: now };
}

async function renderShelf() {
  // A collection produces a facet chip, which makes the Browse shelf visible.
  fakeRepo.__reset(
    [makeStoredBookmark({ id: '7e64cf1e-0000-4000-8000-00000000000a', collection_id: 'col-work' })],
    { tags: [], bookmarkTags: [], collections: [makeCollection('col-work', 'Work')] },
  );
  const screen = await render(
    <BookmarksProvider>
      <CaptureToastProvider>
        <InboxScreen />
      </CaptureToastProvider>
    </BookmarksProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('inbox-scope-picker')).toBeTruthy());
  return screen;
}

test('scope control grows with text and the redundant filter strip is absent', async () => {
  const screen = await renderShelf();
  expect(screen.queryByTestId('browse-shelf')).toBeNull();
  const picker = screen.getByTestId('inbox-scope-picker');
  const style = StyleSheet.flatten(picker.props.style) as ViewStyle;
  expect(style.minHeight).toBe(48);
  expect(style.height).toBeUndefined();
});

test('Folder view keeps the mode control without a scope picker or filter strip', async () => {
  const screen = await renderShelf();
  await fireEvent.press(screen.getByTestId('inbox-view-folder'));
  expect(screen.getByTestId('inbox-view-folder').props.accessibilityState.selected).toBe(true);
  expect(screen.queryByTestId('inbox-scope-picker')).toBeNull();
  expect(screen.queryByTestId('browse-shelf')).toBeNull();
});
