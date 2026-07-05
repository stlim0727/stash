import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { BackHandler, Platform } from 'react-native';

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
const mockParams: Record<string, string> = {};
jest.mock('expo-router', () => {
  const { useEffect } = require('react');
  return {
    Link: ({ children }: { children: ReactNode }) => children,
    useRouter: () => ({ push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn() }),
    useLocalSearchParams: () => mockParams,
    usePathname: () => '/',
    // Honour the callback identity ([cb]) — unlike the always-focused mount mock,
    // the real useFocusEffect re-runs when the callback changes, which is what
    // re-registers the hardware-back handler with fresh query/filter state.
    useFocusEffect: (cb: () => void | (() => void)) => useEffect(cb, [cb]),
  };
});

import InboxScreen from '@/app/(tabs)/index';
import { BookmarksProvider } from '@/store/bookmarks';
import { CaptureToastProvider } from '@/ui/capture-toast';
import type { Collection } from '@/domain/types';
import type { FakeRepositoryModule } from './helpers/fake-repository';
import { makeStoredBookmark } from './helpers/fake-repository';

function makeCollection(id: string, name: string): Collection {
  const now = '2026-06-12T00:00:00.000Z';
  return { id, user_id: 'user-test', name, description: null, created_at: now, updated_at: now };
}

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

function renderInbox() {
  return render(
    <BookmarksProvider>
      <CaptureToastProvider>
        <InboxScreen />
      </CaptureToastProvider>
    </BookmarksProvider>,
  );
}

// Capture every hardware-back handler the screen registers. The screen
// re-registers on each query/filter change, so the most recent entry is the one
// bound to the live state.
let backHandlers: Array<() => boolean | null | undefined> = [];
let addSpy: jest.SpyInstance;

// The screen only subscribes to hardware back on Android (it's a no-op elsewhere
// and react-native-web's BackHandler stub console.errors on subscribe), so pin
// the platform here. Module registries are per-file, so this can't leak.
beforeAll(() => {
  Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' });
});

beforeEach(() => {
  backHandlers = [];
  addSpy = jest
    .spyOn(BackHandler, 'addEventListener')
    .mockImplementation((_event: string, handler: () => boolean | null | undefined) => {
      backHandlers.push(handler);
      return {
        remove: () => {
          backHandlers = backHandlers.filter((entry) => entry !== handler);
        },
      } as ReturnType<typeof BackHandler.addEventListener>;
    });
});

afterEach(() => {
  addSpy.mockRestore();
});

// Fire the live hardware-back handler and flush the state updates it triggers,
// returning whether it consumed the event (true) or let the OS handle it (false).
async function pressBack(): Promise<boolean | null | undefined> {
  const handler = backHandlers[backHandlers.length - 1];
  expect(handler).toBeTruthy();
  let result: boolean | null | undefined;
  await act(async () => {
    result = handler();
  });
  return result;
}

test('hardware back clears an active facet instead of exiting the app', async () => {
  fakeRepo.__reset(
    [
      makeStoredBookmark({
        id: '7e64cf1e-0000-4000-8000-00000000000a',
        title: 'Work doc',
        collection_id: 'col-work',
      }),
      makeStoredBookmark({
        id: '7e64cf1e-0000-4000-8000-00000000000b',
        title: 'Loose link',
        collection_id: null,
      }),
    ],
    { tags: [], bookmarkTags: [], collections: [makeCollection('col-work', 'Work')] },
  );

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Work doc')).toBeTruthy());

  // Narrow to the Work collection — the loose bookmark drops out.
  await fireEvent.press(screen.getByText('Work'));
  expect(screen.queryByText('Loose link')).toBeNull();

  // Back peels the facet (returns to All) and consumes the press.
  expect(await pressBack()).toBe(true);
  expect(screen.getByText('Loose link')).toBeTruthy();
  expect(screen.getByText('Work doc')).toBeTruthy();

  // With nothing left to peel, back is handed to the OS (would exit the app).
  expect(await pressBack()).toBe(false);
});

test('hardware back clears a live search before exiting', async () => {
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

  // Search is tap-to-open: reveal the field, then type a live query.
  await fireEvent.press(screen.getByTestId('tab-header-search'));
  const input = screen.getByPlaceholderText('Search titles, tags, folders');
  await fireEvent.changeText(input, 'local-first');
  await waitFor(() => expect(screen.getByText('1 result')).toBeTruthy());

  // Back peels the search UI: closeSearch clears the query AND folds the field
  // away (a live query can only exist while search is open), consuming the press.
  expect(await pressBack()).toBe(true);
  await waitFor(() => expect(screen.queryByTestId('inbox-search-input')).toBeNull());
  await waitFor(() => expect(screen.getByText('Raindrop review')).toBeTruthy());
});

test('hardware back is left to the OS when the Inbox is not narrowed', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({
      id: '7e64cf1e-0000-4000-8000-00000000000a',
      title: 'Local-first software',
    }),
  ]);

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByText('Local-first software')).toBeTruthy());

  // No facet, no search → the handler declines so Android can exit the app.
  expect(await pressBack()).toBe(false);
});
